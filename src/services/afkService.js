import { PermissionFlagsBits } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { prisma as defaultPrisma } from './prisma.js';
import { DISCORD_MAX_MESSAGE_LENGTH, sanitizeAiMentions } from '../utils/aiFormatter.js';
import { AFK_MAX_REASON_LENGTH } from '../utils/constants.js';
import { createBaseEmbed } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';
import { parsePrefixInvocation, resolvePrefix } from '../utils/prefixParser.js';

export const AFK_DEFAULT_REASON = 'Tidak ada alasan';
export { AFK_MAX_REASON_LENGTH };
export const AFK_COOLDOWN_MS = 3_000;
export const AFK_MAX_MENTION_IDS_PER_QUERY = 25;
export const AFK_MAX_NOTICES_PER_MESSAGE = 5;

export const SAFE_AFK_MENTION_OPTIONS = Object.freeze({
  parse: [],
  repliedUser: false,
});

const USER_MENTION_REGEX = /<@!?(\d{17,22})>/g;
const INVISIBLE_CHAR_REGEX = /[\u0000-\u001F\u007F\u00AD\u034F\u061C\u180E\u200B-\u200D\u2060-\u206F\uFEFF]/g;

/**
 * Normalizes and sanitizes a user-provided AFK reason, falling back to `Tidak ada alasan`
 * when empty or containing only whitespace / invisible characters.
 *
 * @param {unknown} rawReason
 * @returns {string}
 */
export function normalizeAfkReason(rawReason) {
  if (typeof rawReason !== 'string') {
    return AFK_DEFAULT_REASON;
  }

  const collapsed = rawReason
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!collapsed) {
    return AFK_DEFAULT_REASON;
  }

  const visibleOnly = collapsed.replace(INVISIBLE_CHAR_REGEX, '').trim();
  if (!visibleOnly) {
    return AFK_DEFAULT_REASON;
  }

  const mentionSafe = sanitizeAiMentions(collapsed).slice(0, AFK_MAX_REASON_LENGTH).trim();
  return mentionSafe || AFK_DEFAULT_REASON;
}

/**
 * Formats an elapsed millisecond duration into a concise Indonesian duration label.
 *
 * @param {number} elapsedMs
 * @returns {string}
 */
export function formatAfkDuration(elapsedMs) {
  const safeMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds} detik`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} hari`);
  if (hours > 0) parts.push(`${hours} jam`);
  if (minutes > 0) parts.push(`${minutes} menit`);

  return parts.slice(0, 2).join(' ') || '0 menit';
}

/**
 * Formats a relative "since" timestamp in Indonesian (e.g. `15 menit yang lalu` or `baru saja`).
 *
 * @param {Date | string | number} since
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatAfkSince(since, nowMs = Date.now()) {
  const sinceMs = since instanceof Date ? since.getTime() : new Date(since).getTime();
  if (!Number.isFinite(sinceMs)) {
    return 'baru saja';
  }

  const elapsedMs = Math.max(0, nowMs - sinceMs);
  if (elapsedMs < 5_000) {
    return 'baru saja';
  }

  return `${formatAfkDuration(elapsedMs)} yang lalu`;
}

/**
 * Builds the plain-text confirmation message when a user activates/updates AFK.
 *
 * @param {{ userId: string, reason: string }} record
 * @returns {string}
 */
export function buildAfkEnabledMessage(record) {
  const reason = normalizeAfkReason(record?.reason);
  return `🌙 <@${record.userId}> sekarang sedang AFK.\n\nAlasan: ${reason}`;
}

/**
 * Builds the embed confirmation when a user activates/updates AFK.
 *
 * @param {{ userId: string, reason: string }} record
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildAfkEnabledEmbed(record) {
  const reason = normalizeAfkReason(record?.reason);
  return createBaseEmbed({
    title: '🌙 Status AFK Aktif',
    description: `<@${record.userId}> sekarang sedang AFK.\n\n**Alasan:** ${reason}`,
    color: COLORS.PRIMARY,
    includeThumbnail: false,
  });
}

/**
 * Builds a single AFK notice block for an AFK user who was mentioned.
 *
 * @param {{ userId: string, reason: string, since: Date | string | number }} record
 * @param {number} [nowMs]
 * @returns {string}
 */
export function buildAfkMentionNotice(record, nowMs = Date.now()) {
  const reason = normalizeAfkReason(record?.reason);
  const sinceText = formatAfkSince(record?.since, nowMs);
  return `🌙 <@${record.userId}> sedang AFK\n\nAlasan: ${reason}\n\nSejak: ${sinceText}`;
}

/**
 * Combines up to `AFK_MAX_NOTICES_PER_MESSAGE` deduplicated AFK notices into a single
 * Discord message within the 2000-character limit.
 *
 * @param {Array<{ userId: string, reason: string, since: Date | string | number }>} records
 * @param {number} [nowMs]
 * @returns {string}
 */
export function buildAfkMentionMessage(records, nowMs = Date.now()) {
  if (!Array.isArray(records) || records.length === 0) {
    return '';
  }

  const blocks = [];
  let currentLength = 0;

  for (const record of records.slice(0, AFK_MAX_NOTICES_PER_MESSAGE)) {
    const block = buildAfkMentionNotice(record, nowMs);
    const sepLen = blocks.length > 0 ? 2 : 0;
    if (blocks.length > 0 && currentLength + sepLen + block.length > DISCORD_MAX_MESSAGE_LENGTH) {
      break;
    }
    blocks.push(block);
    currentLength += sepLen + block.length;
  }

  return blocks.join('\n\n').slice(0, DISCORD_MAX_MESSAGE_LENGTH);
}

/**
 * Builds an embed containing up to `AFK_MAX_NOTICES_PER_MESSAGE` deduplicated AFK notices.
 *
 * @param {Array<{ userId: string, reason: string, since: Date | string | number }>} records
 * @param {number} [nowMs]
 * @returns {import('discord.js').EmbedBuilder | null}
 */
export function buildAfkMentionEmbed(records, nowMs = Date.now()) {
  if (!Array.isArray(records) || records.length === 0) {
    return null;
  }

  const blocks = [];
  let currentLength = 0;

  for (const record of records.slice(0, AFK_MAX_NOTICES_PER_MESSAGE)) {
    const reason = normalizeAfkReason(record?.reason);
    const sinceText = formatAfkSince(record?.since, nowMs);
    const block = `<@${record.userId}> sedang AFK\n**Alasan:** ${reason}\n**Sejak:** ${sinceText}`;
    const sepLen = blocks.length > 0 ? 2 : 0;
    if (blocks.length > 0 && currentLength + sepLen + block.length > DISCORD_MAX_MESSAGE_LENGTH) {
      break;
    }
    blocks.push(block);
    currentLength += sepLen + block.length;
  }

  if (blocks.length === 0) {
    return null;
  }

  return createBaseEmbed({
    title: '🌙 Pengguna Sedang AFK',
    description: blocks.join('\n\n').slice(0, DISCORD_MAX_MESSAGE_LENGTH),
    color: COLORS.PRIMARY,
    includeThumbnail: false,
  });
}

/**
 * Builds the plain-text welcome-back notification when an AFK user sends a message.
 *
 * @param {{ userId: string, since: Date | string | number }} record
 * @param {number} [nowMs]
 * @returns {string}
 */
export function buildAfkReturnMessage(record, nowMs = Date.now()) {
  const sinceMs = record?.since instanceof Date ? record.since.getTime() : new Date(record?.since).getTime();
  const elapsedMs = Number.isFinite(sinceMs) ? Math.max(0, nowMs - sinceMs) : 0;
  const durationText = formatAfkDuration(elapsedMs);
  return `☀️ Selamat datang kembali, <@${record.userId}>!\n\nKamu telah AFK selama ${durationText}.`;
}

/**
 * Builds the embed welcome-back notification when an AFK user sends a message.
 *
 * @param {{ userId: string, since: Date | string | number }} record
 * @param {number} [nowMs]
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildAfkReturnEmbed(record, nowMs = Date.now()) {
  const sinceMs = record?.since instanceof Date ? record.since.getTime() : new Date(record?.since).getTime();
  const elapsedMs = Number.isFinite(sinceMs) ? Math.max(0, nowMs - sinceMs) : 0;
  const durationText = formatAfkDuration(elapsedMs);
  return createBaseEmbed({
    title: '☀️ Selamat Datang Kembali',
    description: `<@${record.userId}> telah kembali!\n\nKamu telah AFK selama **${durationText}**.`,
    color: COLORS.SUCCESS,
    includeThumbnail: false,
  });
}

/**
 * Activates or updates a user's persistent AFK profile without creating duplicates.
 *
 * @param {{
 *   userId: string,
 *   reason?: unknown,
 *   prisma?: import('@prisma/client').PrismaClient,
 *   now?: () => Date,
 * }} params
 * @returns {Promise<{ userId: string, reason: string, since: Date }>}
 */
export async function setAfkStatus({
  userId,
  reason = AFK_DEFAULT_REASON,
  prisma = defaultPrisma,
  now = () => new Date(),
}) {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error('AFK userId wajib diisi.');
  }
  if (!prisma?.afkStatus) {
    throw new Error('Prisma AFK storage tidak tersedia.');
  }

  const cleanUserId = userId.trim();
  const cleanReason = normalizeAfkReason(reason);
  const since = now();

  return prisma.afkStatus.upsert({
    where: { userId: cleanUserId },
    update: { reason: cleanReason, since },
    create: { userId: cleanUserId, reason: cleanReason, since },
  });
}

/**
 * Fetches a single user's AFK status, or returns `null` if not AFK.
 *
 * @param {string} userId
 * @param {{ prisma?: import('@prisma/client').PrismaClient }} [options]
 */
export async function getAfkStatus(userId, { prisma = defaultPrisma } = {}) {
  if (typeof userId !== 'string' || !userId.trim() || !prisma?.afkStatus?.findUnique) {
    return null;
  }
  return prisma.afkStatus.findUnique({ where: { userId: userId.trim() } });
}

/**
 * Fetches AFK statuses for a list of user IDs while preserving the order of unique input IDs.
 *
 * @param {string[]} userIds
 * @param {{ prisma?: import('@prisma/client').PrismaClient }} [options]
 */
export async function getAfkStatuses(userIds, { prisma = defaultPrisma } = {}) {
  if (!Array.isArray(userIds) || userIds.length === 0 || !prisma?.afkStatus?.findMany) {
    return [];
  }

  const uniqueIds = [];
  const seen = new Set();
  for (const rawId of userIds) {
    if (typeof rawId !== 'string' || !rawId.trim() || seen.has(rawId)) {
      continue;
    }
    seen.add(rawId);
    uniqueIds.push(rawId);
    if (uniqueIds.length >= AFK_MAX_MENTION_IDS_PER_QUERY) {
      break;
    }
  }

  if (uniqueIds.length === 0) {
    return [];
  }

  const rows = await prisma.afkStatus.findMany({
    where: { userId: { in: uniqueIds } },
  });
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const byId = new Map(rows.map((row) => [row.userId, row]));
  return uniqueIds.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Atomically removes a user's AFK status if currently active and returns the previous AFK record.
 * Returns `null` when the user is not AFK or another concurrent request already removed it.
 *
 * @param {string} userId
 * @param {{ prisma?: import('@prisma/client').PrismaClient }} [options]
 * @returns {Promise<{ userId: string, reason: string, since: Date } | null>}
 */
export async function removeAfkStatus(userId, { prisma = defaultPrisma } = {}) {
  if (typeof userId !== 'string' || !userId.trim() || !prisma?.afkStatus) {
    return null;
  }

  const cleanUserId = userId.trim();
  const existing = await prisma.afkStatus.findUnique({ where: { userId: cleanUserId } });
  if (!existing) {
    return null;
  }

  if (typeof prisma.afkStatus.deleteMany === 'function') {
    const res = await prisma.afkStatus.deleteMany({ where: { userId: cleanUserId } });
    if (!res?.count) {
      return null;
    }
    return existing;
  }

  if (typeof prisma.afkStatus.delete === 'function') {
    try {
      await prisma.afkStatus.delete({ where: { userId: cleanUserId } });
      return existing;
    } catch (error) {
      if (error?.code === 'P2025') {
        return null;
      }
      throw error;
    }
  }

  return null;
}

/**
 * Extracts unique mentioned user IDs eligible for AFK notification from a Discord message.
 * Excludes the author (self-mention), this bot, and other bots.
 *
 * @param {import('discord.js').Message} message
 * @returns {string[]}
 */
export function extractMentionedAfkCandidateIds(message) {
  if (!message) {
    return [];
  }

  const authorId = message.author?.id ?? null;
  const selfBotId = message.client?.user?.id ?? null;
  const knownBotIds = new Set();
  const candidateIds = [];
  const seen = new Set();

  const tryAddId = (id, isBot = false) => {
    if (typeof id !== 'string' || !id) return;
    if (isBot) {
      knownBotIds.add(id);
      return;
    }
    if (id === authorId || (selfBotId && id === selfBotId) || knownBotIds.has(id) || seen.has(id)) {
      return;
    }
    if (candidateIds.length < AFK_MAX_MENTION_IDS_PER_QUERY) {
      seen.add(id);
      candidateIds.push(id);
    }
  };

  const mentionedUsers = message.mentions?.users;
  if (mentionedUsers && typeof mentionedUsers.values === 'function') {
    for (const user of mentionedUsers.values()) {
      tryAddId(user?.id, Boolean(user?.bot));
    }
  }

  if (typeof message.content === 'string' && message.content.includes('<@')) {
    USER_MENTION_REGEX.lastIndex = 0;
    let match;
    while ((match = USER_MENTION_REGEX.exec(message.content)) !== null) {
      tryAddId(match[1], false);
    }
  }

  return candidateIds;
}

function resolveChannelPermissions(target) {
  if (!target?.guild || typeof target.channel?.permissionsFor !== 'function') {
    return null;
  }

  const botMember =
    target.guild.members?.me ??
    (target.client?.user?.id ? target.guild.members?.cache?.get?.(target.client.user.id) : null);
  if (!botMember) {
    return null;
  }

  return target.channel.permissionsFor(botMember) ?? null;
}

function canSendMessages(target) {
  const perms = resolveChannelPermissions(target);
  if (!perms) {
    return true;
  }
  return Boolean(
    perms.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.SendMessages),
  );
}

export function canSendEmbeds(target) {
  if (typeof target?.canEmbedLinks === 'boolean') {
    return target.canEmbedLinks;
  }
  const perms = resolveChannelPermissions(target?.message ?? target);
  if (!perms) {
    return true;
  }
  return Boolean(perms.has(PermissionFlagsBits.EmbedLinks));
}

export function buildAfkReplyPayload({ content, embed, target }) {
  const allowedMentions = {
    parse: [...SAFE_AFK_MENTION_OPTIONS.parse],
    repliedUser: SAFE_AFK_MENTION_OPTIONS.repliedUser,
  };

  if (embed && canSendEmbeds(target)) {
    return { embeds: [embed], allowedMentions };
  }

  return { content, allowedMentions };
}

async function sendSafeAfkReply(message, { content, embed }, logger = console) {
  if ((!content && !embed) || !canSendMessages(message)) {
    return null;
  }

  const payload = buildAfkReplyPayload({ content, embed, target: message });

  try {
    if (typeof message.reply === 'function') {
      try {
        return await message.reply(payload);
      } catch {
        // Fallback to channel.send when original trigger message was deleted or reply is disallowed.
      }
    }
    if (typeof message.channel?.send === 'function') {
      return await message.channel.send(payload);
    }
  } catch (error) {
    logger?.warn?.('[AFK] Failed delivering notification:', sanitizeError(error));
  }
  return null;
}

function isAfkPrefixCommandMessage(message, context = {}) {
  const prefix = resolvePrefix(context?.prefix);
  if (typeof message?.content !== 'string' || !message.content.startsWith(prefix)) {
    return false;
  }
  const parsed = parsePrefixInvocation(message.content, { prefix });
  return parsed?.commandName === 'afk';
}

/**
 * Checks and notifies about mentioned AFK users in a Discord message without duplicates.
 *
 * @param {import('discord.js').Message} message
 * @param {{ prisma?: import('@prisma/client').PrismaClient, nowMs?: number, logger?: Console }} [context]
 */
export async function processAfkMentions(message, context = {}) {
  const prisma = context.prisma ?? defaultPrisma;
  const candidateIds = extractMentionedAfkCandidateIds(message);
  if (candidateIds.length === 0) {
    return [];
  }

  const afkRecords = await getAfkStatuses(candidateIds, { prisma });
  if (afkRecords.length === 0) {
    return [];
  }

  const nowMs = context.nowMs ?? Date.now();
  const content = buildAfkMentionMessage(afkRecords, nowMs);
  const embed = buildAfkMentionEmbed(afkRecords, nowMs);
  if (content || embed) {
    await sendSafeAfkReply(message, { content, embed }, context.logger ?? console);
  }
  return afkRecords;
}

/**
 * Handles AFK lifecycle on `MessageCreate`:
 * - Ignores bots, webhooks, system messages, and `!afk` invocations (which update AFK cleanly).
 * - Automatically clears the author's AFK status and welcomes them back.
 * - Notifies when non-self AFK users are mentioned in the message.
 * Errors are caught cleanly so other commands/handlers continue unaffected.
 *
 * @param {import('discord.js').Message} message
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   prefix?: string,
 *   nowMs?: () => number,
 *   logger?: Console,
 * }} [context]
 * @returns {Promise<{ cleared: object | null, notified: object[] }>}
 */
export async function handleAfkMessage(message, context = {}) {
  if (!message || !message.author?.id || message.author.bot || message.webhookId || message.system) {
    return { cleared: null, notified: [] };
  }

  const prisma = context.prisma ?? defaultPrisma;
  if (!prisma?.afkStatus) {
    return { cleared: null, notified: [] };
  }

  if (isAfkPrefixCommandMessage(message, context)) {
    return { cleared: null, notified: [] };
  }

  const logger = context.logger ?? console;
  const nowMs = typeof context.nowMs === 'function' ? context.nowMs() : Date.now();
  let cleared = null;
  let notified = [];

  try {
    cleared = await removeAfkStatus(message.author.id, { prisma });
    if (cleared) {
      await sendSafeAfkReply(
        message,
        {
          content: buildAfkReturnMessage(cleared, nowMs),
          embed: buildAfkReturnEmbed(cleared, nowMs),
        },
        logger,
      );
    }
  } catch (error) {
    logger?.error?.('[AFK] Failed auto-removing AFK status:', sanitizeError(error));
  }

  try {
    notified = await processAfkMentions(message, { prisma, nowMs, logger });
  } catch (error) {
    logger?.error?.('[AFK] Failed processing AFK mentions:', sanitizeError(error));
  }

  return { cleared, notified };
}
