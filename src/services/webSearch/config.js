export const DEFAULT_TAVILY_API_URL = 'https://api.tavily.com/search';
export const DEFAULT_WEB_SEARCH_ENABLED = true;
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_WEB_SEARCH_CACHE_TTL_SECONDS = 900;
export const DEFAULT_WEB_SEARCH_COOLDOWN_SECONDS = 10;
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 15_000;
export const DEFAULT_WEB_SEARCH_GLOBAL_MAX_PER_MIN = 20;

export const MAX_SNIPPET_CHARS = 500;
export const MAX_TOTAL_SEARCH_CONTEXT_CHARS = 3500;

/**
 * Parses a positive integer env/override value within safe inclusive bounds.
 * @param {unknown} rawValue
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function parseBoundedInt(rawValue, fallback, min, max) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Parses boolean-like env/override flags.
 * @param {unknown} rawValue
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBooleanFlag(rawValue, fallback) {
  if (typeof rawValue === 'boolean') return rawValue;
  if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
  const normalized = String(rawValue).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/**
 * Resolves validated web search configuration from overrides and process.env.
 * @param {Record<string, any>} [overrides]
 */
export function getWebSearchConfig(overrides = {}) {
  const apiKey = String(overrides.apiKey ?? process.env.TAVILY_API_KEY ?? '').trim();
  const apiUrl = String(overrides.apiUrl ?? process.env.TAVILY_API_URL ?? DEFAULT_TAVILY_API_URL).trim();
  const enabled = parseBooleanFlag(
    overrides.enabled ?? process.env.WEB_SEARCH_ENABLED,
    DEFAULT_WEB_SEARCH_ENABLED,
  );
  const maxResults = parseBoundedInt(
    overrides.maxResults ?? process.env.WEB_SEARCH_MAX_RESULTS,
    DEFAULT_WEB_SEARCH_MAX_RESULTS,
    1,
    5,
  );
  const cacheTtlSeconds = parseBoundedInt(
    overrides.cacheTtlSeconds ?? process.env.WEB_SEARCH_CACHE_TTL,
    DEFAULT_WEB_SEARCH_CACHE_TTL_SECONDS,
    60,
    86_400,
  );
  const cooldownSeconds = parseBoundedInt(
    overrides.cooldownSeconds ?? process.env.WEB_SEARCH_COOLDOWN_SECONDS,
    DEFAULT_WEB_SEARCH_COOLDOWN_SECONDS,
    1,
    300,
  );
  const timeoutMs = parseBoundedInt(
    overrides.timeoutMs ?? process.env.WEB_SEARCH_TIMEOUT_MS,
    DEFAULT_WEB_SEARCH_TIMEOUT_MS,
    1_000,
    60_000,
  );
  const globalMaxPerMinute = parseBoundedInt(
    overrides.globalMaxPerMinute ?? process.env.WEB_SEARCH_GLOBAL_MAX_PER_MIN,
    DEFAULT_WEB_SEARCH_GLOBAL_MAX_PER_MIN,
    1,
    200,
  );

  return {
    apiKey,
    apiUrl,
    enabled,
    maxResults,
    cacheTtlMs: cacheTtlSeconds * 1000,
    cooldownMs: cooldownSeconds * 1000,
    timeoutMs,
    globalMaxPerMinute,
  };
}
