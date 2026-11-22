import { MessageFlags } from 'discord.js';
import { MessageCommandAdapter } from '../handlers/MessageCommandAdapter.js';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from '../services/downloader/errors.js';
import { sanitizeLogText } from '../services/downloader/ytdlp.js';
import {
  PIN_COOLDOWN_MS,
  defaultPinterestSessionStore,
  searchPinterest,
  validatePinterestQuery,
} from '../services/pinterest/index.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';
import {
  PIN_CUSTOM_ID_PREFIX,
  buildPinterestView,
  parsePinterestCustomId,
} from '../utils/pinterestEmbed.js';

const IGNORED_DISCORD_ERROR_CODES = new Set([10003, 10008, 10062, 40060, 50001, 50013]);

function normalizePinterestError(error) {
  if (error instanceof DownloaderError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return new DownloaderError(
    DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
    'Terjadi gangguan saat mencari atau mengekstrak hasil Pinterest. Silakan coba lagi.',
    { details: sanitizeLogText(message) },
  );
}

async function sendSafeEphemeralError(interaction, message) {
  const payload = {
    embeds: [buildErrorEmbed(message)],
    flags: MessageFlags.Ephemeral,
  };
  try {
    if (interaction.deferred) {
      await interaction.editReply({ embeds: payload.embeds });
    } else if (interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    if (!IGNORED_DISCORD_ERROR_CODES.has(err?.code)) {
      console.error('[Pinterest] Failed to send ephemeral error:', sanitizeError(err));
    }
  }
}

async function sendSafeDeferredError(interaction, message) {
  try {
    await interaction.editReply({
      embeds: [buildErrorEmbed(message)],
      components: [],
    });
  } catch (err) {
    if (!IGNORED_DISCORD_ERROR_CODES.has(err?.code)) {
      console.error('[Pinterest] Failed to deliver deferred error embed:', sanitizeError(err));
    }
  }
}

function createExpirationHandler(logger = console) {
  return async (expiredSession) => {
    const targetMsg = expiredSession?.messageRef;
    if (!targetMsg || typeof targetMsg.edit !== 'function') {
      return;
    }
    try {
      await targetMsg.edit(buildPinterestView({ session: expiredSession, disabled: true }));
    } catch (err) {
      if (!IGNORED_DISCORD_ERROR_CODES.has(err?.code)) {
        logger.warn?.('[Pinterest] Failed to disable expired pagination buttons:', sanitizeError(err));
      }
    }
  };
}

/**
 * Executes `!pin <keyword>` with single-result pagination and per-user 5-minute session.
 *
 * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter | import('discord.js').Message} interactionOrMessage
 * @param {object | string[]} [contextOrArgs]
 * @param {object} [maybeContext]
 */
export async function execute(interactionOrMessage, contextOrArgs = {}, maybeContext = {}) {
  if (!interactionOrMessage) {
    return;
  }

  let interaction = interactionOrMessage;
  let context = contextOrArgs && !Array.isArray(contextOrArgs) ? contextOrArgs : maybeContext;

  if (typeof interactionOrMessage.options?.getString !== 'function') {
    const message = interactionOrMessage;
    if (message.author?.bot) {
      return;
    }

    let query = '';
    if (Array.isArray(contextOrArgs)) {
      query = contextOrArgs.join(' ').trim();
    } else if (typeof message.content === 'string') {
      context = contextOrArgs || {};
      const prefix = context.prefix || '!';
      const raw = message.content.startsWith(prefix)
        ? message.content.slice(prefix.length).trim()
        : message.content.trim();
      query = raw.replace(/^pin\b/i, '').trim();
    }

    interaction = new MessageCommandAdapter({
      message,
      parsed: {
        commandName: 'pin',
        subcommand: null,
        options: query ? { query } : {},
      },
    });
  }

  if (interaction.user?.bot) {
    return;
  }

  const rawQuery = interaction.options?.getString?.('query', false) ?? '';
  let query;
  try {
    query = validatePinterestQuery(rawQuery);
  } catch (error) {
    await sendSafeEphemeralError(interaction, error.userMessage || error.message);
    return;
  }

  await interaction.deferReply();

  const logger = context?.logger ?? console;
  const searchFn = context?.searchPinterest ?? searchPinterest;

  let searchResult;
  try {
    searchResult = await searchFn({ query }, context?.pinterestOptions);
  } catch (error) {
    const mapped = normalizePinterestError(error);
    logger.error?.(
      `[Pinterest] Search failed (${mapped.code})${mapped.details ? ` | ${mapped.details}` : ''}`,
    );
    await sendSafeDeferredError(interaction, mapped.userMessage);
    return;
  }

  const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
  if (results.length === 0) {
    await sendSafeDeferredError(
      interaction,
      `Tidak ada hasil Pinterest ditemukan untuk kata kunci **${query}**.`,
    );
    return;
  }

  const sessionStore = context?.pinterestSessionStore ?? defaultPinterestSessionStore;
  const session = sessionStore.createSession({
    userId: interaction.user.id,
    query: searchResult.query || query,
    results,
    onExpire: createExpirationHandler(logger),
  });

  try {
    const replyMessage = await interaction.editReply(buildPinterestView({ session }));
    if (replyMessage && typeof replyMessage.edit === 'function') {
      sessionStore.setMessageRef(session.sessionId, replyMessage);
    }
  } catch (discordError) {
    sessionStore.deleteSession(session.sessionId);
    if (!IGNORED_DISCORD_ERROR_CODES.has(discordError?.code)) {
      logger.error?.('[Pinterest] Failed to send result embed:', sanitizeError(discordError));
    }
  }
}

/**
 * Handles `pin:prev:<sessionId>:<ownerId>` and `pin:next:<sessionId>:<ownerId>` button interactions.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} [context]
 * @returns {Promise<boolean>}
 */
export async function handlePinterestInteraction(interaction, context = {}) {
  const parsed = parsePinterestCustomId(interaction?.customId);
  if (!parsed.valid) {
    return false;
  }

  const userId = interaction.user?.id ?? null;
  if (!userId || userId !== parsed.ownerId) {
    await sendSafeEphemeralError(
      interaction,
      'Hanya pengguna yang menjalankan perintah `!pin` yang dapat menggunakan tombol navigasi ini.',
    );
    return true;
  }

  const sessionStore = context?.pinterestSessionStore ?? defaultPinterestSessionStore;
  const outcome = sessionStore.paginate({
    sessionId: parsed.sessionId,
    userId,
    direction: parsed.action,
  });

  if (!outcome.ok) {
    if (outcome.reason === 'UNAUTHORIZED') {
      await sendSafeEphemeralError(
        interaction,
        'Hanya pengguna yang menjalankan perintah `!pin` yang dapat menggunakan tombol navigasi ini.',
      );
      return true;
    }

    await sendSafeEphemeralError(
      interaction,
      'Sesi pencarian Pinterest sudah kedaluwarsa (5 menit) atau tidak tersedia. Jalankan `!pin <keyword>` lagi.',
    );
    return true;
  }

  const logger = context?.logger ?? console;
  try {
    await interaction.update(buildPinterestView({ session: outcome.session }));
  } catch (err) {
    if (!IGNORED_DISCORD_ERROR_CODES.has(err?.code)) {
      logger.error?.('[Pinterest] Failed updating pagination embed:', sanitizeError(err));
    }
  }

  return true;
}

export { PIN_COOLDOWN_MS, PIN_CUSTOM_ID_PREFIX };
export default {
  name: 'pin',
  cooldownMs: PIN_COOLDOWN_MS,
  execute,
};
