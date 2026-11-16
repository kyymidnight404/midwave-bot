import { MessageFlags } from 'discord.js';
import { DISCORD_MAX_MESSAGE_LENGTH } from '../utils/aiFormatter.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

export const SAY_MAX_LENGTH = DISCORD_MAX_MESSAGE_LENGTH;
export const SAY_COOLDOWN_MS = 3_000;

const SAFE_MENTION_OPTIONS = Object.freeze({
  parse: [],
  users: [],
  roles: [],
  repliedUser: false,
});

/**
 * Validation error thrown for invalid `!say` input before sending to Discord.
 */
export class SayValidationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SayValidationError';
    this.code = code;
  }
}

/**
 * Validates and trims outer whitespace on `!say` input while preserving internal spaces,
 * newlines, Markdown, Unicode emojis, and raw mention text verbatim.
 *
 * @param {unknown} rawText
 * @param {string} [prefix]
 * @returns {string}
 */
export function validateSayMessage(rawText, prefix = '!') {
  if (typeof rawText !== 'string') {
    throw new SayValidationError(
      'EMPTY_MESSAGE',
      `Masukkan pesan yang ingin diulang. Contoh: \`${prefix}say Halo semuanya!\`.`,
    );
  }

  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new SayValidationError(
      'EMPTY_MESSAGE',
      `Masukkan pesan yang ingin diulang. Contoh: \`${prefix}say Halo semuanya!\`.`,
    );
  }

  if (trimmed.includes('\0')) {
    throw new SayValidationError(
      'INVALID_MESSAGE',
      'Pesan mengandung karakter kontrol yang tidak dapat dikirim ke Discord.',
    );
  }

  // Reject messages consisting exclusively of control or invisible zero-width characters.
  const visibleContent = trimmed
    .replace(/[\u0000-\u001F\u007F\u00AD\u034F\u061C\u180E\u200B-\u200D\u2060-\u206F\uFEFF]/g, '')
    .trim();
  if (!visibleContent) {
    throw new SayValidationError(
      'INVALID_MESSAGE',
      'Pesan hanya berisi karakter kosong yang tidak dapat dikirim ke Discord.',
    );
  }

  if (trimmed.length > SAY_MAX_LENGTH) {
    throw new SayValidationError(
      'MESSAGE_TOO_LONG',
      `Pesan terlalu panjang (${trimmed.length}/${SAY_MAX_LENGTH} karakter). Maksimal ${SAY_MAX_LENGTH} karakter untuk pesan Discord.`,
    );
  }

  return trimmed;
}

/**
 * Builds a clean, plain-text `!say` Discord payload with all mentions disabled.
 * @param {string} validatedText
 * @returns {{ content: string, allowedMentions: { parse: string[], users: string[], roles: string[], repliedUser: boolean } }}
 */
export function buildSayPayload(validatedText) {
  return {
    content: validatedText,
    allowedMentions: {
      parse: [...SAFE_MENTION_OPTIONS.parse],
      users: [...SAFE_MENTION_OPTIONS.users],
      roles: [...SAFE_MENTION_OPTIONS.roles],
      repliedUser: SAFE_MENTION_OPTIONS.repliedUser,
    },
  };
}

function mapDiscordSendErrorMessage(error) {
  const code = Number(error?.code ?? error?.status ?? 0);
  if (code === 50013 || code === 50001) {
    return 'Bot tidak memiliki izin yang cukup untuk mengirim pesan di channel ini.';
  }
  if (code === 50035) {
    return `Pesan ditolak Discord karena melebihi batas atau format tidak valid (maksimal ${SAY_MAX_LENGTH} karakter).`;
  }
  if (code === 50006) {
    return 'Pesan tidak dapat dikirim karena dianggap kosong oleh Discord.';
  }
  return 'Gagal mengirim pesan ke channel ini. Silakan coba lagi.';
}

async function sendSafeSayError(adapter, errorMessage) {
  const canEmbedLinks = adapter?.canEmbedLinks !== false;
  const primaryPayload = canEmbedLinks
    ? {
        embeds: [buildErrorEmbed(errorMessage)],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [], repliedUser: false },
      }
    : {
        content: errorMessage,
        allowedMentions: { parse: [], repliedUser: false },
      };

  try {
    if (typeof adapter?.reply === 'function') {
      await adapter.reply(primaryPayload);
    } else if (typeof adapter?.message?.reply === 'function') {
      await adapter.message.reply({
        content: errorMessage,
        embeds: primaryPayload.embeds,
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
  } catch {
    if (canEmbedLinks && typeof adapter?.reply === 'function') {
      try {
        await adapter.reply({
          content: errorMessage,
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch {
        // Ignore secondary delivery failures
      }
    }
  }
}

/**
 * Executes the `!say` prefix command, repeating validated user text directly
 * as a plain Discord message without embeds, headers, or mention pings.
 *
 * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} adapter
 * @param {{ prefix?: string, logger?: Console }} [context]
 */
export async function execute(adapter, context = {}) {
  if (adapter?.user?.bot) {
    return;
  }

  const rawText = adapter?.options?.getString?.('text', false) ?? '';
  const prefix = context.prefix ?? '!';

  let validatedText;
  try {
    validatedText = validateSayMessage(rawText, prefix);
  } catch (error) {
    await sendSafeSayError(
      adapter,
      error instanceof Error ? error.message : 'Input pesan tidak valid.',
    );
    return;
  }

  const payload = buildSayPayload(validatedText);
  const logger = context.logger ?? console;

  try {
    const channel = adapter?.message?.channel;
    if (typeof channel?.send === 'function') {
      await channel.send(payload);
    } else if (typeof adapter?.reply === 'function') {
      await adapter.reply(payload);
    } else {
      throw new Error('No message delivery channel available.');
    }
  } catch (error) {
    const code = error?.code ?? error?.status ?? 'unknown';
    logger.error?.(`[Say] Failed to send message (${code}):`, sanitizeError(error));
    await sendSafeSayError(adapter, mapDiscordSendErrorMessage(error));
  }
}

export default { name: 'say', execute };
