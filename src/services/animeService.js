export const ANILIST_GRAPHQL_ENDPOINT = 'https://graphql.anilist.co';
export const ANIME_MAX_QUERY_LENGTH = 150;
export const ANIME_REQUEST_TIMEOUT_MS = 10_000;
export const ANIME_COOLDOWN_MS = 5_000;
export const ANIME_CACHE_TTL_MS = 10 * 60_000;
export const ANIME_CACHE_MAX_ENTRIES = 100;
export const ANIME_DEFAULT_PER_PAGE = 5;
export const ANIME_SYNOPSIS_MAX_LENGTH = 350;
export const ANIME_USER_AGENT = 'MidwaveBot/1.0.0 (https://github.com/kyymidnight404/midwave-bot)';

export const ANILIST_SEARCH_QUERY = `
query ($search: String, $page: Int = 1, $perPage: Int = 5) {
  Page(page: $page, perPage: $perPage) {
    media(search: $search, type: ANIME, isAdult: false, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
      id
      title {
        romaji
        english
        native
      }
      coverImage {
        large
      }
      description(asHtml: false)
      genres
      averageScore
      seasonYear
      episodes
      status
      format
      duration
      studios {
        nodes {
          name
          isAnimationStudio
        }
      }
      startDate {
        year
        month
        day
      }
      trailer {
        id
        site
      }
      siteUrl
    }
  }
}
`.trim();

/**
 * Domain error thrown by the Anime service with user-safe Indonesian messages.
 */
export class AnimeServiceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [debugDetail]
   */
  constructor(code, message, debugDetail = '') {
    super(message);
    this.name = 'AnimeServiceError';
    this.code = code;
    if (debugDetail) {
      this.debugDetail = debugDetail;
    }
  }
}

/**
 * In-memory TTL cache for AniList search results.
 */
export class AnimeCache {
  /**
   * @param {number} [ttlMs]
   * @param {number} [maxEntries]
   * @param {() => number} [nowFn]
   */
  constructor(ttlMs = ANIME_CACHE_TTL_MS, maxEntries = ANIME_CACHE_MAX_ENTRIES, nowFn = () => Date.now()) {
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

export const defaultAnimeCache = new AnimeCache();

/**
 * Normalizes a search query for cache keys and fuzzy matching.
 * @param {string} value
 * @returns {string}
 */
export function normalizeAnimeQuery(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates and normalizes the anime search query input.
 * @param {unknown} rawQuery
 * @returns {string}
 */
export function validateAnimeQuery(rawQuery) {
  if (typeof rawQuery !== 'string') {
    throw new AnimeServiceError(
      'INVALID_QUERY',
      'Judul anime wajib diisi. Contoh: `/anime query: Sousou no Frieren` atau `!anime Naruto`.',
    );
  }

  const query = rawQuery.replace(/\s+/g, ' ').trim();
  if (!query) {
    throw new AnimeServiceError(
      'INVALID_QUERY',
      'Judul anime tidak boleh kosong. Contoh: `/anime query: One Piece` atau `!anime One Piece`.',
    );
  }

  if (query.length > ANIME_MAX_QUERY_LENGTH) {
    throw new AnimeServiceError(
      'INVALID_QUERY',
      `Judul anime terlalu panjang (maksimal ${ANIME_MAX_QUERY_LENGTH} karakter).`,
    );
  }

  return query;
}

const HTML_ENTITIES = Object.freeze({
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#039;': "'",
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
});

/**
 * Strips HTML tags, AniList spoiler tags, and decodes HTML entities from raw description text.
 * @param {string | null | undefined} rawDescription
 * @returns {string}
 */
export function cleanAnimeSynopsis(rawDescription) {
  if (typeof rawDescription !== 'string' || !rawDescription.trim()) {
    return '';
  }

  return rawDescription
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/~!([\s\S]*?)!~/g, '')
    .replace(/&[a-z0-9#]+;/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Truncates anime synopsis cleanly on word boundaries.
 * @param {string | null | undefined} text
 * @param {number} [maxLength]
 * @returns {string}
 */
export function truncateSynopsis(text, maxLength = ANIME_SYNOPSIS_MAX_LENGTH) {
  const cleaned = cleanAnimeSynopsis(text);
  if (!cleaned) {
    return 'Sinopsis belum tersedia.';
  }

  const limit = Math.max(50, Math.floor(maxLength));
  if (cleaned.length <= limit) {
    return cleaned;
  }

  const sliceLen = Math.max(1, limit - 3);
  let cutIndex = cleaned.lastIndexOf(' ', sliceLen);
  if (cutIndex < Math.floor(sliceLen * 0.6)) {
    cutIndex = sliceLen;
  }

  return `${cleaned.slice(0, cutIndex).trimEnd()}...`;
}

/**
 * Resolves a trailer URL from AniList `trailer.site` and `trailer.id`.
 * @param {{ id?: string | null, site?: string | null } | null | undefined} trailer
 * @returns {{ id: string, site: string, url: string | null } | null}
 */
export function parseAnimeTrailer(trailer) {
  if (!trailer || typeof trailer !== 'object') {
    return null;
  }

  const id = typeof trailer.id === 'string' ? trailer.id.trim() : '';
  const site = typeof trailer.site === 'string' ? trailer.site.trim() : '';
  if (!id || !site) {
    return null;
  }

  const lowerSite = site.toLowerCase();
  let url = null;
  if (lowerSite === 'youtube') {
    url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  } else if (lowerSite === 'dailymotion') {
    url = `https://www.dailymotion.com/video/${encodeURIComponent(id)}`;
  }

  return { id, site, url };
}

/**
 * Parses and normalizes a raw AniList Media object into Midwave's structured Anime model.
 * @param {any} media
 * @returns {{
 *   id: number,
 *   title: { romaji: string, english: string | null, native: string | null },
 *   coverImage: string | null,
 *   description: string,
 *   synopsis: string,
 *   genres: string[],
 *   averageScore: number | null,
 *   seasonYear: number | null,
 *   episodes: number | null,
 *   status: string,
 *   format: string,
 *   duration: number | null,
 *   studios: string[],
 *   startDate: { year: number | null, month: number | null, day: number | null } | null,
 *   trailer: { id: string, site: string, url: string | null } | null,
 *   siteUrl: string,
 * }}
 */
export function parseAniListMedia(media) {
  if (!media || typeof media !== 'object') {
    throw new AnimeServiceError('API_ERROR', 'Data anime dari AniList tidak valid.');
  }

  const id = Number(media.id) || 0;
  const romaji = typeof media.title?.romaji === 'string' && media.title.romaji.trim()
    ? media.title.romaji.trim()
    : (typeof media.title?.english === 'string' && media.title.english.trim()
        ? media.title.english.trim()
        : (typeof media.title?.native === 'string' && media.title.native.trim()
            ? media.title.native.trim()
            : 'Unknown Title'));
  const english = typeof media.title?.english === 'string' && media.title.english.trim()
    ? media.title.english.trim()
    : null;
  const native = typeof media.title?.native === 'string' && media.title.native.trim()
    ? media.title.native.trim()
    : null;

  const coverImage = typeof media.coverImage?.large === 'string' && media.coverImage.large.trim()
    ? media.coverImage.large.trim()
    : null;

  const cleanedDescription = cleanAnimeSynopsis(media.description);
  const synopsis = truncateSynopsis(cleanedDescription, ANIME_SYNOPSIS_MAX_LENGTH);

  const genres = Array.isArray(media.genres)
    ? media.genres.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim())
    : [];

  const averageScore = typeof media.averageScore === 'number' && Number.isFinite(media.averageScore)
    ? media.averageScore
    : null;

  const startYear = typeof media.startDate?.year === 'number' ? media.startDate.year : null;
  const startMonth = typeof media.startDate?.month === 'number' ? media.startDate.month : null;
  const startDay = typeof media.startDate?.day === 'number' ? media.startDate.day : null;
  const startDate = startYear || startMonth || startDay
    ? { year: startYear, month: startMonth, day: startDay }
    : null;

  const seasonYear = typeof media.seasonYear === 'number' && Number.isFinite(media.seasonYear)
    ? media.seasonYear
    : startYear;

  const episodes = typeof media.episodes === 'number' && Number.isFinite(media.episodes)
    ? media.episodes
    : null;

  const status = typeof media.status === 'string' && media.status.trim()
    ? media.status.trim()
    : 'UNKNOWN';

  const format = typeof media.format === 'string' && media.format.trim()
    ? media.format.trim()
    : 'UNKNOWN';

  const duration = typeof media.duration === 'number' && Number.isFinite(media.duration)
    ? media.duration
    : null;

  const rawStudioNodes = Array.isArray(media.studios?.nodes) ? media.studios.nodes : [];
  const mainStudios = rawStudioNodes.filter((n) => n?.isAnimationStudio === true && typeof n?.name === 'string' && n.name.trim());
  const chosenStudioNodes = mainStudios.length > 0
    ? mainStudios
    : rawStudioNodes.filter((n) => typeof n?.name === 'string' && n.name.trim());
  const studios = [...new Set(chosenStudioNodes.map((n) => n.name.trim()))];

  const trailer = parseAnimeTrailer(media.trailer);

  const siteUrl = typeof media.siteUrl === 'string' && media.siteUrl.trim()
    ? media.siteUrl.trim()
    : (id ? `https://anilist.co/anime/${id}` : 'https://anilist.co');

  return {
    id,
    title: {
      romaji,
      english,
      native,
    },
    coverImage,
    description: cleanedDescription,
    synopsis,
    genres,
    averageScore,
    seasonYear,
    episodes,
    status,
    format,
    duration,
    studios,
    startDate,
    trailer,
    siteUrl,
  };
}

/**
 * Maps raw HTTP / network errors into user-safe `AnimeServiceError`.
 * @param {unknown} error
 * @returns {AnimeServiceError}
 */
function mapAniListFetchError(error) {
  if (error instanceof AnimeServiceError) {
    return error;
  }

  const name = typeof error?.name === 'string' ? error.name : '';
  const msg = typeof error?.message === 'string' ? error.message : '';

  if (name === 'AbortError' || name === 'TimeoutError' || /timeout|timed out|aborted|etimedout/i.test(msg)) {
    return new AnimeServiceError(
      'TIMEOUT',
      'Pencarian anime ke AniList melebihi batas waktu (timeout). Silakan coba lagi sebentar.',
      `name=${name || 'TimeoutError'} msg=${msg.slice(0, 160)}`,
    );
  }

  return new AnimeServiceError(
    'API_ERROR',
    'Layanan AniList sedang mengalami gangguan atau tidak dapat dihubungi. Silakan coba beberapa saat lagi.',
    `name=${name || 'Error'} msg=${msg.slice(0, 160)}`,
  );
}

/**
 * Searches anime on AniList GraphQL API with timeout handling, response parsing, and in-memory TTL caching.
 *
 * @param {string | { query: string, perPage?: number }} input
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   perPage?: number,
 *   cache?: AnimeCache | null,
 *   bypassCache?: boolean,
 * }} [options]
 * @returns {Promise<{
 *   query: string,
 *   results: ReturnType<typeof parseAniListMedia>[],
 *   cached: boolean,
 * }>}
 */
export async function searchAnime(input, options = {}) {
  const rawQuery = typeof input === 'string' ? input : input?.query;
  const query = validateAnimeQuery(rawQuery);
  const perPage = Math.min(Math.max(1, Number(options.perPage ?? input?.perPage ?? ANIME_DEFAULT_PER_PAGE) || ANIME_DEFAULT_PER_PAGE), 10);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? ANIME_REQUEST_TIMEOUT_MS;
  const cache = options.bypassCache ? null : (options.cache === undefined ? defaultAnimeCache : options.cache);

  const cacheKey = `${normalizeAnimeQuery(query)}::${perPage}`;
  if (cache) {
    const cachedResults = cache.get(cacheKey);
    if (cachedResults) {
      return {
        query,
        results: cachedResults,
        cached: true,
      };
    }
  }

  let response;
  try {
    response = await fetchImpl(ANILIST_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': ANIME_USER_AGENT,
      },
      body: JSON.stringify({
        query: ANILIST_SEARCH_QUERY,
        variables: {
          search: query,
          page: 1,
          perPage,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw mapAniListFetchError(error);
  }

  if (response.status === 429) {
    const retryAfter = response.headers?.get?.('retry-after');
    throw new AnimeServiceError(
      'RATE_LIMITED',
      'Pencarian anime sedang mencapai batas permintaan AniList. Tunggu beberapa detik lalu coba lagi.',
      `status=429${retryAfter ? ` retryAfter=${retryAfter}` : ''}`,
    );
  }

  if (!response.ok) {
    throw new AnimeServiceError(
      'API_ERROR',
      'Layanan AniList sedang mengalami gangguan. Silakan coba lagi beberapa saat.',
      `status=${response.status}`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new AnimeServiceError(
      'API_ERROR',
      'Respons dari AniList tidak valid. Silakan coba lagi beberapa saat.',
      `invalid_json msg=${String(error?.message || '').slice(0, 120)}`,
    );
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0 && !payload?.data?.Page?.media) {
    const firstErr = payload.errors[0]?.message || 'GraphQL Error';
    throw new AnimeServiceError(
      'API_ERROR',
      'Gagal mengambil data anime dari AniList. Silakan coba lagi beberapa saat.',
      `graphql_error=${String(firstErr).slice(0, 160)}`,
    );
  }

  const rawMediaList = payload?.data?.Page?.media;
  if (!Array.isArray(rawMediaList) || rawMediaList.length === 0) {
    throw new AnimeServiceError(
      'NOT_FOUND',
      `Anime dengan judul **${query}** tidak ditemukan. Coba periksa ejaan atau gunakan judul Romaji/English.`,
    );
  }

  const results = rawMediaList
    .filter((item) => item && typeof item === 'object')
    .map((item) => parseAniListMedia(item));

  if (results.length === 0) {
    throw new AnimeServiceError(
      'NOT_FOUND',
      `Anime dengan judul **${query}** tidak ditemukan. Coba periksa ejaan atau gunakan judul Romaji/English.`,
    );
  }

  if (cache) {
    cache.set(cacheKey, results);
  }

  return {
    query,
    results,
    cached: false,
  };
}
