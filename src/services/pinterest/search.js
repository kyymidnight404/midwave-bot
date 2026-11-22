import { DOWNLOADER_ERROR_CODES, DownloaderError } from '../downloader/errors.js';
import { assertSafeRemoteHost } from '../downloader/platform.js';
import { sanitizeLogText } from '../downloader/ytdlp.js';
import {
  PINTEREST_USER_AGENT,
  extractPinterestResults,
} from './extractor.js';

export const PIN_MAX_QUERY_LENGTH = 150;
export const PIN_DEFAULT_MAX_RESULTS = 10;
export const PIN_SEARCH_PAGE_SIZE = 25;
export const PIN_SEARCH_TIMEOUT_MS = 10_000;
export const PIN_COOLDOWN_MS = 5_000;

export const PINTEREST_SEARCH_ENDPOINT =
  'https://www.pinterest.com/resource/BaseSearchResource/get/';

/**
 * Validates and normalizes the `!pin` search keyword.
 *
 * @param {unknown} rawQuery
 * @returns {string}
 */
export function validatePinterestQuery(rawQuery) {
  if (typeof rawQuery !== 'string') {
    throw new DownloaderError(
      'INVALID_QUERY',
      'Kata kunci pencarian Pinterest wajib diisi. Contoh: `!pin aesthetic wallpaper`.',
    );
  }

  const query = rawQuery.replace(/\s+/g, ' ').trim();
  if (!query) {
    throw new DownloaderError(
      'INVALID_QUERY',
      'Kata kunci pencarian Pinterest tidak boleh kosong. Contoh: `!pin cyberpunk city`.',
    );
  }

  if (query.length > PIN_MAX_QUERY_LENGTH) {
    throw new DownloaderError(
      'INVALID_QUERY',
      `Kata kunci pencarian terlalu panjang (maksimal ${PIN_MAX_QUERY_LENGTH} karakter).`,
    );
  }

  return query;
}

/**
 * Builds the Pinterest `BaseSearchResource` request URL.
 *
 * @param {string} query
 * @param {number} [pageSize]
 * @returns {string}
 */
export function buildPinterestSearchUrl(query, pageSize = PIN_SEARCH_PAGE_SIZE) {
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
  const dataPayload = JSON.stringify({
    options: {
      query,
      scope: 'pins',
      rs: 'typed',
      page_size: pageSize,
    },
    context: {},
  });

  const url = new URL(PINTEREST_SEARCH_ENDPOINT);
  url.searchParams.set('source_url', sourceUrl);
  url.searchParams.set('data', dataPayload);
  return url.toString();
}

function mapSearchNetworkError(error) {
  if (error instanceof DownloaderError) {
    return error;
  }

  const name = typeof error?.name === 'string' ? error.name : '';
  const msg = typeof error?.message === 'string' ? error.message : '';

  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /timeout|timed out|aborted|etimedout/i.test(msg)
  ) {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.TIMEOUT,
      'Pencarian Pinterest melewati batas waktu (timeout). Silakan coba lagi.',
      { retryable: true, cause: error, details: sanitizeLogText(msg) },
    );
  }

  return new DownloaderError(
    DOWNLOADER_ERROR_CODES.NETWORK_ERROR,
    'Gagal menghubungi layanan Pinterest. Silakan coba lagi nanti.',
    { retryable: true, cause: error, details: sanitizeLogText(msg) },
  );
}

/**
 * Searches Pinterest for pins matching `keyword` and extracts normalized Pin items.
 *
 * @param {string | { query: string, maxResults?: number }} input
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   lookupFn?: typeof import('node:dns/promises').lookup,
 *   timeoutMs?: number,
 *   maxResults?: number,
 * }} [options]
 * @returns {Promise<{
 *   query: string,
 *   results: ReturnType<typeof extractPinterestResults>,
 * }>}
 */
export async function searchPinterest(input, options = {}) {
  const rawQuery = typeof input === 'string' ? input : input?.query;
  const query = validatePinterestQuery(rawQuery);
  const maxResults = Math.min(
    25,
    Math.max(1, Number(options.maxResults ?? input?.maxResults ?? PIN_DEFAULT_MAX_RESULTS) || PIN_DEFAULT_MAX_RESULTS),
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PIN_SEARCH_TIMEOUT_MS;

  if (options.lookupFn || fetchImpl === fetch) {
    await assertSafeRemoteHost('www.pinterest.com', {
      lookupFn: options.lookupFn,
    });
  }

  const requestUrl = buildPinterestSearchUrl(
    query,
    Math.max(PIN_SEARCH_PAGE_SIZE, maxResults * 2),
  );

  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: 'GET',
      headers: {
        'User-Agent': PINTEREST_USER_AGENT,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Pinterest-PWS-Handler': 'www/search/[scope].js',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw mapSearchNetworkError(error);
  }

  if (response.status === 429) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.RATE_LIMITED,
      'Pinterest sedang membatasi permintaan (rate limit). Silakan tunggu sebentar lalu coba lagi.',
      { retryable: true, details: 'status=429' },
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
      'Akses pencarian Pinterest ditolak sementara oleh platform sumber.',
      { details: `status=${response.status}` },
    );
  }

  if (!response.ok) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Layanan pencarian Pinterest sedang mengalami gangguan. Silakan coba lagi nanti.',
      { retryable: response.status >= 500, details: `status=${response.status}` },
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Respons data dari Pinterest tidak valid.',
      { cause: error, details: sanitizeLogText(error?.message) },
    );
  }

  const rawResults = payload?.resource_response?.data?.results;
  if (!Array.isArray(rawResults)) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Struktur respons pencarian Pinterest tidak valid.',
      { details: 'missing_results_array' },
    );
  }

  if (rawResults.length === 0) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      `Tidak ada hasil Pinterest yang relevan ditemukan untuk kata kunci **${query}**.`,
    );
  }

  const results = extractPinterestResults(rawResults, { maxResults, query });
  if (results.length === 0) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      `Tidak ada hasil Pinterest yang relevan ditemukan untuk kata kunci **${query}**.`,
    );
  }

  return {
    query,
    results,
  };
}
