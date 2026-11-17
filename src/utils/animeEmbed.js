import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { COLORS } from '../config/colors.js';
import {
  ANIME_SYNOPSIS_MAX_LENGTH,
  truncateSynopsis,
} from '../services/animeService.js';
import { createBaseEmbed } from './embeds.js';

export const ANIME_SELECTION_TIMEOUT_MS = 120_000;

const STATUS_LABELS = Object.freeze({
  FINISHED: 'Selesai Tayang (Finished)',
  RELEASING: 'Sedang Tayang (Releasing)',
  NOT_YET_RELEASED: 'Belum Rilis (Upcoming)',
  CANCELLED: 'Dibatalkan (Cancelled)',
  HIATUS: 'Hiatus',
});

const FORMAT_LABELS = Object.freeze({
  TV: 'TV Series',
  TV_SHORT: 'TV Short',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Music',
});

const MONTH_NAMES_ID = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
]);

/**
 * Formats an AniList status enum into a clean label.
 * @param {string | null | undefined} status
 * @returns {string}
 */
export function formatAnimeStatus(status) {
  if (!status) return '-';
  return STATUS_LABELS[status] ?? status;
}

/**
 * Formats an AniList media format enum into a clean label.
 * @param {string | null | undefined} format
 * @returns {string}
 */
export function formatAnimeFormat(format) {
  if (!format) return '-';
  return FORMAT_LABELS[format] ?? format;
}

/**
 * Formats an AniList fuzzy date `{ year, month, day }` into a readable Indonesian date string.
 * @param {{ year?: number | null, month?: number | null, day?: number | null } | null | undefined} startDate
 * @returns {string | null}
 */
export function formatAnimeStartDate(startDate) {
  if (!startDate || typeof startDate !== 'object') return null;
  const { year, month, day } = startDate;
  if (!year && !month && !day) return null;

  const monthLabel = typeof month === 'number' && month >= 1 && month <= 12
    ? MONTH_NAMES_ID[month - 1]
    : null;

  if (day && monthLabel && year) {
    return `${day} ${monthLabel} ${year}`;
  }
  if (monthLabel && year) {
    return `${monthLabel} ${year}`;
  }
  if (year) {
    return String(year);
  }
  return null;
}

/**
 * Builds the loading embed shown while AniList GraphQL API is being queried.
 * @param {string} query
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildAnimeLoadingEmbed(query) {
  return createBaseEmbed({
    title: '🎬 Mencari Informasi Anime...',
    description: `⏳ Sedang mencari **${query}** di AniList, mohon tunggu sebentar...`,
    color: COLORS.INFO,
    includeThumbnail: false,
  });
}

/**
 * Builds the Midwave Discord Embed for an anime entry from AniList.
 *
 * @param {import('../services/animeService.js').parseAniListMedia extends (a: any) => infer R ? R : any} anime
 * @param {{
 *   candidates?: any[],
 *   selectedIndex?: number,
 *   synopsisMaxLength?: number,
 * }} [options]
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildAnimeEmbed(anime, options = {}) {
  const {
    candidates = [],
    selectedIndex = 0,
    synopsisMaxLength = ANIME_SYNOPSIS_MAX_LENGTH,
  } = options;

  const romajiTitle = anime?.title?.romaji || 'Unknown Title';
  const englishTitle = anime?.title?.english || null;
  const nativeTitle = anime?.title?.native || null;
  const siteUrl = anime?.siteUrl || (anime?.id ? `https://anilist.co/anime/${anime.id}` : 'https://anilist.co');

  const subtitleLines = [];
  if (englishTitle && englishTitle.toLowerCase() !== romajiTitle.toLowerCase()) {
    subtitleLines.push(`🇺🇸 **English:** ${englishTitle}`);
  } else {
    subtitleLines.push(`🇺🇸 **English:** ${englishTitle || '-'}`);
  }
  if (nativeTitle) {
    subtitleLines.push(`🇯🇵 **Jepang:** ${nativeTitle}`);
  }

  const synopsisText = truncateSynopsis(anime?.description ?? anime?.synopsis ?? '', synopsisMaxLength);

  const descriptionParts = [
    subtitleLines.join('\n'),
    '',
    `📖 **Sinopsis**\n${synopsisText}`,
  ];

  const embed = createBaseEmbed({
    title: `🎬 ${romajiTitle}`,
    description: descriptionParts.join('\n'),
    color: COLORS.PRIMARY,
    includeThumbnail: false,
  });

  if (siteUrl) {
    embed.setURL(siteUrl);
  }

  if (anime?.coverImage) {
    embed.setThumbnail(anime.coverImage);
  }

  const scoreText = typeof anime?.averageScore === 'number'
    ? `⭐ ${anime.averageScore}% (${(anime.averageScore / 10).toFixed(1)}/10)`
    : 'Belum ada rating';
  const episodesText = typeof anime?.episodes === 'number'
    ? `${anime.episodes} Episode`
    : 'Belum diketahui';
  const yearText = anime?.seasonYear ? String(anime.seasonYear) : (anime?.startDate?.year ? String(anime.startDate.year) : '-');
  const genresText = Array.isArray(anime?.genres) && anime.genres.length > 0
    ? anime.genres.join(', ')
    : '-';

  embed.addFields(
    { name: '🆔 ID Anime', value: `\`${anime?.id || '-'}\``, inline: true },
    { name: '📺 Format', value: formatAnimeFormat(anime?.format), inline: true },
    { name: '📡 Status', value: formatAnimeStatus(anime?.status), inline: true },
    { name: '⭐ Rating', value: scoreText, inline: true },
    { name: '🎞️ Jumlah Episode', value: episodesText, inline: true },
    { name: '📅 Tahun Rilis', value: yearText, inline: true },
    { name: '🏷️ Genre', value: genresText, inline: false },
  );

  if (typeof anime?.duration === 'number' && anime.duration > 0) {
    embed.addFields({
      name: '⏱️ Durasi Episode',
      value: `${anime.duration} menit / eps`,
      inline: true,
    });
  }

  if (Array.isArray(anime?.studios) && anime.studios.length > 0) {
    embed.addFields({
      name: '🏢 Studio',
      value: anime.studios.join(', '),
      inline: true,
    });
  }

  const formattedStartDate = formatAnimeStartDate(anime?.startDate);
  if (formattedStartDate) {
    embed.addFields({
      name: '🗓️ Tanggal Rilis',
      value: formattedStartDate,
      inline: true,
    });
  }

  const linkLines = [`🔗 [Halaman AniList](${siteUrl})`];
  if (anime?.trailer?.url) {
    linkLines.push(`▶️ [Tonton Trailer (${anime.trailer.site})](${anime.trailer.url})`);
  } else if (anime?.trailer?.site && anime?.trailer?.id) {
    linkLines.push(`▶️ Trailer: ${anime.trailer.site} (\`${anime.trailer.id}\`)`);
  }

  embed.addFields({
    name: '🌐 Tautan & Trailer',
    value: linkLines.join(' • '),
    inline: false,
  });

  if (Array.isArray(candidates) && candidates.length > 1) {
    const candidateLines = candidates.slice(0, 5).map((item, idx) => {
      const marker = idx === selectedIndex ? '🔹' : `${idx + 1}.`;
      const itemYear = item.seasonYear || item.startDate?.year || '?';
      const itemFormat = item.format || 'ANIME';
      return `${marker} **${item.title?.romaji || 'Unknown'}** (${itemFormat}, ${itemYear})`;
    });
    embed.addFields({
      name: `🔎 Hasil Pencarian Terkait (${candidates.length} ditemukan)`,
      value: candidateLines.join('\n'),
      inline: false,
    });
  }

  return embed;
}

/**
 * Builds interactive components for anime results:
 * - Link buttons for AniList & Trailer
 * - Optional StringSelectMenu when multiple ambiguous results exist
 *
 * @param {{
 *   anime: any,
 *   candidates?: any[],
 *   selectedIndex?: number,
 *   customIdPrefix?: string,
 *   disabled?: boolean,
 * }} options
 * @returns {ActionRowBuilder[]}
 */
export function buildAnimeComponents({
  anime,
  candidates = [],
  selectedIndex = 0,
  customIdPrefix = 'anime',
  disabled = false,
}) {
  const rows = [];

  if (Array.isArray(candidates) && candidates.length > 1) {
    const selectOptions = candidates.slice(0, 10).map((item, idx) => {
      const romaji = String(item.title?.romaji || 'Unknown Title').slice(0, 95);
      const english = item.title?.english ? String(item.title.english) : '';
      const year = item.seasonYear || item.startDate?.year || '-';
      const format = formatAnimeFormat(item.format);
      const desc = `${format} • ${year}${english ? ` • ${english}` : ''}`.slice(0, 100);

      return new StringSelectMenuOptionBuilder()
        .setLabel(romaji)
        .setValue(String(idx))
        .setDescription(desc)
        .setDefault(idx === selectedIndex);
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`${customIdPrefix}:select`)
      .setPlaceholder('Pilih judul anime lain yang sesuai...')
      .setDisabled(disabled)
      .addOptions(selectOptions);

    rows.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  const linkButtons = [];
  if (anime?.siteUrl) {
    linkButtons.push(
      new ButtonBuilder()
        .setLabel('Lihat di AniList')
        .setStyle(ButtonStyle.Link)
        .setURL(anime.siteUrl),
    );
  }
  if (anime?.trailer?.url) {
    linkButtons.push(
      new ButtonBuilder()
        .setLabel('Tonton Trailer')
        .setStyle(ButtonStyle.Link)
        .setURL(anime.trailer.url),
    );
  }

  if (linkButtons.length > 0) {
    rows.push(new ActionRowBuilder().addComponents(linkButtons));
  }

  return rows;
}
