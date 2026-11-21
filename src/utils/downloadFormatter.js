import path from 'node:path';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from '../services/downloader/errors.js';
import { formatBytes } from '../services/downloader/media.js';
import { resolvePlatformLabel } from '../services/downloader/platform.js';

export const DOWNLOAD_SAFE_MENTION_OPTIONS = Object.freeze({
  parse: [],
  users: [],
  roles: [],
  repliedUser: false,
});

const PLACEHOLDER_VALUES = new Set(['undefined', 'null', 'none', 'n/a', 'na', '-']);
const MAX_CREATOR_LENGTH = 60;
const MAX_TITLE_LENGTH = 140;

/**
 * Collapses whitespace and strips placeholder sentinel values (`undefined`, `null`, etc.).
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeTextField(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed || PLACEHOLDER_VALUES.has(collapsed.toLowerCase())) {
    return '';
  }
  return collapsed;
}

/**
 * Formats a creator username as `@creator`, omitting unavailable or placeholder values.
 *
 * @param {unknown} rawAuthor
 * @returns {string}
 */
export function formatCreatorHandle(rawAuthor) {
  const cleaned = sanitizeTextField(rawAuthor);
  if (!cleaned) {
    return '';
  }
  const handle = cleaned.replace(/^@+/, '').trim();
  if (!handle || PLACEHOLDER_VALUES.has(handle.toLowerCase())) {
    return '';
  }
  const truncated =
    handle.length > MAX_CREATOR_LENGTH
      ? `${handle.slice(0, MAX_CREATOR_LENGTH - 3).trimEnd()}...`
      : handle;
  return `@${truncated}`;
}

/**
 * Formats a media title/caption into a compact single-line string.
 *
 * @param {unknown} rawTitle
 * @param {number} [maxLength]
 * @returns {string}
 */
export function formatDownloadTitle(rawTitle, maxLength = MAX_TITLE_LENGTH) {
  const cleaned = sanitizeTextField(rawTitle);
  if (!cleaned) {
    return '';
  }
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(4, maxLength - 3)).trimEnd()}...`;
}

/**
 * Resolves a human-readable platform label from download metadata.
 *
 * @param {{ platformLabel?: unknown, platform?: unknown, extractor?: unknown }} params
 * @returns {string}
 */
function resolveDownloaderPlatform({ platformLabel, platform, extractor }) {
  const explicitLabel = sanitizeTextField(platformLabel);
  if (explicitLabel) {
    if (explicitLabel.toLowerCase().includes('threads')) {
      return 'Threads';
    }
    return explicitLabel;
  }

  const extractorText = sanitizeTextField(extractor);
  const platformText = sanitizeTextField(platform);
  if (!extractorText && !platformText) {
    return '';
  }

  const resolved = resolvePlatformLabel(extractorText || null, platformText || undefined, '');
  return sanitizeTextField(resolved);
}

/**
 * Resolves uppercase media format(s) from explicit format metadata or attachment filenames.
 *
 * @param {{ fileFormat?: unknown, items?: Array<object>, attachments?: Array<object> }} params
 * @returns {string}
 */
function resolveMediaFormat({ fileFormat, items, attachments }) {
  const explicit = sanitizeTextField(fileFormat);
  if (explicit) {
    return explicit.toUpperCase();
  }

  const list = Array.isArray(items) && items.length > 0 ? items : attachments;
  if (!Array.isArray(list) || list.length === 0) {
    return '';
  }

  const formats = [];
  for (const item of list) {
    const itemFormat = sanitizeTextField(item?.format);
    if (itemFormat) {
      formats.push(itemFormat.toUpperCase());
      continue;
    }
    const fileName = sanitizeTextField(item?.fileName);
    if (fileName) {
      const ext = path.extname(fileName).replace(/^\./, '').trim();
      if (ext) {
        formats.push(ext.toUpperCase());
      }
    }
  }

  return [...new Set(formats)].join(' / ');
}

/**
 * Resolves formatted file size (KB/MB/B) from metadata or item byte sizes.
 *
 * @param {{
 *   formattedSize?: unknown,
 *   totalBytes?: unknown,
 *   items?: Array<object>,
 *   attachments?: Array<object>,
 * }} params
 * @returns {string}
 */
function resolveFormattedFileSize({ formattedSize, totalBytes, items, attachments }) {
  if (typeof totalBytes === 'number' && Number.isFinite(totalBytes) && totalBytes > 0) {
    return formatBytes(totalBytes);
  }

  const explicit = sanitizeTextField(formattedSize);
  if (explicit) {
    return explicit;
  }

  const list = Array.isArray(items) && items.length > 0 ? items : attachments;
  if (Array.isArray(list) && list.length > 0) {
    const summed = list.reduce(
      (sum, item) => sum + (typeof item?.sizeBytes === 'number' && item.sizeBytes > 0 ? item.sizeBytes : 0),
      0,
    );
    if (summed > 0) {
      return formatBytes(summed);
    }
  }

  return '';
}

/**
 * Formats a completed media download into the Ultra Compact Plain Text output:
 *
 * ```text
 * ✅ @creator · TikTok
 *
 * #trending #foryou · MP4 · 392.2 KB
 * ```
 *
 * Gracefully omits unavailable metadata without rendering `undefined`, `null`, or placeholders.
 *
 * @param {{
 *   author?: unknown,
 *   platformLabel?: unknown,
 *   platform?: unknown,
 *   extractor?: unknown,
 *   title?: unknown,
 *   fileFormat?: unknown,
 *   formattedSize?: unknown,
 *   totalBytes?: unknown,
 *   items?: Array<object>,
 *   attachments?: Array<object>,
 * }} params
 * @returns {string}
 */
export function formatDownloadSuccessMessage({
  author,
  platformLabel,
  platform,
  extractor,
  title,
  fileFormat,
  formattedSize,
  totalBytes,
  items,
  attachments,
} = {}) {
  const creator = formatCreatorHandle(author);
  const resolvedPlatform = resolveDownloaderPlatform({ platformLabel, platform, extractor });
  const headerParts = [creator, resolvedPlatform].filter(Boolean);
  const firstLine = headerParts.length > 0 ? `✅ ${headerParts.join(' · ')}` : '✅';

  const cleanTitle = formatDownloadTitle(title);
  const cleanFormat = resolveMediaFormat({ fileFormat, items, attachments });
  const cleanSize = resolveFormattedFileSize({ formattedSize, totalBytes, items, attachments });

  const detailParts = [cleanTitle, cleanFormat, cleanSize].filter(Boolean);
  if (detailParts.length === 0) {
    return firstLine;
  }

  return `${firstLine}\n\n${detailParts.join(' · ')}`;
}

/**
 * Formats transient downloader progress updates as compact plain text.
 *
 * @param {{ platformLabel?: unknown, progress?: { stage?: string, percent?: number | null, position?: number } | null }} params
 * @returns {string}
 */
export function formatDownloadProcessingMessage({ platformLabel, progress = null } = {}) {
  const platform = sanitizeTextField(platformLabel);
  const prefix = platform ? `⏳ ${platform}` : '⏳';

  if (progress?.stage === 'queued') {
    return `${prefix} · Queued (#${progress.position || 1})`;
  }
  if (progress?.stage === 'processing') {
    return `${prefix} · Processing...`;
  }
  if (progress?.stage === 'downloading' && typeof progress.percent === 'number' && progress.percent > 0) {
    return `${prefix} · Downloading (${progress.percent.toFixed(0)}%)`;
  }
  return `${prefix} · Downloading...`;
}

const ERROR_CODE_REASONS = Object.freeze({
  [DOWNLOADER_ERROR_CODES.INVALID_URL]: 'Invalid URL',
  [DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM]: 'Unsupported URL',
  [DOWNLOADER_ERROR_CODES.UNSAFE_TARGET]: 'Blocked URL',
  [DOWNLOADER_ERROR_CODES.MISSING_DEPENDENCY]: 'Downloader service unavailable',
  [DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED]: 'Private or restricted media',
  [DOWNLOADER_ERROR_CODES.NOT_FOUND]: 'Media unavailable',
  [DOWNLOADER_ERROR_CODES.UNSUPPORTED_MEDIA]: 'Unsupported media format',
  [DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE]: 'File exceeds Discord upload limit',
  [DOWNLOADER_ERROR_CODES.DURATION_EXCEEDED]: 'Media duration too long',
  [DOWNLOADER_ERROR_CODES.TIMEOUT]: 'Request timed out',
  [DOWNLOADER_ERROR_CODES.RATE_LIMITED]: 'Rate limited by source',
  [DOWNLOADER_ERROR_CODES.NETWORK_ERROR]: 'Network error',
  [DOWNLOADER_ERROR_CODES.BUSY]: 'Downloader queue is busy',
  [DOWNLOADER_ERROR_CODES.UPLOAD_FAILED]: 'Discord upload failed',
  [DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED]: 'Media unavailable',
});

/**
 * Formats downloader and Discord upload failures as compact plain text:
 * `❌ Download failed · <reason>`.
 *
 * @param {unknown} errorOrReason
 * @returns {string}
 */
export function formatDownloadErrorMessage(errorOrReason) {
  if (typeof errorOrReason === 'string') {
    const direct = sanitizeTextField(errorOrReason);
    return `❌ Download failed · ${direct || 'Media unavailable'}`;
  }

  const discordCode = errorOrReason?.code ?? errorOrReason?.rawError?.code;
  if (
    discordCode === 40005 ||
    String(errorOrReason?.message || '').includes('Request entity too large')
  ) {
    return '❌ Download failed · File exceeds Discord upload limit';
  }
  if (discordCode === 50013) {
    return '❌ Download failed · Missing Attach Files permission';
  }

  if (errorOrReason instanceof DownloaderError) {
    const mapped = ERROR_CODE_REASONS[errorOrReason.code];
    if (mapped) {
      return `❌ Download failed · ${mapped}`;
    }
  }

  if (typeof errorOrReason?.code === 'string' && Object.hasOwn(ERROR_CODE_REASONS, errorOrReason.code)) {
    return `❌ Download failed · ${ERROR_CODE_REASONS[errorOrReason.code]}`;
  }

  return '❌ Download failed · Media unavailable';
}
