import { ComponentType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  ANIME_COOLDOWN_MS,
  ANIME_MAX_QUERY_LENGTH,
  AnimeServiceError,
  searchAnime,
  validateAnimeQuery,
} from '../services/animeService.js';
import {
  ANIME_SELECTION_TIMEOUT_MS,
  buildAnimeComponents,
  buildAnimeEmbed,
  buildAnimeLoadingEmbed,
} from '../utils/animeEmbed.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { redactSensitiveText, sanitizeError } from '../utils/errorSanitizer.js';

const IGNORED_DISCORD_ERROR_CODES = new Set([10003, 10008, 10062, 40060]);

export const data = new SlashCommandBuilder()
  .setName('anime')
  .setDescription('Cari informasi lengkap anime dari AniList berdasarkan judul')
  .addStringOption((option) =>
    option
      .setName('query')
      .setDescription('Judul anime yang ingin dicari (contoh: Sousou no Frieren, One Piece, Naruto)')
      .setRequired(true)
      .setMaxLength(ANIME_MAX_QUERY_LENGTH),
  );

/**
 * Safely maps any thrown error from anime lookup into a user-facing `AnimeServiceError`.
 * @param {unknown} error
 * @returns {AnimeServiceError}
 */
export function normalizeAnimeError(error) {
  if (error instanceof AnimeServiceError) {
    return error;
  }
  const message = redactSensitiveText(
    error instanceof Error ? error.message : String(error ?? 'Unknown error'),
  );
  return new AnimeServiceError(
    'INTERNAL_ERROR',
    'Terjadi kesalahan internal saat memproses pencarian anime. Silakan coba lagi.',
    `msg=${message.slice(0, 180)}`,
  );
}

/**
 * Safely delivers an error embed after `deferReply()`.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} message
 */
async function sendSafeAnimeError(interaction, message) {
  try {
    await interaction.editReply({
      embeds: [buildErrorEmbed(message)],
      components: [],
    });
  } catch (sendErr) {
    if (!IGNORED_DISCORD_ERROR_CODES.has(sendErr?.code)) {
      console.error('[Anime] Failed to deliver error embed:', sanitizeError(sendErr));
    }
  }
}

/**
 * Executes `/anime` (and shared `!anime` flow) with loading state, AniList GraphQL lookup,
 * synopsis truncation, and interactive selection when multiple ambiguous titles are found.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
 * @param {{
 *   searchAnime?: typeof searchAnime,
 *   animeOptions?: object,
 *   synopsisMaxLength?: number,
 *   selectionTimeoutMs?: number,
 * }} [context]
 */
export async function execute(interaction, context = {}) {
  if (interaction?.user?.bot) {
    return;
  }

  const rawQuery = interaction.options?.getString?.('query', false) ?? '';

  let query;
  try {
    query = validateAnimeQuery(rawQuery);
  } catch (error) {
    await interaction.reply({
      embeds: [buildErrorEmbed(error.message)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    await interaction.editReply({
      embeds: [buildAnimeLoadingEmbed(query)],
      components: [],
    });
  } catch {
    // Ignore transient loading update failure and continue with lookup
  }

  let searchResult;
  try {
    const searchFn = context.searchAnime ?? searchAnime;
    searchResult = await searchFn({ query }, context.animeOptions);
  } catch (error) {
    const mapped = normalizeAnimeError(error);
    console.error(
      `[Anime] Search failed (${mapped.code})${mapped.debugDetail ? ` | ${mapped.debugDetail}` : ''}`,
    );
    await sendSafeAnimeError(interaction, mapped.message);
    return;
  }

  const results = Array.isArray(searchResult?.results) ? searchResult.results : [];
  if (results.length === 0) {
    await sendSafeAnimeError(
      interaction,
      `Anime dengan judul **${query}** tidak ditemukan. Coba periksa ejaan atau gunakan judul Romaji/English.`,
    );
    return;
  }

  let selectedIndex = 0;
  const customIdPrefix = `anime:${interaction.id ?? Date.now()}`;

  const buildView = (index, disabled = false) => {
    const currentAnime = results[index] ?? results[0];
    return {
      embeds: [
        buildAnimeEmbed(currentAnime, {
          candidates: results,
          selectedIndex: index,
          synopsisMaxLength: context.synopsisMaxLength,
        }),
      ],
      components: buildAnimeComponents({
        anime: currentAnime,
        candidates: results,
        selectedIndex: index,
        customIdPrefix,
        disabled,
      }),
    };
  };

  let replyMessage;
  try {
    replyMessage = await interaction.editReply(buildView(selectedIndex));
  } catch (discordError) {
    if (!IGNORED_DISCORD_ERROR_CODES.has(discordError?.code)) {
      console.error('[Anime] Failed to send anime embed:', sanitizeError(discordError));
    }
    return;
  }

  if (results.length <= 1 || typeof replyMessage?.createMessageComponentCollector !== 'function') {
    return;
  }

  const timeoutMs = context.selectionTimeoutMs ?? ANIME_SELECTION_TIMEOUT_MS;
  const collector = replyMessage.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: timeoutMs,
  });

  collector.on('collect', async (selectInteraction) => {
    try {
      if (selectInteraction.user?.id !== interaction.user?.id) {
        await selectInteraction.reply({
          embeds: [
            buildErrorEmbed(
              'Hanya pengguna yang menjalankan perintah anime ini yang dapat memilih hasil pencarian.',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (selectInteraction.customId === `${customIdPrefix}:select`) {
        const chosenIdx = Number(selectInteraction.values?.[0]);
        if (Number.isInteger(chosenIdx) && chosenIdx >= 0 && chosenIdx < results.length) {
          selectedIndex = chosenIdx;
        }
      }

      await selectInteraction.update(buildView(selectedIndex));
    } catch (selectErr) {
      if (!IGNORED_DISCORD_ERROR_CODES.has(selectErr?.code)) {
        console.error('[Anime] Selection menu error:', sanitizeError(selectErr));
      }
    }
  });

  collector.on('end', async () => {
    try {
      await interaction.editReply(buildView(selectedIndex, true));
    } catch (endErr) {
      if (!IGNORED_DISCORD_ERROR_CODES.has(endErr?.code)) {
        console.warn('[Anime] Failed to disable select menu on timeout:', sanitizeError(endErr));
      }
    }
  });
}

export default { name: 'anime', data, execute, ANIME_COOLDOWN_MS };
