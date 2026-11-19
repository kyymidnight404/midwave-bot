import {
  DEFAULT_CHAT_AUTODOWNLOAD_MAX_SIZE_MB,
  DEFAULT_DOWNLOAD_MAX_SIZE_MB,
  DISCORD_MAX_ATTACHMENTS,
  DOWNLOAD_COOLDOWN_MS,
  getDiscordUploadLimitBytes,
  getDownloaderConfig,
} from './config.js';
import {
  assertInsideDir,
  cleanupStaleTempDirs,
  cleanupTempDir,
  createJobTempDir,
} from './cleanup.js';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from './errors.js';
import {
  detectMediaSignature,
  formatBytes,
  inspectMediaFile,
  sanitizeFileBaseName,
  summarizeDownloadedMedia,
  validateAndPrepareMediaItems,
} from './media.js';
import {
  PLATFORMS,
  PLATFORM_LABELS,
  assertSafeRemoteHost,
  detectPlatformFromHost,
  extractInstagramShortcode,
  isPrivateOrReservedIp,
  resolveAndValidateRedirects,
  resolvePlatformLabel,
  validateMediaUrl,
} from './platform.js';
import { DownloadQueue, defaultDownloadQueue } from './queue.js';
import {
  YTDLP_SCRIPT_PATH,
  resolveDenoBinary,
  resolvePythonBinary,
  runYtDlpDownload,
  sanitizeLogText,
} from './ytdlp.js';

export {
  DEFAULT_CHAT_AUTODOWNLOAD_MAX_SIZE_MB,
  DEFAULT_DOWNLOAD_MAX_SIZE_MB,
  DISCORD_MAX_ATTACHMENTS,
  DOWNLOADER_ERROR_CODES,
  DOWNLOAD_COOLDOWN_MS,
  DownloaderError,
  DownloadQueue,
  PLATFORMS,
  PLATFORM_LABELS,
  YTDLP_SCRIPT_PATH,
  assertInsideDir,
  assertSafeRemoteHost,
  cleanupStaleTempDirs,
  cleanupTempDir,
  createJobTempDir,
  defaultDownloadQueue,
  detectMediaSignature,
  detectPlatformFromHost,
  extractInstagramShortcode,
  formatBytes,
  getDiscordUploadLimitBytes,
  getDownloaderConfig,
  inspectMediaFile,
  isPrivateOrReservedIp,
  resolveAndValidateRedirects,
  resolveDenoBinary,
  resolvePlatformLabel,
  resolvePythonBinary,
  runYtDlpDownload,
  sanitizeFileBaseName,
  sanitizeLogText,
  summarizeDownloadedMedia,
  validateAndPrepareMediaItems,
  validateMediaUrl,
};

export const STANDARD_DISCORD_UPLOAD_LIMIT_BYTES =
  DEFAULT_CHAT_AUTODOWNLOAD_MAX_SIZE_MB * 1024 * 1024;
export const MAX_DISCORD_ATTACHMENTS = DISCORD_MAX_ATTACHMENTS;

/**
 * Returns the active download job count (for concurrency diagnostics and tests).
 *
 * @returns {number}
 */
export function getActiveDownloadCount() {
  return defaultDownloadQueue.getActiveCount();
}

/**
 * Unified yt-dlp downloader pipeline used by `/media action:download`, `!download`,
 * and `messageCreate` AutoDownloader.
 * Caller MUST invoke `cleanupTempDir(result.jobDir)` in `finally` after Discord upload.
 *
 * @param {{
 *   url: string,
 *   mode?: 'video' | 'audio',
 *   guild?: { premiumTier?: number } | null,
 *   maxBytesOverride?: number | null,
 *   config?: ReturnType<typeof getDownloaderConfig>,
 *   onProgress?: (progress: { stage: string, percent?: number | null, position?: number, title?: string }) => void | Promise<void>,
 *   deps?: {
 *     fetchFn?: typeof fetch,
 *     httpsRequestFn?: typeof import('node:https').request,
 *     httpRequestFn?: typeof import('node:http').request,
 *     lookupFn?: typeof import('node:dns/promises').lookup,
 *     spawnFn?: typeof import('node:child_process').spawn,
 *     ytdlpRunner?: typeof runYtDlpDownload,
 *     queue?: DownloadQueue,
 *     logger?: Console,
 *   },
 * }} params
 */
export async function downloadMediaFromUrl(params) {
  const {
    url,
    mode = 'video',
    guild = null,
    maxBytesOverride = null,
    config: rawConfig = getDownloaderConfig(),
    onProgress = null,
    deps = {},
  } = params;

  const config = rawConfig?.fullConfig ?? rawConfig;
  const validated = validateMediaUrl(url);

  const maxBytes =
    typeof maxBytesOverride === 'number' && maxBytesOverride > 0
      ? maxBytesOverride
      : getDiscordUploadLimitBytes(guild, config.maxSizeMb).maxBytes;

  const queue = deps.queue || defaultDownloadQueue;
  if (!deps.queue) {
    queue.configure({
      maxConcurrent: config.maxConcurrent,
      maxQueueSize: config.maxQueueSize,
    });
  }

  return queue.enqueue(
    async () => {
      let jobDir = null;
      try {
        if (typeof onProgress === 'function') {
          await Promise.resolve(onProgress({ stage: 'validating' })).catch(() => {});
        }

        const resolved = await resolveAndValidateRedirects(validated, {
          fetchFn: deps.fetchFn,
          httpsRequestFn: deps.httpsRequestFn,
          httpRequestFn: deps.httpRequestFn,
          lookupFn: deps.lookupFn,
          timeoutMs: Math.min(config.timeoutMs, 15_000),
        });

        jobDir = await createJobTempDir(config.tempBaseDir);

        if (typeof onProgress === 'function') {
          await Promise.resolve(
            onProgress({ stage: 'downloading', percent: null }),
          ).catch(() => {});
        }

        const runner = deps.ytdlpRunner || runYtDlpDownload;
        const ytdlpResult = await runner({
          url: resolved.normalizedUrl,
          jobDir,
          maxBytes,
          mode: mode === 'audio' ? 'audio' : 'video',
          maxDurationSeconds: config.maxDurationSeconds,
          timeoutMs: config.timeoutMs,
          config,
          spawnFn: deps.spawnFn,
          onProgress: (prog) => {
            if (typeof onProgress === 'function') {
              Promise.resolve(
                onProgress({
                  stage: prog.status === 'processing' ? 'processing' : 'downloading',
                  percent: prog.percent ?? null,
                  title: prog.title,
                }),
              ).catch(() => {});
            }
          },
        });

        const prepared = await validateAndPrepareMediaItems(ytdlpResult.files, {
          jobDir,
          maxBytes,
          platform: resolved.platform,
          isAudio: Boolean(ytdlpResult.is_audio || mode === 'audio'),
        });

        const resolvedLabel = resolvePlatformLabel(
          ytdlpResult.extractor,
          resolved.platform,
          resolved.hostname,
        );

        const truncatedCount = Math.max(
          prepared.truncatedCount,
          Number(ytdlpResult.truncated_count) || 0,
        );

        return {
          mode: 'attachments',
          jobDir,
          platform: resolved.platform,
          platformLabel: resolvedLabel,
          extractor: ytdlpResult.extractor || resolved.platform,
          sourceUrl: resolved.normalizedUrl,
          provider: 'yt-dlp',
          title: ytdlpResult.title || '',
          author: ytdlpResult.author || '',
          duration: ytdlpResult.duration ?? null,
          items: prepared.items,
          attachments: prepared.items,
          truncatedCount,
          ...prepared.summary,
        };
      } catch (error) {
        if (jobDir) {
          await cleanupTempDir(jobDir);
        }
        if (error instanceof DownloaderError) {
          throw error;
        }
        throw new DownloaderError(
          DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
          'Gagal mengunduh media dari tautan tersebut.',
          {
            cause: error,
            details: sanitizeLogText(error instanceof Error ? error.message : error),
          },
        );
      }
    },
    {
      onQueued: (position) => {
        if (typeof onProgress === 'function') {
          return onProgress({ stage: 'queued', position });
        }
        return undefined;
      },
    },
  );
}
