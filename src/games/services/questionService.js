import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma as defaultPrisma } from '../../services/prisma.js';
import { sanitizeQuizImageUrl } from '../engines/quizBattle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_TRIVIA_JSON = path.resolve(__dirname, '../../data/trivia.json');

/**
 * Fisher-Yates shuffle returning a new array.
 * @template T
 * @param {T[]} items
 * @param {() => number} [rng]
 * @returns {T[]}
 */
export function shuffleArray(items, rng = Math.random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Shuffles the 4 options of a question and returns updated `{ options, correctIndex }`.
 * @param {string[]} options
 * @param {number} correctIndex
 * @param {() => number} [rng]
 */
export function shuffleQuestionOptions(options, correctIndex, rng = Math.random) {
  const tagged = options.map((text, idx) => ({
    text,
    isCorrect: idx === correctIndex,
  }));
  const shuffled = shuffleArray(tagged, rng);
  return {
    options: shuffled.map((item) => item.text),
    correctIndex: shuffled.findIndex((item) => item.isCorrect),
  };
}

const inFlightSeeds = new WeakMap();
const syncedSignatures = new WeakMap();

/**
 * Idempotently seeds and updates the `QuizQuestion` SQLite table from `src/data/trivia.json`.
 * Uses a per-client promise lock and SQLite transaction so concurrent `!quiz` commands never collide,
 * while ensuring translated/updated questions overwrite stale DB rows automatically.
 * @param {import('@prisma/client').PrismaClient} [prisma]
 * @param {string} [dataPath]
 */
export async function ensureQuizQuestionsSeeded(prisma = defaultPrisma, dataPath = DEFAULT_TRIVIA_JSON) {
  if (inFlightSeeds.has(prisma)) {
    return inFlightSeeds.get(prisma);
  }

  const raw = fs.readFileSync(dataPath, 'utf8');
  if (syncedSignatures.get(prisma) === raw) {
    return JSON.parse(raw).length;
  }

  const seedTask = (async () => {
    const bank = JSON.parse(raw);

    const existingRows = await prisma.quizQuestion.findMany({
      select: {
        externalKey: true,
        category: true,
        difficulty: true,
        question: true,
        optionsJson: true,
        correctIndex: true,
        isActive: true,
      },
    });
    const existingByKey = new Map(existingRows.map((row) => [row.externalKey, row]));

    const pendingItems = bank.filter((item) => {
      const existing = existingByKey.get(item.id);
      if (!existing) return true;
      return (
        existing.category !== item.category ||
        existing.difficulty !== item.difficulty ||
        existing.question !== item.question ||
        existing.optionsJson !== JSON.stringify(item.options) ||
        existing.correctIndex !== item.answerIndex ||
        existing.isActive !== true
      );
    });

    if (pendingItems.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const item of pendingItems) {
          const payload = {
            category: item.category,
            difficulty: item.difficulty,
            question: item.question,
            optionsJson: JSON.stringify(item.options),
            correctIndex: item.answerIndex,
            isActive: true,
          };
          await tx.quizQuestion.upsert({
            where: { externalKey: item.id },
            update: payload,
            create: {
              externalKey: item.id,
              ...payload,
            },
          });
        }
      });
    }

    syncedSignatures.set(prisma, raw);
    return prisma.quizQuestion.count({ where: { isActive: true } });
  })();

  inFlightSeeds.set(prisma, seedTask);
  try {
    return await seedTask;
  } finally {
    if (inFlightSeeds.get(prisma) === seedTask) {
      inFlightSeeds.delete(prisma);
    }
  }
}

/**
 * Fetches and prepares `count` shuffled Quiz Battle questions with shuffled options.
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   category?: string,
 *   difficulty?: string,
 *   count?: number,
 *   rng?: () => number,
 * }} [params]
 */
export async function getPreparedQuizQuestions({
  prisma = defaultPrisma,
  category = 'all',
  difficulty = 'all',
  count = 10,
  rng = Math.random,
} = {}) {
  await ensureQuizQuestionsSeeded(prisma);

  const where = { isActive: true };
  if (category && category !== 'all') {
    where.category = category;
  }
  if (difficulty && difficulty !== 'all') {
    where.difficulty = difficulty;
  }

  let rows = await prisma.quizQuestion.findMany({ where });

  // Fall back to broader filter if a narrow category+difficulty bucket has fewer than `count` questions
  if (rows.length < count && (where.category || where.difficulty)) {
    const existingIds = new Set(rows.map((r) => r.id));
    const fallbackWhere = { isActive: true };
    if (where.category) fallbackWhere.category = where.category;
    let extra = await prisma.quizQuestion.findMany({ where: fallbackWhere });
    for (const row of extra) {
      if (!existingIds.has(row.id)) {
        rows.push(row);
        existingIds.add(row.id);
      }
    }
    if (rows.length < count) {
      extra = await prisma.quizQuestion.findMany({ where: { isActive: true } });
      for (const row of extra) {
        if (!existingIds.has(row.id)) {
          rows.push(row);
          existingIds.add(row.id);
        }
      }
    }
  }

  const picked = shuffleArray(rows, rng).slice(0, count);
  return picked.map((row) => {
    const parsedOptions = JSON.parse(row.optionsJson);
    const { options, correctIndex } = shuffleQuestionOptions(parsedOptions, row.correctIndex, rng);
    const imageUrl = sanitizeQuizImageUrl(row.imageUrl ?? row.image);
    return {
      id: row.id,
      category: row.category,
      difficulty: row.difficulty,
      question: row.question,
      options,
      correctIndex,
      ...(imageUrl ? { imageUrl } : {}),
    };
  });
}
