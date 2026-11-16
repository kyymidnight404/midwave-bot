import axios from 'axios';
import {
  DEFAULT_CHAT_AUTODOWNLOAD_MAX_SIZE_MB,
  DEFAULT_INSTAGRAM_RAPIDAPI_PATH,
  DEFAULT_INSTAGRAM_RENDERABLE_FORMATS,
  DEFAULT_RAPIDAPI_HOST,
  DEFAULT_RAPIDAPI_PATH,
  DEFAULT_TIKTOK_RAPIDAPI_PATH,
  DISCORD_MAX_ATTACHMENTS,
  DOWNLOAD_COOLDOWN_MS,
  getDiscordUploadLimitBytes,
  getDownloaderConfig,
} from './downloader/config.js';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from './downloader/errors.js';
import {
  cleanupTempDir,
  createJobTempDir,
  downloadMediaToTempFile,
  formatBytes,
} from './downloader/fileManager.js';
import {
  assertSafeRemoteHost,
  PLATFORMS,
  PLATFORM_LABELS,
  extractInstagramShortcode,
  resolveAndValidateRedirects,
  validateMediaUrl,
} from './downloader/urlValidator.js';

export {
  DEFAULT_CHAT_AUTODOWNLOAD_MAX_SIZE_MB,
  DEFAULT_INSTAGRAM_RAPIDAPI_PATH,
  DEFAULT_INSTAGRAM_RENDERABLE_FORMATS,
  DEFAULT_RAPIDAPI_HOST,
  DEFAULT_RAPIDAPI_PATH,
  DEFAULT_TIKTOK_RAPIDAPI_PATH,
  DISCORD_MAX_ATTACHMENTS,
  DOWNLOAD_COOLDOWN_MS,
  getDiscordUploadLimitBytes,
  getDownloaderConfig,
};
export { DOWNLOADER_ERROR_CODES, DownloaderError };
export { cleanupTempDir, formatBytes };
export { PLATFORMS, PLATFORM_LABELS, extractInstagramShortcode, validateMediaUrl };

export const STANDARD_DISCORD_UPLOAD_LIMIT_BYTES =
  DEFAULT_CHAT_AUTODOWNLOAD_MAX_SIZE_MB * 1024 * 1024;
export const MAX_DISCORD_ATTACHMENTS = DISCORD_MAX_ATTACHMENTS;

const VIDEO_HINT_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;
const IMAGE_HINT_RE = /\.(jpe?g|png|webp|gif)(\?|$)/i;
const AUDIO_ONLY_RE = /(audio|mp3|m4a|opus|aac|sound_only)/i;

let activeDownloads = 0;

/**
 * Returns the active download job count (primarily for concurrency guard & diagnostics).
 *
 * @returns {number}
 */
export function getActiveDownloadCount() {
  return activeDownloads;
}

/**
 * Backward-compatible helper resolving RapidAPI credentials from config/env.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function getRapidApiConfig(env = process.env) {
  const cfg = getDownloaderConfig(env);
  return {
    apiKey: cfg.rapidApiKey,
    apiHost: cfg.rapidApiHost,
    endpoint: cfg.rapidApiEndpoint,
    configured: cfg.rapidApiConfigured,
    fullConfig: cfg,
  };
}

/**
 * Explicit allowlist of platform-owned CDN domains for Instagram and TikTok media.
 *
 * Security rationale (Multi-Tenant CDN Policy):
 * - Includes only first-party / dedicated CDN domains operated for Meta (Instagram)
 *   and ByteDance (TikTok).
 * - Shared multi-tenant CDN suffixes (`cloudfront.net`, `akamaized.net`) are intentionally
 *   excluded because any third-party tenant can register arbitrary distributions under them,
 *   which would weaken host-level SSRF & origin isolation.
 * - Wildcard patterns (`*`) are never used; matching requires exact host or `.domain` boundary.
 */
export const ALLOWED_CDN_DOMAINS = Object.freeze([
  'cdninstagram.com',
  'fbcdn.net',
  'instagram.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'tiktokcdn-in.com',
  'tiktokv.com',
  'tiktokv.us',
  'tiktok.com',
  'muscdn.com',
  'byteoversea.com',
  'ibytedtos.com',
  'ibyteimg.com',
  'ttwstatic.com',
]);

/**
 * Checks whether a hostname matches the explicit CDN domain allowlist.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isAllowedCdnHost(hostname) {
  const clean = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!clean || clean === 'localhost' || clean.endsWith('.localhost')) {
    return false;
  }
  return ALLOWED_CDN_DOMAINS.some(
    (domain) => clean === domain || clean.endsWith(`.${domain}`),
  );
}

/**
 * Validates that a candidate CDN URL uses HTTPS, has no embedded credentials,
 * and belongs to an allowed CDN host.
 *
 * @param {string} rawUrl
 * @returns {string | null}
 */
export function sanitizeCdnUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return null;
    }
    if (!isAllowedCdnHost(parsed.hostname)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Validates a CDN fallback URL including host allowlist and DNS/IP safety.
 *
 * @param {string} rawUrl
 * @param {{ lookupFn?: Function }} [options]
 * @returns {Promise<string>}
 */
export async function validateCdnFallbackUrl(rawUrl, options = {}) {
  const clean = sanitizeCdnUrl(rawUrl);
  if (!clean) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      'URL CDN fallback tidak valid atau berasal dari host yang tidak diizinkan.',
    );
  }
  const parsed = new URL(clean);
  await assertSafeRemoteHost(parsed.hostname, {
    lookupFn: options.lookupFn,
    allowPrivate: false,
  });
  return clean;
}

/**
 * Validates every CDN candidate URL (host allowlist + DNS/IP check) before any
 * download or fallback response occurs.
 *
 * @param {Array<{ url: string }>} candidates
 * @param {{ lookupFn?: Function }} [options]
 * @returns {Promise<string[]>}
 */
export async function validateAllCdnCandidates(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      'Tidak ada URL media yang valid ditemukan pada respons RapidAPI.',
    );
  }
  return Promise.all(
    candidates.map((candidate) => validateCdnFallbackUrl(candidate?.url, options)),
  );
}

/**
 * Scores video candidates so HD and watermark-free streams rank highest.
 *
 * @param {{ quality?: string, label?: string, watermark?: boolean }} item
 * @returns {number}
 */
function scoreVideoCandidate(item) {
  const tag = `${item.quality || ''} ${item.label || ''}`.toLowerCase();
  let score = 100;

  if (AUDIO_ONLY_RE.test(tag)) return -1000;
  if (tag.includes('no_watermark') || tag.includes('nowatermark') || tag.includes('no-watermark')) score += 60;
  if (tag.includes('hd') || tag.includes('1080') || tag.includes('high')) score += 40;
  if (tag.includes('720')) score += 25;
  if (tag.includes('sd') || tag.includes('480') || tag.includes('low')) score -= 10;
  if (item.watermark === true || (tag.includes('watermark') && !tag.includes('no'))) score -= 45;
  if (tag.includes('render')) score += 10;

  return score;
}

/**
 * Infers whether a candidate item represents video, image, or audio.
 *
 * @param {object} entry
 * @param {string} url
 * @returns {'video' | 'image' | 'audio'}
 */
function inferCandidateKind(entry, url) {
  const typeText = `${entry?.type || ''} ${entry?.mediaType || ''} ${entry?.mime || ''} ${entry?.extension || ''} ${entry?.ext || ''} ${entry?.quality || ''}`.toLowerCase();

  if (AUDIO_ONLY_RE.test(typeText) && !typeText.includes('video')) {
    return 'audio';
  }
  if (
    typeText.includes('image') ||
    typeText.includes('photo') ||
    typeText.includes('jpg') ||
    typeText.includes('png') ||
    typeText.includes('webp') ||
    IMAGE_HINT_RE.test(url)
  ) {
    return 'image';
  }
  if (typeText.includes('video') || typeText.includes('mp4') || VIDEO_HINT_RE.test(url)) {
    return 'video';
  }
  return 'video';
}

export function sanitizeLogText(value, maxLen = 160) {
  return String(value ?? '')
    .replace(/AIza[0-9A-Za-z_-]{10,}|tvly-[A-Za-z0-9_-]{6,}/gi, '[REDACTED_KEY]')
    .replace(/(x-rapidapi-key|api[_-]?key|token|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function getSafeEndpointLabel(endpointUrl) {
  try {
    const parsed = new URL(endpointUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid-endpoint';
  }
}

function extractApiErrorMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    return String(
      data.message || data.error_message || data.error || data.detail || data.msg || '',
    );
  }
  return '';
}

function isMissingEndpointMessage(lowerMsg) {
  return (
    lowerMsg.includes('endpoint') &&
    (lowerMsg.includes('does not exist') || lowerMsg.includes('not found'))
  ) ||
    lowerMsg.includes('no route') ||
    lowerMsg.includes('cannot get') ||
    lowerMsg.includes('route not found');
}

function classifyRapidApiMessageError(rawMsg) {
  const apiMsg = String(rawMsg || '').toLowerCase();

  if (
    apiMsg.includes('invalid api key') ||
    apiMsg.includes('not subscribed') ||
    apiMsg.includes('unauthorized') ||
    apiMsg.includes('forbidden') ||
    apiMsg.includes('subscription')
  ) {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
      'Autentikasi RapidAPI gagal atau belum berlangganan API (`RAPIDAPI_KEY`).',
      { details: sanitizeLogText(rawMsg) },
    );
  }
  if (apiMsg.includes('quota') || apiMsg.includes('exceeded') || apiMsg.includes('limit')) {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.RATE_LIMITED,
      'Kuota atau batas permintaan RapidAPI telah habis. Coba lagi nanti.',
      { details: sanitizeLogText(rawMsg) },
    );
  }
  if (
    apiMsg.includes('private') ||
    apiMsg.includes('login') ||
    apiMsg.includes('restricted') ||
    apiMsg.includes('age')
  ) {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
      'Konten bersifat privat atau dibatasi oleh platform sumber.',
      { details: sanitizeLogText(rawMsg) },
    );
  }
  if (apiMsg.includes('unsupported') || apiMsg.includes('not supported') || apiMsg.includes('invalid url')) {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM,
      'Format URL atau jenis postingan ini belum didukung oleh RapidAPI.',
      { details: sanitizeLogText(rawMsg) },
    );
  }
  if (apiMsg.includes('not found') || apiMsg.includes('unavailable') || apiMsg.includes('deleted')) {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      'Media tidak ditemukan atau postingan telah dihapus.',
      { details: sanitizeLogText(rawMsg) },
    );
  }
  return new DownloaderError(
    DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
    'RapidAPI gagal mengekstrak media dari tautan tersebut.',
    { details: sanitizeLogText(rawMsg) },
  );
}

function getResolutionScore(item) {
  const width = Number(item?.metadata?.width ?? item?.width ?? 0);
  const height = Number(item?.metadata?.height ?? item?.height ?? 0);
  if (width > 0 && height > 0) {
    return width * height;
  }
  const labelMatch = String(item?.label || item?.quality || '').match(/(\d{2,5})\s*x\s*(\d{2,5})/i);
  if (labelMatch) {
    return Number(labelMatch[1]) * Number(labelMatch[2]);
  }
  const heightMatch = String(item?.label || item?.quality || '').match(/(\d{3,4})p/i);
  return heightMatch ? Number(heightMatch[1]) * Number(heightMatch[1]) : 0;
}

function scorePostDetailsVideo(v) {
  if (!v || typeof v !== 'object') {
    return 100;
  }

  const codec = String(v?.metadata?.CodecType || v?.metadata?.codec || v?.codec || '').toLowerCase();
  const format = String(v?.metadata?.Format || v?.metadata?.format || '').toLowerCase();
  const mime = String(v?.metadata?.mime_type || '').toLowerCase();
  const label = String(v?.label || v?.quality || '').toLowerCase();
  const isMp4 = format === 'mp4' || mime.includes('mp4') || label.includes('mp4');
  const isH264 = codec.includes('h264') || codec.includes('avc') || label.includes('h264') || label.includes('avc');
  const isHevc = codec.includes('h265') || codec.includes('hevc') || label.includes('h265') || label.includes('hevc');

  let score = 0;
  if (isMp4) score += 10_000_000;
  if (isH264) score += 100_000_000;
  else if (isHevc) score -= 20_000_000;
  if (v?.metadata?.has_audio !== false) score += 5_000_000;

  return score + getResolutionScore(v) + scoreVideoCandidate(v);
}

function parseInstagramPostDetailsResponse(root, payload, options = {}) {
  const rawError = payload.error ?? root.error;
  if (rawError !== null && rawError !== undefined && rawError !== false && rawError !== '') {
    const errText = typeof rawError === 'string' ? rawError : extractApiErrorMessage(rawError);
    throw classifyRapidApiMessageError(errText || extractApiErrorMessage(payload) || extractApiErrorMessage(root));
  }

  const meta =
    (payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null) ||
    (root.metadata && typeof root.metadata === 'object' ? root.metadata : null) ||
    {};

  const title = String(meta.title || payload.title || root.title || '').trim();
  const author = String(
    meta.author?.user?.uniqueId ||
      meta.author?.user?.nickname ||
      meta.author?.username ||
      meta.author?.nickname ||
      (typeof meta.author === 'string' ? meta.author : '') ||
      payload.author?.username ||
      '',
  ).trim();

  const contents = Array.isArray(payload.contents)
    ? payload.contents
    : Array.isArray(root.contents)
      ? root.contents
      : [];

  const slideCandidates = [];
  const singleSlideVideoVariants = [];

  for (const slide of contents) {
    if (!slide || typeof slide !== 'object') continue;

    // Abaikan renderableAudios[] — jangan pernah kirim audio terpisah
    const slideVideos = [];
    for (const vKey of ['videos', 'renderableVideos']) {
      if (Array.isArray(slide[vKey])) {
        for (const v of slide[vKey]) {
          const clean = sanitizeCdnUrl(typeof v === 'string' ? v : v?.url || v?.link);
          if (clean) {
            slideVideos.push({
              url: clean,
              quality: String(v?.label || v?.quality || 'hd'),
              kind: 'video',
              score: scorePostDetailsVideo(v),
            });
          }
        }
      }
    }
    if (slide.video) {
      const clean = sanitizeCdnUrl(typeof slide.video === 'string' ? slide.video : slide.video?.url);
      if (clean) {
        slideVideos.push({ url: clean, quality: 'hd', kind: 'video', score: 100 });
      }
    }

    if (slideVideos.length > 0) {
      slideVideos.sort((a, b) => b.score - a.score);
      if (contents.length === 1) {
        singleSlideVideoVariants.push(...slideVideos);
      }
      slideCandidates.push(slideVideos[0]);
      continue;
    }

    const slideImages = [];
    if (Array.isArray(slide.images)) {
      for (const img of slide.images) {
        const clean = sanitizeCdnUrl(typeof img === 'string' ? img : img?.url || img?.link);
        if (clean) {
          slideImages.push({
            url: clean,
            quality: String(img?.label || 'image'),
            kind: 'image',
            mimeType: img?.metadata?.mime_type || 'image/jpeg',
            score: getResolutionScore(img),
          });
        }
      }
    }

    if (slideImages.length > 0) {
      slideImages.sort((a, b) => b.score - a.score);
      slideCandidates.push(slideImages[0]);
    }
  }

  // Abaikan additionalData.polaris_ordered_timeline_connection.edges (feed terkait, bukan media postingan!)
  const additionalData =
    (payload.additionalData && typeof payload.additionalData === 'object' ? payload.additionalData : null) ||
    (root.additionalData && typeof root.additionalData === 'object' ? root.additionalData : null) ||
    null;

  const fallbackVideos = [];
  if (Array.isArray(additionalData?.video_versions)) {
    for (const v of additionalData.video_versions) {
      const clean = sanitizeCdnUrl(v?.url);
      if (clean) {
        fallbackVideos.push({
          url: clean,
          quality: `${v.width || ''}x${v.height || ''}`.replace(/^x$/, 'hd'),
          kind: 'video',
          score: getResolutionScore(v),
        });
      }
    }
    fallbackVideos.sort((a, b) => b.score - a.score);
  }

  // TikTok Get-TikTok-Post-Details fallback: gunakan hanya playAddr (jangan duplikasi downloadAddr/videos[])
  const playAddrUrl = sanitizeCdnUrl(additionalData?.video?.playAddr);
  if (playAddrUrl) {
    fallbackVideos.push({
      url: playAddrUrl,
      quality: 'playAddr',
      kind: 'video',
      score: 1,
    });
  }

  const fallbackImages = [];
  if (Array.isArray(additionalData?.image_versions2?.candidates)) {
    for (const img of additionalData.image_versions2.candidates) {
      const clean = sanitizeCdnUrl(img?.url);
      if (clean) {
        fallbackImages.push({
          url: clean,
          quality: `${img.width || ''}x${img.height || ''}`.replace(/^x$/, 'image'),
          kind: 'image',
          mimeType: 'image/jpeg',
          score: getResolutionScore(img),
        });
      }
    }
    fallbackImages.sort((a, b) => b.score - a.score);
  }

  const uniqueByUrl = (list) => {
    const map = new Map();
    for (const item of list) {
      if (!map.has(item.url)) map.set(item.url, item);
    }
    return [...map.values()];
  };

  if (contents.length > 1 && slideCandidates.length > 1) {
    return {
      title,
      author,
      mode: 'carousel',
      candidates: uniqueByUrl(slideCandidates).slice(0, DISCORD_MAX_ATTACHMENTS),
    };
  }

  if (slideCandidates.length === 1) {
    const primary = slideCandidates[0];
    if (primary.kind === 'video') {
      return {
        title,
        author,
        mode: 'video',
        candidates: uniqueByUrl([...singleSlideVideoVariants, ...fallbackVideos]),
      };
    }
    return {
      title,
      author,
      mode: 'image',
      candidates: uniqueByUrl([primary, ...fallbackImages]),
    };
  }

  if (fallbackVideos.length > 0) {
    return {
      title,
      author,
      mode: 'video',
      candidates: uniqueByUrl(fallbackVideos),
    };
  }

  if (fallbackImages.length > 0) {
    return {
      title,
      author,
      mode: 'image',
      candidates: uniqueByUrl(fallbackImages),
    };
  }

  const responseKeys = Object.keys(payload).slice(0, 15).join(', ');
  options.logger?.warn?.(
    `[Downloader] RapidAPI Post Details response contained 0 usable media URLs (keys: ${responseKeys || 'none'})`,
  );
  throw new DownloaderError(
    DOWNLOADER_ERROR_CODES.NOT_FOUND,
    'Tidak ada URL media yang valid ditemukan pada respons RapidAPI.',
    { details: `keys=${responseKeys}` },
  );
}

/**
 * Normalizes flexible RapidAPI JSON responses (`contents` for Instagram Post Details,
 * or `links`, `medias`, `images`, `items`, single `url` for TikTok) into prioritized download candidates.
 *
 * @param {unknown} rawData
 * @param {{ logger?: Console }} [options]
 */
export function parseRapidApiResponse(rawData, options = {}) {
  let normalizedRaw = rawData;
  if (typeof normalizedRaw === 'string') {
    try {
      normalizedRaw = JSON.parse(normalizedRaw);
    } catch {
      normalizedRaw = null;
    }
  }

  const root = normalizedRaw && typeof normalizedRaw === 'object' ? normalizedRaw : null;
  if (!root || Array.isArray(root)) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Respons RapidAPI tidak valid atau bukan objek JSON.',
    );
  }

  // Beberapa endpoint RapidAPI membungkus payload di dalam `data` atau `result`
  const payload =
    (root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : null) ||
    (root.result && typeof root.result === 'object' && !Array.isArray(root.result) ? root.result : null) ||
    root;

  if (
    Array.isArray(payload.contents) ||
    Array.isArray(root.contents) ||
    (payload.additionalData && typeof payload.additionalData === 'object') ||
    (root.additionalData && typeof root.additionalData === 'object')
  ) {
    return parseInstagramPostDetailsResponse(root, payload, options);
  }

  if (
    root.success === false ||
    payload.success === false ||
    root.error === true ||
    payload.error === true
  ) {
    const rawMsg = extractApiErrorMessage(payload) || extractApiErrorMessage(root);
    throw classifyRapidApiMessageError(rawMsg);
  }

  const title = String(payload.title || payload.caption || payload.description || root.title || '').trim();
  const author = String(
    payload.author?.nickname ||
      payload.author?.username ||
      payload.author ||
      payload.username ||
      payload.creator ||
      '',
  ).trim();

  const rawEntries = [];
  const pushEntry = (entry, forcedKind = null, fallbackQuality = 'hd') => {
    if (typeof entry === 'string') {
      const clean = sanitizeCdnUrl(entry);
      if (clean) {
        rawEntries.push({
          url: clean,
          quality: fallbackQuality,
          kind: forcedKind || inferCandidateKind({ quality: fallbackQuality }, clean),
        });
      }
      return;
    }
    if (!entry || typeof entry !== 'object') return;

    const candidateUrl = sanitizeCdnUrl(
      entry.link ||
        entry.url ||
        entry.download_url ||
        entry.downloadUrl ||
        entry.videoUrl ||
        entry.imageUrl ||
        entry.src ||
        entry.href ||
        entry.play ||
        entry.hdplay ||
        entry.media,
    );
    if (!candidateUrl) return;

    const kind = forcedKind || inferCandidateKind(entry, candidateUrl);
    if (kind === 'audio') return;

    rawEntries.push({
      url: candidateUrl,
      quality: String(entry.quality || entry.label || entry.resolution || fallbackQuality),
      watermark: entry.watermark,
      kind,
    });
  };

  const pushCollection = (collection, forcedKind = null) => {
    if (Array.isArray(collection)) {
      collection.forEach((item) => pushEntry(item, forcedKind));
      return;
    }
    if (collection && typeof collection === 'object') {
      for (const [key, value] of Object.entries(collection)) {
        if (AUDIO_ONLY_RE.test(key)) continue;
        if (typeof value === 'string') {
          pushEntry(value, forcedKind, key);
        } else if (value && typeof value === 'object') {
          pushEntry({ quality: key, ...value }, forcedKind, key);
        }
      }
    }
  };

  for (const listKey of ['links', 'medias', 'media', 'items', 'carousel', 'downloads']) {
    pushCollection(payload[listKey]);
    if (root[listKey] !== payload[listKey]) {
      pushCollection(root[listKey]);
    }
  }

  for (const imageKey of ['images', 'photos', 'gallery']) {
    pushCollection(payload[imageKey], 'image');
    if (root[imageKey] !== payload[imageKey]) {
      pushCollection(root[imageKey], 'image');
    }
  }

  for (const singleKey of ['hdplay', 'play', 'video', 'url', 'download_url', 'downloadUrl', 'wmplay']) {
    const val = payload[singleKey] ?? root[singleKey];
    if (typeof val === 'string') {
      pushEntry({ url: val, quality: singleKey, watermark: singleKey === 'wmplay' }, 'video');
    } else if (val && typeof val === 'object' && typeof (val.url || val.link) === 'string') {
      pushEntry(val);
    }
  }

  const uniqueMap = new Map();
  for (const entry of rawEntries) {
    if (!uniqueMap.has(entry.url)) {
      uniqueMap.set(entry.url, entry);
    }
  }
  const unique = [...uniqueMap.values()];

  if (unique.length === 0) {
    const responseKeys = Object.keys(payload).slice(0, 15).join(', ');
    options.logger?.warn?.(
      `[Downloader] RapidAPI response contained 0 usable media URLs (keys: ${responseKeys || 'none'})`,
    );
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      'Tidak ada URL media yang valid ditemukan pada respons RapidAPI.',
      { details: `keys=${responseKeys}` },
    );
  }

  const images = unique.filter((item) => item.kind === 'image');
  const videos = unique.filter((item) => item.kind === 'video');

  if (images.length > 0 && (videos.length === 0 || images.length > 1)) {
    const carouselItems = unique
      .filter((item) => item.kind === 'image' || videos.length === 1)
      .slice(0, DISCORD_MAX_ATTACHMENTS);

    return {
      title,
      author,
      mode: carouselItems.length > 1 ? 'carousel' : 'image',
      candidates: carouselItems,
    };
  }

  const sortedVideos = [...videos].sort((a, b) => scoreVideoCandidate(b) - scoreVideoCandidate(a));

  return {
    title,
    author,
    mode: 'video',
    candidates: sortedVideos,
  };
}

/**
 * Classifies Axios / RapidAPI errors without leaking sensitive API keys.
 *
 * @param {unknown} error
 * @returns {DownloaderError}
 */
function mapRapidApiError(error) {
  if (error instanceof DownloaderError) {
    return error;
  }

  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || error?.name === 'AbortError') {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.TIMEOUT,
      'Permintaan ke RapidAPI melewati batas waktu (timeout). Silakan coba lagi.',
      { retryable: true, cause: error },
    );
  }

  const status = error?.response?.status;
  const rawBodyMsg = extractApiErrorMessage(error?.response?.data) || String(error?.message || '');
  const bodyMsg = rawBodyMsg.toLowerCase();

  if (status === 429) {
    const isQuota = bodyMsg.includes('quota') || bodyMsg.includes('monthly') || bodyMsg.includes('exceeded');
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.RATE_LIMITED,
      isQuota
        ? 'Kuota RapidAPI telah habis. Silakan periksa langganan atau tunggu reset kuota.'
        : 'Batas permintaan RapidAPI tercapai (HTTP 429). Coba lagi beberapa saat lagi.',
      { details: sanitizeLogText(`HTTP 429: ${rawBodyMsg}`) },
    );
  }

  if (status === 401 || status === 403) {
    if (bodyMsg.includes('private')) {
      return new DownloaderError(
        DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
        'Postingan bersifat privat atau dibatasi oleh platform sumber.',
        { details: sanitizeLogText(`HTTP ${status}: ${rawBodyMsg}`) },
      );
    }
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
      'Autentikasi RapidAPI gagal atau belum berlangganan API (`RAPIDAPI_KEY`).',
      { details: sanitizeLogText(`HTTP ${status}: ${rawBodyMsg}`) },
    );
  }

  if (status === 400 || status === 422) {
    if (bodyMsg.includes('unsupported') || bodyMsg.includes('not supported')) {
      return new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM,
        'Tautan atau jenis konten ini belum didukung oleh endpoint RapidAPI.',
        { details: sanitizeLogText(`HTTP ${status}: ${rawBodyMsg}`) },
      );
    }
    if (bodyMsg.includes('invalid url') || bodyMsg.includes('url is required')) {
      return new DownloaderError(
        DOWNLOADER_ERROR_CODES.INVALID_URL,
        'Format tautan ditolak oleh RapidAPI. Pastikan tautan postingan valid.',
        { details: sanitizeLogText(`HTTP ${status}: ${rawBodyMsg}`) },
      );
    }
    if (bodyMsg.includes('private') || bodyMsg.includes('login')) {
      return new DownloaderError(
        DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
        'Postingan bersifat privat atau memerlukan login.',
        { details: sanitizeLogText(`HTTP ${status}: ${rawBodyMsg}`) },
      );
    }
  }

  if (status === 404) {
    if (isMissingEndpointMessage(bodyMsg)) {
      return new DownloaderError(
        DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
        'Endpoint RapidAPI tidak ditemukan. Periksa konfigurasi `RAPIDAPI_ENDPOINT`.',
        { details: sanitizeLogText(`HTTP 404 endpoint mismatch: ${rawBodyMsg}`) },
      );
    }
    if (bodyMsg.includes('unsupported')) {
      return new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM,
        'Jenis tautan ini tidak didukung oleh endpoint RapidAPI.',
        { details: sanitizeLogText(`HTTP 404: ${rawBodyMsg}`) },
      );
    }
    if (bodyMsg.includes('private') || bodyMsg.includes('login')) {
      return new DownloaderError(
        DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
        'Postingan bersifat privat atau dibatasi.',
        { details: sanitizeLogText(`HTTP 404: ${rawBodyMsg}`) },
      );
    }
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      'Postingan tidak ditemukan atau tautan sudah tidak valid.',
      { details: sanitizeLogText(`HTTP 404: ${rawBodyMsg}`) },
    );
  }

  if (!error?.response && (error?.code === 'ENOTFOUND' || error?.code === 'ECONNRESET' || error?.code === 'EAI_AGAIN')) {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Gangguan jaringan saat menghubungi layanan RapidAPI. Silakan coba lagi.',
      { retryable: true, cause: error },
    );
  }

  if (bodyMsg.includes('private')) {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
      'Postingan bersifat privat dan tidak dapat diunduh.',
    );
  }

  return new DownloaderError(
    DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
    'Gagal mengambil data media dari RapidAPI.',
    { retryable: Boolean(status >= 500), cause: error },
  );
}

/**
 * Derives human-readable summary metadata for Discord embed responses.
 *
 * @param {Array<{ kind: 'video' | 'image', format: string, sizeBytes: number }>} items
 */
function summarizeDownloadedMedia(items) {
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  const formats = [...new Set(items.map((item) => item.format))];
  const hasVideo = items.some((item) => item.kind === 'video');
  const hasImage = items.some((item) => item.kind === 'image');

  let mediaType = 'Media';
  if (items.length === 1) {
    mediaType = items[0].kind === 'video' ? 'Video' : 'Image';
  } else if (hasImage && !hasVideo) {
    mediaType = `Slideshow / Carousel (${items.length} gambar)`;
  } else if (hasVideo && !hasImage) {
    mediaType = `Carousel Video (${items.length} video)`;
  } else {
    mediaType = `Carousel Media (${items.length} file)`;
  }

  return {
    mediaType,
    fileFormat: formats.join(' / '),
    totalBytes,
    formattedSize: formatBytes(totalBytes),
  };
}

/**
 * Calls RapidAPI with single transient retry on timeout or 5xx network failure.
 *
 * @param {string} targetUrl
 * @param {ReturnType<typeof getDownloaderConfig>} config
 * @param {typeof axios} axiosClient
 */
async function requestRapidApiMetadata(targetUrl, config, axiosClient, options = {}) {
  // Enforce TikTok/Instagram allowlist directly at the RapidAPI boundary as defense in depth.
  const validated = validateMediaUrl(targetUrl);
  if (validated.platform !== PLATFORMS.INSTAGRAM && validated.platform !== PLATFORMS.TIKTOK) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM,
      'Platform tidak didukung. Hanya tautan publik Instagram dan TikTok yang dapat diteruskan.',
    );
  }

  const { platform = validated.platform, shortcode = validated.shortcode, logger = console } = options;

  if (platform === PLATFORMS.INSTAGRAM) {
    const resolvedShortcode = shortcode || extractInstagramShortcode(validated.normalizedUrl);
    if (!resolvedShortcode) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM,
        'Tautan Instagram harus berupa postingan `/p/{shortcode}/`, `/reel/{shortcode}/`, atau `/tv/{shortcode}/`.',
      );
    }

    const instagramEndpoint =
      config.instagramRapidApiEndpoint ||
      `https://${config.rapidApiHost || DEFAULT_RAPIDAPI_HOST}${DEFAULT_INSTAGRAM_RAPIDAPI_PATH}`;
    const endpointLabel = getSafeEndpointLabel(instagramEndpoint);
    const params = { shortcode: resolvedShortcode };
    if (config.instagramRenderableFormats) {
      params.renderableFormats = config.instagramRenderableFormats;
    }

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await axiosClient.get(instagramEndpoint, {
          params,
          headers: {
            'x-rapidapi-key': config.rapidApiKey,
            'x-rapidapi-host': config.rapidApiHost,
          },
          timeout: config.timeoutMs,
        });
        return parseRapidApiResponse(response.data, { logger });
      } catch (error) {
        const status = error?.response?.status;
        const mapped = mapRapidApiError(error);
        lastError = mapped;

        logger?.warn?.(
          `[Downloader] RapidAPI Instagram request failed (${endpointLabel}, status=${status ?? error?.code ?? 'ERR'}, code=${mapped.code}): ${sanitizeLogText(mapped.details || mapped.userMessage)}`,
        );

        if (attempt === 0 && mapped.retryable) {
          continue;
        }
        throw mapped;
      }
    }
    throw lastError;
  }

  const tiktokEndpoint =
    config.tiktokRapidApiEndpoint ||
    config.rapidApiEndpoint ||
    `https://${config.rapidApiHost || DEFAULT_RAPIDAPI_HOST}${DEFAULT_TIKTOK_RAPIDAPI_PATH}`;
  const endpointLabel = getSafeEndpointLabel(tiktokEndpoint);

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await axiosClient.get(tiktokEndpoint, {
        params: { url: validated.normalizedUrl },
        headers: {
          'x-rapidapi-key': config.rapidApiKey,
          'x-rapidapi-host': config.rapidApiHost,
        },
        timeout: config.timeoutMs,
      });
      return parseRapidApiResponse(response.data, { logger });
    } catch (error) {
      const status = error?.response?.status;
      const mapped = mapRapidApiError(error);
      lastError = mapped;

      logger?.warn?.(
        `[Downloader] RapidAPI TikTok request failed (${endpointLabel}, status=${status ?? error?.code ?? 'ERR'}, code=${mapped.code}): ${sanitizeLogText(mapped.details || mapped.userMessage)}`,
      );

      if (attempt === 0 && mapped.retryable) {
        continue;
      }
      throw mapped;
    }
  }
  throw lastError;
}

/**
 * Unified RapidAPI + Axios downloader used by both `/download` Slash Command and `messageCreate` Auto-Downloader.
 * On `mode === 'attachments'`, caller MUST invoke `cleanupTempDir(result.jobDir)` in `finally` after Discord upload.
 *
 * @param {{
 *   url: string,
 *   guild?: { premiumTier?: number } | null,
 *   maxBytesOverride?: number | null,
 *   allowCdnFallback?: boolean,
 *   config?: ReturnType<typeof getDownloaderConfig>,
 *   deps?: {
 *     axiosClient?: typeof axios,
 *     fetchFn?: typeof fetch,
 *     lookupFn?: typeof import('node:dns/promises').lookup,
 *   },
 * }} params
 */
export async function downloadMediaFromUrl(params) {
  const {
    url,
    guild = null,
    maxBytesOverride = null,
    allowCdnFallback = false,
    config: rawConfig = getDownloaderConfig(),
    deps = {},
  } = params;

  const config = rawConfig?.fullConfig ?? rawConfig;
  const validated = validateMediaUrl(url);

  if (!config?.rapidApiConfigured) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.MISSING_DEPENDENCY,
      'Fitur unduhan belum aktif karena `RAPIDAPI_KEY` belum dikonfigurasi oleh administrator.',
    );
  }

  if (activeDownloads >= config.maxConcurrent) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.BUSY,
      'Terlalu banyak unduhan berjalan bersamaan. Silakan tunggu beberapa detik lalu coba lagi.',
    );
  }

  const axiosClient = deps.axiosClient || axios;
  const maxBytes =
    typeof maxBytesOverride === 'number' && maxBytesOverride > 0
      ? maxBytesOverride
      : getDiscordUploadLimitBytes(guild, config.maxSizeMb).maxBytes;

  activeDownloads += 1;
  let jobDir = null;

  try {
    const resolved = await resolveAndValidateRedirects(validated, {
      fetchFn: deps.fetchFn,
      lookupFn: deps.lookupFn,
      timeoutMs: Math.min(config.timeoutMs, 15_000),
    });

    const parsed = await requestRapidApiMetadata(resolved.normalizedUrl, config, axiosClient, {
      platform: resolved.platform,
      shortcode: resolved.shortcode,
      logger: deps.logger || console,
    });
    const validatedCdnUrls = await validateAllCdnCandidates(parsed.candidates, {
      lookupFn: deps.lookupFn,
    });
    jobDir = await createJobTempDir(config.tempBaseDir);

    const downloadOpts = {
      jobDir,
      timeoutMs: config.timeoutMs,
      axiosClient: deps.fetchFn ? null : axiosClient,
      fetchFn: deps.fetchFn,
      lookupFn: deps.lookupFn,
    };

    const items = [];
    let lastDownloadError = null;
    let remainingBytes = maxBytes;

    if (parsed.mode === 'carousel' || parsed.mode === 'image') {
      const selected =
        parsed.mode === 'image'
          ? parsed.candidates
          : parsed.candidates.slice(0, DISCORD_MAX_ATTACHMENTS);
      for (let i = 0; i < selected.length; i += 1) {
        if (remainingBytes < 1024) break;
        try {
          const file = await downloadMediaToTempFile({
            ...downloadOpts,
            url: selected[i].url,
            fileBaseName:
              parsed.mode === 'image'
                ? `${resolved.platform}_image`
                : `${resolved.platform}_slide_${i + 1}`,
            maxBytes: remainingBytes,
          });
          items.push(file);
          remainingBytes -= file.sizeBytes;
          if (parsed.mode === 'image') {
            break;
          }
        } catch (err) {
          lastDownloadError = err;
          if (items.length === 0 && !allowCdnFallback && selected.length === 1) {
            throw err;
          }
        }
      }

      if (items.length > 0) {
        const summary = summarizeDownloadedMedia(items);
        return {
          mode: 'attachments',
          jobDir,
          platform: resolved.platform,
          platformLabel: PLATFORM_LABELS[resolved.platform],
          sourceUrl: resolved.normalizedUrl,
          provider: 'rapidapi',
          title: parsed.title,
          author: parsed.author,
          items,
          attachments: items,
          primaryCdnUrl: selected[0].url,
          cdnLinks: selected.map((c) => c.url),
          truncatedCount:
            parsed.mode === 'image' ? 0 : Math.max(0, parsed.candidates.length - items.length),
          ...summary,
        };
      }
    } else {
      // Video tunggal: coba kandidat kualitas tertinggi (HD tanpa watermark), fallback ke varian berikutnya jika > maxBytes
      for (const candidate of parsed.candidates) {
        try {
          const file = await downloadMediaToTempFile({
            ...downloadOpts,
            url: candidate.url,
            fileBaseName: `${resolved.platform}_video`,
            maxBytes,
          });
          const summary = summarizeDownloadedMedia([file]);
          return {
            mode: 'attachments',
            jobDir,
            platform: resolved.platform,
            platformLabel: PLATFORM_LABELS[resolved.platform],
            sourceUrl: resolved.normalizedUrl,
            provider: 'rapidapi',
            title: parsed.title,
            author: parsed.author,
            items: [file],
            attachments: [file],
            primaryCdnUrl: candidate.url,
            cdnLinks: validatedCdnUrls,
            truncatedCount: 0,
            ...summary,
          };
        } catch (err) {
          lastDownloadError = err;
          if (err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET) {
            throw err;
          }
        }
      }
    }

    if (allowCdnFallback) {
      await cleanupTempDir(jobDir);
      jobDir = null;

      const verifiedFallbackUrls = await validateAllCdnCandidates(parsed.candidates, {
        lookupFn: deps.lookupFn,
      });

      const isTooLarge =
        lastDownloadError instanceof DownloaderError &&
        lastDownloadError.code === DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE;

      return {
        mode: 'fallback',
        jobDir: null,
        platform: resolved.platform,
        platformLabel: PLATFORM_LABELS[resolved.platform],
        sourceUrl: resolved.normalizedUrl,
        provider: 'rapidapi',
        title: parsed.title,
        author: parsed.author,
        items: [],
        attachments: [],
        primaryCdnUrl: verifiedFallbackUrls[0],
        cdnLinks: verifiedFallbackUrls,
        reason: isTooLarge
          ? `Ukuran media melebihi batas unggahan standar ${formatBytes(maxBytes)}.`
          : 'Media tidak dapat dilampirkan langsung ke Discord, gunakan tautan CDN langsung di bawah ini.',
      };
    }

    if (lastDownloadError instanceof DownloaderError) {
      throw lastDownloadError;
    }

    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      'Tidak ada file media valid yang berhasil diunduh dari RapidAPI.',
    );
  } catch (error) {
    if (jobDir) {
      await cleanupTempDir(jobDir);
    }
    if (error instanceof DownloaderError) {
      throw error;
    }
    throw mapRapidApiError(error);
  } finally {
    activeDownloads = Math.max(0, activeDownloads - 1);
  }
}

/**
 * Alias eksplisit untuk kompatibilitas pemanggilan Auto-Downloader.
 */
export async function downloadViaRapidApi(params) {
  return downloadMediaFromUrl({
    allowCdnFallback: true,
    maxBytesOverride: STANDARD_DISCORD_UPLOAD_LIMIT_BYTES,
    ...params,
  });
}
