import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { buildDynamicHelpEmbed, discoverHelpEntries } from '../services/helpService.js';
import {
  BOT_PLAYER_ID,
  EMBED_FOOTER,
  GAME_METADATA,
  GAME_MODES,
  LOGO_ATTACHMENT_URL,
  LOGO_FILENAME,
  LOGO_PATH,
} from './constants.js';

const ICON_DIR = path.resolve(process.cwd(), 'assets/icon');

export const FEATURE_ICONS = Object.freeze({
  coinflip: 'coinflip.png',
  donate: 'donate.png',
  feedback: 'feedback.png',
  join: 'join.png',
  menu: 'menu.png',
  quiz: 'quiz.png',
  rps: 'rps.png',
  tictactoe: 'tic-tac-toe.png',
  'tic-tac-toe': 'tic-tac-toe.png',
  ttt: 'tic-tac-toe.png',
  weather: 'weather.png',
});

let logoAvailableCache = null;
const iconAvailableCache = new Map();

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

function resolveFeatureIconInfo(iconName) {
  const filename = iconName ? FEATURE_ICONS[String(iconName).toLowerCase()] : null;
  if (filename) {
    if (!iconAvailableCache.has(filename)) {
      iconAvailableCache.set(filename, fs.existsSync(path.join(ICON_DIR, filename)));
    }
    if (iconAvailableCache.get(filename)) {
      return {
        filename,
        filePath: path.join(ICON_DIR, filename),
        attachmentUrl: `attachment://${filename}`,
      };
    }
  }
  if (hasLogoAsset()) {
    return {
      filename: LOGO_FILENAME,
      filePath: LOGO_PATH,
      attachmentUrl: LOGO_ATTACHMENT_URL,
    };
  }
  return null;
}

/**
 * Checks whether a named feature icon (or fallback logo) exists on disk.
 * @param {string} iconName
 * @returns {boolean}
 */
export function hasIconAsset(iconName) {
  return resolveFeatureIconInfo(iconName) !== null;
}

/**
 * Returns the Discord `attachment://` URL for a feature icon (with logo fallback).
 * @param {string} [iconName]
 * @returns {string}
 */
export function getIconAttachmentUrl(iconName) {
  return resolveFeatureIconInfo(iconName)?.attachmentUrl ?? LOGO_ATTACHMENT_URL;
}

/**
 * Creates a fresh AttachmentBuilder for a feature icon (with logo fallback).
 * @param {string} [iconName]
 * @returns {AttachmentBuilder[]}
 */
export function getIconFiles(iconName) {
  const info = resolveFeatureIconInfo(iconName);
  if (!info) return [];
  return [new AttachmentBuilder(info.filePath, { name: info.filename })];
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
 * Creates a base Midwave embed with consistent branding, optional logo thumbnail, footer, and timestamp.
 * @param {{
 *   title?: string,
 *   description?: string,
 *   color?: number,
 *   includeThumbnail?: boolean,
 *   includeFooter?: boolean,
 *   footer?: string | { text: string, iconURL?: string } | null,
 *   timestamp?: boolean | Date | number,
 * }} [options]
 * @returns {EmbedBuilder}
 */
export function createBaseEmbed({
  title,
  description,
  color = COLORS.PRIMARY,
  includeThumbnail = true,
  iconName = null,
  includeFooter = false,
  footer = null,
  timestamp = false,
} = {}) {
  const resolvedColor = color ?? COLORS.PRIMARY;
  const embed = new EmbedBuilder().setColor(resolvedColor);

  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (includeThumbnail) {
    const thumbUrl = iconName ? resolveFeatureIconInfo(iconName)?.attachmentUrl : hasLogoAsset() ? LOGO_ATTACHMENT_URL : null;
    if (thumbUrl) {
      embed.setThumbnail(thumbUrl);
    }
  }
  if (footer) {
    embed.setFooter(typeof footer === 'string' ? { text: footer } : footer);
  } else if (includeFooter) {
    embed.setFooter({ text: EMBED_FOOTER });
  }
  if (timestamp === true) {
    embed.setTimestamp();
  } else if (timestamp instanceof Date || typeof timestamp === 'number') {
    embed.setTimestamp(timestamp);
  }

  return embed;
}

/**
 * Builds an ephemeral error embed.
 * @param {string} message
 * @param {string} [title='Tidak Dapat Diproses']
 * @param {{ includeThumbnail?: boolean, includeFooter?: boolean, footer?: string | { text: string, iconURL?: string } | null, timestamp?: boolean | Date | number }} [options]
 * @returns {EmbedBuilder}
 */
export function buildErrorEmbed(message, title = 'Tidak Dapat Diproses', options = {}) {
  return createBaseEmbed({
    title,
    description: message,
    color: COLORS.ERROR,
    includeThumbnail: false,
    ...options,
  });
}

/**
 * Builds a success status embed.
 * @param {string} message
 * @param {string} [title='Berhasil']
 * @param {{ includeThumbnail?: boolean, includeFooter?: boolean, footer?: string | { text: string, iconURL?: string } | null, timestamp?: boolean | Date | number }} [options]
 * @returns {EmbedBuilder}
 */
export function buildSuccessEmbed(message, title = 'Berhasil', options = {}) {
  return createBaseEmbed({
    title,
    description: message,
    color: COLORS.SUCCESS,
    includeThumbnail: false,
    ...options,
  });
}

/**
 * Builds a warning status embed.
 * @param {string} message
 * @param {string} [title='Peringatan']
 * @param {{ includeThumbnail?: boolean, includeFooter?: boolean, footer?: string | { text: string, iconURL?: string } | null, timestamp?: boolean | Date | number }} [options]
 * @returns {EmbedBuilder}
 */
export function buildWarningEmbed(message, title = 'Peringatan', options = {}) {
  return createBaseEmbed({
    title,
    description: message,
    color: COLORS.WARNING,
    includeThumbnail: false,
    ...options,
  });
}

/**
 * Builds an informational embed.
 * @param {string} title
 * @param {string} description
 * @param {number} [color]
 * @param {{ includeThumbnail?: boolean, includeFooter?: boolean, footer?: string | { text: string, iconURL?: string } | null, timestamp?: boolean | Date | number }} [options]
 * @returns {EmbedBuilder}
 */
export function buildInfoEmbed(title, description, color = COLORS.INFO, options = {}) {
  return createBaseEmbed({ title, description, color, ...options });
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
  color = COLORS.PRIMARY,
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
  iconName = null,
  color = COLORS.PRIMARY,
}) {
  const modeLabel = mode === GAME_MODES.SOLO ? 'Solo' : 'Multiplayer';
  const playerText = players.map(formatPlayer).join(' vs ');

  const embed = createBaseEmbed({
    title: gameTitle,
    description: gameDescription,
    color,
    iconName,
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
  iconName = null,
  color,
}) {
  const resolvedColor = color ?? (isDraw ? COLORS.WARNING : COLORS.SUCCESS);
  const modeLabel = mode === GAME_MODES.SOLO ? 'Solo' : 'Multiplayer';

  const embed = createBaseEmbed({
    title: `${gameTitle} — Hasil Akhir`,
    description: resultDescription,
    color: resolvedColor,
    iconName,
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
    color: COLORS.PRIMARY,
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
    color: COLORS.PRIMARY,
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
  YouTube: '📺 YouTube',
  Instagram: '📸 Instagram',
  TikTok: '🎵 TikTok',
  Facebook: '📘 Facebook',
  'X / Twitter': '𝕏 X / Twitter',
  Reddit: '👽 Reddit',
  Twitch: '🟣 Twitch',
  SoundCloud: '☁️ SoundCloud',
  Vimeo: '🎞️ Vimeo',
  Dailymotion: '🎥 Dailymotion',
  Bilibili: '📺 Bilibili',
});

function formatPlatformBadge(platformLabel) {
  return PLATFORM_BADGES[platformLabel] || `🌐 ${platformLabel}`;
}

/**
 * Builds the processing status embed shown while media is being extracted and uploaded.
 *
 * @param {{ platformLabel: string, statusText?: string }} params
 * @returns {EmbedBuilder}
 */
export function buildDownloadProcessingEmbed({ platformLabel, statusText = null }) {
  const badge = formatPlatformBadge(platformLabel);
  const detail =
    statusText || 'Mengekstrak dan mengunduh media dengan yt-dlp sebelum diunggah ke Discord.';
  return createBaseEmbed({
    title: 'MIDWAVE MEDIA DOWNLOADER',
    description: `${badge}\n\n⏳ **Memproses unduhan...**\n${detail}`,
    color: COLORS.INFO,
    includeThumbnail: false,
  });
}

/**
 * Builds the dark Midwave-styled completion embed for `/media action:download` and `!download`.
 *
 * @param {{
 *   platformLabel: string,
 *   mediaType: string,
 *   fileFormat: string,
 *   formattedSize: string,
 *   requesterId: string,
 *   title?: string,
 *   author?: string,
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
  title = '',
  author = '',
  truncatedCount = 0,
}) {
  const badge = formatPlatformBadge(platformLabel);
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const cleanAuthor = String(author || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  const lines = [
    badge,
    '',
    '**Download Completed**',
  ];

  if (cleanTitle) {
    lines.push(`• **Judul:** ${cleanTitle}`);
  }
  if (cleanAuthor) {
    lines.push(`• **Kreator:** ${cleanAuthor}`);
  }

  lines.push(
    `• **Platform:** ${platformLabel}`,
    `• **Media Type:** ${mediaType}`,
    `• **File Format:** ${fileFormat}`,
    `• **File Size:** ${formattedSize}`,
  );

  if (truncatedCount > 0) {
    lines.push(
      '',
      `⚠️ *${truncatedCount} item lainnya tidak disertakan karena batas maksimal 10 lampiran atau ukuran unggahan Discord.*`,
    );
  }

  lines.push('', `Requested by: <@${requesterId}>`);

  return createBaseEmbed({
    title: 'MIDWAVE MEDIA DOWNLOADER',
    description: lines.join('\n'),
    color: COLORS.SUCCESS,
    includeThumbnail: false,
  });
}
