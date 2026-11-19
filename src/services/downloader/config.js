import path from 'node:path';

export const DISCORD_MAX_ATTACHMENTS = 10;
export const DEFAULT_DOWNLOAD_MAX_SIZE_MB = 25;
export const DEFAULT_CHAT_AUTODOWNLOAD_MAX_SIZE_MB = 10;
export const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 60;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = DEFAULT_DOWNLOAD_TIMEOUT_SECONDS * 1000;
export const DEFAULT_DOWNLOAD_MAX_CONCURRENT = 3;
export const DEFAULT_DOWNLOAD_MAX_QUEUE_SIZE = 10;
export const DEFAULT_DOWNLOAD_COOLDOWN_SECONDS = 10;
export const DEFAULT_DOWNLOAD_MAX_DURATION_SECONDS = 900;
export const DEFAULT_DOWNLOAD_TEMP_DIR = './temp/downloads';
export const DEFAULT_PYTHON_PATH = process.platform === 'win32' ? 'python' : 'python3';
export const DEFAULT_YTDLP_PATH = 'yt-dlp';

/**
 * Parses an integer environment variable with clamping.
 *
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseClampedInt(raw, fallback, min, max) {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export const DOWNLOAD_COOLDOWN_MS =
  parseClampedInt(
    process.env.DOWNLOAD_COOLDOWN_SECONDS,
    DEFAULT_DOWNLOAD_COOLDOWN_SECONDS,
    0,
    300,
  ) * 1000;

/**
 * Resolves the configured temporary download directory path.
 *
 * @param {string | undefined} rawTempDir
 * @returns {string}
 */
export function resolveTempBaseDir(rawTempDir) {
  const cleaned = typeof rawTempDir === 'string' ? rawTempDir.trim() : '';
  const target = cleaned || DEFAULT_DOWNLOAD_TEMP_DIR;
  return path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
}

/**
 * Builds the runtime yt-dlp downloader configuration from environment variables.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function getDownloaderConfig(env = process.env) {
  const maxSizeMb = parseClampedInt(env.DOWNLOAD_MAX_SIZE_MB, DEFAULT_DOWNLOAD_MAX_SIZE_MB, 1, 100);

  let timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS;
  if (env.DOWNLOAD_TIMEOUT_SECONDS !== undefined && env.DOWNLOAD_TIMEOUT_SECONDS !== '') {
    timeoutMs =
      parseClampedInt(env.DOWNLOAD_TIMEOUT_SECONDS, DEFAULT_DOWNLOAD_TIMEOUT_SECONDS, 5, 300) * 1000;
  } else if (env.DOWNLOAD_TIMEOUT_MS !== undefined && env.DOWNLOAD_TIMEOUT_MS !== '') {
    timeoutMs = parseClampedInt(env.DOWNLOAD_TIMEOUT_MS, DEFAULT_DOWNLOAD_TIMEOUT_MS, 5_000, 300_000);
  }

  const maxConcurrent = parseClampedInt(
    env.DOWNLOAD_MAX_CONCURRENT,
    DEFAULT_DOWNLOAD_MAX_CONCURRENT,
    1,
    10,
  );
  const maxQueueSize = parseClampedInt(
    env.DOWNLOAD_MAX_QUEUE_SIZE,
    DEFAULT_DOWNLOAD_MAX_QUEUE_SIZE,
    0,
    50,
  );
  const maxDurationSeconds = parseClampedInt(
    env.DOWNLOAD_MAX_DURATION_SECONDS,
    DEFAULT_DOWNLOAD_MAX_DURATION_SECONDS,
    0,
    7200,
  );
  const cooldownSeconds = parseClampedInt(
    env.DOWNLOAD_COOLDOWN_SECONDS,
    DEFAULT_DOWNLOAD_COOLDOWN_SECONDS,
    0,
    300,
  );

  const pythonPath = (env.PYTHON_PATH || '').trim() || DEFAULT_PYTHON_PATH;
  const ytdlpPath = (env.YTDLP_PATH || '').trim() || DEFAULT_YTDLP_PATH;
  const ffmpegPath = (env.FFMPEG_PATH || '').trim() || null;
  const ffprobePath = (env.FFPROBE_PATH || '').trim() || null;
  const denoPath = (env.DENO_PATH || '').trim() || null;
  const tempBaseDir = resolveTempBaseDir(env.DOWNLOAD_TEMP_DIR);
  const autoDownloadEnabled = String(env.AUTO_DOWNLOAD_ENABLED ?? 'true').trim().toLowerCase() !== 'false';

  return {
    maxSizeMb,
    timeoutMs,
    timeoutSeconds: Math.ceil(timeoutMs / 1000),
    maxConcurrent,
    maxQueueSize,
    maxDurationSeconds,
    cooldownMs: cooldownSeconds * 1000,
    tempBaseDir,
    pythonPath,
    ytdlpPath,
    ffmpegPath,
    ffprobePath,
    denoPath,
    autoDownloadEnabled,
  };
}

/**
 * Computes the effective Discord upload limit in bytes based on guild boost tier
 * and the operator's configured maximum size cap.
 *
 * @param {{ premiumTier?: number } | null | undefined} guild
 * @param {number} [configuredMaxMb]
 * @returns {{ maxBytes: number, maxMb: number, tierLabel: string }}
 */
export function getDiscordUploadLimitBytes(guild, configuredMaxMb = DEFAULT_DOWNLOAD_MAX_SIZE_MB) {
  const tier = typeof guild?.premiumTier === 'number' ? guild.premiumTier : 0;

  let serverCapMb = 25;
  let tierLabel = 'Standar (25 MB)';

  if (tier >= 3) {
    serverCapMb = 100;
    tierLabel = 'Server Boost Level 3 (100 MB)';
  } else if (tier === 2) {
    serverCapMb = 50;
    tierLabel = 'Server Boost Level 2 (50 MB)';
  }

  const effectiveMb = Math.min(serverCapMb, configuredMaxMb);

  return {
    maxMb: effectiveMb,
    maxBytes: effectiveMb * 1024 * 1024,
    tierLabel,
  };
}
