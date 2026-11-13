export const LYRICS_MAX_QUERY_LENGTH = 150;
export const LYRICS_MAX_ARTIST_LENGTH = 100;
export const LYRICS_REQUEST_TIMEOUT_MS = 10_000;
export const LYRICS_COOLDOWN_MS = 5_000;
export const LYRICS_CACHE_TTL_MS = 10 * 60_000;
export const LYRICS_CACHE_MAX_ENTRIES = 100;

export const LRCLIB_BASE_URL = 'https://lrclib.net/api';
export const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
export const GENIUS_API_SEARCH_URL = 'https://api.genius.com/search';
export const LYRICS_USER_AGENT = 'MidwaveBot/1.0.0 (https://github.com/kyymidnight404/midwave-bot)';

/**
 * Domain error thrown by the Lyrics Finder service with user-safe Indonesian messages.
 */
export class LyricsServiceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [debugDetail]
   */
  constructor(code, message, debugDetail = '') {
    super(message);
    this.name = 'LyricsServiceError';
    this.code = code;
    if (debugDetail) {
      this.debugDetail = debugDetail;
    }
  }
}

/**
 * Redacts tokens or auth secrets from diagnostic messages before logging.
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|access[_-]?token|token|authorization)\s*[:=]\s*['"]?[^\s'",}]+/gi, '$1=[REDACTED]');
}

/**
 * Normalizes a string for fuzzy title/artist comparison.
 * @param {string} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\(\)\[\]\{\}]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates and trims `/lyrics` query and optional artist inputs.
 * @param {unknown} rawQuery
 * @param {unknown} [rawArtist]
 * @returns {{ query: string, artist: string }}
 */
export function validateLyricsInput(rawQuery, rawArtist = '') {
  if (typeof rawQuery !== 'string') {
    throw new LyricsServiceError(
      'INVALID_QUERY',
      'Judul lagu atau kata kunci wajib diisi. Contoh: `/lyrics query: Love artist: wave to earth`.',
    );
  }

  const query = rawQuery.replace(/\s+/g, ' ').trim();
  if (!query) {
    throw new LyricsServiceError(
      'INVALID_QUERY',
      'Kata kunci pencarian lirik tidak boleh kosong. Contoh: `/lyrics query: APT`.',
    );
  }

  if (query.length > LYRICS_MAX_QUERY_LENGTH) {
    throw new LyricsServiceError(
      'INVALID_QUERY',
      `Kata kunci terlalu panjang (maksimal ${LYRICS_MAX_QUERY_LENGTH} karakter).`,
    );
  }

  let artist = '';
  if (rawArtist !== null && rawArtist !== undefined) {
    if (typeof rawArtist !== 'string') {
      throw new LyricsServiceError('INVALID_QUERY', 'Parameter `artist` harus berupa teks.');
    }
    artist = rawArtist.replace(/\s+/g, ' ').trim();
    if (artist.length > LYRICS_MAX_ARTIST_LENGTH) {
      throw new LyricsServiceError(
        'INVALID_QUERY',
        `Nama artis terlalu panjang (maksimal ${LYRICS_MAX_ARTIST_LENGTH} karakter).`,
      );
    }
  }

  return { query, artist };
}

/**
 * Converts time-synced LRC text into clean plain lyrics by removing timestamp tags.
 * @param {string | null | undefined} syncedLyrics
 * @returns {string}
 */
export function stripLrcTimestamps(syncedLyrics) {
  if (typeof syncedLyrics !== 'string' || !syncedLyrics.trim()) {
    return '';
  }

  return syncedLyrics
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*)+/, '').replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '').trim())
    .join('\n')
    .trim();
}

/**
 * Extracts usable plain lyrics from an LRCLIB record.
 * @param {any} record
 * @returns {string}
 */
function extractLrclibLyrics(record) {
  if (typeof record?.plainLyrics === 'string' && record.plainLyrics.trim()) {
    return record.plainLyrics.replace(/\r\n/g, '\n').trim();
  }
  return stripLrcTimestamps(record?.syncedLyrics);
}

/**
 * Scores and selects the best matching LRCLIB record for a query and optional artist.
 * @param {any[]} records
 * @param {string} query
 * @param {string} [artist]
 * @param {string} [preferredArtist]
 * @returns {any | null}
 */
export function pickBestLrclibMatch(records, query, artist = '', preferredArtist = '') {
  if (!Array.isArray(records) || records.length === 0) {
    return null;
  }

  const normQuery = normalizeText(query);
  const normArtist = normalizeText(artist);
  const normPreferredArtist = normalizeText(preferredArtist);

  let bestRecord = null;
  let bestScore = -Infinity;

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;

    const lyrics = extractLrclibLyrics(record);
    const normTrack = normalizeText(cleanTrackTitle(record.trackName || record.name, record.artistName));
    const normRecArtist = normalizeText(record.artistName);

    let score = 0;
    if (lyrics) score += 100;
    if (record.plainLyrics && record.plainLyrics.trim()) score += 20;
    if (record.instrumental) score -= 30;

    if (normQuery) {
      if (normTrack === normQuery) score += 50;
      else if (normTrack.includes(normQuery)) score += 25;
      else if (normQuery.includes(normTrack) && normTrack.length >= 3) score += 15;
    }

    if (normArtist) {
      if (normRecArtist === normArtist) score += 60;
      else if (normRecArtist.includes(normArtist) || normArtist.includes(normRecArtist)) score += 30;
      else score -= 25;
    } else if (normPreferredArtist) {
      if (normRecArtist === normPreferredArtist) score += 45;
      else if (normRecArtist.includes(normPreferredArtist) || normPreferredArtist.includes(normRecArtist)) score += 25;
    }

    if (score > bestScore) {
      bestScore = score;
      bestRecord = record;
    }
  }

  return bestRecord;
}

/**
 * Maps raw HTTP / fetch failures into safe `LyricsServiceError` instances.
 * @param {unknown} error
 * @param {string} provider
 * @returns {LyricsServiceError}
 */
function mapFetchError(error, provider) {
  if (error instanceof LyricsServiceError) {
    return error;
  }

  const name = typeof error?.name === 'string' ? error.name : '';
  const msg = typeof error?.message === 'string' ? error.message : '';
  const safeMsg = redactSecrets(msg).slice(0, 180);

  if (name === 'AbortError' || name === 'TimeoutError' || /timeout|timed out|aborted|etimedout/i.test(msg)) {
    return new LyricsServiceError(
      'TIMEOUT',
      'Pencarian lirik melebihi batas waktu. Silakan coba lagi sebentar.',
      `${provider} name=${name || 'TimeoutError'} msg=${safeMsg}`,
    );
  }

  return new LyricsServiceError(
    'API_ERROR',
    'Layanan pencarian lirik sedang mengalami gangguan. Silakan coba lagi beberapa saat.',
    `${provider} name=${name || 'Error'} msg=${safeMsg}`,
  );
}

/**
 * Performs a timeout-bounded JSON fetch with rate-limit and error mapping.
 * @param {string} url
 * @param {{
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   provider?: string,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 * @returns {Promise<any>}
 */
async function fetchJsonWithTimeout(url, options = {}) {
  const {
    headers = {},
    timeoutMs = LYRICS_REQUEST_TIMEOUT_MS,
    provider = 'LyricsAPI',
    fetchImpl = fetch,
  } = options;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': LYRICS_USER_AGENT,
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw mapFetchError(error, provider);
  }

  if (response.status === 429) {
    const retryAfter = response.headers?.get?.('retry-after');
    throw new LyricsServiceError(
      'RATE_LIMITED',
      'Layanan pencari lirik sedang mencapai batas permintaan. Tunggu sebentar lalu coba lagi.',
      `${provider} status=429${retryAfter ? ` retryAfter=${retryAfter}` : ''}`,
    );
  }

  if (!response.ok) {
    throw new LyricsServiceError(
      'API_ERROR',
      'Layanan pencarian lirik sedang mengalami gangguan. Silakan coba lagi beberapa saat.',
      `${provider} status=${response.status}`,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new LyricsServiceError(
      'API_ERROR',
      'Respons dari penyedia lirik tidak valid. Silakan coba lagi beberapa saat.',
      `${provider} invalid_json msg=${redactSecrets(error?.message || '').slice(0, 120)}`,
    );
  }
}

/**
 * Simple in-memory TTL cache for lyrics lookup results (no database or disk writes).
 */
export class LyricsCache {
  /**
   * @param {number} [ttlMs]
   * @param {number} [maxEntries]
   * @param {() => number} [nowFn]
   */
  constructor(ttlMs = LYRICS_CACHE_TTL_MS, maxEntries = LYRICS_CACHE_MAX_ENTRIES, nowFn = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.nowFn = nowFn;
    this.store = new Map();
  }

  /**
   * @param {string} key
   * @returns {any | null}
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.nowFn() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    if (this.ttlMs <= 0) return;
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: this.nowFn() + this.ttlMs,
    });
  }

  clear() {
    this.store.clear();
  }
}

export const defaultLyricsCache = new LyricsCache();

/**
 * Cleans LRCLIB track titles that occasionally repeat `"Artist - Title"`.
 * @param {string} rawTitle
 * @param {string} rawArtist
 * @returns {string}
 */
function cleanTrackTitle(rawTitle, rawArtist) {
  const title = String(rawTitle || '').trim();
  const artist = String(rawArtist || '').trim();
  if (!title || !artist) return title;

  const prefix = `${artist} - `;
  if (title.toLowerCase().startsWith(prefix.toLowerCase()) && title.length > prefix.length) {
    return title.slice(prefix.length).trim();
  }
  return title;
}

/**
 * Queries Apple iTunes Search API for popularity-ranked song metadata (cover art, album, link).
 * Never throws; returns `null` if unavailable or empty.
 * @param {{ term: string, title?: string, artist?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} params
 */
async function lookupItunesTrack({ term, title = '', artist = '', timeoutMs = 4_000, fetchImpl = fetch }) {
  try {
    const itunesUrl = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(term)}&entity=song&limit=8&media=music`;
    const itunesData = await fetchJsonWithTimeout(itunesUrl, {
      timeoutMs,
      provider: 'iTunesAPI',
      fetchImpl,
    });

    const results = Array.isArray(itunesData?.results) ? itunesData.results : [];
    if (results.length === 0) return null;

    const normTitle = normalizeText(title);
    const normArtist = normalizeText(artist);

    let best = results[0];
    let bestScore = -Infinity;

    for (let i = 0; i < results.length; i += 1) {
      const item = results[i];
      const itemTitle = normalizeText(item.trackName);
      const itemArtist = normalizeText(item.artistName);
      let score = results.length - i; // Preserve iTunes popularity rank as tie-breaker

      if (normTitle) {
        if (itemTitle === normTitle) score += 50;
        else if (itemTitle.includes(normTitle) || normTitle.includes(itemTitle)) score += 25;
      }
      if (normArtist) {
        if (itemArtist === normArtist) score += 60;
        else if (itemArtist.includes(normArtist) || normArtist.includes(itemArtist)) score += 30;
        else score -= 20;
      }

      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    return {
      trackName: typeof best.trackName === 'string' ? best.trackName.trim() : '',
      artistName: typeof best.artistName === 'string' ? best.artistName.trim() : '',
      albumName: typeof best.collectionName === 'string' ? best.collectionName.trim() : null,
      thumbnailUrl:
        typeof best.artworkUrl100 === 'string' && best.artworkUrl100.trim()
          ? best.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.')
          : null,
      trackUrl: typeof best.trackViewUrl === 'string' && best.trackViewUrl.trim() ? best.trackViewUrl.trim() : null,
    };
  } catch {
    return null;
  }
}

/**
 * Enriches track metadata with album cover thumbnail and official page URL without failing the main lookup.
 * Uses Official Genius API when `GENIUS_API_KEY` is provided, and Apple iTunes Search API as keyless fallback.
 *
 * @param {{
 *   title: string,
 *   artist: string,
 *   album?: string | null,
 *   geniusApiKey?: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   prefetchedItunes?: { trackName: string, artistName: string, albumName: string | null, thumbnailUrl: string | null, trackUrl: string | null } | null,
 * }} params
 * @returns {Promise<{ album: string | null, thumbnailUrl: string | null, sourceUrl: string | null, metadataProvider: string | null }>}
 */
async function enrichTrackMetadata({
  title,
  artist,
  album = null,
  geniusApiKey = '',
  timeoutMs = Math.min(LYRICS_REQUEST_TIMEOUT_MS, 5_000),
  fetchImpl = fetch,
  prefetchedItunes = null,
}) {
  const cleanLrcAlbum = album && String(album).trim() ? String(album).trim() : null;
  const isGenericLrcAlbum =
    cleanLrcAlbum &&
    (normalizeText(cleanLrcAlbum) === normalizeText(artist) ||
      normalizeText(cleanLrcAlbum) === normalizeText(title));

  let resolvedAlbum = cleanLrcAlbum;
  let thumbnailUrl = null;
  let sourceUrl = null;
  let metadataProvider = null;

  const searchTerm = `${title} ${artist}`.trim();

  if (geniusApiKey) {
    try {
      const geniusUrl = `${GENIUS_API_SEARCH_URL}?q=${encodeURIComponent(searchTerm)}`;
      const geniusData = await fetchJsonWithTimeout(geniusUrl, {
        headers: { Authorization: `Bearer ${geniusApiKey}` },
        timeoutMs,
        provider: 'GeniusAPI',
        fetchImpl,
      });

      const hits = geniusData?.response?.hits;
      const topSong = Array.isArray(hits) ? hits.find((h) => h?.type === 'song' && h?.result)?.result : null;
      if (topSong) {
        thumbnailUrl = topSong.song_art_image_thumbnail_url || topSong.header_image_thumbnail_url || null;
        sourceUrl = topSong.url || null;
        metadataProvider = 'Genius';
      }
    } catch {
      // Optional metadata enrichment must not fail lyrics delivery.
    }
  }

  if (!thumbnailUrl || !sourceUrl || !resolvedAlbum || isGenericLrcAlbum) {
    const itunesMatch =
      prefetchedItunes && normalizeText(prefetchedItunes.artistName) === normalizeText(artist)
        ? prefetchedItunes
        : await lookupItunesTrack({ term: searchTerm, title, artist, timeoutMs, fetchImpl });

    if (itunesMatch) {
      if (itunesMatch.albumName && (!resolvedAlbum || isGenericLrcAlbum)) {
        resolvedAlbum = itunesMatch.albumName;
      }
      if (!thumbnailUrl && itunesMatch.thumbnailUrl) {
        thumbnailUrl = itunesMatch.thumbnailUrl;
      }
      if (!sourceUrl && itunesMatch.trackUrl) {
        sourceUrl = itunesMatch.trackUrl;
      }
      if (!metadataProvider && (thumbnailUrl || sourceUrl)) {
        metadataProvider = 'Apple Music';
      }
    }
  }

  return { album: resolvedAlbum, thumbnailUrl, sourceUrl, metadataProvider };
}

/**
 * Searches song lyrics from LRCLIB and enriches metadata from iTunes / optional official Genius API.
 *
 * @param {{ query: string, artist?: string }} input
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   geniusApiKey?: string,
 *   cache?: LyricsCache | null,
 *   bypassCache?: boolean,
 * }} [options]
 * @returns {Promise<{
 *   title: string,
 *   artist: string,
 *   album: string | null,
 *   thumbnailUrl: string | null,
 *   lyrics: string,
 *   sourceName: string,
 *   sourceUrl: string,
 *   cached: boolean,
 * }>}
 */
export async function searchLyrics(input, options = {}) {
  const { query, artist } = validateLyricsInput(input?.query, input?.artist);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? LYRICS_REQUEST_TIMEOUT_MS;
  const geniusApiKey = (options.geniusApiKey ?? process.env.GENIUS_API_KEY ?? '').trim();
  const cache = options.bypassCache ? null : (options.cache === undefined ? defaultLyricsCache : options.cache);

  const cacheKey = `${normalizeText(query)}::${normalizeText(artist)}`;
  if (cache) {
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      return { ...cachedResult, cached: true };
    }
  }

  let candidates = [];
  let prefetchedItunes = null;
  let preferredArtist = '';

  if (artist) {
    const structuredUrl = `${LRCLIB_BASE_URL}/search?track_name=${encodeURIComponent(query)}&artist_name=${encodeURIComponent(artist)}`;
    const structured = await fetchJsonWithTimeout(structuredUrl, {
      timeoutMs,
      provider: 'LRCLIB',
      fetchImpl,
    });
    if (Array.isArray(structured)) {
      candidates = structured;
    }
  } else {
    // Use popularity-ranked iTunes lookup in parallel to guide artist matching for ambiguous titles (e.g. "APT", "Blue").
    prefetchedItunes = await lookupItunesTrack({
      term: query,
      title: query,
      timeoutMs: Math.min(timeoutMs, 4_000),
      fetchImpl,
    });
    if (prefetchedItunes?.artistName) {
      preferredArtist = prefetchedItunes.artistName;
      const guidedUrl = `${LRCLIB_BASE_URL}/search?track_name=${encodeURIComponent(prefetchedItunes.trackName || query)}&artist_name=${encodeURIComponent(preferredArtist)}`;
      const guided = await fetchJsonWithTimeout(guidedUrl, {
        timeoutMs,
        provider: 'LRCLIB',
        fetchImpl,
      });
      if (Array.isArray(guided)) {
        candidates = guided.filter((r) => extractLrclibLyrics(r));
      }
    }
  }

  if (candidates.length === 0) {
    const combinedQuery = artist ? `${query} ${artist}` : query;
    const generalUrl = `${LRCLIB_BASE_URL}/search?q=${encodeURIComponent(combinedQuery)}`;
    const general = await fetchJsonWithTimeout(generalUrl, {
      timeoutMs,
      provider: 'LRCLIB',
      fetchImpl,
    });
    if (Array.isArray(general)) {
      candidates = general;
    }
  }

  const bestMatch = pickBestLrclibMatch(candidates, query, artist, preferredArtist);
  if (!bestMatch) {
    throw new LyricsServiceError(
      'NOT_FOUND',
      `Lagu untuk pencarian **${query}**${artist ? ` oleh **${artist}**` : ''} tidak ditemukan. Coba periksa ejaan judul atau tambahkan parameter \`artist\`.`,
    );
  }

  const matchedArtist = String(bestMatch.artistName || artist || 'Unknown Artist').trim();
  const matchedTitle = cleanTrackTitle(bestMatch.trackName || bestMatch.name || query, matchedArtist);
  const lyrics = extractLrclibLyrics(bestMatch);

  if (!lyrics) {
    const label = `**${matchedTitle} — ${matchedArtist}**`;
    const reason = bestMatch.instrumental
      ? `Lagu ${label} terdeteksi sebagai **instrumental** sehingga tidak memiliki lirik.`
      : `Lagu ${label} ditemukan, tetapi liriknya belum tersedia di penyedia saat ini.`;
    throw new LyricsServiceError('LYRICS_UNAVAILABLE', reason);
  }

  const metadata = await enrichTrackMetadata({
    title: matchedTitle,
    artist: matchedArtist,
    album: bestMatch.albumName,
    geniusApiKey,
    timeoutMs: Math.min(timeoutMs, 5_000),
    fetchImpl,
    prefetchedItunes,
  });

  const lrclibRecordUrl = bestMatch.id ? `${LRCLIB_BASE_URL}/get/${bestMatch.id}` : 'https://lrclib.net';
  const sourceUrl = metadata.sourceUrl || lrclibRecordUrl;
  const sourceName = metadata.metadataProvider
    ? `LRCLIB (Info: ${metadata.metadataProvider})`
    : 'LRCLIB';

  const result = {
    title: matchedTitle,
    artist: matchedArtist,
    album: metadata.album,
    thumbnailUrl: metadata.thumbnailUrl,
    lyrics,
    sourceName,
    sourceUrl,
    cached: false,
  };

  if (cache) {
    cache.set(cacheKey, result);
  }

  return result;
}
