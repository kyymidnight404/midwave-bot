import { COLORS } from '../config/colors.js';
import { sanitizeError } from './errorSanitizer.js';
import { GAME_METADATA, GAME_TYPES } from './constants.js';
import {
  buildGameEmbed,
  buildInfoEmbed,
  buildLobbyEmbed,
  buildResultEmbed,
  createBaseEmbed,
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
        await msg.edit({
          embeds: payload.embeds,
          ...(payload.components !== undefined ? { components: payload.components } : {}),
        });
        return { channelId: msg.channelId, messageId: msg.id };
      }
    } catch (err) {
      // 10008 = Unknown Message (deleted); fall through to send a fresh board message.
      if (err?.code !== 10008 && err?.code !== 10003) {
        console.warn('[DiscordBoard] Failed to edit public message:', sanitizeError(err));
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
        ...(payload.components !== undefined ? { components: payload.components } : {}),
        files: getLogoFiles(),
      });
      return { channelId: sent.channelId, messageId: sent.id };
    }
  } catch (err) {
    console.warn('[DiscordBoard] Failed to send fallback public message:', sanitizeError(err));
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
      { embeds: [embed], components: [] },
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
    const embed =
      expiredInvite.gameType === GAME_TYPES.COINFLIP
        ? createBaseEmbed({
            title: '🪙 Coin Flip',
            description: '⏱️ **Kedaluwarsa** — Tantangan berakhir tanpa jawaban.',
            color: COLORS.WARNING,
          })
        : buildLobbyEmbed({
            gameTitle,
            hostId: expiredInvite.hostId,
            opponentId: expiredInvite.opponentId,
            status: 'Kedaluwarsa',
            instructions: 'Undangan telah melewati batas waktu 60 detik. Buat tantangan baru jika masih ingin bermain.',
            color: COLORS.WARNING,
          });

    await updatePublicMessage(
      client,
      expiredInvite.lobbyMessageRef,
      { embeds: [embed], components: [] },
      expiredInvite.channelId,
    );
  };
}
