import { ComponentType, MessageFlags } from 'discord.js';
import {
  LyricsServiceError,
  searchLyrics,
  validateLyricsInput,
} from '../services/lyricsService.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { redactSensitiveText, sanitizeError } from '../utils/errorSanitizer.js';
import {
  LYRICS_PAGINATION_TIMEOUT_MS,
  buildLyricsEmbed,
  buildLyricsPaginationRow,
  paginateLyrics,
} from '../utils/lyricsFormatter.js';

const IGNORED_DISCORD_ERROR_CODES = new Set([10003, 10008, 10062, 40060]);

/**
 * Safely maps any thrown error from lyrics lookup into a user-facing `LyricsServiceError`.
 * @param {unknown} error
 * @returns {LyricsServiceError}
 */
function normalizeLyricsError(error) {
  if (error instanceof LyricsServiceError) {
    return error;
  }
  const message = redactSensitiveText(
    error instanceof Error ? error.message : String(error ?? 'Unknown error'),
  );
  return new LyricsServiceError(
    'INTERNAL_ERROR',
    'Terjadi kesalahan internal saat memproses pencarian lirik. Silakan coba lagi.',
    `msg=${message.slice(0, 180)}`,
  );
}

/**
 * Safely delivers an error embed after `deferReply()`.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} message
 */
async function sendSafeLyricsError(interaction, message) {
  try {
    await interaction.editReply({
      embeds: [buildErrorEmbed(message)],
      components: [],
    });
  } catch (sendErr) {
    if (!IGNORED_DISCORD_ERROR_CODES.has(sendErr?.code)) {
      console.error('[Lyrics] Failed to deliver error embed:', sanitizeError(sendErr));
    }
  }
}

/**
 * Executes Lyrics search with deferred loading and interactive pagination
 * for both `/media action:lyrics` and `!lyrics` / `!lirik`.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{
 *   searchLyrics?: typeof searchLyrics,
 *   lyricsOptions?: object,
 *   maxCharsPerPage?: number,
 *   paginationTimeoutMs?: number,
 * }} [context]
 */
export async function execute(interaction, context = {}) {
  if (interaction.user?.bot) {
    return;
  }

  const rawQuery = interaction.options?.getString?.('query', false) ?? '';
  const rawArtist = interaction.options?.getString?.('artist', false) ?? null;

  let validated;
  try {
    validated = validateLyricsInput(rawQuery, rawArtist);
  } catch (error) {
    await interaction.reply({
      embeds: [buildErrorEmbed(error.message)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  let track;
  try {
    const searchFn = context.searchLyrics ?? searchLyrics;
    track = await searchFn(validated, context.lyricsOptions);
  } catch (error) {
    const mapped = normalizeLyricsError(error);
    console.error(
      `[Lyrics] Search failed (${mapped.code})${mapped.debugDetail ? ` | ${mapped.debugDetail}` : ''}`,
    );
    await sendSafeLyricsError(interaction, mapped.message);
    return;
  }

  const pages = paginateLyrics(track?.lyrics, context.maxCharsPerPage);
  if (pages.length === 0) {
    await sendSafeLyricsError(
      interaction,
      `Lagu **${track?.title || validated.query} — ${track?.artist || validated.artist || 'Unknown Artist'}** ditemukan, tetapi liriknya belum tersedia.`,
    );
    return;
  }

  const requesterName =
    interaction.user?.username ||
    interaction.user?.globalName ||
    'user';
  const requesterIconUrl = typeof interaction.user?.displayAvatarURL === 'function'
    ? interaction.user.displayAvatarURL({ size: 64 })
    : null;

  let currentPage = 0;
  const customIdPrefix = `lyrics:${interaction.id ?? Date.now()}`;
  const buildView = (pageIndex, disabled = false) => ({
    embeds: [
      buildLyricsEmbed(track, {
        pages,
        pageIndex,
        requesterName,
        requesterIconUrl,
      }),
    ],
    components:
      pages.length > 1
        ? [
            buildLyricsPaginationRow({
              currentPage: pageIndex,
              totalPages: pages.length,
              disabled,
              customIdPrefix,
            }),
          ]
        : [],
  });

  let replyMessage;
  try {
    replyMessage = await interaction.editReply(buildView(currentPage));
  } catch (discordError) {
    if (!IGNORED_DISCORD_ERROR_CODES.has(discordError?.code)) {
      console.error('[Lyrics] Failed to send lyrics embed:', sanitizeError(discordError));
    }
    return;
  }

  if (pages.length <= 1 || typeof replyMessage?.createMessageComponentCollector !== 'function') {
    return;
  }

  const timeoutMs = context.paginationTimeoutMs ?? LYRICS_PAGINATION_TIMEOUT_MS;
  const collector = replyMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeoutMs,
  });

  collector.on('collect', async (btnInteraction) => {
    try {
      if (btnInteraction.user?.id !== interaction.user.id) {
        await btnInteraction.reply({
          embeds: [
            buildErrorEmbed('Hanya pengguna yang menjalankan perintah lirik ini yang dapat mengontrol tombol halaman ini.'),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (btnInteraction.customId === `${customIdPrefix}:prev`) {
        currentPage = Math.max(0, currentPage - 1);
      } else if (btnInteraction.customId === `${customIdPrefix}:next`) {
        currentPage = Math.min(pages.length - 1, currentPage + 1);
      }

      await btnInteraction.update(buildView(currentPage));
    } catch (btnErr) {
      if (!IGNORED_DISCORD_ERROR_CODES.has(btnErr?.code)) {
        console.error('[Lyrics] Pagination button error:', sanitizeError(btnErr));
      }
    }
  });

  collector.on('end', async () => {
    try {
      await interaction.editReply(buildView(currentPage, true));
    } catch (endErr) {
      if (!IGNORED_DISCORD_ERROR_CODES.has(endErr?.code)) {
        console.warn('[Lyrics] Failed to disable pagination buttons on timeout:', sanitizeError(endErr));
      }
    }
  });
}

export default { name: 'lyrics', execute };
