import { MAX_SNIPPET_CHARS, getWebSearchConfig } from './config.js';

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
]);

/**
 * Domain error for Tavily Search provider failures.
 */
export class TavilySearchError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [debugDetail]
   */
  constructor(code, message, debugDetail = '') {
    super(message);
    this.name = 'TavilySearchError';
    this.code = code;
    if (debugDetail) {
      this.debugDetail = debugDetail;
    }
  }
}

/**
 * Redacts Tavily API keys and auth headers from any log or debug string.
 * @param {string} text
 * @returns {string}
 */
export function redactTavilySecrets(text) {
  return String(text || '')
    .replace(/tvly-[A-Za-z0-9_-]{6,}/gi, '[REDACTED_TAVILY_KEY]')
    .replace(/(api[_-]?key|authorization|bearer)\s*[:=]?\s*['"]?[A-Za-z0-9._-]{8,}['"]?/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}

/**
 * Sanitizes untrusted web snippet/title text so it cannot break XML/prompt delimiters
 * or inject control characters into Gemini prompts.
 *
 * @param {unknown} rawText
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeWebText(rawText, maxLength = MAX_SNIPPET_CHARS) {
  if (typeof rawText !== 'string') return '';
  const cleaned = rawText
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/<\/?\s*(web_search_results|system|instruction|prompt)[^>]*>/gi, '[filtered-tag]')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

/**
 * Normalizes a URL for deduplication and validates it uses HTTP(S).
 * Returns null if invalid or non-HTTP(S).
 * @param {unknown} rawUrl
 * @returns {{ normalizedKey: string, cleanUrl: string } | null}
 */
function parseAndNormalizeWebUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const dedupUrl = new URL(parsed.toString());
  dedupUrl.hash = '';
  for (const key of [...dedupUrl.searchParams.keys()]) {
    if (TRACKING_QUERY_PARAMS.has(key.toLowerCase())) {
      dedupUrl.searchParams.delete(key);
    }
  }
  if (dedupUrl.pathname.length > 1 && dedupUrl.pathname.endsWith('/')) {
    dedupUrl.pathname = dedupUrl.pathname.slice(0, -1);
  }

  return {
    normalizedKey: dedupUrl.toString().toLowerCase(),
    cleanUrl: parsed.toString(),
  };
}

/**
 * Validates, sanitizes, and deduplicates Tavily search results (max 5 unique URLs).
 * @param {unknown} rawResults
 * @param {number} [maxResults]
 * @returns {Array<{ title: string, url: string, content: string, publishedDate: string | null }>}
 */
export function deduplicateAndValidateResults(rawResults, maxResults = 5) {
  if (!Array.isArray(rawResults)) {
    throw new TavilySearchError(
      'INVALID_RESPONSE',
      'Respons dari penyedia pencarian web tidak valid.',
      'results_not_array',
    );
  }

  const cap = Math.min(5, Math.max(1, maxResults));
  const seenUrls = new Set();
  const normalized = [];

  for (const item of rawResults) {
    if (!item || typeof item !== 'object') continue;
    const urlInfo = parseAndNormalizeWebUrl(item.url);
    if (!urlInfo) continue;
    if (seenUrls.has(urlInfo.normalizedKey)) continue;
    seenUrls.add(urlInfo.normalizedKey);

    const title = sanitizeWebText(item.title || new URL(urlInfo.cleanUrl).hostname, 160);
    const content = sanitizeWebText(item.content || '', MAX_SNIPPET_CHARS);
    const publishedRaw =
      typeof item.published_date === 'string'
        ? item.published_date.trim()
        : typeof item.publishedDate === 'string'
          ? item.publishedDate.trim()
          : '';
    const publishedDate = publishedRaw ? sanitizeWebText(publishedRaw, 40) : null;

    normalized.push({
      title: title || urlInfo.cleanUrl,
      url: urlInfo.cleanUrl,
      content,
      publishedDate,
    });

    if (normalized.length >= cap) {
      break;
    }
  }

  return normalized;
}

/**
 * Maps HTTP / network errors from Tavily into safe domain errors without leaking secrets.
 * @param {number} status
 * @param {string} [bodyText]
 * @returns {TavilySearchError}
 */
function mapTavilyHttpError(status, bodyText = '') {
  const safeDetail = redactTavilySecrets(bodyText).replace(/\s+/g, ' ').trim().slice(0, 180);
  const lower = safeDetail.toLowerCase();

  if (status === 401 || status === 403 || /invalid api key|unauthorized/i.test(lower)) {
    return new TavilySearchError(
      'INVALID_API_KEY',
      'Autentikasi Tavily Search API gagal.',
      `status=${status}`,
    );
  }

  if (status === 402 || status === 432 || status === 433 || /quota|credit|plan limit|usage limit/i.test(lower)) {
    return new TavilySearchError(
      'QUOTA_EXCEEDED',
      'Kuota Tavily Search API saat ini sudah habis.',
      `status=${status}`,
    );
  }

  if (status === 429 || /rate limit|too many requests/i.test(lower)) {
    return new TavilySearchError(
      'RATE_LIMITED',
      'Tavily Search API sedang mencapai batas rate limit.',
      `status=${status}`,
    );
  }

  return new TavilySearchError(
    'API_ERROR',
    'Pencarian web sedang mengalami gangguan sementara.',
    `status=${status}${safeDetail ? ` detail=${safeDetail}` : ''}`,
  );
}

/**
 * Executes a single Tavily Search API call.
 *
 * @param {string} query
 * @param {{
 *   topic?: 'general' | 'news',
 *   maxResults?: number,
 *   timeoutMs?: number,
 *   apiKey?: string,
 *   apiUrl?: string,
 *   fetchFn?: typeof fetch,
 * }} [options]
 * @returns {Promise<{ results: Array<{ title: string, url: string, content: string, publishedDate: string | null }>, searchedAt: string }>}
 */
export async function searchTavily(query, options = {}) {
  const config = getWebSearchConfig(options);
  if (!config.apiKey) {
    throw new TavilySearchError(
      'MISSING_API_KEY',
      'TAVILY_API_KEY belum dikonfigurasi.',
    );
  }

  const cleanQuery = String(query || '').trim().slice(0, 300);
  if (!cleanQuery) {
    throw new TavilySearchError('EMPTY_QUERY', 'Query pencarian tidak boleh kosong.');
  }

  const topic = options.topic === 'news' ? 'news' : 'general';
  const maxResults = Math.min(5, Math.max(1, options.maxResults ?? config.maxResults));
  const fetchImpl = options.fetchFn ?? globalThis.fetch;

  let response;
  try {
    response = await fetchImpl(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        query: cleanQuery,
        search_depth: 'basic',
        topic,
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const name = typeof error?.name === 'string' ? error.name : '';
    const msg = redactTavilySecrets(error?.message ?? '');
    if (name === 'AbortError' || name === 'TimeoutError' || /timeout|aborted|etimedout/i.test(msg)) {
      throw new TavilySearchError(
        'TIMEOUT',
        'Permintaan pencarian web melebihi batas waktu.',
        `name=${name || 'Timeout'}`,
      );
    }
    throw new TavilySearchError(
      'API_ERROR',
      'Gagal menghubungi layanan pencarian web.',
      msg.slice(0, 180),
    );
  }

  if (!response?.ok) {
    let errBody = '';
    try {
      errBody = typeof response?.text === 'function' ? await response.text() : '';
    } catch {
      errBody = '';
    }
    throw mapTavilyHttpError(Number(response?.status || 0), errBody);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new TavilySearchError(
      'INVALID_RESPONSE',
      'Respons JSON dari Tavily Search API tidak valid.',
      'json_parse_failed',
    );
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.results)) {
    throw new TavilySearchError(
      'INVALID_RESPONSE',
      'Struktur respons Tavily Search API tidak valid.',
      'missing_results_array',
    );
  }

  const results = deduplicateAndValidateResults(data.results, maxResults);
  if (results.length === 0) {
    throw new TavilySearchError(
      'EMPTY_RESULTS',
      'Tidak ada hasil pencarian web yang relevan ditemukan.',
    );
  }

  return {
    results,
    searchedAt: new Date().toISOString(),
  };
}
