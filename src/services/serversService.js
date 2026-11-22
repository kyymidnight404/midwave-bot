import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { getComponentEmoji, getEmoji } from '../config/emojis.js';
import { createBaseEmbed } from '../utils/embeds.js';

export const SERVERS_PER_PAGE = 10;
export const SERVERS_CUSTOM_ID_PREFIX = 'servers';

const EMBED_DESCRIPTION_LIMIT = 4096;
const MAX_SERVER_NAME_LENGTH = 80;

/**
 * Resolves a safe HTTP/HTTPS server icon URL from a Discord.js Guild object if available.
 *
 * @param {any} guild
 * @returns {string | null}
 */
function resolveGuildIconUrl(guild) {
  let raw = null;
  try {
    if (typeof guild?.iconURL === 'function') {
      raw = guild.iconURL({ size: 128 });
    } else if (typeof guild?.iconURL === 'string') {
      raw = guild.iconURL;
    }
  } catch {
    return null;
  }

  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }

  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Extracts normalized guild metadata strictly from `client.guilds.cache`.
 * Handles missing member counts and missing icons safely.
 *
 * @param {import('discord.js').Client | null | undefined} client
 * @returns {{
 *   servers: Array<{ id: string, name: string, memberCount: number | null, iconUrl: string | null }>,
 *   totalServers: number,
 *   totalMembers: number | null,
 * }}
 */
export function extractBotServers(client) {
  const cache = client?.guilds?.cache;
  if (!cache) {
    return { servers: [], totalServers: 0, totalMembers: null };
  }

  const rawGuilds =
    typeof cache.values === 'function'
      ? Array.from(cache.values())
      : Array.isArray(cache)
        ? cache
        : [];

  const servers = [];
  let totalMembersSum = 0;
  let hasAnyMemberCount = false;

  for (const guild of rawGuilds) {
    if (!guild || typeof guild !== 'object') {
      continue;
    }

    const id = guild.id ? String(guild.id).trim() : 'Unknown ID';
    const rawName = typeof guild.name === 'string' ? guild.name.replace(/\s+/g, ' ').trim() : '';
    const name = rawName
      ? rawName.length > MAX_SERVER_NAME_LENGTH
        ? `${rawName.slice(0, MAX_SERVER_NAME_LENGTH - 3).trimEnd()}...`
        : rawName
      : 'Unknown Server';

    const memberCount =
      typeof guild.memberCount === 'number' && Number.isFinite(guild.memberCount) && guild.memberCount >= 0
        ? Math.floor(guild.memberCount)
        : null;

    if (memberCount !== null) {
      totalMembersSum += memberCount;
      hasAnyMemberCount = true;
    }

    servers.push({
      id,
      name,
      memberCount,
      iconUrl: resolveGuildIconUrl(guild),
    });
  }

  return {
    servers,
    totalServers: servers.length,
    totalMembers: hasAnyMemberCount ? totalMembersSum : null,
  };
}

/**
 * Slices a server list for a single pagination page (max 10 items per page).
 *
 * @param {Array<object>} servers
 * @param {number} [page]
 * @param {number} [perPage]
 */
export function paginateServers(servers, page = 0, perPage = SERVERS_PER_PAGE) {
  const list = Array.isArray(servers) ? servers : [];
  const safePerPage = Math.max(1, Math.min(SERVERS_PER_PAGE, Math.floor(Number(perPage) || SERVERS_PER_PAGE)));
  const totalServers = list.length;
  const totalPages = Math.max(1, Math.ceil(totalServers / safePerPage));
  const parsedPage = Number.isInteger(page) ? page : Number.parseInt(String(page ?? 0), 10);
  const currentPage = Number.isFinite(parsedPage)
    ? Math.min(Math.max(0, parsedPage), totalPages - 1)
    : 0;
  const startIndex = currentPage * safePerPage;

  return {
    items: list.slice(startIndex, startIndex + safePerPage),
    currentPage,
    totalPages,
    totalServers,
    startIndex,
  };
}

/**
 * Builds a pagination customId: `servers:<action>:<targetPage>:<ownerId>`.
 *
 * @param {'prev' | 'next'} action
 * @param {number} targetPage
 * @param {string} ownerId
 * @returns {string}
 */
export function buildServersCustomId(action, targetPage, ownerId) {
  return `${SERVERS_CUSTOM_ID_PREFIX}:${action}:${targetPage}:${ownerId}`;
}

/**
 * Parses and validates a `servers:<action>:<targetPage>:<ownerId>` customId.
 *
 * @param {unknown} customId
 * @returns {{ valid: boolean, action?: 'prev' | 'next', targetPage?: number, ownerId?: string }}
 */
export function parseServersCustomId(customId) {
  if (typeof customId !== 'string') {
    return { valid: false };
  }
  const parts = customId.split(':');
  if (parts.length !== 4 || parts[0] !== SERVERS_CUSTOM_ID_PREFIX) {
    return { valid: false };
  }
  const [, action, rawPage, ownerId] = parts;
  const targetPage = Number.parseInt(rawPage, 10);
  if (
    (action !== 'prev' && action !== 'next') ||
    !Number.isInteger(targetPage) ||
    targetPage < 0 ||
    !ownerId
  ) {
    return { valid: false };
  }
  return { valid: true, action, targetPage, ownerId };
}

function formatServerEntry(server, number) {
  const lines = [
    `${number}. **${server.name}**`,
    `   ID: \`${server.id}\``,
  ];

  const metaParts = [];
  if (server.memberCount !== null) {
    metaParts.push(`Members: ${server.memberCount.toLocaleString('en-US')}`);
  }
  if (server.iconUrl) {
    metaParts.push(`[Icon](${server.iconUrl})`);
  }
  if (metaParts.length > 0) {
    lines.push(`   ${metaParts.join(' • ')}`);
  }

  return lines.join('\n');
}

/**
 * Builds the minimalist Midwave Server List Embed for a single page.
 *
 * @param {{
 *   items: Array<{ id: string, name: string, memberCount: number | null, iconUrl: string | null }>,
 *   totalServers: number,
 *   totalMembers: number | null,
 *   currentPage: number,
 *   totalPages: number,
 *   startIndex: number,
 * }} data
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildServersEmbed({
  items,
  totalServers,
  totalMembers,
  currentPage,
  totalPages,
  startIndex,
}) {
  const headerLines = [`Total Servers: **${totalServers}**`];
  if (totalMembers !== null) {
    headerLines.push(`Total Members: **${totalMembers.toLocaleString('en-US')}**`);
  }

  let bodyText;
  if (!Array.isArray(items) || items.length === 0) {
    bodyText = 'Bot belum tergabung di server mana pun.';
  } else {
    bodyText = items
      .map((server, idx) => formatServerEntry(server, startIndex + idx + 1))
      .join('\n\n');
  }

  const header = headerLines.join('\n');
  let description = `${header}\n\n${bodyText}`;
  if (description.length > EMBED_DESCRIPTION_LIMIT) {
    description = `${description.slice(0, EMBED_DESCRIPTION_LIMIT - 4).trimEnd()}\n...`;
  }

  const embed = createBaseEmbed({
    title: `${getEmoji('users')} Midwave — Server List`,
    description,
    color: COLORS.PRIMARY,
    includeThumbnail: false,
    footer: `Page ${currentPage + 1}/${totalPages} • MIDWAVE`,
  });

  const firstIconUrl = Array.isArray(items)
    ? items.find((s) => typeof s?.iconUrl === 'string' && s.iconUrl)?.iconUrl ?? null
    : null;
  if (firstIconUrl) {
    embed.setThumbnail(firstIconUrl);
  }

  return embed;
}

/**
 * Builds the Previous / Next pagination ActionRow for `!servers`.
 *
 * @param {{
 *   currentPage: number,
 *   totalPages: number,
 *   ownerId: string,
 *   disabled?: boolean,
 * }} options
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildServersPaginationRow({
  currentPage,
  totalPages,
  ownerId,
  disabled = false,
}) {
  const safeTotalPages = Math.max(1, totalPages);
  const safePage = Math.min(Math.max(0, currentPage), safeTotalPages - 1);

  const prevBtn = new ButtonBuilder()
    .setCustomId(buildServersCustomId('prev', Math.max(0, safePage - 1), ownerId))
    .setLabel('Previous')
    .setEmoji(getComponentEmoji('back'))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(Boolean(disabled) || safePage <= 0);

  const nextBtn = new ButtonBuilder()
    .setCustomId(buildServersCustomId('next', Math.min(safeTotalPages - 1, safePage + 1), ownerId))
    .setLabel('Next')
    .setEmoji(getComponentEmoji('next'))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(Boolean(disabled) || safePage >= safeTotalPages - 1);

  return new ActionRowBuilder().addComponents(prevBtn, nextBtn);
}

/**
 * Renders the full Discord message payload for a `!servers` page.
 *
 * @param {{
 *   snapshot: ReturnType<typeof extractBotServers>,
 *   page?: number,
 *   ownerId: string,
 *   disabled?: boolean,
 * }} params
 */
export function buildServersView({ snapshot, page = 0, ownerId, disabled = false }) {
  const paginated = paginateServers(snapshot?.servers ?? [], page, SERVERS_PER_PAGE);
  const embed = buildServersEmbed({
    items: paginated.items,
    totalServers: snapshot?.totalServers ?? 0,
    totalMembers: snapshot?.totalMembers ?? null,
    currentPage: paginated.currentPage,
    totalPages: paginated.totalPages,
    startIndex: paginated.startIndex,
  });

  const components =
    paginated.totalPages > 1
      ? [
          buildServersPaginationRow({
            currentPage: paginated.currentPage,
            totalPages: paginated.totalPages,
            ownerId,
            disabled,
          }),
        ]
      : [];

  return {
    embeds: [embed],
    components,
    allowedMentions: { parse: [], repliedUser: false },
  };
}
