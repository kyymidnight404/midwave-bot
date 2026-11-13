export const DISCORD_MAX_MESSAGE_LENGTH = 2000;
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
  const sanitized = sanitizeAiMentions(rawText).trim();
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
