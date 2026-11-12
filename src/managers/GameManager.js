import { BOT_PLAYER_ID, GAME_MODES, MATCH_STATUS } from '../utils/constants.js';
import { defaultRng } from '../utils/random.js';

/**
 * Coordinates pure game engines with SessionManager and InviteManager.
 */
export class GameManager {
  /**
   * @param {{
   *   sessionManager: import('./SessionManager.js').SessionManager,
   *   inviteManager: import('./InviteManager.js').InviteManager,
   *   rng?: object,
   *   nowFn?: () => number,
   * }} options
   */
  constructor({ sessionManager, inviteManager, rng = defaultRng, nowFn = () => Date.now() }) {
    this.sessionManager = sessionManager;
    this.inviteManager = inviteManager;
    this.rng = rng;
    this.nowFn = nowFn;

    /** @type {Map<string, object>} */
    this.engines = new Map();
  }

  /**
   * Registers a pure game engine module for a game type.
   * @param {string} gameType
   * @param {object} engine
   */
  registerGame(gameType, engine) {
    if (
      !engine ||
      typeof engine.create !== 'function' ||
      typeof engine.applyAction !== 'function' ||
      typeof engine.getPublicView !== 'function' ||
      typeof engine.getPrivateView !== 'function'
    ) {
      throw new Error(`Invalid game engine contract for ${gameType}`);
    }
    this.engines.set(gameType, engine);
  }

  /**
   * @param {string} gameType
   * @returns {object}
   */
  getEngine(gameType) {
    const engine = this.engines.get(gameType);
    if (!engine) {
      throw new Error(`Game engine "${gameType}" belum terdaftar.`);
    }
    return engine;
  }

  /**
   * Runs a single-turn instant solo game without allocating a session (e.g. RPS/CoinFlip/Dice solo).
   * @param {{ gameType: string, playerId: string, config?: object, action: object }} params
   */
  playInstantSolo({ gameType, playerId, config = {}, action }) {
    const engine = this.getEngine(gameType);
    const initialState = engine.create(
      { ...config, mode: GAME_MODES.SOLO },
      [playerId, BOT_PLAYER_ID],
      this.rng,
    );
    const outcome = engine.applyAction(initialState, playerId, action, this.rng);
    if (outcome.error) {
      return { error: outcome.error };
    }
    return {
      state: outcome.state,
      finished: Boolean(outcome.finished),
      result: outcome.result ?? null,
      publicView: engine.getPublicView(outcome.state),
      privateView: engine.getPrivateView(outcome.state, playerId),
    };
  }

  /**
   * Starts a stateful solo session (e.g. Guess, Trivia, TicTacToe, ConnectFour).
   */
  startSoloSession({ gameType, channelId, playerId, config = {}, onTimeout = null }) {
    const engine = this.getEngine(gameType);
    if (this.sessionManager.hasActiveSession(playerId)) {
      throw new Error('Kamu masih memiliki pertandingan aktif. Selesaikan atau batalkan dengan `/game cancel`.');
    }
    if (this.inviteManager.getOutgoingInvite(playerId)) {
      throw new Error('Kamu masih memiliki undangan multiplayer pending. Batalkan dulu dengan `/game cancel`.');
    }

    const players = [playerId, BOT_PLAYER_ID];
    const state = engine.create({ ...config, mode: GAME_MODES.SOLO }, players, this.rng);
    const session = this.sessionManager.createSession({
      gameType,
      mode: GAME_MODES.SOLO,
      channelId,
      players,
      currentTurn: state.currentTurn ?? playerId,
      state,
      onTimeout,
    });

    return {
      session,
      publicView: engine.getPublicView(state),
      privateView: engine.getPrivateView(state, playerId),
    };
  }

  /**
   * Creates a multiplayer challenge invitation.
   */
  createChallenge({ gameType, channelId, hostId, opponentId, config = {}, onExpire = null }) {
    this.getEngine(gameType);
    return this.inviteManager.createInvite({
      gameType,
      channelId,
      hostId,
      opponentId,
      config,
      onExpire,
    });
  }

  /**
   * Accepts a pending multiplayer challenge and creates the active game session.
   * For instant multiplayer games (like Dice challenge), the engine may finish immediately on start.
   */
  acceptChallenge(opponentId, { onTimeout = null } = {}) {
    const invite = this.inviteManager.acceptInvite(opponentId);
    const engine = this.getEngine(invite.gameType);
    const players = [invite.hostId, invite.opponentId];
    const state = engine.create(
      { ...invite.config, mode: GAME_MODES.MULTIPLAYER },
      players,
      this.rng,
    );

    // If the game resolves immediately upon acceptance (e.g. Dice Rolling multiplayer)
    if (state.status === MATCH_STATUS.FINISHED && state.result) {
      return {
        invite,
        session: null,
        immediateFinished: true,
        result: state.result,
        publicView: engine.getPublicView(state),
      };
    }

    const session = this.sessionManager.createSession({
      gameType: invite.gameType,
      mode: GAME_MODES.MULTIPLAYER,
      channelId: invite.channelId,
      players,
      currentTurn: state.currentTurn ?? null,
      state,
      onTimeout,
    });

    return {
      invite,
      session,
      immediateFinished: false,
      publicView: engine.getPublicView(state),
    };
  }

  /**
   * Declines a pending invite for `opponentId`.
   */
  declineChallenge(opponentId) {
    return this.inviteManager.declineInvite(opponentId);
  }

  /**
   * Applies a player action inside the session's exclusive lock.
   * Automatically ends and cleans up the session when the game finishes.
   */
  async submitAction(playerId, expectedGameType, action) {
    const session = this.sessionManager.getPlayerSession(playerId);
    if (!session) {
      return { error: 'Kamu tidak sedang berada di dalam pertandingan aktif.' };
    }
    if (expectedGameType && session.gameType !== expectedGameType) {
      return {
        error: `Kamu sedang memainkan **${session.gameType}**, bukan **${expectedGameType}**. Gunakan \`/game cancel\` jika ingin membatalkan.`,
      };
    }

    const engine = this.getEngine(session.gameType);

    return this.sessionManager.runExclusive(session.sessionId, async (liveSession) => {
      if (!liveSession.players.includes(playerId)) {
        return { error: 'Kamu bukan peserta dalam pertandingan ini.' };
      }

      const outcome = engine.applyAction(liveSession.state, playerId, action, this.rng);
      if (outcome.error) {
        return { error: outcome.error, session: liveSession };
      }

      const publicView = engine.getPublicView(outcome.state);
      const privateView = engine.getPrivateView(outcome.state, playerId);

      if (outcome.finished) {
        const closedSession = this.sessionManager.endSession(
          liveSession.sessionId,
          MATCH_STATUS.FINISHED,
        );
        const durationMs = Math.max(0, (closedSession?.endedAt ?? this.nowFn()) - liveSession.startedAt);
        return {
          finished: true,
          state: outcome.state,
          result: outcome.result,
          durationMs,
          publicView,
          privateView,
          session: closedSession ?? liveSession,
        };
      }

      this.sessionManager.updateSession(
        liveSession.sessionId,
        outcome.state,
        outcome.state.currentTurn ?? null,
      );

      return {
        finished: false,
        state: outcome.state,
        roundAdvanced: Boolean(outcome.roundAdvanced),
        publicView,
        privateView,
        session: liveSession,
      };
    });
  }

  /**
   * Cancels an active game (any participant) or outgoing pending invite (host only).
   * @param {string} userId
   */
  cancelByUser(userId) {
    const session = this.sessionManager.getPlayerSession(userId);
    if (session) {
      const closed = this.sessionManager.endSession(session.sessionId, MATCH_STATUS.CANCELLED);
      return { type: 'session', session: closed };
    }

    const outgoingInvite = this.inviteManager.cancelOutgoingInvite(userId);
    if (outgoingInvite) {
      return { type: 'invite', invite: outgoingInvite };
    }

    const incomingInvite = this.inviteManager.getIncomingInvite(userId);
    if (incomingInvite) {
      throw new Error('Hanya host yang dapat membatalkan undangan, atau gunakan `/invite decline` untuk menolak.');
    }

    throw new Error('Kamu tidak memiliki pertandingan aktif atau undangan yang bisa dibatalkan.');
  }

  /**
   * Gets current active session or pending invite for a user.
   * @param {string} userId
   */
  getStatus(userId) {
    const session = this.sessionManager.getPlayerSession(userId);
    if (session) {
      return { type: 'session', session };
    }

    const invite = this.inviteManager.getInviteForUser(userId);
    if (invite) {
      return { type: 'invite', invite };
    }

    return { type: 'none' };
  }
}
