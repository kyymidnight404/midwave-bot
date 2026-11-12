import {
  COLORS,
  GAME_METADATA,
  GAME_MODES,
  GAME_TYPES,
  MATCH_STATUS,
  TRIVIA_CONFIG,
} from './constants.js';
import {
  buildGameEmbed,
  buildInfoEmbed,
  buildLobbyEmbed,
  buildResultEmbed,
  formatPlayer,
  getLogoFiles,
} from './embeds.js';

/**
 * Edits an existing public Discord message by reference, falling back to sending a new message
 * in the channel if the original message was deleted or inaccessible.
 * @param {import('discord.js').Client | null | undefined} client
 * @param {{ channelId: string, messageId: string } | null | undefined} messageRef
 * @param {{ embeds: import('discord.js').EmbedBuilder[] }} payload
 * @param {string | null} [fallbackChannelId]
 * @returns {Promise<{ channelId: string, messageId: string } | null>}
 */
export async function updatePublicMessage(client, messageRef, payload, fallbackChannelId = null) {
  if (!client || !client.channels) return null;

  if (messageRef?.channelId && messageRef?.messageId) {
    try {
      const channel = await client.channels.fetch(messageRef.channelId);
      if (channel?.isTextBased?.()) {
        const msg = await channel.messages.fetch(messageRef.messageId);
        await msg.edit({ embeds: payload.embeds });
        return { channelId: msg.channelId, messageId: msg.id };
      }
    } catch (err) {
      // 10008 = Unknown Message (deleted); fall through to send a fresh board message.
      if (err?.code !== 10008 && err?.code !== 10003) {
        console.warn('[DiscordBoard] Failed to edit public message:', err?.message ?? err);
      }
    }
  }

  const targetChannelId = fallbackChannelId ?? messageRef?.channelId;
  if (!targetChannelId) return null;

  try {
    const channel = await client.channels.fetch(targetChannelId);
    if (channel?.isTextBased?.()) {
      const sent = await channel.send({
        embeds: payload.embeds,
        files: getLogoFiles(),
      });
      return { channelId: sent.channelId, messageId: sent.id };
    }
  } catch (err) {
    console.warn('[DiscordBoard] Failed to send fallback public message:', err?.message ?? err);
  }

  return null;
}

/**
 * Builds the Game Embed or Result Embed from a public view returned by a game engine.
 * @param {string} gameType
 * @param {object} publicView
 * @param {object | null} [result]
 * @param {number} [durationMs]
 * @returns {import('discord.js').EmbedBuilder}
 */
export function renderGameOrResultEmbed(gameType, publicView, result = null, durationMs = 0) {
  const meta = GAME_METADATA[gameType];
  const gameTitle = meta?.name ?? gameType;

  if (result) {
    return buildResultEmbed({
      gameTitle,
      mode: publicView.mode,
      players: publicView.players,
      winnerId: result.winnerId,
      loserId: result.loserId,
      isDraw: Boolean(result.isDraw),
      finalScore: result.finalScore ?? null,
      durationMs,
      resultDescription: result.description,
      boardOrDetails: publicView.boardOrInfo,
    });
  }

  return buildGameEmbed({
    gameTitle,
    gameDescription: publicView.description ?? meta?.description,
    mode: publicView.mode,
    players: publicView.players,
    status: publicView.status,
    currentTurn: publicView.currentTurn ?? null,
    boardOrInfo: publicView.boardOrInfo,
    instructions: publicView.instructions,
  });
}

/**
 * Creates a session idle-timeout handler that notifies the channel/board message.
 * @param {import('discord.js').Client} client
 */
export function createSessionTimeoutHandler(client) {
  return async (closedSession) => {
    const meta = GAME_METADATA[closedSession.gameType];
    const gameTitle = meta?.name ?? closedSession.gameType;
    const embed = buildInfoEmbed(
      `${gameTitle} — Timeout`,
      `Pertandingan antara ${closedSession.players.map(formatPlayer).join(' vs ')} berakhir otomatis karena tidak ada aktivitas.`,
      COLORS.WARNING,
    );

    await updatePublicMessage(
      client,
      closedSession.boardMessageRef,
      { embeds: [embed] },
      closedSession.channelId,
    );
  };
}

/**
 * Creates an invite expiration handler that updates the lobby embed.
 * @param {import('discord.js').Client} client
 */
export function createInviteExpireHandler(client) {
  return async (expiredInvite) => {
    const meta = GAME_METADATA[expiredInvite.gameType];
    const gameTitle = meta?.name ?? expiredInvite.gameType;
    const embed = buildLobbyEmbed({
      gameTitle,
      hostId: expiredInvite.hostId,
      opponentId: expiredInvite.opponentId,
      status: 'Kedaluwarsa',
      instructions: 'Undangan telah melewati batas waktu 60 detik. Buat tantangan baru jika masih ingin bermain.',
      color: COLORS.MUTED,
    });

    await updatePublicMessage(
      client,
      expiredInvite.lobbyMessageRef,
      { embeds: [embed] },
      expiredInvite.channelId,
    );
  };
}

/**
 * Schedules the 20-second round timer for an active Trivia session.
 * Clears previous round timers so only one round timer is active at a time.
 * @param {{
 *   client: import('discord.js').Client,
 *   sessionManager: import('../managers/SessionManager.js').SessionManager,
 *   gameManager: import('../managers/GameManager.js').GameManager,
 *   sessionId: string,
 *   expectedRoundIndex: number,
 *   durationMs?: number,
 * }} params
 */
export function scheduleTriviaRoundTimer({
  client,
  sessionManager,
  gameManager,
  sessionId,
  expectedRoundIndex,
  durationMs = TRIVIA_CONFIG.ROUND_DURATION_MS,
}) {
  sessionManager.clearExtraTimers(sessionId);

  const handle = setTimeout(async () => {
    const live = sessionManager.getSession(sessionId);
    if (!live || live.status !== MATCH_STATUS.ACTIVE) return;

    try {
      const outcome = await sessionManager.runExclusive(sessionId, async (session) => {
        if (session.state.currentRoundIndex !== expectedRoundIndex) {
          return null;
        }

        const engine = gameManager.getEngine(GAME_TYPES.TRIVIA);
        const step = engine.advanceRoundOnTimeout(session.state);
        const publicView = engine.getPublicView(step.state);

        if (step.finished) {
          const closed = sessionManager.endSession(sessionId, MATCH_STATUS.FINISHED);
          const elapsed = Math.max(0, (closed?.endedAt ?? Date.now()) - session.startedAt);
          return { finished: true, result: step.result, publicView, durationMs: elapsed, session: closed ?? session };
        }

        sessionManager.updateSession(sessionId, step.state, step.state.currentTurn ?? null);
        return { finished: false, state: step.state, publicView, session };
      });

      if (!outcome) return;

      const embed = renderGameOrResultEmbed(
        GAME_TYPES.TRIVIA,
        outcome.publicView,
        outcome.finished ? outcome.result : null,
        outcome.durationMs ?? 0,
      );

      const newRef = await updatePublicMessage(
        client,
        outcome.session.boardMessageRef,
        { embeds: [embed] },
        outcome.session.channelId,
      );

      if (!outcome.finished) {
        if (newRef) sessionManager.setBoardMessageRef(sessionId, newRef);
        scheduleTriviaRoundTimer({
          client,
          sessionManager,
          gameManager,
          sessionId,
          expectedRoundIndex: outcome.state.currentRoundIndex,
          durationMs,
        });
      }
    } catch (err) {
      // Session might already be closed between timer fire and exclusive lock
      if (!String(err?.message).includes('berakhir')) {
        console.error('[TriviaTimer] Error advancing round:', err);
      }
    }
  }, durationMs);

  sessionManager.registerTimer(sessionId, handle);
}

/**
 * Helper used by `/invite accept` and `/game cancel` to start/update board after challenge acceptance.
 */
export function startTriviaTimerIfNeeded({ client, sessionManager, gameManager, session }) {
  if (session?.gameType === GAME_TYPES.TRIVIA && session.mode === GAME_MODES.MULTIPLAYER) {
    scheduleTriviaRoundTimer({
      client,
      sessionManager,
      gameManager,
      sessionId: session.sessionId,
      expectedRoundIndex: session.state.currentRoundIndex,
    });
  }
}
