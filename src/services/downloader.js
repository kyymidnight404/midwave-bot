import axios from 'axios';
import {
  DEFAULT_CHAT_AUTODOWNLOAD_MAX_SIZE_MB,
  DEFAULT_RAPIDAPI_HOST,
  DEFAULT_RAPIDAPI_PATH,
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
  PLATFORMS,
  PLATFORM_LABELS,
  resolveAndValidateRedirects,
  validateMediaUrl,
} from './downloader/urlValidator.js';

export {
  DEFAULT_CHAT_AUTODOWNLOAD_MAX_SIZE_MB,
  DEFAULT_RAPIDAPI_HOST,
  DEFAULT_RAPIDAPI_PATH,
  DISCORD_MAX_ATTACHMENTS,
  DOWNLOAD_COOLDOWN_MS,
  getDiscordUploadLimitBytes,
  getDownloaderConfig,
};
export { DOWNLOADER_ERROR_CODES, DownloaderError };
export { cleanupTempDir, formatBytes };
export { PLATFORMS, PLATFORM_LABELS, validateMediaUrl };

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
 * Validates that a candidate CDN URL uses HTTPS without embedded credentials.
 *
 * @param {string} rawUrl
 * @returns {string | null}
 */
function sanitizeCdnUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
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

function sanitizeLogText(value, maxLen = 160) {
  return String(value ?? '')
    .replace(/(x-rapidapi-key|api[_-]?key|token|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
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

/**
 * Normalizes flexible RapidAPI JSON responses (`links`, `medias`, `images`, `items`, or single `url`)
 * into prioritized download candidates.
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
    root.success === false ||
    payload.success === false ||
    root.error === true ||
    payload.error === true
  ) {
    const rawMsg = extractApiErrorMessage(payload) || extractApiErrorMessage(root);
    const apiMsg = rawMsg.toLowerCase();

    if (
      apiMsg.includes('invalid api key') ||
      apiMsg.includes('not subscribed') ||
      apiMsg.includes('unauthorized') ||
      apiMsg.includes('forbidden') ||
      apiMsg.includes('subscription')
    ) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
        'Autentikasi RapidAPI gagal atau belum berlangganan API (`RAPIDAPI_KEY`).',
        { details: sanitizeLogText(rawMsg) },
      );
    }
    if (apiMsg.includes('quota') || apiMsg.includes('exceeded') || apiMsg.includes('limit')) {
      throw new DownloaderError(
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
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
        'Konten bersifat privat atau dibatasi oleh platform sumber.',
        { details: sanitizeLogText(rawMsg) },
      );
    }
    if (apiMsg.includes('unsupported') || apiMsg.includes('not supported') || apiMsg.includes('invalid url')) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM,
        'Format URL atau jenis postingan ini belum didukung oleh RapidAPI.',
        { details: sanitizeLogText(rawMsg) },
      );
    }
    if (apiMsg.includes('not found') || apiMsg.includes('unavailable') || apiMsg.includes('deleted')) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.NOT_FOUND,
        'Media tidak ditemukan atau postingan telah dihapus.',
        { details: sanitizeLogText(rawMsg) },
      );
    }
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'RapidAPI gagal mengekstrak media dari tautan tersebut.',
      { details: sanitizeLogText(rawMsg) },
    );
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
  const { platform = null, logger = console } = options;
  const defaultUniversalEndpoint = `https://${DEFAULT_RAPIDAPI_HOST}${DEFAULT_RAPIDAPI_PATH}`;
  const endpoints = [config.rapidApiEndpoint];

  if (
    config.rapidApiHost === DEFAULT_RAPIDAPI_HOST &&
    config.rapidApiEndpoint === defaultUniversalEndpoint &&
    (platform === PLATFORMS.INSTAGRAM || platform === PLATFORMS.TIKTOK)
  ) {
    endpoints.push(`https://${config.rapidApiHost}/smvd/get/${platform}`);
  }

  let lastError = null;
  for (let epIdx = 0; epIdx < endpoints.length; epIdx += 1) {
    const endpoint = endpoints[epIdx];
    const endpointLabel = getSafeEndpointLabel(endpoint);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await axiosClient.get(endpoint, {
          params: { url: targetUrl },
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
          `[Downloader] RapidAPI request failed (${endpointLabel}, platform=${platform || 'unknown'}, status=${status ?? error?.code ?? 'ERR'}, code=${mapped.code}): ${sanitizeLogText(mapped.details || mapped.userMessage)}`,
        );

        if (attempt === 0 && mapped.retryable) {
          continue;
        }

        const canTryPlatformEndpoint =
          epIdx === 0 &&
          endpoints.length > 1 &&
          (status === 404 || mapped.code === DOWNLOADER_ERROR_CODES.NOT_FOUND);

        if (canTryPlatformEndpoint) {
          break;
        }
        throw mapped;
      }
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
      logger: deps.logger || console,
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
      const selected = parsed.candidates.slice(0, DISCORD_MAX_ATTACHMENTS);
      for (let i = 0; i < selected.length; i += 1) {
        if (remainingBytes < 1024) break;
        try {
          const file = await downloadMediaToTempFile({
            ...downloadOpts,
            url: selected[i].url,
            fileBaseName: `${resolved.platform}_slide_${i + 1}`,
            maxBytes: remainingBytes,
          });
          items.push(file);
          remainingBytes -= file.sizeBytes;
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
          truncatedCount: Math.max(0, parsed.candidates.length - items.length),
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
            cdnLinks: parsed.candidates.map((c) => c.url),
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
        primaryCdnUrl: parsed.candidates[0].url,
        cdnLinks: parsed.candidates.map((c) => c.url),
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
