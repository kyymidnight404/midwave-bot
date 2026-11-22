import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { getComponentEmoji } from '../config/emojis.js';
import { createBaseEmbed } from './embeds.js';

export const PIN_CUSTOM_ID_PREFIX = 'pin';

const EMBED_TITLE_MAX_LENGTH = 256;

/**
 * Builds a Discord component customId for Pinterest pagination buttons.
 *
 * @param {'prev' | 'next'} action
 * @param {string} sessionId
 * @param {string} ownerId
 * @returns {string}
 */
export function buildPinterestCustomId(action, sessionId, ownerId) {
  return `${PIN_CUSTOM_ID_PREFIX}:${action}:${sessionId}:${ownerId}`;
}

/**
 * Parses and validates a `pin:<action>:<sessionId>:<ownerId>` customId.
 *
 * @param {unknown} customId
 * @returns {{ valid: boolean, action?: 'prev' | 'next', sessionId?: string, ownerId?: string }}
 */
export function parsePinterestCustomId(customId) {
  if (typeof customId !== 'string') {
    return { valid: false };
  }
  const parts = customId.split(':');
  if (parts.length !== 4 || parts[0] !== PIN_CUSTOM_ID_PREFIX) {
    return { valid: false };
  }
  const [, action, sessionId, ownerId] = parts;
  if ((action !== 'prev' && action !== 'next') || !sessionId || !ownerId) {
    return { valid: false };
  }
  return { valid: true, action, sessionId, ownerId };
}

/**
 * Builds the minimalist single-result Pinterest Search Discord Embed.
 *
 * Structure:
 * - Author: Pinterest
 * - Title: Pin title
 * - Image: Active Pin image or thumbnail
 * - Footer: `{currentIndex}/{totalResults} • {keyword}`
 *
 * @param {{
 *   title: string,
 *   thumbnailUrl: string,
 *   pinUrl: string,
 * }} pin
 * @param {{
 *   currentIndex: number,
 *   total: number,
 *   query?: string,
 * }} meta
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildPinterestEmbed(pin, { currentIndex = 0, total = 1, query = '' } = {}) {
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeIndex = Math.min(Math.max(0, Number(currentIndex) || 0), safeTotal - 1);
  const pageIndicator = `${safeIndex + 1}/${safeTotal}`;

  const rawTitle = String(pin?.title || 'Untitled Pin').trim() || 'Untitled Pin';
  const title =
    rawTitle.length > EMBED_TITLE_MAX_LENGTH
      ? `${rawTitle.slice(0, EMBED_TITLE_MAX_LENGTH - 3).trimEnd()}...`
      : rawTitle;
  const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim();
  const footerText = cleanQuery ? `${pageIndicator} • ${cleanQuery}` : pageIndicator;

  const embed = createBaseEmbed({
    title,
    color: COLORS.PRIMARY,
    includeThumbnail: false,
    footer: footerText.slice(0, 2048),
  }).setAuthor({ name: 'Pinterest' });

  if (pin?.pinUrl) {
    embed.setURL(pin.pinUrl);
  }

  if (pin?.thumbnailUrl) {
    embed.setImage(pin.thumbnailUrl);
  }

  return embed;
}

/**
 * Builds the single ActionRow with exactly three buttons:
 * 1. `Prev` (ButtonStyle.Secondary) — disabled on first result or when expired
 * 2. `Link` (ButtonStyle.Link) — active Pin URL
 * 3. `Next` (ButtonStyle.Secondary) — disabled on last result or when expired
 *
 * @param {{
 *   currentIndex: number,
 *   total: number,
 *   pinUrl: string,
 *   sessionId: string,
 *   ownerId: string,
 *   disabled?: boolean,
 * }} options
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildPinterestActionRow({
  currentIndex,
  total,
  pinUrl,
  sessionId,
  ownerId,
  disabled = false,
}) {
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeIndex = Math.min(Math.max(0, Number(currentIndex) || 0), safeTotal - 1);

  const prevButton = new ButtonBuilder()
    .setCustomId(buildPinterestCustomId('prev', sessionId, ownerId))
    .setLabel('Prev')
    .setEmoji(getComponentEmoji('back'))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(Boolean(disabled) || safeIndex <= 0);

  const linkButton = new ButtonBuilder()
    .setLabel('Link')
    .setEmoji(getComponentEmoji('link'))
    .setStyle(ButtonStyle.Link)
    .setURL(pinUrl);

  const nextButton = new ButtonBuilder()
    .setCustomId(buildPinterestCustomId('next', sessionId, ownerId))
    .setLabel('Next')
    .setEmoji(getComponentEmoji('next'))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(Boolean(disabled) || safeIndex >= safeTotal - 1);

  return new ActionRowBuilder().addComponents(prevButton, linkButton, nextButton);
}

/**
 * Renders the full message payload (single Embed + 1 ActionRow) for a Pinterest search session.
 *
 * @param {{
 *   session: {
 *     sessionId: string,
 *     userId: string,
 *     query?: string,
 *     results: Array<object>,
 *     currentIndex: number,
 *   },
 *   disabled?: boolean,
 * }} params
 * @returns {{
 *   embeds: import('discord.js').EmbedBuilder[],
 *   components: ActionRowBuilder<ButtonBuilder>[],
 *   allowedMentions: { parse: string[], repliedUser: boolean },
 * }}
 */
export function buildPinterestView({ session, disabled = false }) {
  const results = Array.isArray(session?.results) ? session.results : [];
  const total = Math.max(1, results.length);
  const currentIndex = Math.min(Math.max(0, session?.currentIndex ?? 0), total - 1);
  const activePin = results[currentIndex];

  const embed = buildPinterestEmbed(activePin, {
    currentIndex,
    total,
    query: session?.query ?? '',
  });

  const row = buildPinterestActionRow({
    currentIndex,
    total,
    pinUrl: activePin.pinUrl,
    sessionId: session.sessionId,
    ownerId: session.userId,
    disabled,
  });

  return {
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [], repliedUser: false },
  };
}
