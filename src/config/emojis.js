/**
 * Centralized MIDWAVE custom system emoji registry.
 * Maps Microsoft Fluent Emoji 3D Discord Application Emojis (`mw_*`) to their
 * verified Discord IDs with runtime validation and safe Unicode fallbacks.
 */

const DISCORD_SNOWFLAKE_REGEX = /^\d{17,22}$/;
const UNKNOWN_EMOJI_FALLBACK = '🔹';

export const EMOJI_IDS = Object.freeze({
  success: '1574041460016156883',
  error: '1574041386230095933',
  warning: '1574041470288138420',
  info: '1574041433772400660',
  loading: '1574041439065612521',
  refresh: '1574041449605894204',
  home: '1574041417825783979',
  search: '1574041454777733250',
  back: '1574041332383752193',
  next: '1574041444442706083',
  add: '1574041309394763816',
  remove: '1574041452466540544',
  edit: '1574041377572921544',
  delete: '1574041362645651486',
  download: '1574041369935089764',
  upload: '1574041462478340157',
  folder: '1574041405809229996',
  file: '1574041396162068610',
  users: '1574041464990863464',
  analytics: '1574041324842393661',
  calendar: '1574041348422635700',
  clock: '1574041354441465950',
  notification: '1574041447127056526',
  link: '1574041436465135657',
  ai: '1574041317393170622',
  calculator: '1574041339946074292',
  image: '1574041430656295042',
  video: '1574041467738132641',
  music: '1574041441762811955',
  shield: '1574041457206235196',
  game: '1574054366615179435',
  timer: '1574054372739121182',
  trophy: '1574054379034775611',
  surrender: '1574054384722251887',
  stop: '1574054391579803668',
  quiz: '1574054397648961555',
  coin: '1574054403491762307',
  tails: '1574054409946669330',
  bug: '1574054416028532817',
  idea: '1574054422558802121',
  chat: '1574054428070117396',
  wave: '1574054436182040616',
  tools: '1574054441999401070',
  id: '1574054444549804074',
  status: '1574054447049478195',
  star: '1574054449343635516',
  tag: '1574054452514660432',
  studio: '1574054455299809432',
  location: '1574054457682165790',
  source: '1574054460060074055',
  temperature: '1574054462643773461',
  humidity: '1574054465407811654',
  wind: '1574054467643379733',
});

export const EMOJI_FALLBACKS = Object.freeze({
  success: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
  loading: '⏳',
  refresh: '🔄',
  home: '🏠',
  search: '🔍',
  back: '◀️',
  next: '▶️',
  add: '➕',
  remove: '➖',
  edit: '✏️',
  delete: '🗑️',
  download: '⬇️',
  upload: '⬆️',
  folder: '📁',
  file: '📄',
  users: '👥',
  analytics: '📊',
  calendar: '📅',
  clock: '🕒',
  notification: '🔔',
  link: '🔗',
  ai: '✨',
  calculator: '🧮',
  image: '🖼️',
  video: '🎬',
  music: '🎵',
  shield: '🛡️',
  game: '🎮',
  timer: '⏱️',
  trophy: '🏆',
  surrender: '🏳️',
  stop: '🛑',
  quiz: '🧠',
  coin: '🪙',
  tails: '🌗',
  bug: '🐛',
  idea: '💡',
  chat: '💬',
  wave: '🌊',
  tools: '🛠️',
  id: '🆔',
  status: '📡',
  star: '⭐',
  tag: '🏷️',
  studio: '🏢',
  location: '📍',
  source: '🏛️',
  temperature: '🌡️',
  humidity: '💧',
  wind: '💨',
});

const emojiNamesEntries = Object.keys(EMOJI_IDS).map((key) => [key, `mw_${key}`]);
export const EMOJI_NAMES = Object.freeze(Object.fromEntries(emojiNamesEntries));

function formatCustomEmoji(key) {
  const id = EMOJI_IDS[key];
  const name = EMOJI_NAMES[key];
  if (!name || !DISCORD_SNOWFLAKE_REGEX.test(String(id ?? ''))) {
    return null;
  }
  return `<:${name}:${id}>`;
}

export const EMOJIS = Object.freeze(
  Object.fromEntries(
    Object.keys(EMOJI_IDS).map((key) => [key, formatCustomEmoji(key) ?? EMOJI_FALLBACKS[key]]),
  ),
);

export const EMOJI_KEY_MAP = Object.freeze(
  Object.fromEntries(
    Object.keys(EMOJI_IDS).flatMap((key) => [
      [key, key],
      [`mw_${key}`, key],
    ]),
  ),
);

const unavailableEmojiKeys = new Set();
let validationStatus = {
  validated: false,
  availableCount: Object.keys(EMOJI_IDS).length,
  missingKeys: [],
};

export function normalizeEmojiKey(key) {
  if (typeof key !== 'string') return null;
  const cleaned = key.trim().toLowerCase();
  return EMOJI_KEY_MAP[cleaned] ?? null;
}

export function isEmojiAvailable(key) {
  const normalized = normalizeEmojiKey(key);
  if (!normalized) return false;
  if (!DISCORD_SNOWFLAKE_REGEX.test(String(EMOJI_IDS[normalized] ?? ''))) {
    return false;
  }
  return !unavailableEmojiKeys.has(normalized);
}

export function hasCustomEmojisAvailable() {
  return Object.keys(EMOJI_IDS).every((key) => isEmojiAvailable(key));
}

export function getEmoji(key, options = {}) {
  const normalized = normalizeEmojiKey(key);
  if (!normalized) {
    return options.fallback ?? UNKNOWN_EMOJI_FALLBACK;
  }

  const fallback = options.fallback ?? EMOJI_FALLBACKS[normalized] ?? UNKNOWN_EMOJI_FALLBACK;
  if (options.useFallback === true || !isEmojiAvailable(normalized)) {
    return fallback;
  }

  return EMOJIS[normalized] ?? fallback;
}

export function getComponentEmoji(key, options = {}) {
  const normalized = normalizeEmojiKey(key);
  if (!normalized) {
    return options.fallback ?? UNKNOWN_EMOJI_FALLBACK;
  }

  const fallback = options.fallback ?? EMOJI_FALLBACKS[normalized] ?? UNKNOWN_EMOJI_FALLBACK;
  if (options.useFallback === true || !isEmojiAvailable(normalized)) {
    return fallback;
  }

  return {
    id: EMOJI_IDS[normalized],
    name: EMOJI_NAMES[normalized],
  };
}

export function setEmojiAvailability(keyOrMap, available) {
  if (typeof keyOrMap === 'string') {
    const normalized = normalizeEmojiKey(keyOrMap);
    if (!normalized) return;
    if (available) {
      unavailableEmojiKeys.delete(normalized);
    } else {
      unavailableEmojiKeys.add(normalized);
    }
    return;
  }

  if (keyOrMap && typeof keyOrMap === 'object') {
    for (const [key, isAvail] of Object.entries(keyOrMap)) {
      setEmojiAvailability(key, Boolean(isAvail));
    }
  }
}

export function resetEmojiValidationCache() {
  unavailableEmojiKeys.clear();
  validationStatus = {
    validated: false,
    availableCount: Object.keys(EMOJI_IDS).length,
    missingKeys: [],
  };
}

export function getEmojiValidationStatus() {
  return {
    ...validationStatus,
    missingKeys: [...validationStatus.missingKeys],
  };
}

function extractFetchedEmojiCollections(fetched) {
  const ids = new Set();
  const names = new Set();

  if (!fetched) return { ids, names };

  const items =
    typeof fetched.values === 'function'
      ? Array.from(fetched.values())
      : Array.isArray(fetched)
        ? fetched
        : [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.id) ids.add(String(item.id));
    if (item.name) names.add(String(item.name).toLowerCase());
  }

  return { ids, names };
}

/**
 * Validate uploaded Discord application emojis once at startup.
 * Caches unavailable emoji keys so commands fall back to Unicode automatically.
 */
export async function validateApplicationEmojis(client, options = {}) {
  const logger = options.logger ?? console;
  const fetcher = client?.application?.emojis?.fetch;

  if (typeof fetcher !== 'function') {
    return getEmojiValidationStatus();
  }

  try {
    const fetched = await fetcher.call(client.application.emojis);
    const { ids, names } = extractFetchedEmojiCollections(fetched);

    unavailableEmojiKeys.clear();
    const missingKeys = [];

    for (const key of Object.keys(EMOJI_IDS)) {
      const id = EMOJI_IDS[key];
      const name = EMOJI_NAMES[key];
      const exists = ids.has(id) || names.has(name);
      if (!exists) {
        unavailableEmojiKeys.add(key);
        missingKeys.push(key);
      }
    }

    const total = Object.keys(EMOJI_IDS).length;
    const availableCount = total - missingKeys.length;
    validationStatus = {
      validated: true,
      availableCount,
      missingKeys,
    };

    if (missingKeys.length > 0) {
      logger.warn?.(
        `[Midwave] Missing ${missingKeys.length}/${total} application emojis (${missingKeys.join(', ')}); Unicode fallback active.`,
      );
    } else {
      logger.info?.(`[Midwave] Verified ${availableCount}/${total} custom application emojis.`);
    }
  } catch (err) {
    logger.warn?.('[Midwave] Failed to validate application emojis; keeping configured IDs:', err?.message ?? err);
  }

  return getEmojiValidationStatus();
}
