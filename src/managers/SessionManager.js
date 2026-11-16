import { randomUUID } from 'node:crypto';
import { BOT_PLAYER_ID, MATCH_STATUS, TIMEOUTS } from '../utils/constants.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

/**
 * Manages active in-memory game sessions, TTL idle timeouts,
 * per-session concurrency locks, and deterministic cleanup.
 */
export class SessionManager {
  /**
   * @param {{
   *   maxSessions?: number,
   *   defaultIdleTimeoutMs?: number,
   *   nowFn?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.maxSessions = options.maxSessions ?? TIMEOUTS.MAX_ACTIVE_SESSIONS;
    this.defaultIdleTimeoutMs = options.defaultIdleTimeoutMs ?? TIMEOUTS.SESSION_IDLE_MS;
    this.nowFn = options.nowFn ?? (() => Date.now());

    /** @type {Map<string, object>} */
    this.activeGames = new Map();
    /** @type {Map<string, string>} */
    this.playerSessions = new Map();
  }

  /**
   * @param {string} userId
   * @returns {boolean}
   */
  hasActiveSession(userId) {
    return this.playerSessions.has(userId);
  }

  /**
   * @param {string} sessionId
   * @returns {object | undefined}
   */
  getSession(sessionId) {
    return this.activeGames.get(sessionId);
  }

  /**
   * @param {string} userId
   * @returns {object | undefined}
   */
  getPlayerSession(userId) {
    const sessionId = this.playerSessions.get(userId);
    if (!sessionId) return undefined;
    const session = this.activeGames.get(sessionId);
    if (!session) {
      this.playerSessions.delete(userId);
      return undefined;
    }
    return session;
  }

  /**
   * Creates and indexes a new active game session.
   * @param {{
   *   gameType: string,
   *   mode: string,
   *   channelId: string,
   *   players: string[],
   *   currentTurn?: string | null,
   *   state: object,
   *   idleTimeoutMs?: number,
   *   onTimeout?: (session: object) => Promise<void> | void,
   * }} params
   * @returns {object}
   */
  createSession({
    gameType,
    mode,
    channelId,
    players,
    currentTurn = null,
    state,
    idleTimeoutMs = this.defaultIdleTimeoutMs,
    onTimeout = null,
  }) {
    if (this.activeGames.size >= this.maxSessions) {
      throw new Error('Server bot sedang penuh (batas sesi aktif tercapai). Coba beberapa saat lagi.');
    }

    const humanPlayers = players.filter((id) => id !== BOT_PLAYER_ID);
    for (const playerId of humanPlayers) {
      if (this.playerSessions.has(playerId)) {
        throw new Error('Salah satu pemain sudah berada di dalam pertandingan aktif.');
      }
    }

    const now = this.nowFn();
    const sessionId = randomUUID().slice(0, 8);
    const session = {
      sessionId,
      gameType,
      mode,
      channelId,
      players: [...players],
      humanPlayers,
      currentTurn,
      state,
      status: MATCH_STATUS.ACTIVE,
      startedAt: now,
      lastActivityAt: now,
      expiresAt: now + idleTimeoutMs,
      idleTimeoutMs,
      onTimeout,
      idleTimer: null,
      extraTimers: new Set(),
      disposers: [],
      boardMessageRef: null,
      queue: Promise.resolve(),
    };

    this.activeGames.set(sessionId, session);
    for (const playerId of humanPlayers) {
      this.playerSessions.set(playerId, sessionId);
    }

    this._scheduleIdleTimer(session);
    return session;
  }

  /**
   * Executes an async callback serially per session to prevent race conditions.
   * @template T
   * @param {string} sessionId
   * @param {(session: object) => Promise<T> | T} task
   * @returns {Promise<T>}
   */
  runExclusive(sessionId, task) {
    const session = this.activeGames.get(sessionId);
    if (!session) {
      return Promise.reject(new Error('Pertandingan tidak ditemukan atau sudah berakhir.'));
    }

    const next = session.queue.then(async () => {
      const liveSession = this.activeGames.get(sessionId);
      if (!liveSession || liveSession.status !== MATCH_STATUS.ACTIVE) {
        throw new Error('Pertandingan sudah berakhir.');
      }
      return task(liveSession);
    });

    // Keep queue chain alive even if a task throws so subsequent calls aren't poisoned.
    session.queue = next.catch(() => {});
    return next;
  }

  /**
   * Updates session state and refreshes the idle TTL timer.
   * @param {string} sessionId
   * @param {object} newState
   * @param {string | null} [currentTurn]
   * @returns {object | null}
   */
  updateSession(sessionId, newState, currentTurn = undefined) {
    const session = this.activeGames.get(sessionId);
    if (!session || session.status !== MATCH_STATUS.ACTIVE) return null;

    session.state = newState;
    if (currentTurn !== undefined) {
      session.currentTurn = currentTurn;
    }
    this.touchSession(sessionId);
    return session;
  }

  /**
   * Refreshes the idle TTL timer for an active session.
   * @param {string} sessionId
   */
  touchSession(sessionId) {
    const session = this.activeGames.get(sessionId);
    if (!session || session.status !== MATCH_STATUS.ACTIVE) return;

    const now = this.nowFn();
    session.lastActivityAt = now;
    session.expiresAt = now + session.idleTimeoutMs;
    this._scheduleIdleTimer(session);
  }

  /**
   * Tracks a game-specific timer (e.g. Trivia round timer) so endSession clears it.
   * @param {string} sessionId
   * @param {ReturnType<typeof setTimeout>} timerHandle
   */
  registerTimer(sessionId, timerHandle) {
    const session = this.activeGames.get(sessionId);
    if (!session) {
      clearTimeout(timerHandle);
      return;
    }
    timerHandle?.unref?.();
    session.extraTimers.add(timerHandle);
  }

  /**
   * Clears and removes all extra game timers for a session.
   * @param {string} sessionId
   */
  clearExtraTimers(sessionId) {
    const session = this.activeGames.get(sessionId);
    if (!session) return;
    for (const handle of session.extraTimers) {
      clearTimeout(handle);
    }
    session.extraTimers.clear();
  }

  /**
   * Registers a cleanup callback/listener disposer for this session.
   * @param {string} sessionId
   * @param {() => void} disposer
   */
  addDisposer(sessionId, disposer) {
    const session = this.activeGames.get(sessionId);
    if (!session || typeof disposer !== 'function') return;
    session.disposers.push(disposer);
  }

  /**
   * Associates a public board message reference with this session.
   * @param {string} sessionId
   * @param {{ channelId: string, messageId: string }} ref
   */
  setBoardMessageRef(sessionId, ref) {
    const session = this.activeGames.get(sessionId);
    if (!session) return;
    session.boardMessageRef = ref;
  }

  /**
   * Idempotent single cleanup path for finished, cancelled, and timed-out sessions.
   * Clears idle timer, extra timers, disposers, and all Map references.
   * @param {string} sessionId
   * @param {'finished' | 'cancelled' | 'timeout'} [reason='finished']
   * @returns {object | null}
   */
  endSession(sessionId, reason = MATCH_STATUS.FINISHED) {
    const session = this.activeGames.get(sessionId);
    if (!session) return null;

    this.activeGames.delete(sessionId);
    for (const playerId of session.humanPlayers) {
      if (this.playerSessions.get(playerId) === sessionId) {
        this.playerSessions.delete(playerId);
      }
    }

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    for (const handle of session.extraTimers) {
      clearTimeout(handle);
    }
    session.extraTimers.clear();

    const disposers = session.disposers.splice(0);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (err) {
        console.error(`[SessionManager] Disposer error on session ${sessionId}:`, sanitizeError(err));
      }
    }

    session.status = reason;
    session.endedAt = this.nowFn();
    return session;
  }

  /**
   * Terminates all active sessions (used during shutdown or test teardown).
   */
  clearAll() {
    for (const sessionId of Array.from(this.activeGames.keys())) {
      this.endSession(sessionId, MATCH_STATUS.CANCELLED);
    }
    this.activeGames.clear();
    this.playerSessions.clear();
  }

  /**
   * @returns {{ activeGamesCount: number, playerSessionsCount: number }}
   */
  getStats() {
    return {
      activeGamesCount: this.activeGames.size,
      playerSessionsCount: this.playerSessions.size,
    };
  }

  /**
   * @private
   */
  _scheduleIdleTimer(session) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.idleTimeoutMs <= 0) return;

    session.idleTimer = setTimeout(() => {
      const closed = this.endSession(session.sessionId, MATCH_STATUS.TIMEOUT);
      if (closed && typeof closed.onTimeout === 'function') {
        Promise.resolve(closed.onTimeout(closed)).catch((err) => {
          console.error(`[SessionManager] Timeout callback error for ${closed.sessionId}:`, sanitizeError(err));
        });
      }
    }, session.idleTimeoutMs);

    session.idleTimer?.unref?.();
  }
}
