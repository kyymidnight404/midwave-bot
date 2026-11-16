import { prisma as defaultPrisma } from '../../services/prisma.js';
import { calculateWinRate, GAME_CENTER_TYPES } from './scoreService.js';

export const LEADERBOARD_PAGE_SIZE = 10;

const GAME_FILTER_ALIASES = Object.freeze({
  all: 'all',
  overall: 'all',
  ttt: GAME_CENTER_TYPES.TTT,
  tictactoe: GAME_CENTER_TYPES.TTT,
  connect4: GAME_CENTER_TYPES.CONNECT4,
  c4: GAME_CENTER_TYPES.CONNECT4,
  quiz: GAME_CENTER_TYPES.QUIZ,
  rps: GAME_CENTER_TYPES.RPS,
});

/**
 * Normalizes a leaderboard filter argument (returns `'all'`, a valid gameType, or `null` if invalid).
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeLeaderboardFilter(raw) {
  if (!raw || typeof raw !== 'string') {
    return 'all';
  }
  const key = raw.trim().toLowerCase();
  if (!key) {
    return 'all';
  }
  return Object.hasOwn(GAME_FILTER_ALIASES, key) ? GAME_FILTER_ALIASES[key] : null;
}

/**
 * Fetches paginated guild leaderboard entries (overall or per-game).
 * Guarantees guild isolation and accurate tie-breaking (points desc, wins desc, matches asc).
 *
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   guildId: string,
 *   gameType?: string,
 *   page?: number,
 *   pageSize?: number,
 * }} params
 */
export async function getGuildLeaderboard({
  prisma = defaultPrisma,
  guildId,
  gameType = 'all',
  page = 1,
  pageSize = LEADERBOARD_PAGE_SIZE,
}) {
  const normalizedGame = normalizeLeaderboardFilter(gameType) ?? 'all';
  const rows = await prisma.gameStats.findMany({
    where: {
      guildId,
      ...(normalizedGame !== 'all' ? { gameType: normalizedGame } : {}),
    },
  });

  const byUser = new Map();
  for (const row of rows) {
    const existing = byUser.get(row.userId) ?? {
      userId: row.userId,
      username: row.username ?? null,
      matches: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      points: 0,
    };
    existing.matches += row.matches;
    existing.wins += row.wins;
    existing.losses += row.losses;
    existing.draws += row.draws;
    existing.points += row.points;
    if (!existing.username && row.username) {
      existing.username = row.username;
    }
    byUser.set(row.userId, existing);
  }

  const sorted = Array.from(byUser.values())
    .filter((entry) => entry.matches > 0)
    .map((entry) => ({
      ...entry,
      winRate: calculateWinRate(entry.wins, entry.matches),
    }))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.matches - b.matches;
    });

  const totalEntries = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));
  const rawPage = Number(page);
  const safePage = Number.isFinite(rawPage)
    ? Math.min(Math.max(1, Math.trunc(rawPage)), totalPages)
    : 1;
  const startIdx = (safePage - 1) * pageSize;
  const entries = sorted.slice(startIdx, startIdx + pageSize).map((item, idx) => ({
    ...item,
    rank: startIdx + idx + 1,
  }));

  return {
    gameType: normalizedGame,
    page: safePage,
    totalPages,
    totalEntries,
    entries,
  };
}

/**
 * Fetches full guild-scoped profile statistics for a user across all Game Center games.
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   guildId: string,
 *   userId: string,
 * }} params
 */
export async function getUserProfileStats({
  prisma = defaultPrisma,
  guildId,
  userId,
}) {
  const rows = await prisma.gameStats.findMany({
    where: { guildId, userId },
  });

  const summary = {
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    points: 0,
    winRate: 0,
  };

  const perGame = {};
  for (const type of Object.values(GAME_CENTER_TYPES)) {
    perGame[type] = {
      matches: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      points: 0,
      winRate: 0,
    };
  }

  for (const row of rows) {
    summary.matches += row.matches;
    summary.wins += row.wins;
    summary.losses += row.losses;
    summary.draws += row.draws;
    summary.points += row.points;

    if (Object.hasOwn(perGame, row.gameType)) {
      perGame[row.gameType] = {
        matches: row.matches,
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
        points: row.points,
        winRate: calculateWinRate(row.wins, row.matches),
      };
    }
  }

  summary.winRate = calculateWinRate(summary.wins, summary.matches);

  return {
    guildId,
    userId,
    summary,
    perGame,
  };
}
