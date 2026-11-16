import { prisma as defaultPrisma } from '../../services/prisma.js';

export const GAME_CENTER_TYPES = Object.freeze({
  TTT: 'ttt',
  CONNECT4: 'connect4',
  QUIZ: 'quiz',
  RPS: 'rps',
});

export const GAME_CENTER_LABELS = Object.freeze({
  ttt: 'Tic Tac Toe',
  connect4: 'Connect Four',
  quiz: 'Quiz Battle',
  rps: 'Rock Paper Scissors',
});

export const MATCH_POINTS = Object.freeze({
  WIN: 25,
  DRAW: 10,
  LOSS: 0,
});

/**
 * Calculates win rate percentage safely without dividing by zero.
 * @param {number} wins
 * @param {number} matches
 * @returns {number}
 */
export function calculateWinRate(wins, matches) {
  if (!Number.isFinite(matches) || matches <= 0 || !Number.isFinite(wins) || wins <= 0) {
    return 0;
  }
  return Number(((wins / matches) * 100).toFixed(1));
}

/**
 * Atomically records final match statistics once per session (`statsRecorded === false` guard).
 * Never records unfinished matches.
 *
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   sessionId: string,
 *   results: Array<{
 *     userId: string,
 *     username?: string | null,
 *     outcome: 'win' | 'loss' | 'draw',
 *     points: number,
 *   }>,
 * }} params
 * @returns {Promise<{ recorded: boolean }>}
 */
async function persistPlayerResultsInTx(tx, { sessionId, guildId, gameType, results }) {
  for (const entry of results) {
    const winInc = entry.outcome === 'win' ? 1 : 0;
    const lossInc = entry.outcome === 'loss' ? 1 : 0;
    const drawInc = entry.outcome === 'draw' ? 1 : 0;
    const pts = Math.max(0, Math.trunc(entry.points ?? 0));

    await tx.gameParticipant.updateMany({
      where: { sessionId, userId: entry.userId },
      data: {
        outcome: entry.outcome,
        score: pts,
        ...(entry.username ? { username: entry.username } : {}),
      },
    });

    await tx.gameStats.upsert({
      where: {
        guildId_userId_gameType: {
          guildId,
          userId: entry.userId,
          gameType,
        },
      },
      update: {
        matches: { increment: 1 },
        wins: { increment: winInc },
        losses: { increment: lossInc },
        draws: { increment: drawInc },
        points: { increment: pts },
        ...(entry.username ? { username: entry.username } : {}),
      },
      create: {
        guildId,
        userId: entry.userId,
        username: entry.username ?? null,
        gameType,
        matches: 1,
        wins: winInc,
        losses: lossInc,
        draws: drawInc,
        points: pts,
      },
    });
  }
}

export async function recordMatchStatsOnce({
  prisma = defaultPrisma,
  sessionId,
  results,
}) {
  if (!sessionId || !Array.isArray(results) || results.length === 0) {
    return { recorded: false };
  }

  return prisma.$transaction(async (tx) => {
    const session = await tx.gameSession.findUnique({
      where: { id: sessionId },
      select: { id: true, guildId: true, gameType: true, status: true, statsRecorded: true },
    });

    if (!session || session.status !== 'finished' || session.statsRecorded) {
      return { recorded: false };
    }

    const claim = await tx.gameSession.updateMany({
      where: { id: sessionId, status: 'finished', statsRecorded: false },
      data: { statsRecorded: true },
    });

    if (claim.count === 0) {
      return { recorded: false };
    }

    await persistPlayerResultsInTx(tx, {
      sessionId,
      guildId: session.guildId,
      gameType: session.gameType,
      results,
    });

    return { recorded: true };
  });
}

/**
 * Atomically transitions a session to `'finished'` AND records final stats in one transaction.
 * Prevents any window where `status === 'finished'` while `statsRecorded === false`.
 *
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   sessionId: string,
 *   finishData: {
 *     winnerId?: string | null,
 *     isDraw?: boolean,
 *     state: object,
 *     finishedAt?: Date,
 *   },
 *   results: Array<{
 *     userId: string,
 *     username?: string | null,
 *     outcome: 'win' | 'loss' | 'draw',
 *     points: number,
 *   }>,
 * }} params
 */
export async function finalizeSessionAndRecordStats({
  prisma = defaultPrisma,
  sessionId,
  finishData,
  results,
}) {
  if (!sessionId || !finishData || !Array.isArray(results) || results.length === 0) {
    return { recorded: false, session: null };
  }

  return prisma.$transaction(async (tx) => {
    const claim = await tx.gameSession.updateMany({
      where: { id: sessionId, statsRecorded: false, status: { in: ['pending', 'active'] } },
      data: {
        status: 'finished',
        statsRecorded: true,
        currentTurnId: null,
        winnerId: finishData.winnerId ?? null,
        isDraw: Boolean(finishData.isDraw),
        stateJson: JSON.stringify(finishData.state),
        expiresAt: null,
        finishedAt: finishData.finishedAt ?? new Date(),
      },
    });

    if (claim.count === 0) {
      return { recorded: false, session: null };
    }

    const session = await tx.gameSession.findUnique({
      where: { id: sessionId },
      include: { participants: true },
    });

    await persistPlayerResultsInTx(tx, {
      sessionId,
      guildId: session.guildId,
      gameType: session.gameType,
      results,
    });

    return { recorded: true, session };
  });
}

/**
 * Helper to build 2-player match results from winnerId / isDraw.
 * @param {string[]} playerIds
 * @param {{ winnerId?: string | null, isDraw?: boolean, usernames?: Record<string, string> }} outcomeInfo
 */
export function buildTwoPlayerResults(playerIds, { winnerId = null, isDraw = false, usernames = {} } = {}) {
  return playerIds.map((userId) => {
    let outcome = 'loss';
    let points = MATCH_POINTS.LOSS;
    if (isDraw) {
      outcome = 'draw';
      points = MATCH_POINTS.DRAW;
    } else if (winnerId === userId) {
      outcome = 'win';
      points = MATCH_POINTS.WIN;
    }
    return {
      userId,
      username: usernames[userId] ?? null,
      outcome,
      points,
    };
  });
}

/**
 * Helper to build Quiz Battle results directly from round scores + winner bonus.
 * @param {string[]} playerIds
 * @param {{
 *   scores: Record<string, number>,
 *   winnerId?: string | null,
 *   winnerIds?: string[],
 *   isDraw?: boolean,
 *   usernames?: Record<string, string>,
 * }} info
 */
export function buildQuizMatchResults(
  playerIds,
  { scores, winnerId = null, winnerIds = [], isDraw = false, usernames = {} },
) {
  const topSet = new Set(winnerIds);
  return playerIds.map((userId) => {
    let outcome = 'loss';
    if (winnerId === userId) {
      outcome = 'win';
    } else if (isDraw && topSet.has(userId)) {
      outcome = 'draw';
    }
    return {
      userId,
      username: usernames[userId] ?? null,
      outcome,
      points: Math.max(0, Math.trunc(scores[userId] ?? 0)),
    };
  });
}
