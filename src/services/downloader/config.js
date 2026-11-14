import os from 'node:os';

export const DISCORD_MAX_ATTACHMENTS = 10;
export const DEFAULT_DOWNLOAD_MAX_SIZE_MB = 25;
export const DEFAULT_CHAT_AUTODOWNLOAD_MAX_SIZE_MB = 10;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 25_000;
export const DEFAULT_DOWNLOAD_MAX_CONCURRENT = 3;
export const DEFAULT_DOWNLOAD_COOLDOWN_SECONDS = 10;
export const DEFAULT_RAPIDAPI_HOST = 'social-media-video-downloader.p.rapidapi.com';
export const DEFAULT_TIKTOK_RAPIDAPI_PATH = '/tiktok/v3/post/details';
export const DEFAULT_RAPIDAPI_PATH = DEFAULT_TIKTOK_RAPIDAPI_PATH;
export const DEFAULT_INSTAGRAM_RAPIDAPI_PATH = '/instagram/v3/media/post/details';
export const DEFAULT_INSTAGRAM_RENDERABLE_FORMATS = '720p';

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
 * Builds the runtime downloader configuration from environment variables.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   maxSizeMb: number,
 *   timeoutMs: number,
 *   maxConcurrent: number,
 *   cooldownMs: number,
 *   tempBaseDir: string,
 *   rapidApiKey: string,
 *   rapidApiHost: string,
 *   rapidApiEndpoint: string,
 *   rapidApiConfigured: boolean,
 * }}
 */
export function getDownloaderConfig(env = process.env) {
  const maxSizeMb = parseClampedInt(env.DOWNLOAD_MAX_SIZE_MB, DEFAULT_DOWNLOAD_MAX_SIZE_MB, 1, 100);
  const timeoutMs = parseClampedInt(env.DOWNLOAD_TIMEOUT_MS, DEFAULT_DOWNLOAD_TIMEOUT_MS, 5_000, 180_000);
  const maxConcurrent = parseClampedInt(
    env.DOWNLOAD_MAX_CONCURRENT,
    DEFAULT_DOWNLOAD_MAX_CONCURRENT,
    1,
    20,
  );
  const cooldownSeconds = parseClampedInt(
    env.DOWNLOAD_COOLDOWN_SECONDS,
    DEFAULT_DOWNLOAD_COOLDOWN_SECONDS,
    0,
    300,
  );

  const rapidApiKey = (env.RAPIDAPI_KEY || '').trim();
  const rapidApiHost = (env.RAPIDAPI_HOST || DEFAULT_RAPIDAPI_HOST).trim();
  const customTikTokEndpoint = (env.RAPIDAPI_TIKTOK_ENDPOINT || env.RAPIDAPI_ENDPOINT || '').trim();
  const tiktokRapidApiEndpoint =
    customTikTokEndpoint || `https://${rapidApiHost}${DEFAULT_TIKTOK_RAPIDAPI_PATH}`;
  const rapidApiEndpoint = tiktokRapidApiEndpoint;
  const customInstagramEndpoint = (env.RAPIDAPI_INSTAGRAM_ENDPOINT || '').trim();
  const instagramRapidApiEndpoint =
    customInstagramEndpoint || `https://${rapidApiHost}${DEFAULT_INSTAGRAM_RAPIDAPI_PATH}`;
  const instagramRenderableFormats = (
    env.RAPIDAPI_RENDERABLE_FORMATS ?? DEFAULT_INSTAGRAM_RENDERABLE_FORMATS
  ).trim();
  const tempBaseDir = (env.DOWNLOAD_TEMP_DIR || '').trim() || os.tmpdir();

  return {
    maxSizeMb,
    timeoutMs,
    maxConcurrent,
    cooldownMs: cooldownSeconds * 1000,
    tempBaseDir,
    rapidApiKey,
    rapidApiHost,
    rapidApiEndpoint,
    tiktokRapidApiEndpoint,
    instagramRapidApiEndpoint,
    instagramRenderableFormats,
    rapidApiConfigured: Boolean(rapidApiKey && rapidApiHost),
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
