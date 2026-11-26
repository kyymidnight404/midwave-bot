import crypto from 'node:crypto';
import { prisma as defaultPrisma } from '../../services/prisma.js';

export const CHALLENGE_TTL_MS = 2 * 60 * 1000; // 2 minutes to accept/decline challenge
export const GAME_INACTIVITY_TTL_MS = 10 * 60 * 1000; // 10 minutes per turn / lobby
export const DEFAULT_FINISHED_SESSION_RETENTION_MS = 60 * 60 * 1000; // 1 hour retention after terminal state

const sessionLocks = new Map();
const activeTimers = new Map();

/**
 * Serializes concurrent async operations on the same `sessionId` to prevent race conditions.
 * @template T
 * @param {string} sessionId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSessionLock(sessionId, fn) {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => next);
  sessionLocks.set(sessionId, chained);

  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === chained) {
      sessionLocks.delete(sessionId);
    }
  }
}

/**
 * Registers a timer under `(sessionId, key)` and automatically clears any prior timer for that key.
 * @param {string} sessionId
 * @param {string} key
 * @param {() => void} callback
 * @param {number} delayMs
 */
export function setSessionTimer(sessionId, key, callback, delayMs) {
  clearSessionTimer(sessionId, key);
  const fullKey = `${sessionId}:${key}`;
  const handle = setTimeout(() => {
    activeTimers.delete(fullKey);
    callback();
  }, delayMs);
  if (typeof handle.unref === 'function') {
    handle.unref();
  }
  activeTimers.set(fullKey, handle);
  return handle;
}

/**
 * Clears a specific timer for a session.
 * @param {string} sessionId
 * @param {string} key
 */
export function clearSessionTimer(sessionId, key) {
  const fullKey = `${sessionId}:${key}`;
  const existing = activeTimers.get(fullKey);
  if (existing) {
    clearTimeout(existing);
    activeTimers.delete(fullKey);
  }
}

/**
 * Clears all timers belonging to `sessionId`.
 * @param {string} sessionId
 */
export function clearSessionTimers(sessionId) {
  const prefix = `${sessionId}:`;
  for (const [key, handle] of activeTimers.entries()) {
    if (key.startsWith(prefix)) {
      clearTimeout(handle);
      activeTimers.delete(key);
    }
  }
}

/**
 * Clears all active Game Center timers (used during graceful bot shutdown).
 */
export function clearAllGameCenterTimers() {
  for (const handle of activeTimers.values()) {
    clearTimeout(handle);
  }
  activeTimers.clear();
}

/**
 * Generates a compact URL-safe session ID (8 hex chars = fits Discord 100-char customId easily).
 */
export function createGameSessionId() {
  return crypto.randomBytes(5).toString('hex');
}

/**
 * Creates a new `GameSession` + initial `GameParticipant` rows in SQLite.
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   id?: string,
 *   guildId: string,
 *   channelId: string,
 *   gameType: string,
 *   status?: string,
 *   hostId: string,
 *   currentTurnId?: string | null,
 *   state: object,
 *   participants: Array<{ userId: string, username?: string | null, role: string }>,
 *   ttlMs?: number,
 * }} params
 */
export async function createPersistedSession({
  prisma = defaultPrisma,
  id = createGameSessionId(),
  guildId,
  channelId,
  gameType,
  status = 'pending',
  hostId,
  currentTurnId = null,
  state,
  participants,
  ttlMs = CHALLENGE_TTL_MS,
}) {
  const expiresAt = ttlMs > 0 ? new Date(Date.now() + ttlMs) : null;
  const session = await prisma.gameSession.create({
    data: {
      id,
      guildId,
      channelId,
      gameType,
      status,
      hostId,
      currentTurnId,
      stateJson: JSON.stringify(state),
      expiresAt,
      participants: {
        create: participants.map((p) => ({
          userId: p.userId,
          // Privacy-by-design: never persist Discord usernames in SQLite
          username: null,
          role: p.role,
        })),
      },
    },
    include: { participants: true },
  });

  return hydrateSession(session);
}

/**
 * Parses `stateJson` into `.state` on a Prisma `GameSession` record.
 * @param {any} row
 */
export function hydrateSession(row) {
  if (!row) return null;
  let state = null;
  try {
    state = JSON.parse(row.stateJson);
  } catch {
    state = null;
  }
  return { ...row, state };
}

/**
 * Fetches a session with participants from SQLite.
 * @param {string} sessionId
 * @param {import('@prisma/client').PrismaClient} [prisma]
 */
export async function getPersistedSession(sessionId, prisma = defaultPrisma) {
  const row = await prisma.gameSession.findUnique({
    where: { id: sessionId },
    include: { participants: true },
  });
  return hydrateSession(row);
}

/**
 * Marks timed-out pending/active Game Center sessions as `'expired'`.
 * @param {import('@prisma/client').PrismaClient} [prisma]
 * @param {string | null} [guildId]
 */
export async function expireStaleSessions(prisma = defaultPrisma, guildId = null) {
  if (!prisma?.gameSession?.updateMany) return { count: 0 };
  const now = new Date();
  return prisma.gameSession.updateMany({
    where: {
      ...(guildId ? { guildId } : {}),
      status: { in: ['pending', 'active'] },
      expiresAt: { lt: now },
    },
    data: { status: 'expired' },
  });
}

/**
 * Deletes terminal (`finished`, `cancelled`, `expired`) Game Center sessions whose retention
 * TTL has elapsed, and removes associated `GameParticipant` rows via cascade.
 *
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   retentionMs?: number,
 *   now?: number,
 * }} [options]
 * @returns {Promise<{ deletedCount: number }>}
 */
export async function purgeExpiredGameSessions({
  prisma = defaultPrisma,
  retentionMs = DEFAULT_FINISHED_SESSION_RETENTION_MS,
  now = Date.now(),
} = {}) {
  if (!prisma?.gameSession) return { deletedCount: 0 };
  await expireStaleSessions(prisma);
  if (typeof prisma.gameSession.deleteMany !== 'function') {
    return { deletedCount: 0 };
  }
  const cutoff = new Date(now - Math.max(0, retentionMs));
  const res = await prisma.gameSession.deleteMany({
    where: {
      status: { in: ['finished', 'cancelled', 'expired'] },
      updatedAt: { lt: cutoff },
    },
  });
  return { deletedCount: res?.count ?? 0 };
}

/**
 * Purges guild-scoped persisted data (`AutoRole` and `GameSession`) when the bot leaves a guild.
 *
 * @param {string | null | undefined} guildId
 * @param {import('@prisma/client').PrismaClient} [prisma]
 */
export async function purgeGuildPersistedData(guildId, prisma = defaultPrisma) {
  if (!guildId || !prisma) {
    return { deletedAutoRoles: 0, deletedSessions: 0 };
  }
  const [autoRolesRes, sessionsRes] = await Promise.all([
    prisma.autoRole?.deleteMany?.({ where: { guildId } }).catch(() => ({ count: 0 })) ??
      Promise.resolve({ count: 0 }),
    prisma.gameSession?.deleteMany?.({ where: { guildId } }).catch(() => ({ count: 0 })) ??
      Promise.resolve({ count: 0 }),
  ]);
  return {
    deletedAutoRoles: autoRolesRes?.count ?? 0,
    deletedSessions: sessionsRes?.count ?? 0,
  };
}

function isUnconsentedOpponentSession(session, userId) {
  if (!session || !userId || session.hostId === userId) {
    return false;
  }
  if (session.status === 'pending') {
    return true;
  }
  if (
    session.status === 'active' &&
    (session.gameType === 'ttt' || session.gameType === 'rps' || session.gameType === 'cf' || session.gameType === 'coinflip')
  ) {
    return session.state?.opponentConsented !== true;
  }
  return false;
}

/**
 * Cancels unconsented sessions targeting `userId` when `userId` starts their own game.
 * Prevents griefer lockout (`MW-SEC-014`).
 */
export async function releaseUnconsentedSessionsForUser(guildId, userId, prisma = defaultPrisma) {
  if (!guildId || !userId || !prisma?.gameSession?.findMany) return 0;
  const rows = await prisma.gameSession.findMany({
    where: {
      guildId,
      status: { in: ['pending', 'active'] },
      participants: { some: { userId } },
    },
    include: { participants: true },
  });
  let released = 0;
  for (const row of rows) {
    const hydrated = hydrateSession(row);
    if (isUnconsentedOpponentSession(hydrated, userId)) {
      await prisma.gameSession.update({
        where: { id: hydrated.id },
        data: { status: 'cancelled', expiresAt: null },
      });
      released += 1;
    }
  }
  return released;
}

/**
 * Checks if a user already has an active or pending Game Center session in the guild.
 * Automatically marks expired sessions as `'expired'` and does not allow unconsented
 * incoming invites/lobby-starts from other players to lock out the user.
 * @param {string} guildId
 * @param {string} userId
 * @param {import('@prisma/client').PrismaClient} [prisma]
 */
export async function findActiveUserSession(guildId, userId, prisma = defaultPrisma) {
  await expireStaleSessions(prisma, guildId);

  if (typeof prisma.gameSession.findMany === 'function') {
    const rows = await prisma.gameSession.findMany({
      where: {
        guildId,
        status: { in: ['pending', 'active'] },
        participants: { some: { userId } },
      },
      include: { participants: true },
    });

    for (const row of rows) {
      const hydrated = hydrateSession(row);
      if (hydrated && !isUnconsentedOpponentSession(hydrated, userId)) {
        return hydrated;
      }
    }
    return null;
  }

  const existing = await prisma.gameSession.findFirst({
    where: {
      guildId,
      status: { in: ['pending', 'active'] },
      participants: { some: { userId } },
    },
    include: { participants: true },
  });
  const hydrated = hydrateSession(existing);
  return hydrated && !isUnconsentedOpponentSession(hydrated, userId) ? hydrated : null;
}

/**
 * Finds the active (or pending) Quiz Battle session in a specific channel, automatically expiring stale ones.
 * @param {string} channelId
 * @param {import('@prisma/client').PrismaClient} [prisma]
 * @param {{ includePending?: boolean }} [options]
 */
export async function findActiveChannelQuizSession(
  channelId,
  prisma = defaultPrisma,
  { includePending = false } = {},
) {
  if (!channelId || !prisma?.gameSession) {
    return null;
  }

  const now = new Date();
  await prisma.gameSession.updateMany({
    where: {
      channelId,
      gameType: 'quiz',
      status: { in: ['pending', 'active'] },
      expiresAt: { lt: now },
    },
    data: { status: 'expired' },
  });

  const targetStatuses = includePending ? ['pending', 'active'] : ['active'];
  const active = await prisma.gameSession.findFirst({
    where: {
      channelId,
      gameType: 'quiz',
      status: { in: targetStatuses },
    },
    include: { participants: true },
  });
  return hydrateSession(active);
}

/**
 * Updates `GameSession` state, status, turn, winner, host, or expiration in SQLite.
 * @param {string} sessionId
 * @param {{
 *   status?: string,
 *   hostId?: string,
 *   messageId?: string,
 *   currentTurnId?: string | null,
 *   winnerId?: string | null,
 *   isDraw?: boolean,
 *   state?: object,
 *   ttlMs?: number | null,
 *   finishedAt?: Date | null,
 * }} patch
 * @param {import('@prisma/client').PrismaClient} [prisma]
 */
export async function updatePersistedSession(sessionId, patch, prisma = defaultPrisma) {
  const data = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.hostId !== undefined) data.hostId = patch.hostId;
  if (patch.messageId !== undefined) data.messageId = patch.messageId;
  if (patch.currentTurnId !== undefined) data.currentTurnId = patch.currentTurnId;
  if (patch.winnerId !== undefined) data.winnerId = patch.winnerId;
  if (patch.isDraw !== undefined) data.isDraw = patch.isDraw;
  if (patch.state !== undefined) data.stateJson = JSON.stringify(patch.state);
  if (patch.finishedAt !== undefined) data.finishedAt = patch.finishedAt;
  if (patch.ttlMs !== undefined) {
    data.expiresAt = patch.ttlMs === null ? null : new Date(Date.now() + patch.ttlMs);
  }

  const updated = await prisma.gameSession.update({
    where: { id: sessionId },
    data,
    include: { participants: true },
  });
  return hydrateSession(updated);
}

/**
 * Adds a participant row to an existing Quiz Battle session.
 * @param {string} sessionId
 * @param {{ userId: string, role?: string }} participant
 * @param {import('@prisma/client').PrismaClient} [prisma]
 */
export async function addSessionParticipant(
  sessionId,
  { userId, role = 'player' },
  prisma = defaultPrisma,
) {
  return prisma.gameParticipant.upsert({
    where: { sessionId_userId: { sessionId, userId } },
    update: { username: null },
    create: { sessionId, userId, username: null, role },
  });
}

/**
 * Removes a participant row from a pending Quiz Battle lobby.
 * @param {string} sessionId
 * @param {string} userId
 * @param {import('@prisma/client').PrismaClient} [prisma]
 */
export async function removeSessionParticipant(sessionId, userId, prisma = defaultPrisma) {
  return prisma.gameParticipant.deleteMany({
    where: { sessionId, userId },
  });
}
