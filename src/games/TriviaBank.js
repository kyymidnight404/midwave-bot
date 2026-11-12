import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIFFICULTIES,
  TRIVIA_CATEGORIES,
  TRIVIA_CONFIG,
} from '../utils/constants.js';
import { defaultRng } from '../utils/random.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TRIVIA_DATA_PATH = path.resolve(__dirname, '../data/trivia.json');

/**
 * Validates the structure, uniqueness, and bucket coverage of a trivia question bank.
 * @param {unknown} questions
 * @returns {Array<object>}
 */
export function validateTriviaBank(questions) {
  if (!Array.isArray(questions)) {
    throw new Error('Trivia bank must be a JSON array.');
  }

  const seenIds = new Set();
  const seenPrompts = new Set();
  const bucketCounts = new Map();

  for (const cat of TRIVIA_CATEGORIES) {
    for (const diff of DIFFICULTIES) {
      bucketCounts.set(`${cat}:${diff}`, 0);
    }
  }

  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    if (!q || typeof q !== 'object') {
      throw new Error(`Trivia item at index ${i} must be an object.`);
    }
    if (typeof q.id !== 'string' || !q.id.trim()) {
      throw new Error(`Trivia item at index ${i} is missing a valid string id.`);
    }
    if (seenIds.has(q.id)) {
      throw new Error(`Duplicate trivia question id: ${q.id}`);
    }
    seenIds.add(q.id);

    if (!TRIVIA_CATEGORIES.includes(q.category)) {
      throw new Error(`Invalid trivia category "${q.category}" on question ${q.id}`);
    }
    if (!DIFFICULTIES.includes(q.difficulty)) {
      throw new Error(`Invalid trivia difficulty "${q.difficulty}" on question ${q.id}`);
    }
    if (typeof q.question !== 'string' || !q.question.trim()) {
      throw new Error(`Empty trivia question text on ${q.id}`);
    }

    const normalizedPrompt = q.question.trim().toLowerCase();
    if (seenPrompts.has(normalizedPrompt)) {
      throw new Error(`Duplicate trivia question prompt detected on ${q.id}`);
    }
    seenPrompts.add(normalizedPrompt);

    if (!Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(`Trivia question ${q.id} must have exactly 4 options.`);
    }
    const optionSet = new Set();
    for (const opt of q.options) {
      if (typeof opt !== 'string' || !opt.trim()) {
        throw new Error(`Trivia question ${q.id} contains an empty option.`);
      }
      const normOpt = opt.trim().toLowerCase();
      if (optionSet.has(normOpt)) {
        throw new Error(`Trivia question ${q.id} contains duplicate options.`);
      }
      optionSet.add(normOpt);
    }

    if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex > 3) {
      throw new Error(`Trivia question ${q.id} has invalid answerIndex: ${q.answerIndex}`);
    }

    const key = `${q.category}:${q.difficulty}`;
    bucketCounts.set(key, (bucketCounts.get(key) ?? 0) + 1);
  }

  for (const [bucket, count] of bucketCounts.entries()) {
    if (count < TRIVIA_CONFIG.QUESTIONS_PER_BUCKET) {
      throw new Error(
        `Trivia bucket "${bucket}" has ${count} questions; minimum required is ${TRIVIA_CONFIG.QUESTIONS_PER_BUCKET}.`,
      );
    }
  }

  return questions;
}

let cachedBank = null;

/**
 * Loads and validates the trivia bank from disk (cached in memory as read-only).
 * @returns {Array<object>}
 */
export function loadTriviaBank() {
  if (cachedBank) return cachedBank;
  const raw = fs.readFileSync(TRIVIA_DATA_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  cachedBank = validateTriviaBank(parsed);
  return cachedBank;
}

/**
 * Selects `count` unique questions without replacement for a given category and difficulty.
 * @param {{ category: string, difficulty: string, count?: number, rng?: object }} params
 * @returns {Array<object>}
 */
export function selectTriviaQuestions({
  category = 'general',
  difficulty = 'normal',
  count = TRIVIA_CONFIG.ROUNDS_PER_MATCH,
  rng = defaultRng,
}) {
  const bank = loadTriviaBank();
  const pool = bank.filter((q) => q.category === category && q.difficulty === difficulty);
  if (pool.length < count) {
    throw new Error(`Insufficient trivia questions for ${category}/${difficulty}: found ${pool.length}, need ${count}.`);
  }
  const shuffled = rng.shuffle(pool);
  return shuffled.slice(0, count);
}
