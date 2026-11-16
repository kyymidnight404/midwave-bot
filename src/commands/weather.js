import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  buildWeatherEmbed,
  fetchBmkgWeather,
  WEATHER_COOLDOWN_MS,
  WEATHER_MAX_LOCATION_LENGTH,
  WeatherError,
} from '../services/weatherService.js';
import { buildErrorEmbed, getIconFiles } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

export const data = new SlashCommandBuilder()
  .setName('weather')
  .setDescription('Cek prakiraan cuaca wilayah Indonesia langsung dari BMKG')
  .addStringOption((opt) =>
    opt
      .setName('location')
      .setDescription('Nama kota, kabupaten, kecamatan, atau kode wilayah ADM4 (contoh: Jakarta)')
      .setRequired(true)
      .setMaxLength(WEATHER_MAX_LOCATION_LENGTH),
  );

/**
 * Executes `/weather` and `!weather`.
 * @param {import('discord.js').ChatInputCommandInteraction | import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
 * @param {object} [context]
 */
export async function execute(interaction, context = {}) {
  const locationInput = interaction.options?.getString?.('location', false)?.trim() ?? '';
  if (!locationInput) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Masukkan nama lokasi di Indonesia. Contoh: `!weather Jakarta` atau `!weather Kemayoran, Jakarta`.',
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const weatherData = await fetchBmkgWeather(locationInput, {
      fetchFn: context?.fetchFn,
      nowMs: context?.nowMs,
    });
    const canAttach = interaction.canAttachFiles !== false;
    const embed = buildWeatherEmbed(weatherData, { includeThumbnail: canAttach });

    await interaction.editReply({
      embeds: [embed],
      files: canAttach ? getIconFiles('weather') : [],
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (err) {
    if (err instanceof WeatherError) {
      await interaction.editReply({
        embeds: [buildErrorEmbed(err.message)],
      });
      return;
    }

    context?.logger?.error?.('[Weather] Failed fetching BMKG weather:', sanitizeError(err));
    await interaction.editReply({
      embeds: [
        buildErrorEmbed(
          'Gagal mengambil data cuaca dari BMKG saat ini. Silakan coba beberapa saat lagi.',
        ),
      ],
    });
  }
}

export default { data, execute, WEATHER_COOLDOWN_MS };
