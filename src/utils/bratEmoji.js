const TWEMOJI_SVG_BASE_URL = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg';
const DISCORD_EMOJI_CDN_BASE_URL = 'https://cdn.discordapp.com/emojis';
const MAX_EMOJI_ASSET_BYTES = 512 * 1024;
const MAX_CACHE_ENTRIES = 256;
const DEFAULT_FETCH_TIMEOUT_MS = 4000;

const CUSTOM_EMOJI_REGEX = /<a?:([a-zA-Z0-9_~-]+):(\d{17,22})>/g;
const UNICODE_EMOJI_REGEX =
  /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Extended_Pictographic}(?=[\u200D\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]))(?:\uFE0F|\u200D|\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}])*)$/u;

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const defaultEmojiCache = new Map();

/**
 * Converts a Unicode emoji grapheme into primary (and optional fallback) Twemoji hex code points.
 * @param {string} grapheme
 * @returns {{ primary: string, fallback: string | null }}
 */
export function toTwemojiCodePoints(grapheme) {
  const codePoints = [];
  for (const ch of grapheme) {
    codePoints.push(ch.codePointAt(0));
  }

  const hasZwj = codePoints.includes(0x200d);
  const withoutFe0f = codePoints.filter((cp) => cp !== 0xfe0f);
  const primaryList = hasZwj ? codePoints : withoutFe0f;
  const primary = primaryList.map((cp) => cp.toString(16)).join('-');
  const withoutFe0fStr = withoutFe0f.map((cp) => cp.toString(16)).join('-');

  return {
    primary,
    fallback: hasZwj && withoutFe0fStr !== primary ? withoutFe0fStr : null,
  };
}

/**
 * Segments plain text (without Discord custom emojis) into text and Unicode emoji atomic tokens.
 * @param {string} text
 * @returns {Array<{ type: 'text' | 'emoji', raw: string, key?: string, codePoint?: string, fallbackCodePoint?: string | null }>}
 */
function segmentPlainText(text) {
  if (!text) return [];
  const tokens = [];

  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (UNICODE_EMOJI_REGEX.test(segment)) {
      const { primary, fallback } = toTwemojiCodePoints(segment);
      if (primary) {
        tokens.push({
          type: 'emoji',
          raw: segment,
          key: `unicode:${primary}`,
          codePoint: primary,
          fallbackCodePoint: fallback,
        });
        continue;
      }
    }
    tokens.push({ type: 'text', raw: segment });
  }

  return tokens;
}

/**
 * Tokenizes Brat text into atomic grapheme/emoji/custom-emoji units.
 * @param {string} text
 * @returns {Array<{
 *   type: 'text' | 'emoji' | 'custom-emoji',
 *   raw: string,
 *   key?: string,
 *   name?: string,
 *   id?: string,
 *   codePoint?: string,
 *   fallbackCodePoint?: string | null,
 * }>}
 */
export function tokenizeBratUnits(text) {
  const tokens = [];
  let lastIndex = 0;

  CUSTOM_EMOJI_REGEX.lastIndex = 0;
  for (const match of text.matchAll(CUSTOM_EMOJI_REGEX)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      tokens.push(...segmentPlainText(text.slice(lastIndex, matchIndex)));
    }
    const [, name, id] = match;
    tokens.push({
      type: 'custom-emoji',
      raw: match[0],
      name,
      id,
      key: `custom:${id}`,
    });
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push(...segmentPlainText(text.slice(lastIndex)));
  }

  return tokens;
}

/**
 * Merges consecutive text-like units into render segments using resolved emoji data URIs.
 * @param {string} line
 * @param {Map<string, string>} [emojiAssets]
 * @returns {Array<{ type: 'text', value: string } | { type: 'image', href: string }>}
 */
export function buildLineRenderSegments(line, emojiAssets = new Map()) {
  const units = tokenizeBratUnits(line);
  const segments = [];

  const pushText = (value) => {
    if (!value) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.type === 'text') {
      prev.value += value;
    } else {
      segments.push({ type: 'text', value });
    }
  };

  for (const unit of units) {
    if (unit.type !== 'text' && unit.key && emojiAssets.has(unit.key)) {
      segments.push({ type: 'image', href: emojiAssets.get(unit.key) });
      continue;
    }
    pushText(unit.type === 'custom-emoji' ? `:${unit.name}:` : unit.raw);
  }

  return segments;
}

/**
 * Reads a fetch response safely up to MAX_EMOJI_ASSET_BYTES.
 * @param {Response} response
 * @returns {Promise<Buffer | null>}
 */
async function readBoundedBuffer(response) {
  const contentLength = Number(response.headers?.get?.('content-length') ?? 0);
  if (contentLength > MAX_EMOJI_ASSET_BYTES) {
    return null;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_EMOJI_ASSET_BYTES) {
    return null;
  }
  return buffer;
}

function isPngBuffer(buffer) {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  );
}

function setBoundedCache(cache, key, value) {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, value);
}

async function fetchSvgDataUri(url, fetchFn, timeoutMs) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response?.ok) return null;

  const buffer = await readBoundedBuffer(response);
  if (!buffer) return null;

  const text = buffer.toString('utf8').trimStart();
  if (!text.startsWith('<svg') && !text.startsWith('<?xml')) {
    return null;
  }
  return `data:image/svg+xml;base64,${buffer.toString('base64')}`;
}

async function fetchPngDataUri(url, fetchFn, timeoutMs) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response?.ok) return null;

  const buffer = await readBoundedBuffer(response);
  if (!buffer || !isPngBuffer(buffer)) {
    return null;
  }
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function fetchTokenAsset(token, fetchFn, timeoutMs) {
  if (token.type === 'custom-emoji') {
    if (!/^\d{17,22}$/.test(token.id ?? '')) return null;
    const url = `${DISCORD_EMOJI_CDN_BASE_URL}/${token.id}.png?size=128`;
    return fetchPngDataUri(url, fetchFn, timeoutMs);
  }

  if (!/^[0-9a-f-]+$/.test(token.codePoint ?? '')) return null;
  const primaryUrl = `${TWEMOJI_SVG_BASE_URL}/${token.codePoint}.svg`;
  const primaryUri = await fetchSvgDataUri(primaryUrl, fetchFn, timeoutMs);
  if (primaryUri || !token.fallbackCodePoint) {
    return primaryUri;
  }

  if (!/^[0-9a-f-]+$/.test(token.fallbackCodePoint)) return null;
  const fallbackUrl = `${TWEMOJI_SVG_BASE_URL}/${token.fallbackCodePoint}.svg`;
  return fetchSvgDataUri(fallbackUrl, fetchFn, timeoutMs);
}

/**
 * Resolves all Unicode and Discord custom emoji assets in normalized text into data URIs.
 * Gracefully skips any emoji that fails to fetch so text rendering still succeeds.
 * @param {string} text
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, cache?: Map<string, string> }} [options]
 * @returns {Promise<Map<string, string>>}
 */
export async function resolveBratEmojiAssets(text, options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const cache = options.cache ?? defaultEmojiCache;

  const uniqueTokens = new Map();
  for (const token of tokenizeBratUnits(text)) {
    if (token.type !== 'text' && token.key && !uniqueTokens.has(token.key)) {
      uniqueTokens.set(token.key, token);
    }
  }

  const assets = new Map();
  if (uniqueTokens.size === 0) {
    return assets;
  }

  await Promise.all(
    Array.from(uniqueTokens.entries()).map(async ([key, token]) => {
      if (cache.has(key)) {
        assets.set(key, cache.get(key));
        return;
      }
      if (typeof fetchFn !== 'function') {
        return;
      }

      try {
        const dataUri = await fetchTokenAsset(token, fetchFn, timeoutMs);
        if (dataUri) {
          setBoundedCache(cache, key, dataUri);
          assets.set(key, dataUri);
        }
      } catch {
        // Fallback cleanly to plain text/name if emoji asset cannot be fetched
      }
    }),
  );

  return assets;
}
