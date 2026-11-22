import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getEmoji } from '../config/emojis.js';
import { MessageCommandAdapter } from '../handlers/MessageCommandAdapter.js';
import { buildErrorEmbed, buildSuccessEmbed, buildWarningEmbed } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

export const CLEAR_MIN_AMOUNT = 1;
export const CLEAR_MAX_AMOUNT = 100;
export const CLEAR_COOLDOWN_MS = 3_000;
export const DISCORD_BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Validation error thrown for invalid `!clear` arguments.
 */
export class ClearValidationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ClearValidationError';
    this.code = code;
  }
}

/**
 * Validates raw `!clear` argument input as an integer between 1 and 100.
 *
 * @param {unknown} rawInput
 * @param {string} [prefix]
 * @returns {number}
 */
export function validateClearAmount(rawInput, prefix = '!') {
  const usageHint = `Gunakan \`${prefix}clear <jumlah>\` dengan bilangan bulat **${CLEAR_MIN_AMOUNT}–${CLEAR_MAX_AMOUNT}**. Contoh: \`${prefix}clear 10\`.`;

  if (typeof rawInput !== 'string') {
    throw new ClearValidationError('MISSING_AMOUNT', `Masukkan jumlah pesan yang ingin dihapus. ${usageHint}`);
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new ClearValidationError('MISSING_AMOUNT', `Masukkan jumlah pesan yang ingin dihapus. ${usageHint}`);
  }

  if (!/^\d+$/.test(trimmed)) {
    throw new ClearValidationError('INVALID_AMOUNT', `Jumlah pesan harus berupa bilangan bulat antara **${CLEAR_MIN_AMOUNT}–${CLEAR_MAX_AMOUNT}**. ${usageHint}`);
  }

  const amount = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(amount) || amount < CLEAR_MIN_AMOUNT || amount > CLEAR_MAX_AMOUNT) {
    throw new ClearValidationError(
      'OUT_OF_RANGE',
      `Jumlah pesan harus berada di antara **${CLEAR_MIN_AMOUNT}** hingga **${CLEAR_MAX_AMOUNT}**. ${usageHint}`,
    );
  }

  return amount;
}

async function resolveInvokerPermissions(adapter, message) {
  if (adapter?.memberPermissions && typeof adapter.memberPermissions.has === 'function') {
    return adapter.memberPermissions;
  }
  if (message?.member?.permissions && typeof message.member.permissions.has === 'function') {
    return message.member.permissions;
  }
  const userId = message?.author?.id ?? adapter?.user?.id;
  if (userId && typeof message?.guild?.members?.fetch === 'function') {
    const member = await message.guild.members.fetch(userId).catch(() => null);
    if (member?.permissions && typeof member.permissions.has === 'function') {
      return member.permissions;
    }
  }
  return null;
}

async function resolveBotMember(guild, client) {
  if (!guild) {
    return null;
  }
  if (guild.members?.me) {
    return guild.members.me;
  }
  const botId = client?.user?.id;
  if (botId && typeof guild.members?.cache?.get === 'function') {
    const cached = guild.members.cache.get(botId);
    if (cached) {
      return cached;
    }
  }
  if (typeof guild.members?.fetchMe === 'function') {
    return guild.members.fetchMe().catch(() => null);
  }
  return null;
}

async function hasBotManageMessagesPermission(message, adapter) {
  const guild = message?.guild;
  const channel = message?.channel;
  const botMember = await resolveBotMember(guild, message?.client ?? adapter?.client);

  if (typeof channel?.permissionsFor === 'function' && botMember) {
    const perms = channel.permissionsFor(botMember);
    return Boolean(perms?.has?.(PermissionFlagsBits.ManageMessages));
  }

  if (typeof adapter?.canManageMessages === 'boolean') {
    return adapter.canManageMessages;
  }

  if (typeof botMember?.permissions?.has === 'function') {
    return Boolean(botMember.permissions.has(PermissionFlagsBits.ManageMessages));
  }

  return false;
}

function resolveMessageTimestamp(msg) {
  if (typeof msg?.createdTimestamp === 'number' && Number.isFinite(msg.createdTimestamp)) {
    return msg.createdTimestamp;
  }
  if (typeof msg?.createdAt?.getTime === 'function') {
    const ts = msg.createdAt.getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

function formatChannelLabel(channel) {
  const name = typeof channel?.name === 'string' ? channel.name.trim() : '';
  if (channel?.id && name) {
    return `**#${name}** (<#${channel.id}>)`;
  }
  if (channel?.id) {
    return `<#${channel.id}>`;
  }
  if (name) {
    return `**#${name}**`;
  }
  return 'channel ini';
}

function mapClearDiscordError(error) {
  const code = Number(error?.code ?? error?.status ?? 0);
  if (code === 50013 || code === 50001) {
    return 'Bot tidak memiliki izin yang cukup di channel ini. Pastikan bot memiliki izin **Manage Messages** dan **Read Message History**.';
  }
  if (code === 429 || error?.status === 429) {
    return 'Permintaan penghapusan pesan sedang dibatasi oleh Discord (rate limit). Silakan coba lagi beberapa saat lagi.';
  }
  if (code === 50034) {
    return 'Sebagian atau seluruh pesan tidak dapat dihapus karena sudah berusia **14 hari atau lebih** (batas bulk delete Discord).';
  }
  if (code === 10003) {
    return 'Channel ini tidak mendukung atau tidak lagi tersedia untuk penghapusan pesan.';
  }
  return 'Terjadi kegagalan saat menghapus pesan dari Discord. Silakan coba lagi.';
}

async function sendEmbedResponse(adapter, message, embed, { preferChannelSend = false } = {}) {
  const payload = {
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [], repliedUser: false },
  };

  try {
    if (preferChannelSend && typeof message?.channel?.send === 'function') {
      const { flags: _ignoredFlags, ...publicPayload } = payload;
      await message.channel.send(publicPayload);
      return;
    }

    if (typeof adapter?.reply === 'function') {
      await adapter.reply(payload);
      return;
    }

    if (typeof message?.channel?.send === 'function') {
      const { flags: _ignoredFlags, ...publicPayload } = payload;
      await message.channel.send(publicPayload);
    }
  } catch {
    // Ignore secondary delivery failures
  }
}

async function cleanupCommandMessage(message) {
  if (!message || message.deletable === false || typeof message.delete !== 'function') {
    return false;
  }
  try {
    await message.delete();
    return true;
  } catch {
    return false;
  }
}

/**
 * Executes `!clear <jumlah>` for server Administrators only.
 * Bulk-deletes up to `amount` (1..100) recent messages younger than 14 days in the current guild channel.
 *
 * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter | import('discord.js').Message} interactionOrMessage
 * @param {{ prefix?: string, logger?: Console, nowFn?: () => number }} [context]
 */
export async function execute(interactionOrMessage, context = {}) {
  if (!interactionOrMessage) {
    return;
  }

  let adapter = interactionOrMessage;
  if (typeof interactionOrMessage.options?.getString !== 'function') {
    const rawMsg = interactionOrMessage;
    const rawParts = typeof rawMsg.content === 'string' ? rawMsg.content.trim().split(/\s+/).slice(1).join(' ') : '';
    adapter = new MessageCommandAdapter({
      message: rawMsg,
      parsed: {
        commandName: 'clear',
        subcommand: null,
        options: rawParts ? { amountRaw: rawParts } : {},
      },
    });
  }

  const message = adapter.message;
  if (adapter.user?.bot || message?.author?.bot) {
    return;
  }

  const prefix = context.prefix ?? '!';
  const logger = context.logger ?? console;
  const nowFn = typeof context.nowFn === 'function' ? context.nowFn : () => Date.now();

  if (!adapter.guildId || !message?.guild) {
    await sendEmbedResponse(
      adapter,
      message,
      buildErrorEmbed(`Command \`${prefix}clear\` hanya dapat digunakan di dalam server, bukan melalui DM.`),
    );
    return;
  }

  const invokerPerms = await resolveInvokerPermissions(adapter, message);
  if (!invokerPerms?.has?.(PermissionFlagsBits.Administrator)) {
    await sendEmbedResponse(
      adapter,
      message,
      buildErrorEmbed(
        'Command ini hanya dapat digunakan oleh Administrator server.',
        `${getEmoji('shield')} Akses Ditolak`,
      ),
    );
    return;
  }

  const botHasManageMessages = await hasBotManageMessagesPermission(message, adapter);
  if (!botHasManageMessages) {
    await sendEmbedResponse(
      adapter,
      message,
      buildErrorEmbed('Bot membutuhkan izin **Manage Messages** di channel ini untuk menghapus pesan.'),
    );
    return;
  }

  const channel = message.channel;
  if (
    !channel ||
    channel.isDMBased?.() === true ||
    typeof channel.messages?.fetch !== 'function' ||
    typeof channel.bulkDelete !== 'function'
  ) {
    await sendEmbedResponse(
      adapter,
      message,
      buildErrorEmbed('Channel ini tidak mendukung operasi penghapusan pesan massal.'),
    );
    return;
  }

  const rawAmount = adapter.options?.getString?.('amountRaw', false) ?? '';
  let amount;
  try {
    amount = validateClearAmount(rawAmount, prefix);
  } catch (err) {
    await sendEmbedResponse(
      adapter,
      message,
      buildErrorEmbed(err instanceof Error ? err.message : `Format tidak valid. Gunakan \`${prefix}clear <jumlah>\`.`),
    );
    return;
  }

  const channelLabel = formatChannelLabel(channel);

  try {
    const fetchOptions = message.id ? { limit: amount, before: message.id } : { limit: amount };
    const fetched = await channel.messages.fetch(fetchOptions);
    const fetchedList = Array.isArray(fetched) ? fetched : Array.from(fetched?.values?.() ?? []);
    const bounded = fetchedList
      .filter((msg) => msg && msg.id !== message.id)
      .slice(0, amount);

    const cutoffMs = nowFn() - DISCORD_BULK_DELETE_MAX_AGE_MS;
    const eligible = [];
    let tooOldCount = 0;

    for (const msg of bounded) {
      const ts = resolveMessageTimestamp(msg);
      if (ts === null || ts <= cutoffMs) {
        tooOldCount += 1;
      } else {
        eligible.push(msg);
      }
    }

    if (eligible.length === 0) {
      const commandDeleted = await cleanupCommandMessage(message);
      const description =
        tooOldCount > 0
          ? `Tidak ada pesan yang memenuhi syarat untuk dihapus di ${channelLabel}.\n\n` +
            `**${tooOldCount} pesan** yang diperiksa berusia **14 hari atau lebih** dan tidak dapat dihapus secara bulk oleh Discord.`
          : `Tidak ada pesan sebelumnya yang ditemukan untuk dihapus di ${channelLabel}.`;

      await sendEmbedResponse(
        adapter,
        message,
        buildWarningEmbed(description, 'Tidak Ada Pesan Dihapus'),
        { preferChannelSend: commandDeleted },
      );
      return;
    }

    const deletedResult = await channel.bulkDelete(eligible, true);
    const rawDeletedCount =
      typeof deletedResult?.size === 'number'
        ? deletedResult.size
        : Array.isArray(deletedResult)
          ? deletedResult.length
          : eligible.length;
    const deletedCount = Math.min(amount, Math.max(0, rawDeletedCount));

    const commandDeleted = await cleanupCommandMessage(message);

    if (deletedCount === 0) {
      const description =
        tooOldCount > 0
          ? `Tidak ada pesan yang berhasil dihapus di ${channelLabel}. **${tooOldCount} pesan** berusia **14 hari atau lebih**.`
          : `Tidak ada pesan yang berhasil dihapus di ${channelLabel} karena tidak memenuhi syarat bulk delete.`;

      await sendEmbedResponse(
        adapter,
        message,
        buildWarningEmbed(description, 'Tidak Ada Pesan Dihapus'),
        { preferChannelSend: commandDeleted },
      );
      return;
    }

    let successText = `Berhasil menghapus **${deletedCount} pesan** terbaru di ${channelLabel}.`;
    if (tooOldCount > 0) {
      successText += `\n\n${getEmoji('warning')} **${tooOldCount} pesan** tidak dapat dihapus karena berusia **14 hari atau lebih** (batas bulk delete Discord).`;
    }

    await sendEmbedResponse(
      adapter,
      message,
      buildSuccessEmbed(successText, `${getEmoji('delete')} Pesan Dibersihkan`),
      { preferChannelSend: commandDeleted },
    );
  } catch (err) {
    logger.error?.('[Clear] Failed clearing messages:', sanitizeError(err));
    await sendEmbedResponse(adapter, message, buildErrorEmbed(mapClearDiscordError(err)));
  }
}

export default { name: 'clear', execute };
