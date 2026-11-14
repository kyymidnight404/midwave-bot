import fs from 'node:fs';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { buildDynamicHelpEmbed, discoverHelpEntries } from '../services/helpService.js';
import {
  BOT_PLAYER_ID,
  COLORS,
  EMBED_FOOTER,
  GAME_METADATA,
  GAME_MODES,
  LOGO_ATTACHMENT_URL,
  LOGO_FILENAME,
  LOGO_PATH,
} from './constants.js';

let logoAvailableCache = null;

/**
 * Checks once whether the local logo asset exists on disk.
 * @returns {boolean}
 */
export function hasLogoAsset() {
  if (logoAvailableCache === null) {
    logoAvailableCache = fs.existsSync(LOGO_PATH);
  }
  return logoAvailableCache;
}

/**
 * Creates a fresh AttachmentBuilder for the Midwave logo if present.
 * @returns {AttachmentBuilder[]}
 */
export function getLogoFiles() {
  if (!hasLogoAsset()) return [];
  return [new AttachmentBuilder(LOGO_PATH, { name: LOGO_FILENAME })];
}

/**
 * Formats a Discord user mention or bot label.
 * @param {string} playerId
 * @returns {string}
 */
export function formatPlayer(playerId) {
  if (playerId === BOT_PLAYER_ID) return 'Midwave Bot';
  return `<@${playerId}>`;
}

/**
 * Formats duration in milliseconds as human-readable seconds/minutes.
 * @param {number} durationMs
 * @returns {string}
 */
export function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} detik`;
  return `${minutes}m ${seconds}d`;
}

/**
 * Creates a base Midnight Ocean embed with consistent footer and optional logo thumbnail.
 * @param {{ title?: string, description?: string, color?: number, includeThumbnail?: boolean }} [options]
 * @returns {EmbedBuilder}
 */
export function createBaseEmbed({
  title,
  description,
  color = COLORS.PRIMARY,
  includeThumbnail = true,
} = {}) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: EMBED_FOOTER });

  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (includeThumbnail && hasLogoAsset()) {
    embed.setThumbnail(LOGO_ATTACHMENT_URL);
  }

  return embed;
}

/**
 * Builds an ephemeral error embed.
 * @param {string} message
 * @param {string} [title='Terjadi Kesalahan']
 * @returns {EmbedBuilder}
 */
export function buildErrorEmbed(message, title = 'Tidak Dapat Diproses') {
  return createBaseEmbed({
    title,
    description: message,
    color: COLORS.DANGER,
    includeThumbnail: false,
  });
}

/**
 * Builds an informational embed.
 * @param {string} title
 * @param {string} description
 * @param {number} [color]
 * @returns {EmbedBuilder}
 */
export function buildInfoEmbed(title, description, color = COLORS.SECONDARY) {
  return createBaseEmbed({ title, description, color });
}

/**
 * Builds a Lobby / Invitation embed per PRD §6.3.
 * @param {{
 *   gameTitle: string,
 *   gameDescription?: string,
 *   hostId: string,
 *   opponentId: string,
 *   status: string,
 *   details?: string,
 *   instructions?: string,
 *   color?: number,
 * }} data
 * @returns {EmbedBuilder}
 */
export function buildLobbyEmbed({
  gameTitle,
  gameDescription,
  hostId,
  opponentId,
  status,
  details,
  instructions = 'Gunakan `/invite accept` untuk menerima atau `/invite decline` untuk menolak.',
  color = COLORS.SECONDARY,
}) {
  const embed = createBaseEmbed({
    title: `Undangan ${gameTitle}`,
    description: gameDescription,
    color,
  });

  embed.addFields(
    { name: 'Host', value: formatPlayer(hostId), inline: true },
    { name: 'Lawan', value: formatPlayer(opponentId), inline: true },
    { name: 'Status Undangan', value: status, inline: true },
  );

  if (details) {
    embed.addFields({ name: 'Pengaturan', value: details, inline: false });
  }

  embed.addFields({ name: 'Instruksi', value: instructions, inline: false });
  return embed;
}

/**
 * Builds an active Game Embed per PRD §6.3.
 * Note: Callers pass sanitized public views; secret choices must never appear here.
 * @param {{
 *   gameTitle: string,
 *   gameDescription?: string,
 *   mode: string,
 *   players: string[],
 *   status: string,
 *   currentTurn?: string | null,
 *   boardOrInfo: string,
 *   instructions?: string,
 *   finalResult?: string,
 *   color?: number,
 * }} data
 * @returns {EmbedBuilder}
 */
export function buildGameEmbed({
  gameTitle,
  gameDescription,
  mode,
  players,
  status,
  currentTurn = null,
  boardOrInfo,
  instructions,
  finalResult,
  color = COLORS.ACCENT,
}) {
  const modeLabel = mode === GAME_MODES.SOLO ? 'Solo' : 'Multiplayer';
  const playerText = players.map(formatPlayer).join(' vs ');

  const embed = createBaseEmbed({
    title: gameTitle,
    description: gameDescription,
    color,
  });

  embed.addFields(
    { name: 'Mode', value: modeLabel, inline: true },
    { name: 'Pemain', value: playerText, inline: true },
    { name: 'Status', value: status, inline: true },
  );

  if (currentTurn) {
    embed.addFields({ name: 'Giliran Saat Ini', value: formatPlayer(currentTurn), inline: false });
  }

  embed.addFields({ name: 'Papan / Informasi', value: boardOrInfo || '-', inline: false });

  if (instructions) {
    embed.addFields({ name: 'Instruksi', value: instructions, inline: false });
  }

  if (finalResult) {
    embed.addFields({ name: 'Hasil Akhir', value: finalResult, inline: false });
  }

  return embed;
}

/**
 * Builds a Result Embed per PRD §6.3.
 * @param {{
 *   gameTitle: string,
 *   mode: string,
 *   players: string[],
 *   winnerId?: string | null,
 *   loserId?: string | null,
 *   isDraw?: boolean,
 *   finalScore?: string | null,
 *   durationMs?: number,
 *   resultDescription: string,
 *   boardOrDetails?: string | null,
 *   color?: number,
 * }} data
 * @returns {EmbedBuilder}
 */
export function buildResultEmbed({
  gameTitle,
  mode,
  players,
  winnerId = null,
  loserId = null,
  isDraw = false,
  finalScore = null,
  durationMs = 0,
  resultDescription,
  boardOrDetails = null,
  color,
}) {
  const resolvedColor = color ?? (isDraw ? COLORS.WARNING : COLORS.SUCCESS);
  const modeLabel = mode === GAME_MODES.SOLO ? 'Solo' : 'Multiplayer';

  const embed = createBaseEmbed({
    title: `${gameTitle} — Hasil Akhir`,
    description: resultDescription,
    color: resolvedColor,
  });

  embed.addFields(
    { name: 'Mode', value: modeLabel, inline: true },
    { name: 'Durasi', value: formatDuration(durationMs), inline: true },
  );

  if (isDraw) {
    embed.addFields({
      name: 'Hasil',
      value: `Seri (${players.map(formatPlayer).join(' vs ')})`,
      inline: true,
    });
  } else {
    if (winnerId) {
      embed.addFields({ name: 'Pemenang', value: formatPlayer(winnerId), inline: true });
    }
    if (loserId) {
      embed.addFields({ name: 'Kalah', value: formatPlayer(loserId), inline: true });
    }
  }

  if (finalScore) {
    embed.addFields({ name: 'Skor Akhir', value: finalScore, inline: false });
  }

  if (boardOrDetails) {
    embed.addFields({ name: 'Detail Pertandingan', value: boardOrDetails, inline: false });
  }

  return embed;
}

/**
 * Builds `/game action:status` embed for an active session.
 * @param {{
 *   sessionId: string,
 *   gameType: string,
 *   mode: string,
 *   players: string[],
 *   currentTurn: string | null,
 *   status: string,
 *   startedAt: number,
 *   expiresAt: number,
 * }} session
 * @param {number} [now=Date.now()]
 * @returns {EmbedBuilder}
 */
export function buildStatusEmbed(session, now = Date.now()) {
  const meta = GAME_METADATA[session.gameType];
  const remainingSec = Math.max(0, Math.ceil((session.expiresAt - now) / 1000));

  const embed = createBaseEmbed({
    title: 'Status Pertandingan Aktif',
    color: COLORS.ACCENT,
  });

  embed.addFields(
    { name: 'Game', value: meta ? meta.name : session.gameType, inline: true },
    { name: 'Mode', value: session.mode === GAME_MODES.SOLO ? 'Solo' : 'Multiplayer', inline: true },
    { name: 'Status', value: session.status, inline: true },
    { name: 'Pemain', value: session.players.map(formatPlayer).join(' vs '), inline: false },
    {
      name: 'Giliran',
      value: session.currentTurn ? formatPlayer(session.currentTurn) : 'Bebas / Simultan',
      inline: true,
    },
    { name: 'Sisa Waktu Idle', value: `${remainingSec} detik`, inline: true },
    { name: 'Session ID', value: `\`${session.sessionId}\``, inline: false },
  );

  return embed;
}

/**
 * Builds the `/games` catalog embed.
 * @returns {EmbedBuilder}
 */
export function buildGamesListEmbed() {
  const embed = createBaseEmbed({
    title: 'Daftar Permainan Midwave',
    description:
      'Semua game mendukung mode **Solo** dan **Multiplayer (2 pemain)** melalui `/game`.\nUntuk fitur media, AI, & interaksi sosial seperti `/media` atau `/social`, lihat `/help`.',
    color: COLORS.SECONDARY,
  });

  for (const game of Object.values(GAME_METADATA)) {
    embed.addFields({
      name: game.name,
      value: `${game.description}\n• Solo: ${game.soloCommands}\n• Multiplayer: ${game.multiplayerCommands}`,
      inline: false,
    });
  }

  return embed;
}

/**
 * Builds the `/help` guide embed dynamically from registered commands.
 * @param {string} [prefix]
 * @returns {EmbedBuilder}
 */
export function buildHelpEmbed(prefix = '!') {
  const safePrefix = typeof prefix === 'string' && prefix.trim() ? prefix.trim() : '!';
  const entries = discoverHelpEntries({ prefix: safePrefix });
  return buildDynamicHelpEmbed({ entries, prefix: safePrefix });
}

const PLATFORM_BADGES = Object.freeze({
  Instagram: '📸 Instagram',
  TikTok: '🎵 TikTok',
});

/**
 * Builds the processing status embed shown while media is being extracted and uploaded.
 *
 * @param {{ platformLabel: string }} params
 * @returns {EmbedBuilder}
 */
export function buildDownloadProcessingEmbed({ platformLabel }) {
  const badge = PLATFORM_BADGES[platformLabel] || platformLabel;
  return createBaseEmbed({
    title: 'MIDWAVE MEDIA DOWNLOADER',
    description: `${badge}\n\n⏳ **Memproses unduhan...**\nMengekstrak dan memvalidasi file media sebelum diunggah ke Discord.`,
    color: COLORS.SECONDARY,
    includeThumbnail: false,
  });
}

/**
 * Builds the dark Midwave-styled completion embed for `/media action:download`.
 *
 * @param {{
 *   platformLabel: string,
 *   mediaType: string,
 *   fileFormat: string,
 *   formattedSize: string,
 *   requesterId: string,
 *   truncatedCount?: number,
 * }} params
 * @returns {EmbedBuilder}
 */
export function buildDownloadSuccessEmbed({
  platformLabel,
  mediaType,
  fileFormat,
  formattedSize,
  requesterId,
  truncatedCount = 0,
}) {
  const badge = PLATFORM_BADGES[platformLabel] || platformLabel;
  const lines = [
    badge,
    '',
    '**Download Completed**',
    `• **Platform:** ${platformLabel}`,
    `• **Media Type:** ${mediaType}`,
    `• **File Format:** ${fileFormat}`,
    `• **File Size:** ${formattedSize}`,
  ];

  if (truncatedCount > 0) {
    lines.push(
      '',
      `⚠️ *${truncatedCount} item carousel lainnya tidak disertakan karena batas maksimal 10 lampiran atau ukuran unggahan Discord.*`,
    );
  }

  lines.push('', `Requested by: <@${requesterId}>`);

  return createBaseEmbed({
    title: 'MIDWAVE MEDIA DOWNLOADER',
    description: lines.join('\n'),
    color: COLORS.PRIMARY,
    includeThumbnail: false,
  });
}
