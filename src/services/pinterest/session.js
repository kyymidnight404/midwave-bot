import crypto from 'node:crypto';
import { sanitizeError } from '../../utils/errorSanitizer.js';

export const PIN_SESSION_TTL_MS = 5 * 60 * 1000;
export const PIN_MAX_ACTIVE_SESSIONS = 500;

/**
 * Manages per-user Pinterest search pagination sessions with a 5-minute expiration TTL.
 */
export class PinterestSessionStore {
  /**
   * @param {{
   *   ttlMs?: number,
   *   maxSessions?: number,
   *   nowFn?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? PIN_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? PIN_MAX_ACTIVE_SESSIONS;
    this.nowFn = options.nowFn ?? (() => Date.now());

    /** @type {Map<string, object>} */
    this.sessionsById = new Map();
    /** @type {Map<string, string>} */
    this.sessionsByUser = new Map();
  }

  /**
   * Removes expired sessions from memory.
   *
   * @param {number} [now]
   * @returns {number}
   */
  pruneExpired(now = this.nowFn()) {
    let removed = 0;
    for (const [sessionId, session] of this.sessionsById.entries()) {
      if (now >= session.expiresAt) {
        this.deleteSession(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Creates a new per-user Pinterest search session, replacing any older session for that user.
   *
   * @param {{
   *   userId: string,
   *   query: string,
   *   results: Array<object>,
   *   messageRef?: { edit?: Function } | null,
   *   onExpire?: (session: object) => Promise<void> | void,
   * }} params
   */
  createSession({ userId, query, results, messageRef = null, onExpire = null }) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('Pinterest session requires a valid userId.');
    }
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error('Pinterest session requires at least one result.');
    }

    const previousId = this.sessionsByUser.get(userId);
    if (previousId) {
      this.deleteSession(previousId);
    }

    const now = this.nowFn();
    this.pruneExpired(now);

    while (this.sessionsById.size >= this.maxSessions) {
      const oldestKey = this.sessionsById.keys().next().value;
      if (oldestKey === undefined) break;
      this.deleteSession(oldestKey);
    }

    const sessionId = crypto.randomBytes(6).toString('hex');
    const session = {
      sessionId,
      userId,
      query,
      results: [...results],
      currentIndex: 0,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      messageRef,
      onExpire,
      timer: null,
    };

    this.sessionsById.set(sessionId, session);
    this.sessionsByUser.set(userId, sessionId);

    if (this.ttlMs > 0) {
      const timer = setTimeout(() => {
        const expired = this.deleteSession(sessionId);
        if (expired && typeof expired.onExpire === 'function') {
          Promise.resolve(expired.onExpire(expired)).catch((err) => {
            console.error(
              `[PinterestSession] Expiration callback failed for ${sessionId}:`,
              sanitizeError(err),
            );
          });
        }
      }, this.ttlMs);
      timer.unref?.();
      session.timer = timer;
    }

    return session;
  }

  /**
   * Returns an active session by ID, or `null` if missing or expired.
   *
   * @param {string} sessionId
   * @returns {object | null}
   */
  getSession(sessionId) {
    if (!sessionId) return null;
    const session = this.sessionsById.get(sessionId);
    if (!session) return null;

    if (this.nowFn() >= session.expiresAt) {
      this.deleteSession(sessionId);
      return null;
    }

    return session;
  }

  /**
   * Returns the active session owned by `userId`, or `null` if none/expired.
   *
   * @param {string} userId
   * @returns {object | null}
   */
  getUserSession(userId) {
    const sessionId = this.sessionsByUser.get(userId);
    if (!sessionId) return null;
    return this.getSession(sessionId);
  }

  /**
   * Associates a sent Discord message object/reference with an active session for timeout cleanup.
   *
   * @param {string} sessionId
   * @param {object} messageRef
   */
  setMessageRef(sessionId, messageRef) {
    const session = this.getSession(sessionId);
    if (!session) return;
    session.messageRef = messageRef;
  }

  /**
   * Validates ownership & expiration and moves the session's active index (`prev` or `next`).
   *
   * @param {{
   *   sessionId: string,
   *   userId: string,
   *   direction: 'prev' | 'next',
   * }} params
   * @returns {{
   *   ok: boolean,
   *   reason?: 'NOT_FOUND' | 'EXPIRED' | 'UNAUTHORIZED' | 'INVALID_ACTION',
   *   session?: object,
   *   ownerId?: string,
   * }}
   */
  paginate({ sessionId, userId, direction }) {
    if (!sessionId) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return { ok: false, reason: 'NOT_FOUND' };
    }

    if (this.nowFn() >= session.expiresAt) {
      this.deleteSession(sessionId);
      return { ok: false, reason: 'EXPIRED', ownerId: session.userId, session };
    }

    if (session.userId !== userId) {
      return { ok: false, reason: 'UNAUTHORIZED', ownerId: session.userId };
    }

    if (direction === 'prev') {
      session.currentIndex = Math.max(0, session.currentIndex - 1);
      return { ok: true, session };
    }

    if (direction === 'next') {
      session.currentIndex = Math.min(session.results.length - 1, session.currentIndex + 1);
      return { ok: true, session };
    }

    return { ok: false, reason: 'INVALID_ACTION' };
  }

  /**
   * Deletes a session and clears its expiration timer idempotently.
   *
   * @param {string} sessionId
   * @returns {object | null}
   */
  deleteSession(sessionId) {
    const session = this.sessionsById.get(sessionId);
    if (!session) return null;

    this.sessionsById.delete(sessionId);
    if (this.sessionsByUser.get(session.userId) === sessionId) {
      this.sessionsByUser.delete(session.userId);
    }

    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }

    return session;
  }

  /**
   * Clears all active sessions and timers (used on shutdown and test teardown).
   */
  clearAll() {
    for (const sessionId of Array.from(this.sessionsById.keys())) {
      this.deleteSession(sessionId);
    }
    this.sessionsById.clear();
    this.sessionsByUser.clear();
  }

  /**
   * @returns {{ activeSessionsCount: number, activeUsersCount: number }}
   */
  getStats() {
    return {
      activeSessionsCount: this.sessionsById.size,
      activeUsersCount: this.sessionsByUser.size,
    };
  }
}

export const defaultPinterestSessionStore = new PinterestSessionStore();
