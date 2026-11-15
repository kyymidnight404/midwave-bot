import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { createBaseEmbed } from './embeds.js';

export const LYRICS_EMBED_MAX_PAGE_CHARS = 4000;
export const LYRICS_DEFAULT_PAGE_CHARS = 1800;
export const LYRICS_PAGINATION_TIMEOUT_MS = 120_000;

const EMBED_DESCRIPTION_HARD_LIMIT = 4096;
const DIVIDER = '━━━━━━━━━━━━━━━━';

/**
 * Splits a single oversized line on word boundaries so words are not broken mid-word.
 * @param {string} line
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitLongLine(line, maxLen) {
  if (line.length <= maxLen) return [line];

  const segments = [];
  let remaining = line;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt <= 0) {
      splitAt = maxLen;
    }
    segments.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    segments.push(remaining);
  }

  return segments;
}

/**
 * Splits lyrics into readable pages within `maxCharsPerPage` (hard-capped at 4,000 chars)
 * while preferring paragraph/line breaks and never splitting mid-word when avoidable.
 *
 * @param {string} lyrics
 * @param {number} [maxCharsPerPage]
 * @returns {string[]}
 */
export function paginateLyrics(lyrics, maxCharsPerPage = LYRICS_DEFAULT_PAGE_CHARS) {
  const normalized = String(lyrics || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) {
    return [];
  }

  const effectiveMax = Math.min(Math.max(100, Math.floor(maxCharsPerPage)), LYRICS_EMBED_MAX_PAGE_CHARS);
  const rawLines = normalized.split('\n');
  const lines = [];

  for (const line of rawLines) {
    if (line.length <= effectiveMax) {
      lines.push(line);
    } else {
      lines.push(...splitLongLine(line, effectiveMax));
    }
  }

  const pages = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= effectiveMax) {
      current = candidate;
    } else {
      if (current.trim()) {
        pages.push(current.trim());
      }
      current = line.trimStart();
    }
  }

  if (current.trim()) {
    pages.push(current.trim());
  }

  return pages;
}

/**
 * Builds the modern Midwave Lyrics Finder embed for a single page.
 *
 * @param {{
 *   title: string,
 *   artist: string,
 *   album?: string | null,
 *   thumbnailUrl?: string | null,
 *   sourceName: string,
 *   sourceUrl?: string | null,
 * }} track
 * @param {{
 *   pages: string[],
 *   pageIndex?: number,
 *   requesterName?: string,
 *   requesterIconUrl?: string | null,
 * }} view
 * @returns {EmbedBuilder}
 */
export function buildLyricsEmbed(track, view) {
  const pages = Array.isArray(view?.pages) && view.pages.length > 0 ? view.pages : [''];
  const totalPages = pages.length;
  const pageIndex = Math.min(Math.max(0, view?.pageIndex ?? 0), totalPages - 1);
  const pageBody = pages[pageIndex] ?? '';

  const headerLines = [`**${track.title} — ${track.artist}**`];
  if (track.album) {
    headerLines.push(`Album: ${track.album}`);
  }
  const header = headerLines.join('\n');

  const sourceLine = track.sourceUrl
    ? `Source: [${track.sourceName}](${track.sourceUrl})`
    : `Source: ${track.sourceName}`;

  const prefix = `${header}\n\n${DIVIDER}\n\n`;
  const suffix = `\n\n${DIVIDER}\n${sourceLine}`;

  const availableForBody = Math.max(100, EMBED_DESCRIPTION_HARD_LIMIT - prefix.length - suffix.length);
  const safeBody = pageBody.length > availableForBody
    ? `${pageBody.slice(0, Math.max(0, availableForBody - 1)).trimEnd()}…`
    : pageBody;

  const description = `${prefix}${safeBody}${suffix}`;

  const embed = createBaseEmbed({
    title: '🎵 Lyrics Finder',
    description,
    color: COLORS.PRIMARY,
    includeThumbnail: false,
  });

  if (track.thumbnailUrl) {
    embed.setThumbnail(track.thumbnailUrl);
  }

  return embed;
}

/**
 * Builds Previous / Page Indicator / Next buttons for paginated lyrics embeds.
 *
 * @param {{
 *   currentPage: number,
 *   totalPages: number,
 *   disabled?: boolean,
 *   customIdPrefix?: string,
 * }} options
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildLyricsPaginationRow({
  currentPage,
  totalPages,
  disabled = false,
  customIdPrefix = 'lyrics',
}) {
  const safeTotal = Math.max(1, totalPages);
  const safePage = Math.min(Math.max(0, currentPage), safeTotal - 1);

  const prevBtn = new ButtonBuilder()
    .setCustomId(`${customIdPrefix}:prev`)
    .setLabel('◀ Previous')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || safePage <= 0);

  const pageIndicatorBtn = new ButtonBuilder()
    .setCustomId(`${customIdPrefix}:page`)
    .setLabel(`Page ${safePage + 1}/${safeTotal}`)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(true);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`${customIdPrefix}:next`)
    .setLabel('Next ▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || safePage >= safeTotal - 1);

  return new ActionRowBuilder().addComponents(prevBtn, pageIndicatorBtn, nextBtn);
}
