export const OTAKUGIFS_API_URL = 'https://api.otakugifs.xyz/gif';
export const OTAKUGIFS_ALL_REACTIONS_URL = 'https://api.otakugifs.xyz/gif/allreactions';
export const OTAKUGIFS_TIMEOUT_MS = 8_000;
export const SOCIAL_COOLDOWN_MS = 3_000;

/**
 * Validated reaction names supported by OtakuGIFs `/gif/allreactions`.
 * `bonk`, `yeet`, and `highfive` are not exposed directly by OtakuGIFs and are
 * mapped to the closest supported API reactions (`smack`, `punch`, `brofist`).
 */
export const VALID_API_REACTIONS = new Set([
  'hug',
  'pat',
  'slap',
  'smack',
  'poke',
  'punch',
  'brofist',
  'wave',
  'laugh',
  'cry',
]);

export const SOCIAL_INTERACTIONS = Object.freeze({
  hug: {
    command: 'hug',
    apiReaction: 'hug',
    requiresTarget: true,
    description: 'Memberikan pelukan hangat ke pengguna lain',
    formatMessage: (author, target) => `**${author}** gives **${target}** a warm hug!`,
  },
  pat: {
    command: 'pat',
    apiReaction: 'pat',
    requiresTarget: true,
    description: 'Mengelus kepala pengguna lain dengan lembut',
    formatMessage: (author, target) => `Headpats for **${target}** from **${author}**~`,
  },
  slap: {
    command: 'slap',
    apiReaction: 'slap',
    requiresTarget: true,
    description: 'Menampar pengguna lain',
    formatMessage: (author, target) => `**${author}** slaps **${target}** across the face!`,
  },
  bonk: {
    command: 'bonk',
    apiReaction: 'smack',
    requiresTarget: true,
    description: 'Memukul pengguna lain dengan bonk',
    formatMessage: (author, target) => `**${author}** bonks **${target}**! Go to jail!`,
  },
  kick: {
    command: 'kick',
    apiReaction: 'punch',
    requiresTarget: true,
    description: 'Menendang pengguna lain secara bercanda (anime GIF)',
    formatMessage: (author, target) => `**${author}** kicks **${target}**!`,
  },
  poke: {
    command: 'poke',
    apiReaction: 'poke',
    requiresTarget: true,
    description: 'Mencolek pengguna lain untuk menarik perhatian',
    formatMessage: (author, target) => `**${author}** pokes **${target}** to get their attention.`,
  },
  yeet: {
    command: 'yeet',
    apiReaction: 'punch',
    requiresTarget: true,
    description: 'Melempar pengguna lain ke orbit',
    formatMessage: (author, target) => `**${author}** yeets **${target}** into orbit!`,
  },
  highfive: {
    command: 'highfive',
    apiReaction: 'brofist',
    requiresTarget: true,
    description: 'Memberikan tos epik kepada pengguna lain',
    formatMessage: (author, target) => `**${author}** gives **${target}** an epic high-five!`,
  },
  wave: {
    command: 'wave',
    apiReaction: 'wave',
    requiresTarget: true,
    description: 'Melambaikan tangan menyapa pengguna lain',
    formatMessage: (author, target) => `**${author}** waves at **${target}**! Hello~`,
  },
  laugh: {
    command: 'laugh',
    apiReaction: 'laugh',
    requiresTarget: false,
    description: 'Tertawa terbahak-bahak',
    formatMessage: (author) => `**${author}** is laughing out loud!`,
  },
  cry: {
    command: 'cry',
    apiReaction: 'cry',
    requiresTarget: false,
    description: 'Menangis tersedu-sedu',
    formatMessage: (author) => `**${author}** is crying... someone send tissues!`,
  },
});

export const TARGETED_SOCIAL_COMMANDS = Object.freeze(
  Object.values(SOCIAL_INTERACTIONS)
    .filter((item) => item.requiresTarget)
    .map((item) => item.command),
);

export const SOLO_SOCIAL_COMMANDS = Object.freeze(
  Object.values(SOCIAL_INTERACTIONS)
    .filter((item) => !item.requiresTarget)
    .map((item) => item.command),
);

/**
 * Domain error for OtakuGIFs API failures with user-friendly messages.
 */
export class OtakuGifsError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'OtakuGifsError';
    this.code = code;
  }
}

/**
 * Validates that a returned GIF URL is a safe HTTP(S) URL.
 * @param {unknown} url
 * @returns {string}
 */
export function validateGifUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new OtakuGifsError('EMPTY_GIF_URL', 'Layanan GIF tidak mengembalikan URL gambar.');
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new OtakuGifsError('INVALID_GIF_URL', 'URL GIF dari layanan tidak valid.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OtakuGifsError('INVALID_GIF_URL', 'URL GIF dari layanan tidak valid.');
  }

  return parsed.toString();
}

/**
 * Resolves a command or reaction name to a validated OtakuGIFs API reaction name.
 * @param {string} reaction
 * @returns {string}
 */
export function resolveApiReaction(reaction) {
  if (typeof reaction !== 'string' || !reaction.trim()) {
    throw new OtakuGifsError('UNKNOWN_REACTION', 'Reaction tidak ditemukan.');
  }

  const key = reaction.trim().toLowerCase();
  const mapped = Object.hasOwn(SOCIAL_INTERACTIONS, key)
    ? SOCIAL_INTERACTIONS[key].apiReaction
    : key;

  if (!VALID_API_REACTIONS.has(mapped)) {
    throw new OtakuGifsError('UNKNOWN_REACTION', `Reaction \`${key}\` tidak didukung oleh layanan GIF.`);
  }

  return mapped;
}

/**
 * Fetches a random GIF URL for the specified social reaction from OtakuGIFs API.
 * @param {string} reaction
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, apiUrl?: string }} [options]
 * @returns {Promise<string>}
 */
export async function getReactionGif(reaction, options = {}) {
  const apiReaction = resolveApiReaction(reaction);
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? OTAKUGIFS_TIMEOUT_MS;
  const apiUrl = options.apiUrl ?? OTAKUGIFS_API_URL;

  if (typeof fetchFn !== 'function') {
    throw new OtakuGifsError('API_UNAVAILABLE', 'HTTP client tidak tersedia untuk mengambil GIF.');
  }

  const requestUrl = `${apiUrl}?reaction=${encodeURIComponent(apiReaction)}&format=gif`;

  let response;
  try {
    response = await fetchFn(requestUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new OtakuGifsError('TIMEOUT', 'Permintaan ke layanan GIF melebihi batas waktu. Silakan coba lagi.');
    }
    throw new OtakuGifsError('API_UNAVAILABLE', 'Layanan GIF sedang tidak dapat diakses. Silakan coba lagi nanti.');
  }

  if (!response?.ok) {
    if (response?.status === 404) {
      throw new OtakuGifsError('UNKNOWN_REACTION', 'Reaction tidak ditemukan di layanan GIF.');
    }
    throw new OtakuGifsError(
      'API_HTTP_ERROR',
      `Layanan GIF sedang bermasalah (HTTP ${response?.status ?? 'error'}). Silakan coba lagi nanti.`,
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new OtakuGifsError('INVALID_RESPONSE', 'Respons dari layanan GIF tidak valid.');
  }

  return validateGifUrl(data?.url);
}
