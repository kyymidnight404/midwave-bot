import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { COLORS } from '../config/colors.js';
import { getComponentEmoji, getEmoji } from '../config/emojis.js';
import { buildErrorEmbed, createBaseEmbed, getIconFiles } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

export const FEEDBACK_COOLDOWN_MS = 60_000;
export const FEEDBACK_SUBJECT_MAX = 100;
export const FEEDBACK_DESCRIPTION_MAX = 1000;
export const FEEDBACK_URL_MAX = 500;
export const FEEDBACK_PROMPT_TTL_MS = 15 * 60 * 1000;

export const FEEDBACK_CUSTOM_ID_PREFIX = 'feedback';

export const FEEDBACK_CATEGORIES = Object.freeze({
  bug: Object.freeze({
    id: 'bug',
    emojiKey: 'bug',
    get emoji() {
      return getEmoji('bug');
    },
    label: 'Bug Report',
    get display() {
      return `${getEmoji('bug')} Bug Report`;
    },
    description: 'Laporkan error, crash, atau perilaku bot yang tidak sesuai.',
  }),
  feature: Object.freeze({
    id: 'feature',
    emojiKey: 'idea',
    get emoji() {
      return getEmoji('idea');
    },
    label: 'Feature Suggestion',
    get display() {
      return `${getEmoji('idea')} Feature Suggestion`;
    },
    description: 'Usulkan fitur baru atau peningkatan command yang ada.',
  }),
  general: Object.freeze({
    id: 'general',
    emojiKey: 'chat',
    get emoji() {
      return getEmoji('chat');
    },
    label: 'General Feedback',
    get display() {
      return `${getEmoji('chat')} General Feedback`;
    },
    description: 'Bagikan pendapat, pengalaman, atau masukan umum.',
  }),
  other: Object.freeze({
    id: 'other',
    emojiKey: 'warning',
    get emoji() {
      return getEmoji('warning');
    },
    label: 'Other Issues',
    get display() {
      return `${getEmoji('warning')} Other Issues`;
    },
    description: 'Masalah lain di luar kategori di atas.',
  }),
});

export const FEEDBACK_STATUSES = Object.freeze({
  pending: Object.freeze({
    id: 'pending',
    label: '🟡 Pending',
    color: COLORS.WARNING,
  }),
  reviewing: Object.freeze({
    id: 'reviewing',
    label: '🔵 Reviewing',
    color: COLORS.PRIMARY,
  }),
  resolved: Object.freeze({
    id: 'resolved',
    label: '🟢 Resolved',
    color: COLORS.SUCCESS,
  }),
  rejected: Object.freeze({
    id: 'rejected',
    label: '🔴 Rejected',
    color: COLORS.ERROR,
  }),
});

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const INVISIBLE_ONLY_RE =
  /[\u0000-\u001F\u007F\u00AD\u034F\u061C\u180E\u200B-\u200D\u2060-\u206F\uFEFF]/g;
const SNOWFLAKE_RE = /^\d{17,22}$/;
const IGNORED_DISCORD_CODES = new Set([10062, 40060]);

// In-memory ephemeral state for prompt selections, active submissions, and report metadata
const FEEDBACK_REPORT_TTL_MS = 24 * 60 * 60 * 1000;
const FEEDBACK_REPORT_MAX_ENTRIES = 500;
const pendingPrompts = new Map();
const activeSubmissions = new Set();
const activeStatusUpdates = new Set();
const reportStore = new Map();

function pruneReportStore(now = Date.now()) {
  for (const [key, entry] of reportStore.entries()) {
    const createdAt = entry?.createdAt instanceof Date ? entry.createdAt.getTime() : Number(entry?.createdAt || 0);
    if (!entry || (createdAt > 0 && now - createdAt > FEEDBACK_REPORT_TTL_MS)) {
      reportStore.delete(key);
    }
  }
  while (reportStore.size > FEEDBACK_REPORT_MAX_ENTRIES) {
    const oldestKey = reportStore.keys().next().value;
    if (oldestKey === undefined) break;
    reportStore.delete(oldestKey);
  }
}

function pruneExpiredPrompts(now = Date.now()) {
  for (const [key, entry] of pendingPrompts.entries()) {
    if (!entry || now - entry.createdAt > FEEDBACK_PROMPT_TTL_MS) {
      pendingPrompts.delete(key);
    }
  }
}

export function clearFeedbackStateForTests() {
  pendingPrompts.clear();
  activeSubmissions.clear();
  activeStatusUpdates.clear();
  reportStore.clear();
}

export function generateReportId() {
  return `FB-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

export function getFeedbackChannelId(env = process.env) {
  const raw = typeof env?.FEEDBACK_CHANNEL_ID === 'string' ? env.FEEDBACK_CHANNEL_ID.trim() : '';
  return SNOWFLAKE_RE.test(raw) ? raw : null;
}

/**
 * Extracts and validates comma-separated staff role Snowflakes from `FEEDBACK_STAFF_ROLE_IDS`.
 * When empty or invalid, only Discord server Administrators are treated as trusted staff (fail-closed).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function getStaffRoleIds(env = process.env) {
  const raw = typeof env?.FEEDBACK_STAFF_ROLE_IDS === 'string' ? env.FEEDBACK_STAFF_ROLE_IDS : '';
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => SNOWFLAKE_RE.test(id));
}

/**
 * Determines whether a guild member is authorized to review feedback reports.
 *
 * Policy:
 * - Discord `Administrator` permission inherently bypasses channel overwrites at the platform level
 *   and is treated as trusted staff.
 * - All other members must hold at least one role listed in `FEEDBACK_STAFF_ROLE_IDS`.
 *
 * @param {import('discord.js').GuildMember | null | undefined} member
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isStaffMember(member, env = process.env) {
  if (!member) return false;

  const hasAdmin =
    typeof member.permissions?.has === 'function' &&
    member.permissions.has(PermissionFlagsBits.Administrator);
  if (hasAdmin) return true;

  const staffRoleIds = getStaffRoleIds(env);
  if (staffRoleIds.length === 0) return false;

  if (typeof member.roles?.cache?.has === 'function') {
    return staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
  }
  if (Array.isArray(member.roles)) {
    return staffRoleIds.some((roleId) => member.roles.includes(roleId));
  }
  return false;
}

export function sanitizeTextInput(raw, maxLength) {
  if (typeof raw !== 'string') return '';
  return raw.replace(CONTROL_CHARS_RE, '').trim().slice(0, maxLength);
}

export function hasVisibleText(text) {
  if (typeof text !== 'string') return false;
  return text.replace(INVISIBLE_ONLY_RE, '').trim().length > 0;
}

export function validateScreenshotUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { valid: true, url: null };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > FEEDBACK_URL_MAX) {
    return { valid: false, error: `URL screenshot maksimal ${FEEDBACK_URL_MAX} karakter.` };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'URL screenshot harus menggunakan protokol http:// atau https://.' };
    }
    if (parsed.username || parsed.password) {
      return { valid: false, error: 'URL screenshot tidak boleh menyertakan username atau password.' };
    }
    return { valid: true, url: parsed.toString() };
  } catch {
    return { valid: false, error: 'Format URL screenshot tidak valid.' };
  }
}

export function validateFeedbackInput({ category, subject, description, screenshotUrl }) {
  if (!category || !Object.hasOwn(FEEDBACK_CATEGORIES, category)) {
    return { valid: false, error: 'Kategori feedback tidak valid. Silakan pilih kategori yang tersedia.' };
  }

  const cleanSubject = typeof subject === 'string' ? subject.replace(CONTROL_CHARS_RE, '').trim() : '';
  if (!hasVisibleText(cleanSubject)) {
    return { valid: false, error: 'Subject laporan tidak boleh kosong.' };
  }
  if (cleanSubject.length > FEEDBACK_SUBJECT_MAX) {
    return {
      valid: false,
      error: `Subject terlalu panjang (${cleanSubject.length}/${FEEDBACK_SUBJECT_MAX} karakter).`,
    };
  }

  const cleanDescription =
    typeof description === 'string' ? description.replace(CONTROL_CHARS_RE, '').trim() : '';
  if (!hasVisibleText(cleanDescription)) {
    return { valid: false, error: 'Deskripsi laporan tidak boleh kosong.' };
  }
  if (cleanDescription.length > FEEDBACK_DESCRIPTION_MAX) {
    return {
      valid: false,
      error: `Deskripsi terlalu panjang (${cleanDescription.length}/${FEEDBACK_DESCRIPTION_MAX} karakter).`,
    };
  }

  const urlCheck = validateScreenshotUrl(screenshotUrl);
  if (!urlCheck.valid) {
    return { valid: false, error: urlCheck.error };
  }

  return {
    valid: true,
    data: {
      category,
      subject: cleanSubject,
      description: cleanDescription,
      screenshotUrl: urlCheck.url,
    },
  };
}

/**
 * Resolves and validates the target staff feedback channel and bot permissions.
 * @param {import('discord.js').Client} client
 * @param {{ env?: NodeJS.ProcessEnv, logger?: Console }} [options]
 */
export async function resolveFeedbackChannel(client, { env = process.env, logger = console } = {}) {
  const channelId = getFeedbackChannelId(env);
  if (!channelId) {
    logger.error?.('[Feedback] FEEDBACK_CHANNEL_ID is not configured or invalid.');
    return {
      ok: false,
      reason: 'NOT_CONFIGURED',
      userMessage: 'Sistem feedback sedang belum dikonfigurasi oleh pengelola bot. Silakan hubungi admin server.',
    };
  }

  let channel = client?.channels?.cache?.get?.(channelId) ?? null;
  if (!channel && typeof client?.channels?.fetch === 'function') {
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      logger.error?.('[Feedback] Failed to fetch feedback channel:', sanitizeError(err));
      channel = null;
    }
  }

  if (!channel || (typeof channel.isTextBased === 'function' && !channel.isTextBased()) || !channel.guild) {
    logger.error?.('[Feedback] Configured feedback channel is unavailable or not a guild text channel.');
    return {
      ok: false,
      reason: 'CHANNEL_UNAVAILABLE',
      userMessage: 'Channel tujuan feedback tidak tersedia saat ini. Silakan hubungi admin.',
    };
  }

  const isThread =
    (typeof channel.isThread === 'function' && channel.isThread()) ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread;

  const isSupportedGuildText =
    typeof channel.type !== 'number' ||
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement;

  if (isThread || !isSupportedGuildText) {
    logger.error?.('[Feedback] Rejected feedback channel: threads and non-text channel types are not allowed.');
    return {
      ok: false,
      reason: 'UNSUPPORTED_CHANNEL_TYPE',
      userMessage:
        'Pengiriman laporan ditolak: channel feedback harus berupa text channel server privat, bukan thread atau tipe channel lain.',
    };
  }

  const botMember =
    channel.guild.members?.me ??
    (client?.user?.id ? channel.guild.members?.cache?.get?.(client.user.id) : null);

  if (botMember && typeof channel.permissionsFor === 'function') {
    const perms = channel.permissionsFor(botMember);
    const hasRequired =
      perms?.has?.(PermissionFlagsBits.ViewChannel) &&
      perms?.has?.(PermissionFlagsBits.SendMessages) &&
      perms?.has?.(PermissionFlagsBits.EmbedLinks);

    if (!hasRequired) {
      logger.error?.('[Feedback] Bot lacks ViewChannel, SendMessages, or EmbedLinks in feedback channel.');
      return {
        ok: false,
        reason: 'MISSING_PERMISSIONS',
        userMessage: 'Bot tidak memiliki izin untuk mengirim laporan ke channel staff. Silakan hubungi admin.',
      };
    }
  }

  const everyoneRole =
    channel.guild.roles?.everyone ?? channel.guild.roles?.cache?.get?.(channel.guild.id) ?? null;

  if (!everyoneRole || typeof channel.permissionsFor !== 'function') {
    logger.error?.(
      '[Feedback] Rejected feedback channel: unable to verify @everyone ViewChannel permissions.',
    );
    return {
      ok: false,
      reason: 'CHANNEL_PRIVACY_UNVERIFIED',
      userMessage:
        'Pengiriman laporan ditolak karena privasi channel feedback belum dapat diverifikasi. Pastikan channel berada di server yang valid dan batasi izin `@everyone`.',
    };
  }

  const everyonePerms = channel.permissionsFor(everyoneRole);
  if (everyonePerms?.has?.(PermissionFlagsBits.ViewChannel) !== false) {
    logger.error?.(
      '[Feedback] Rejected insecure feedback channel: channel is accessible by @everyone.',
    );
    return {
      ok: false,
      reason: 'CHANNEL_NOT_PRIVATE',
      userMessage:
        'Pengiriman laporan ditolak demi privasi: channel feedback saat ini dapat dilihat oleh `@everyone`. Admin wajib mengatur `FEEDBACK_CHANNEL_ID` ke channel privat khusus staff (nonaktifkan izin `View Channel` untuk `@everyone`).',
    };
  }

  const overwritesCache = channel.permissionOverwrites?.cache;
  if (!overwritesCache || typeof overwritesCache.values !== 'function') {
    logger.error?.(
      '[Feedback] Rejected feedback channel: unable to verify channel permission overwrites.',
    );
    return {
      ok: false,
      reason: 'CHANNEL_PRIVACY_UNVERIFIED',
      userMessage:
        'Pengiriman laporan ditolak karena permission overwrite channel feedback tidak dapat diverifikasi. Pastikan channel berada di server yang valid.',
    };
  }

  const staffRoleIds = new Set(getStaffRoleIds(env));

  for (const overwrite of overwritesCache.values()) {
    if (!overwrite || overwrite.id === channel.guild.id) continue;

    const isRoleOverwrite =
      overwrite.type === OverwriteType.Role || overwrite.type === 0 || overwrite.type === 'role';
    const isMemberOverwrite =
      overwrite.type === OverwriteType.Member || overwrite.type === 1 || overwrite.type === 'member';

    if (isRoleOverwrite && !staffRoleIds.has(overwrite.id) && overwrite.allow?.has?.(PermissionFlagsBits.ViewChannel)) {
      logger.error?.(
        `[Feedback] Rejected insecure feedback channel: non-staff role ${overwrite.id} has ViewChannel overwrite.`,
      );
      return {
        ok: false,
        reason: 'CHANNEL_NOT_PRIVATE',
        userMessage:
          'Pengiriman laporan ditolak demi privasi: terdapat role non-staff yang memiliki izin `View Channel` pada channel feedback. Admin wajib membatasi akses hanya untuk role staff terdaftar (`FEEDBACK_STAFF_ROLE_IDS`) dan Administrator server.',
      };
    }

    if (
      isMemberOverwrite &&
      overwrite.id !== client?.user?.id &&
      overwrite.allow?.has?.(PermissionFlagsBits.ViewChannel)
    ) {
      logger.error?.(
        `[Feedback] Rejected insecure feedback channel: member ${overwrite.id} has explicit ViewChannel overwrite.`,
      );
      return {
        ok: false,
        reason: 'CHANNEL_NOT_PRIVATE',
        userMessage:
          'Pengiriman laporan ditolak demi privasi: terdapat member non-bot yang diberi izin `View Channel` secara langsung pada channel feedback.',
      };
    }
  }

  if (channel.guild.roles?.cache && typeof channel.guild.roles.cache.values === 'function') {
    for (const role of channel.guild.roles.cache.values()) {
      if (!role || role.id === channel.guild.id || role.managed) continue;
      if (staffRoleIds.has(role.id)) continue;
      // Discord Administrators inherently bypass channel overwrites and are treated as trusted staff.
      if (role.permissions?.has?.(PermissionFlagsBits.Administrator)) continue;

      const rolePerms = channel.permissionsFor(role);
      if (rolePerms?.has?.(PermissionFlagsBits.ViewChannel) === true) {
        logger.error?.(
          `[Feedback] Rejected insecure feedback channel: non-staff role ${role.id} can view channel.`,
        );
        return {
          ok: false,
          reason: 'CHANNEL_NOT_PRIVATE',
          userMessage:
            'Pengiriman laporan ditolak demi privasi: terdapat role non-staff yang memiliki akses `View Channel` pada channel feedback. Admin wajib membatasi akses hanya untuk role staff terdaftar (`FEEDBACK_STAFF_ROLE_IDS`) dan Administrator server.',
        };
      }
    }
  }

  return { ok: true, channel };
}

export function registerFeedbackPrompt(promptId, { userId, selectedCategory = null, attachmentUrl = null }) {
  pruneExpiredPrompts();
  pendingPrompts.set(promptId, {
    userId,
    selectedCategory,
    attachmentUrl,
    createdAt: Date.now(),
  });
}

export function getFeedbackPrompt(promptId) {
  pruneExpiredPrompts();
  return pendingPrompts.get(promptId) ?? null;
}

export function buildFeedbackPromptEmbed({ selectedCategory = null, attachmentUrl = null, includeThumbnail = true } = {}) {
  const categoryInfo = selectedCategory ? FEEDBACK_CATEGORIES[selectedCategory] : null;
  const lines = [
    'Gunakan panel ini untuk mengirim laporan bug, saran fitur, atau masukan langsung kepada tim staff.',
    '',
    '1. Pilih **Kategori** pada menu di bawah.',
    '2. Klik tombol **Submit Feedback** untuk mengisi Subject & Description.',
  ];
  if (categoryInfo) {
    lines.push('', `**Kategori dipilih:** ${categoryInfo.display}`);
  }
  if (attachmentUrl) {
    lines.push(`${getEmoji('image')} **Screenshot terdeteksi:** Lampiran gambar akan ikut disertakan.`);
  }

  return createBaseEmbed({
    title: 'Midwave Feedback & Reports',
    description: lines.join('\n'),
    color: COLORS.PRIMARY,
    includeThumbnail,
    iconName: 'feedback',
  });
}

export function buildFeedbackPromptComponents(promptId, ownerId, { selectedCategory = null, disabled = false } = {}) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`${FEEDBACK_CUSTOM_ID_PREFIX}:category:${promptId}:${ownerId}`)
    .setPlaceholder('Pilih kategori feedback...')
    .setDisabled(disabled)
    .addOptions(
      Object.values(FEEDBACK_CATEGORIES).map((cat) => ({
        label: cat.label,
        value: cat.id,
        emoji: cat.emojiKey ? getComponentEmoji(cat.emojiKey) : cat.emoji,
        description: cat.description,
        default: selectedCategory === cat.id,
      })),
    );

  const submitButton = new ButtonBuilder()
    .setCustomId(`${FEEDBACK_CUSTOM_ID_PREFIX}:open:${promptId}:${ownerId}`)
    .setLabel('Submit Feedback')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled);

  return [
    new ActionRowBuilder().addComponents(selectMenu),
    new ActionRowBuilder().addComponents(submitButton),
  ];
}

export function buildFeedbackModal(promptId, categoryId) {
  const category = FEEDBACK_CATEGORIES[categoryId];
  const modal = new ModalBuilder()
    .setCustomId(`${FEEDBACK_CUSTOM_ID_PREFIX}:submit:${promptId}:${categoryId}`)
    .setTitle(`Feedback — ${category.label}`.slice(0, 45));

  const subjectInput = new TextInputBuilder()
    .setCustomId('subject')
    .setLabel('Subject / Judul Laporan')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Ringkasan singkat laporan Anda...')
    .setRequired(true)
    .setMinLength(3)
    .setMaxLength(FEEDBACK_SUBJECT_MAX);

  const descriptionInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description / Penjelasan Lengkap')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Jelaskan detail bug, langkah reproduksi, atau saran Anda...')
    .setRequired(true)
    .setMinLength(10)
    .setMaxLength(FEEDBACK_DESCRIPTION_MAX);

  const screenshotInput = new TextInputBuilder()
    .setCustomId('screenshot_url')
    .setLabel('Screenshot URL (Opsional)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://... (opsional, atau lampirkan gambar saat !feedback)')
    .setRequired(false)
    .setMaxLength(FEEDBACK_URL_MAX);

  return modal.addComponents(
    new ActionRowBuilder().addComponents(subjectInput),
    new ActionRowBuilder().addComponents(descriptionInput),
    new ActionRowBuilder().addComponents(screenshotInput),
  );
}

export function buildFeedbackReportEmbed({
  reportId,
  category,
  subject,
  description,
  reporterTag,
  reporterId,
  guildName,
  guildId,
  createdAt = new Date(),
  status = 'pending',
  screenshotUrl = null,
  reviewedByTag = null,
  reviewedById = null,
  reviewedAt = null,
}) {
  const categoryInfo = FEEDBACK_CATEGORIES[category] ?? FEEDBACK_CATEGORIES.other;
  const statusInfo = FEEDBACK_STATUSES[status] ?? FEEDBACK_STATUSES.pending;
  const createdUnix = Math.floor(new Date(createdAt).getTime() / 1000);

  const embed = createBaseEmbed({
    title: `${getEmoji('notification')} [${reportId}] ${subject}`,
    description,
    color: statusInfo.color,
    includeThumbnail: true,
    iconName: 'feedback',
  }).addFields(
    { name: 'Kategori', value: categoryInfo.display, inline: true },
    { name: 'Status', value: statusInfo.label, inline: true },
    { name: 'Waktu Laporan', value: `<t:${createdUnix}:F>`, inline: true },
    { name: 'Pelapor', value: `${reporterTag} (<@${reporterId}>)\nID: \`${reporterId}\``, inline: true },
    {
      name: 'Server Asal',
      value: guildName ? `${guildName}\nID: \`${guildId ?? 'N/A'}\`` : 'Direct Message',
      inline: true,
    },
  );

  if (reviewedById || reviewedByTag) {
    const reviewedUnix = reviewedAt ? Math.floor(new Date(reviewedAt).getTime() / 1000) : null;
    const staffText = reviewedById ? `<@${reviewedById}> (${reviewedByTag ?? reviewedById})` : reviewedByTag;
    embed.addFields({
      name: 'Diproses Oleh',
      value: reviewedUnix ? `${staffText} • <t:${reviewedUnix}:R>` : staffText,
      inline: true,
    });
  }

  if (screenshotUrl) {
    embed.setImage(screenshotUrl);
  }

  return embed;
}

export function buildStaffActionRow(reportId, currentStatus = 'pending') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${FEEDBACK_CUSTOM_ID_PREFIX}:status:reviewing:${reportId}`)
      .setLabel('Mark as Reviewing')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentStatus === 'reviewing'),
    new ButtonBuilder()
      .setCustomId(`${FEEDBACK_CUSTOM_ID_PREFIX}:status:resolved:${reportId}`)
      .setLabel('Mark as Resolved')
      .setStyle(ButtonStyle.Success)
      .setDisabled(currentStatus === 'resolved'),
    new ButtonBuilder()
      .setCustomId(`${FEEDBACK_CUSTOM_ID_PREFIX}:status:rejected:${reportId}`)
      .setLabel('Mark as Rejected')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(currentStatus === 'rejected'),
  );
}

async function safeEphemeralError(interaction, message) {
  const payload = {
    embeds: [buildErrorEmbed(message)],
    flags: MessageFlags.Ephemeral,
  };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    if (!IGNORED_DISCORD_CODES.has(err?.code)) {
      console.error('[Feedback] Failed to send ephemeral error:', sanitizeError(err));
    }
  }
}

function extractReportFromMessageEmbed(existingEmbed, reportId) {
  if (!existingEmbed) return null;
  const fields = existingEmbed.fields ?? existingEmbed.data?.fields ?? [];
  const getField = (name) => fields.find((f) => f.name === name)?.value ?? '';

  const categoryText = getField('Kategori');
  const matchedCat =
    Object.values(FEEDBACK_CATEGORIES).find((c) => categoryText.includes(c.label))?.id ?? 'other';

  const titleRaw = existingEmbed.title ?? existingEmbed.data?.title ?? '';
  const subject = titleRaw.replace(/^\[FB-[A-Z0-9]+\]\s*/i, '') || 'Feedback Report';
  const description = existingEmbed.description ?? existingEmbed.data?.description ?? '';
  const pelaporField = getField('Pelapor');
  const reporterIdMatch = pelaporField.match(/<@(\d+)>/);
  const reporterId = reporterIdMatch ? reporterIdMatch[1] : 'unknown';
  const reporterTag = pelaporField.split(' (<@')[0] || 'Unknown User';

  const serverField = getField('Server Asal');
  const [guildNameLine, guildIdLine] = serverField.split('\n');
  const guildIdMatch = guildIdLine?.match(/`([^`]+)`/);

  return {
    reportId,
    category: matchedCat,
    subject,
    description,
    reporterTag,
    reporterId,
    guildName: guildNameLine === 'Direct Message' ? null : guildNameLine,
    guildId: guildIdMatch ? guildIdMatch[1] : null,
    createdAt: existingEmbed.timestamp ? new Date(existingEmbed.timestamp) : new Date(),
    screenshotUrl: existingEmbed.image?.url ?? existingEmbed.data?.image?.url ?? null,
  };
}

/**
 * Handles all `feedback:*` component and modal interactions.
 * @param {import('discord.js').Interaction} interaction
 * @param {object} context
 */
export async function handleFeedbackInteraction(interaction, context = {}) {
  const logger = context.logger ?? console;
  const customId = interaction?.customId ?? '';
  const parts = customId.split(':');
  if (parts[0] !== FEEDBACK_CUSTOM_ID_PREFIX) return false;

  const action = parts[1];

  // 1. Category select menu
  if (action === 'category' && interaction.isStringSelectMenu?.()) {
    const [, , promptId, ownerId] = parts;
    if (interaction.user.id !== ownerId) {
      await safeEphemeralError(interaction, 'Panel feedback ini hanya dapat digunakan oleh pembuat perintah.');
      return true;
    }

    const selectedCategory = interaction.values?.[0];
    if (!Object.hasOwn(FEEDBACK_CATEGORIES, selectedCategory)) {
      await safeEphemeralError(interaction, 'Kategori yang dipilih tidak valid.');
      return true;
    }

    const existingPrompt = getFeedbackPrompt(promptId);
    registerFeedbackPrompt(promptId, {
      userId: ownerId,
      selectedCategory,
      attachmentUrl: existingPrompt?.attachmentUrl ?? null,
    });

    try {
      await interaction.update({
        embeds: [
          buildFeedbackPromptEmbed({
            selectedCategory,
            attachmentUrl: existingPrompt?.attachmentUrl ?? null,
          }),
        ],
        components: buildFeedbackPromptComponents(promptId, ownerId, { selectedCategory }),
      });
    } catch (err) {
      if (!IGNORED_DISCORD_CODES.has(err?.code)) {
        logger.error?.('[Feedback] Failed to update category selection:', sanitizeError(err));
      }
    }
    return true;
  }

  // 2. Open modal button
  if (action === 'open' && interaction.isButton?.()) {
    const [, , promptId, ownerId] = parts;
    if (interaction.user.id !== ownerId) {
      await safeEphemeralError(interaction, 'Tombol ini hanya dapat digunakan oleh pembuat perintah.');
      return true;
    }

    const promptState = getFeedbackPrompt(promptId);
    if (!promptState) {
      await safeEphemeralError(interaction, 'Sesi formulir feedback sudah kedaluwarsa. Jalankan `!feedback` lagi.');
      return true;
    }
    if (!promptState.selectedCategory) {
      await safeEphemeralError(
        interaction,
        'Pilih kategori feedback terlebih dahulu dari menu pilihan di atas sebelum menekan **Submit Feedback**.',
      );
      return true;
    }

    if (context.cooldowns?.check) {
      const cd = context.cooldowns.check(`feedback:submit:${interaction.user.id}`);
      if (cd?.onCooldown) {
        const waitSec = Math.max(1, Math.ceil(cd.remainingMs / 1000));
        await safeEphemeralError(
          interaction,
          `Anda baru saja mengirim feedback. Tunggu ${waitSec} detik sebelum mengirim lagi.`,
        );
        return true;
      }
    }

    try {
      const modal = buildFeedbackModal(promptId, promptState.selectedCategory);
      await interaction.showModal(modal);
    } catch (err) {
      if (!IGNORED_DISCORD_CODES.has(err?.code)) {
        logger.error?.('[Feedback] Failed to open feedback modal:', sanitizeError(err));
        await safeEphemeralError(interaction, 'Gagal membuka formulir feedback. Silakan coba lagi.');
      }
    }
    return true;
  }

  // 3. Modal submission
  if (action === 'submit' && interaction.isModalSubmit?.()) {
    const [, , promptId, categoryId] = parts;
    const userId = interaction.user.id;

    if (activeSubmissions.has(userId)) {
      await safeEphemeralError(interaction, 'Laporan Anda sedang diproses. Mohon tunggu sebentar.');
      return true;
    }

    activeSubmissions.add(userId);
    try {
      const promptState = getFeedbackPrompt(promptId);
      const subject = interaction.fields.getTextInputValue('subject');
      const description = interaction.fields.getTextInputValue('description');
      let rawScreenshot = '';
      try {
        rawScreenshot = interaction.fields.getTextInputValue('screenshot_url');
      } catch {
        rawScreenshot = '';
      }

      const finalScreenshot = rawScreenshot?.trim() || promptState?.attachmentUrl || '';
      const validation = validateFeedbackInput({
        category: categoryId,
        subject,
        description,
        screenshotUrl: finalScreenshot,
      });

      if (!validation.valid) {
        await safeEphemeralError(interaction, validation.error);
        return true;
      }

      if (context.cooldowns) {
        const cd = context.cooldowns.tryAcquire(`feedback:submit:${userId}`, FEEDBACK_COOLDOWN_MS);
        if (!cd.allowed) {
          const waitSec = Math.max(1, Math.ceil(cd.remainingMs / 1000));
          await safeEphemeralError(
            interaction,
            `Terlalu cepat! Tunggu ${waitSec} detik sebelum mengirim feedback lagi.`,
          );
          return true;
        }
      }

      const channelResolution = await resolveFeedbackChannel(interaction.client ?? context.client, {
        env: context.env ?? process.env,
        logger,
      });

      if (!channelResolution.ok) {
        await safeEphemeralError(interaction, channelResolution.userMessage);
        return true;
      }

      const reportId = generateReportId();
      const createdAt = new Date();
      const reportData = {
        reportId,
        category: validation.data.category,
        subject: validation.data.subject,
        description: validation.data.description,
        reporterTag: interaction.user.tag ?? interaction.user.username,
        reporterId: userId,
        guildName: interaction.guild?.name ?? null,
        guildId: interaction.guild?.id ?? null,
        createdAt,
        status: 'pending',
        screenshotUrl: validation.data.screenshotUrl,
      };

      const reportEmbed = buildFeedbackReportEmbed(reportData);
      const staffRow = buildStaffActionRow(reportId, 'pending');

      try {
        await channelResolution.channel.send({
          embeds: [reportEmbed],
          components: [staffRow],
          files: getIconFiles('feedback'),
        });
      } catch (err) {
        logger.error?.('[Feedback] Failed to deliver report to staff channel:', sanitizeError(err));
        await safeEphemeralError(
          interaction,
          'Gagal meneruskan laporan ke channel staff. Silakan coba lagi nanti.',
        );
        return true;
      }

      reportStore.set(reportId, reportData);
        pruneReportStore();
      pendingPrompts.delete(promptId);

      // Disable original prompt components silently if accessible
      if (interaction.message && typeof interaction.message.edit === 'function') {
        interaction.message
          .edit({
            components: buildFeedbackPromptComponents(promptId, userId, {
              selectedCategory: validation.data.category,
              disabled: true,
            }),
          })
          .catch(() => {});
      }

      const categoryDisplay = FEEDBACK_CATEGORIES[validation.data.category].display;
      const confirmEmbed = createBaseEmbed({
        title: 'Feedback Diterima',
        description: [
          `Terima kasih! Laporan Anda telah diteruskan ke tim staff.`,
          '',
          `**ID Laporan:** \`${reportId}\``,
          `**Kategori:** ${categoryDisplay}`,
          `**Status:** ${FEEDBACK_STATUSES.pending.label} — menunggu peninjauan staff.`,
        ].join('\n'),
        color: COLORS.SUCCESS,
        includeThumbnail: false,
      });

      await interaction.reply({
        embeds: [confirmEmbed],
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      if (!IGNORED_DISCORD_CODES.has(err?.code)) {
        logger.error?.('[Feedback] Unexpected error during modal submission:', sanitizeError(err));
        await safeEphemeralError(interaction, 'Terjadi kesalahan saat memproses feedback Anda.');
      }
    } finally {
      activeSubmissions.delete(userId);
    }
    return true;
  }

  // 4. Staff status update buttons
  if (action === 'status' && interaction.isButton?.()) {
    const [, , nextStatus, reportId] = parts;
    if (!Object.hasOwn(FEEDBACK_STATUSES, nextStatus) || nextStatus === 'pending') {
      await safeEphemeralError(interaction, 'Status laporan tidak valid.');
      return true;
    }

    if (!isStaffMember(interaction.member, context.env ?? process.env)) {
      await safeEphemeralError(
        interaction,
        'Anda tidak memiliki izin staff/administrator untuk mengubah status laporan ini.',
      );
      return true;
    }

    if (activeStatusUpdates.has(reportId)) {
      await safeEphemeralError(interaction, 'Pembaruan status sedang diproses. Mohon tunggu.');
      return true;
    }

    activeStatusUpdates.add(reportId);
    try {
      const existingData =
        reportStore.get(reportId) ??
        extractReportFromMessageEmbed(interaction.message?.embeds?.[0], reportId);

      if (!existingData) {
        await safeEphemeralError(interaction, 'Data laporan tidak ditemukan.');
        return true;
      }

      const updatedData = {
        ...existingData,
        status: nextStatus,
        reviewedByTag: interaction.user.tag ?? interaction.user.username,
        reviewedById: interaction.user.id,
        reviewedAt: new Date(),
      };

      reportStore.set(reportId, updatedData);

      const updatedEmbed = buildFeedbackReportEmbed(updatedData);
      const updatedRow = buildStaffActionRow(reportId, nextStatus);

      await interaction.update({
        embeds: [updatedEmbed],
        components: [updatedRow],
      });

      const statusInfo = FEEDBACK_STATUSES[nextStatus];
      await interaction.followUp({
        embeds: [
          createBaseEmbed({
            title: 'Status Laporan Diperbarui',
            description: `Laporan \`${reportId}\` telah ditandai sebagai **${statusInfo.label}**.`,
            color: statusInfo.color,
            includeThumbnail: false,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      if (!IGNORED_DISCORD_CODES.has(err?.code)) {
        logger.error?.('[Feedback] Failed to update report status:', sanitizeError(err));
        await safeEphemeralError(interaction, 'Gagal memperbarui status laporan. Silakan coba lagi.');
      }
    } finally {
      activeStatusUpdates.delete(reportId);
    }
    return true;
  }

  return false;
}
