import { DOWNLOADER_ERROR_CODES, DownloaderError } from '../downloader/errors.js';
import {
  PLATFORMS,
  resolveAndValidateRedirects,
  validateMediaUrl,
} from '../downloader/platform.js';
import { sanitizeLogText } from '../downloader/ytdlp.js';

export const PIN_TITLE_MAX_LENGTH = 120;
export const PIN_CREATOR_MAX_LENGTH = 80;
export const PIN_DEFAULT_TIMEOUT_MS = 10_000;
export const PINTEREST_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PIN_IMAGE_PREFERRED_KEYS = Object.freeze(['orig', '736x', '564x', '474x', '236x', '170x']);
const PIN_PATH_RE = /^\/pin\/([^/?#]+)/i;
const PLACEHOLDER_VALUES = new Set(['undefined', 'null', 'none', 'n/a', 'na', '-']);
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;

/**
 * Collapses whitespace, strips control chars, and filters placeholder sentinel values.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function cleanPinterestText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const cleaned = value.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || PLACEHOLDER_VALUES.has(cleaned.toLowerCase())) {
    return '';
  }
  return cleaned;
}

function truncateOnWordBoundary(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text;
  }
  const limit = Math.max(4, maxLength - 3);
  let cutIndex = text.lastIndexOf(' ', limit);
  if (cutIndex < Math.floor(limit * 0.5)) {
    cutIndex = limit;
  }
  return `${text.slice(0, cutIndex).trimEnd()}...`;
}

/**
 * Extracts a Pinterest Pin ID from a Pin URL or raw Pin ID string.
 *
 * @param {string | URL | null | undefined} input
 * @returns {string | null}
 */
export function extractPinterestPinId(input) {
  if (!input) return null;

  if (input instanceof URL) {
    const match = input.pathname.match(PIN_PATH_RE);
    return match ? match[1].trim() : null;
  }

  const raw = String(input).trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const match = parsed.pathname.match(PIN_PATH_RE);
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
  }

  if (/\s|\//.test(raw)) {
    return null;
  }

  return raw;
}

/**
 * Builds a canonical Pinterest Pin URL from a Pin ID.
 *
 * @param {string} pinId
 * @returns {string}
 */
export function buildPinterestPinUrl(pinId) {
  const cleanId = extractPinterestPinId(pinId);
  if (!cleanId) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'ID Pin Pinterest tidak valid.',
    );
  }
  return `https://www.pinterest.com/pin/${encodeURIComponent(cleanId)}/`;
}

/**
 * Validates that a URL is a safe, public Pinterest Pin or `pin.it` URL using MIDWAVE's
 * shared SSRF/URL validator.
 *
 * @param {string} rawUrl
 */
export function validatePinterestPinUrl(rawUrl) {
  const validated = validateMediaUrl(rawUrl);

  if (validated.platform !== PLATFORMS.PINTEREST) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'URL bukan tautan Pinterest yang valid.',
    );
  }

  const pinId = extractPinterestPinId(validated.url);
  const hasShortCode =
    validated.isShortLink &&
    validated.url.pathname.length > 1 &&
    validated.url.pathname !== '/';

  if (!pinId && !hasShortCode) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'Tautan Pinterest harus mengarah langsung ke Pin yang valid.',
    );
  }

  return {
    ...validated,
    pinId,
  };
}

function validatePublicMediaAssetUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return null;
  }
  try {
    const validated = validateMediaUrl(rawUrl.trim());
    return validated.normalizedUrl;
  } catch {
    return null;
  }
}

function pickBestVideoFromList(videoList) {
  if (!videoList || typeof videoList !== 'object') {
    return null;
  }

  const entries = Object.values(videoList).filter((v) => v && typeof v === 'object');
  if (entries.length === 0) {
    return null;
  }

  const mp4Entry = entries.find(
    (entry) => typeof entry.url === 'string' && /\.mp4(?:$|\?)/i.test(entry.url),
  );
  const chosen = mp4Entry || entries[0];

  return {
    thumbnailUrl: validatePublicMediaAssetUrl(chosen.thumbnail || chosen.poster || ''),
    videoUrl: validatePublicMediaAssetUrl(chosen.url || ''),
  };
}

function extractVideoInfo(rawPin) {
  const directVideo = pickBestVideoFromList(rawPin?.videos?.video_list);
  if (directVideo && (directVideo.thumbnailUrl || directVideo.videoUrl)) {
    return {
      hasVideo: true,
      thumbnailUrl: directVideo.thumbnailUrl,
      videoUrl: directVideo.videoUrl,
    };
  }

  const pages = Array.isArray(rawPin?.story_pin_data?.pages) ? rawPin.story_pin_data.pages : [];
  for (const page of pages) {
    const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
    for (const block of blocks) {
      const storyVideo = pickBestVideoFromList(block?.video?.video_list);
      if (storyVideo && (storyVideo.thumbnailUrl || storyVideo.videoUrl)) {
        return {
          hasVideo: true,
          thumbnailUrl: storyVideo.thumbnailUrl,
          videoUrl: storyVideo.videoUrl,
        };
      }
    }
  }

  return {
    hasVideo: Boolean(rawPin?.is_video),
    thumbnailUrl: null,
    videoUrl: null,
  };
}

/**
 * Extracts the best valid image/video thumbnail URL from raw Pinterest Pin data.
 *
 * @param {Record<string, any>} rawPin
 * @returns {{ thumbnailUrl: string | null, mediaType: 'image' | 'video', videoUrl: string | null }}
 */
export function extractThumbnailFromPinData(rawPin) {
  const videoInfo = extractVideoInfo(rawPin);
  const candidates = [];

  if (rawPin?.images && typeof rawPin.images === 'object') {
    for (const key of PIN_IMAGE_PREFERRED_KEYS) {
      if (rawPin.images[key]?.url) {
        candidates.push(rawPin.images[key].url);
      }
    }
    for (const entry of Object.values(rawPin.images)) {
      if (entry && typeof entry === 'object' && typeof entry.url === 'string') {
        candidates.push(entry.url);
      }
    }
  }

  if (videoInfo.thumbnailUrl) {
    candidates.push(videoInfo.thumbnailUrl);
  }

  for (const fallbackField of [
    rawPin?.thumbnailUrl,
    rawPin?.thumbnail,
    rawPin?.image_large_url,
    rawPin?.imageUrl,
    rawPin?.image,
  ]) {
    if (typeof fallbackField === 'string') {
      candidates.push(fallbackField);
    }
  }

  let thumbnailUrl = null;
  for (const candidate of candidates) {
    const valid = validatePublicMediaAssetUrl(candidate);
    if (valid) {
      thumbnailUrl = valid;
      break;
    }
  }

  return {
    thumbnailUrl,
    mediaType: videoInfo.hasVideo ? 'video' : 'image',
    videoUrl: videoInfo.videoUrl,
  };
}

/**
 * Extracts a clean, user-readable creator label from Pinterest Pin metadata.
 *
 * @param {Record<string, any>} rawPin
 * @returns {string}
 */
export function extractCreatorFromPinData(rawPin) {
  const person =
    (rawPin?.native_creator && typeof rawPin.native_creator === 'object' ? rawPin.native_creator : null) ??
    (rawPin?.pinner && typeof rawPin.pinner === 'object' ? rawPin.pinner : null) ??
    (rawPin?.author && typeof rawPin.author === 'object' ? rawPin.author : null);

  if (person) {
    const fullName = cleanPinterestText(person.full_name || person.name);
    const username = cleanPinterestText(person.username).replace(/^@+/, '');

    if (fullName && username && fullName.toLowerCase() !== username.toLowerCase()) {
      return truncateOnWordBoundary(`${fullName} (@${username})`, PIN_CREATOR_MAX_LENGTH);
    }
    if (fullName) {
      return truncateOnWordBoundary(fullName, PIN_CREATOR_MAX_LENGTH);
    }
    if (username) {
      return truncateOnWordBoundary(`@${username}`, PIN_CREATOR_MAX_LENGTH);
    }
  }

  for (const rawCreator of [rawPin?.creator, rawPin?.uploader, rawPin?.author]) {
    const cleaned = cleanPinterestText(rawCreator);
    if (cleaned) {
      return truncateOnWordBoundary(cleaned, PIN_CREATOR_MAX_LENGTH);
    }
  }

  return 'Pinterest Creator';
}

/**
 * Extracts a clean title from Pinterest Pin metadata.
 *
 * @param {Record<string, any>} rawPin
 * @returns {string}
 */
export function extractTitleFromPinData(rawPin) {
  const candidates = [
    rawPin?.title,
    rawPin?.grid_title,
    rawPin?.rich_summary?.display_name,
    rawPin?.seo_alt_text,
    rawPin?.auto_alt_text,
    rawPin?.description,
  ];

  for (const candidate of candidates) {
    const cleaned = cleanPinterestText(candidate);
    if (cleaned) {
      return truncateOnWordBoundary(cleaned, PIN_TITLE_MAX_LENGTH);
    }
  }

  return 'Untitled Pin';
}

/**
 * Extracts and validates a normalized Pin object from raw Pinterest search or pin data.
 *
 * @param {Record<string, any>} rawPin
 * @returns {{
 *   id: string,
 *   title: string,
 *   creator: string,
 *   thumbnailUrl: string,
 *   pinUrl: string,
 *   mediaType: 'image' | 'video',
 *   videoUrl: string | null,
 * }}
 */
export function extractPinMetadata(rawPin) {
  if (!rawPin || typeof rawPin !== 'object') {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Data Pin Pinterest tidak valid.',
    );
  }

  let pinUrl = null;
  let pinId = extractPinterestPinId(rawPin.id);

  for (const rawUrlCandidate of [rawPin.pinUrl, rawPin.url, rawPin.link]) {
    if (typeof rawUrlCandidate !== 'string' || !rawUrlCandidate.trim()) {
      continue;
    }
    try {
      const validatedUrl = validatePinterestPinUrl(rawUrlCandidate);
      pinUrl = validatedUrl.normalizedUrl;
      pinId = pinId || validatedUrl.pinId || rawPin.id;
      break;
    } catch {
      // Fall through to ID-based canonical URL
    }
  }

  if (!pinUrl && pinId) {
    const canonical = buildPinterestPinUrl(pinId);
    pinUrl = validatePinterestPinUrl(canonical).normalizedUrl;
  }

  if (!pinUrl) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'URL Pin Pinterest tidak valid.',
    );
  }

  const media = extractThumbnailFromPinData(rawPin);
  if (!media.thumbnailUrl) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Gagal mengekstrak gambar atau thumbnail dari Pin Pinterest.',
    );
  }

  return {
    id: String(pinId || pinUrl),
    title: extractTitleFromPinData(rawPin),
    creator: extractCreatorFromPinData(rawPin),
    thumbnailUrl: media.thumbnailUrl,
    pinUrl,
    mediaType: media.mediaType,
    videoUrl: media.videoUrl,
  };
}

/**
 * Extracts and validates up to `maxResults` organic Pin objects from raw search entries.
 *
 * @param {unknown[]} rawItems
 * @param {{ maxResults?: number }} [options]
 * @returns {ReturnType<typeof extractPinMetadata>[]}
 */
export function extractPinterestResults(rawItems, options = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return [];
  }

  const maxResults = Math.min(25, Math.max(1, Number(options.maxResults) || 10));
  const organicItems = rawItems.filter((item) => item && typeof item === 'object' && item.is_promoted !== true);
  const candidates = organicItems.length > 0 ? organicItems : rawItems.filter((item) => item && typeof item === 'object');

  if (candidates.length === 0) {
    return [];
  }

  const extracted = [];
  const seenUrls = new Set();

  for (const item of candidates) {
    try {
      const normalized = extractPinMetadata(item);
      if (seenUrls.has(normalized.pinUrl)) {
        continue;
      }
      seenUrls.add(normalized.pinUrl);
      extracted.push(normalized);
      if (extracted.length >= maxResults) {
        break;
      }
    } catch {
      // Skip individual unextractable/invalid pin items unless all fail
    }
  }

  if (extracted.length === 0) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Gagal mengekstrak hasil Pinterest yang valid.',
    );
  }

  return extracted;
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;|&apos;/gi, "'");
}

function parseMetaContent(html, propertyName) {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reA = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i');
  const reB = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i');
  const match = html.match(reA) || html.match(reB);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function extractPinObjectFromHtml(html, pinUrl) {
  const pwsMatch = html.match(/<script[^>]*id=["']__PWS_INITIAL_PROPS__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (pwsMatch) {
    try {
      const pws = JSON.parse(pwsMatch[1]);
      const pinsMap = pws?.initialReduxState?.pins;
      if (pinsMap && typeof pinsMap === 'object') {
        const firstPin = Object.values(pinsMap).find((p) => p && typeof p === 'object');
        if (firstPin) {
          return { ...firstPin, pinUrl: firstPin.pinUrl || pinUrl };
        }
      }
    } catch {
      // Fall through to JSON-LD / OpenGraph
    }
  }

  const ldMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      const item = Array.isArray(ld) ? ld[0] : ld;
      if (item && typeof item === 'object') {
        return {
          id: extractPinterestPinId(pinUrl),
          pinUrl,
          title: item.headline || item.name || '',
          description: item.description || '',
          creator: item.author?.name || item.creator?.name || '',
          thumbnailUrl:
            typeof item.image === 'string'
              ? item.image
              : (item.image?.url || item.thumbnailUrl || ''),
        };
      }
    } catch {
      // Fall through to OpenGraph
    }
  }

  const ogImage = parseMetaContent(html, 'og:image');
  const ogTitle = parseMetaContent(html, 'og:title');
  const ogDesc = parseMetaContent(html, 'og:description');
  if (ogImage) {
    return {
      id: extractPinterestPinId(pinUrl),
      pinUrl,
      title: ogTitle || ogDesc || '',
      creator: parseMetaContent(html, 'pinterestapp:pinner') || '',
      thumbnailUrl: ogImage,
    };
  }

  return null;
}

/**
 * Extracts metadata from an individual Pinterest Pin URL (`pinterest.com/pin/...` or `pin.it/...`)
 * using MIDWAVE's SSRF-safe redirect resolver and HTML/JSON parser.
 *
 * @param {string} rawPinUrl
 * @param {{
 *   fetchFn?: typeof fetch,
 *   lookupFn?: typeof import('node:dns/promises').lookup,
 *   timeoutMs?: number,
 * }} [options]
 */
export async function extractPinFromUrl(rawPinUrl, options = {}) {
  const {
    fetchFn = fetch,
    lookupFn,
    timeoutMs = PIN_DEFAULT_TIMEOUT_MS,
  } = options;

  const validated = validatePinterestPinUrl(rawPinUrl);
  const resolved = await resolveAndValidateRedirects(validated, {
    fetchFn: options.fetchFn,
    lookupFn,
    timeoutMs,
  });
  const finalValidated = validatePinterestPinUrl(resolved.normalizedUrl);

  let response;
  try {
    response = await fetchFn(finalValidated.normalizedUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': PINTEREST_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = typeof error?.name === 'string' ? error.name : '';
    const msg = typeof error?.message === 'string' ? error.message : '';
    if (name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|aborted/i.test(msg)) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.TIMEOUT,
        'Permintaan ekstraksi Pin Pinterest melewati batas waktu (timeout).',
        { retryable: true, cause: error },
      );
    }
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NETWORK_ERROR,
      'Gagal menghubungi halaman Pin Pinterest.',
      { retryable: true, cause: error, details: sanitizeLogText(msg) },
    );
  }

  if (response.status === 404 || response.status === 410) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      'Pin Pinterest tidak ditemukan atau sudah dihapus.',
    );
  }
  if (response.status === 429) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.RATE_LIMITED,
      'Pinterest membatasi permintaan sementara (rate limit). Silakan coba lagi nanti.',
    );
  }
  if (!response.ok) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      `Gagal mengekstrak Pin Pinterest (HTTP ${response.status}).`,
      { retryable: response.status >= 500 },
    );
  }

  const html = await response.text();
  const parsedPin = extractPinObjectFromHtml(html, finalValidated.normalizedUrl);
  if (!parsedPin) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Metadata Pin Pinterest tidak dapat diekstrak dari halaman tersebut.',
    );
  }

  return extractPinMetadata(parsedPin);
}
