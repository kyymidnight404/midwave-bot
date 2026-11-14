import { COLORS, EMBED_FOOTER } from './constants.js';
import { createBaseEmbed } from './embeds.js';

export const DISCORD_MAX_MESSAGE_LENGTH = 2000;
export const DISCORD_EMBED_DESCRIPTION_LIMIT = 3800;
export const DISCORD_EMBED_FIELD_LIMIT = 1024;
const SAFE_CHUNK_BUDGET = 1980;

/**
 * Neutralizes `@everyone` and `@here` mentions to prevent mass pings from AI output.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeAiMentions(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/@(everyone|here)/gi, '@\u200B$1');
}

const OFFICIAL_MIDWAVE_LINKS = [
  { label: 'repository', url: 'https://github.com/kyymidnight404/midwave-bot' },
  { label: 'github', url: 'https://github.com/kyymidnight404' },
  { label: 'website', url: 'https://midwave.ai.id/' },
];

/**
 * Ensures official Midwave URLs are formatted as clean Discord Markdown masked links
 * (`[label](URL)`) without double URLs or backslash escaping, while leaving code blocks
 * and all other text untouched.
 *
 * @param {string} text
 * @returns {string}
 */
export function formatDiscordMaskedLinks(text) {
  if (typeof text !== 'string' || !text) return '';

  // Split by fenced code blocks or inline code so code snippets remain untouched.
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return segments
    .map((segment, idx) => {
      if (idx % 2 === 1) return segment;

      let out = segment
        // Remove accidental backslash escaping inside Markdown links: [label]\(https\://...\)
        .replace(/\[([^\]]+)\]\s*\\\(\s*(https?)\\?:\/\/([^)\\]+)\\?\)/gi, '[$1]($2://$3)');

      for (const { label, url } of OFFICIAL_MIDWAVE_LINKS) {
        const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '/?');
        // Fix duplicated URL label: [https://midwave.ai.id/](https://midwave.ai.id/) -> [website](https://midwave.ai.id/)
        out = out.replace(
          new RegExp(`\\[https?:\\/\\/[^\\]]*\\]\\((${escapedUrl})\\)`, 'gi'),
          `[${label}](${url})`,
        );
        // Convert bare official URLs (not already inside ](url)) into [label](url)
        out = out.replace(
          new RegExp(`(?<!\\]\\()\\b(${escapedUrl})(?![a-z0-9_/-])`, 'gi'),
          `[${label}](${url})`,
        );
      }
      return out;
    })
    .join('');
}

/**
 * Tracks open/closed Markdown fenced code blocks across lines so splits never break formatting.
 * @param {string} text
 * @returns {{ openFence: string | null }}
 */
function inspectCodeFenceState(text) {
  let openFence = null;
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('```')) continue;
    if (openFence === null) {
      const lang = trimmed.slice(3).trim().split(/\s+/)[0] ?? '';
      openFence = `\`\`\`${lang}`;
    } else {
      openFence = null;
    }
  }

  return { openFence };
}

/**
 * Finds a clean split index <= limit prioritizing paragraph, line, and word boundaries.
 * @param {string} remaining
 * @param {number} limit
 * @returns {number}
 */
function findSafeSplitIndex(remaining, limit) {
  if (remaining.length <= limit) {
    return remaining.length;
  }

  const window = remaining.slice(0, limit);
  const minPreferred = Math.floor(limit * 0.45);

  const paragraphIdx = window.lastIndexOf('\n\n');
  if (paragraphIdx >= minPreferred) {
    return paragraphIdx + 2;
  }

  const lineIdx = window.lastIndexOf('\n');
  if (lineIdx >= minPreferred) {
    return lineIdx + 1;
  }

  const spaceIdx = window.lastIndexOf(' ');
  if (spaceIdx >= minPreferred) {
    return spaceIdx + 1;
  }

  return limit;
}

/**
 * Sanitizes AI output and splits it safely into Discord messages (max 2000 chars each)
 * while preserving fenced code blocks across chunks.
 *
 * @param {string} rawText
 * @param {number} [maxLength]
 * @returns {string[]}
 */
export function formatDiscordAiChunks(rawText, maxLength = DISCORD_MAX_MESSAGE_LENGTH) {
  const sanitized = formatDiscordMaskedLinks(sanitizeAiMentions(rawText)).trim();
  if (!sanitized) {
    return [];
  }

  if (sanitized.length <= maxLength) {
    return [sanitized];
  }

  const budget = Math.min(SAFE_CHUNK_BUDGET, Math.max(50, maxLength - 20));
  const chunks = [];
  let remaining = sanitized;
  let carriedFence = null;

  while (remaining.length > 0) {
    const prefix = carriedFence ? `${carriedFence}\n` : '';
    const available = Math.max(20, budget - prefix.length);

    if (prefix.length + remaining.length <= maxLength) {
      const finalChunk = `${prefix}${remaining}`.trim();
      if (finalChunk) {
        chunks.push(finalChunk);
      }
      break;
    }

    const splitIdx = findSafeSplitIndex(remaining, available);
    let body = remaining.slice(0, splitIdx).trimEnd();
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');

    // If trimming end removed everything (e.g., whitespace-only slice), force progress safely.
    if (!body && remaining.length > 0) {
      body = remaining.slice(0, available);
      remaining = remaining.slice(available);
    }

    let chunk = `${prefix}${body}`;
    const { openFence } = inspectCodeFenceState(chunk);
    if (openFence !== null) {
      chunk = `${chunk}\n\`\`\``;
      carriedFence = openFence;
    } else {
      carriedFence = null;
    }

    const finalChunk = chunk.trim();
    if (finalChunk) {
      chunks.push(finalChunk.slice(0, maxLength));
    }
  }

  return chunks;
}

/**
 * Formats up to 5 unique web search sources as numbered Markdown links
 * guaranteed to fit inside Discord's 1024-character embed field limit.
 *
 * @param {Array<{ title?: string, url?: string }>} sources
 * @param {number} [maxSources]
 * @returns {string}
 */
export function formatSourcesList(sources, maxSources = 5) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return '';
  }

  const lines = [];
  let totalLength = 0;
  const seen = new Set();

  for (const source of sources) {
    const url = typeof source?.url === 'string' ? source.url.trim() : '';
    if (!url || (!url.startsWith('https://') && !url.startsWith('http://'))) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const rawTitle = typeof source?.title === 'string' && source.title.trim() ? source.title.trim() : url;
    const safeTitle = rawTitle.replace(/[\[\]()]/g, '').slice(0, 90).trim() || url;
    const line = `${lines.length + 1}. [${safeTitle}](${url})`;
    const nextLength = totalLength + (lines.length > 0 ? 1 : 0) + line.length;

    if (nextLength > DISCORD_EMBED_FIELD_LIMIT) {
      break;
    }

    lines.push(line);
    totalLength = nextLength;
    if (lines.length >= Math.min(5, Math.max(1, maxSources))) {
      break;
    }
  }

  return lines.join('\n');
}

/**
 * Builds a Midwave-branded Discord Embed for web-grounded or search-fallback AI responses.
 *
 * @param {{
 *   description: string,
 *   sources?: Array<{ title?: string, url?: string }>,
 *   searchedAt?: string | null,
 *   cached?: boolean,
 *   mode?: 'web_search' | 'fallback',
 *   fallbackNotice?: string,
 * }} options
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildWebSearchEmbed({
  description,
  sources = [],
  searchedAt = null,
  cached = false,
  mode = 'web_search',
  fallbackNotice = '',
}) {
  const isFallback = mode === 'fallback';
  const safeDescription = formatDiscordMaskedLinks(sanitizeAiMentions(description || ''))
    .trim()
    .slice(0, 4096);

  const embed = createBaseEmbed({
    title: isFallback ? 'Midwave AI • Mode Non-Real-Time' : 'Midwave AI • Web Search',
    description: safeDescription || undefined,
    color: isFallback ? COLORS.WARNING : COLORS.SECONDARY,
    includeThumbnail: false,
  });

  if (fallbackNotice) {
    embed.addFields({
      name: 'Status Pencarian Web',
      value: sanitizeAiMentions(fallbackNotice).slice(0, DISCORD_EMBED_FIELD_LIMIT),
    });
  }

  const formattedSources = formatSourcesList(sources);
  if (formattedSources) {
    embed.addFields({
      name: 'Sumber:',
      value: formattedSources,
    });
  }

  if (searchedAt) {
    const parsedDate = new Date(searchedAt);
    if (!Number.isNaN(parsedDate.getTime())) {
      embed.setTimestamp(parsedDate);
    }
    embed.setFooter({
      text: cached
        ? `${EMBED_FOOTER} • Web Search (Cache)`
        : `${EMBED_FOOTER} • Web Search`,
    });
  }

  return embed;
}
