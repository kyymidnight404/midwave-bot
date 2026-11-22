import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLORS } from '../config/colors.js';
import { getEmoji } from '../config/emojis.js';
import { WEATHER_MAX_LOCATION_LENGTH } from '../utils/constants.js';
import { createBaseEmbed } from '../utils/embeds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGIONS_PATH = path.resolve(__dirname, '../data/bmkgRegions.json');

export const WEATHER_COOLDOWN_MS = 5000;
export { WEATHER_MAX_LOCATION_LENGTH };

const BMKG_FORECAST_URL = 'https://api.bmkg.go.id/publik/prakiraan-cuaca';
const WILAYAH_API_BASE = 'https://wilayah.id/api';
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const ADM4_PATTERN = /^\d{2}\.\d{2}\.\d{2}\.\d{4}$/;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const REGION_ALIASES = Object.freeze({
  jakarta: '31.71',
  'dki jakarta': '31.71',
  'jakarta pusat': '31.71',
  jakpus: '31.71',
  'jakarta utara': '31.72',
  jakut: '31.72',
  'jakarta barat': '31.73',
  jakbar: '31.73',
  'jakarta selatan': '31.74',
  jaksel: '31.74',
  'jakarta timur': '31.75',
  jaktim: '31.75',
  jogja: '34.71',
  yogya: '34.71',
  yogyakarta: '34.71',
  'di yogyakarta': '34.71',
  diy: '34.71',
  solo: '33.72',
  surakarta: '33.72',
  bali: '51.71',
  lombok: '52.71',
  aceh: '11.71',
  'banda aceh': '11.71',
  papua: '91.71',
  jayapura: '91.71',
});

const PROVINCE_CAPITALS = Object.freeze({
  '11': '11.71',
  '12': '12.71',
  '13': '13.71',
  '14': '14.71',
  '15': '15.71',
  '16': '16.71',
  '17': '17.71',
  '18': '18.71',
  '19': '19.71',
  '21': '21.72',
  '31': '31.71',
  '32': '32.73',
  '33': '33.74',
  '34': '34.71',
  '35': '35.78',
  '36': '36.73',
  '51': '51.71',
  '52': '52.71',
  '53': '53.71',
  '61': '61.71',
  '62': '62.71',
  '63': '63.71',
  '64': '64.72',
  '65': '65.71',
  '71': '71.71',
  '72': '72.71',
  '73': '73.71',
  '74': '74.71',
  '75': '75.71',
  '76': '76.02',
  '81': '81.71',
  '82': '82.71',
  '91': '91.71',
  '92': '92.02',
  '93': '93.01',
  '94': '94.04',
  '95': '95.01',
  '96': '96.71',
});

let cachedRegions = null;
const adm4Cache = new Map();
const wilayahJsonCache = new Map();

export class WeatherError extends Error {
  constructor(message, code = 'WEATHER_ERROR') {
    super(message);
    this.name = 'WeatherError';
    this.code = code;
  }
}

export function clearWeatherCaches() {
  adm4Cache.clear();
  wilayahJsonCache.clear();
}

function loadRegions() {
  if (cachedRegions) return cachedRegions;
  const raw = fs.readFileSync(REGIONS_PATH, 'utf8');
  const provinces = JSON.parse(raw);

  const flatRegencies = [];
  for (const prov of provinces) {
    for (const reg of prov.regencies ?? []) {
      const bare = stripRegionPrefix(reg.name);
      flatRegencies.push({
        code: reg.code,
        name: reg.name,
        bareName: bare,
        isKota: /\bkota\b/i.test(reg.name),
        provinceCode: prov.code,
        provinceName: prov.name,
      });
    }
  }
  cachedRegions = { provinces, flatRegencies };
  return cachedRegions;
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[.,/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripRegionPrefix(name) {
  return normalizeText(name)
    .replace(/^(kota administrasi|kabupaten administrasi|kota|kabupaten|kab)\s+/i, '')
    .trim();
}

function pickBestRegencyByName(queryNorm, flatRegencies) {
  if (!queryNorm) return null;
  const wantsKab = /\b(kabupaten|kab)\b/i.test(queryNorm);
  const bareQuery = stripRegionPrefix(queryNorm);

  let best = null;
  let bestScore = -1;

  for (const reg of flatRegencies) {
    const fullNorm = normalizeText(reg.name);
    let score = -1;

    if (fullNorm === queryNorm) {
      score = 100;
    } else if (reg.bareName === bareQuery) {
      score = 90 + (reg.isKota && !wantsKab ? 5 : 0);
    } else if (reg.bareName.startsWith(bareQuery) && bareQuery.length >= 4) {
      score = 70 + (reg.isKota && !wantsKab ? 5 : 0) - (reg.bareName.length - bareQuery.length) * 0.1;
    } else if (bareQuery.length >= 4 && reg.bareName.includes(bareQuery)) {
      score = 50 + (reg.isKota && !wantsKab ? 5 : 0) - (reg.bareName.length - bareQuery.length) * 0.1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = reg;
    }
  }

  return best;
}

function findRegencyAndSubHint(rawInput, { provinces, flatRegencies }) {
  const commaParts = String(rawInput ?? '')
    .split(',')
    .map((p) => normalizeText(p))
    .filter(Boolean);

  if (commaParts.length >= 2) {
    const firstPart = commaParts[0];
    const restParts = commaParts.slice(1).join(' ');
    const aliasCode = REGION_ALIASES[restParts] ?? REGION_ALIASES[firstPart];
    if (aliasCode) {
      const reg = flatRegencies.find((r) => r.code === aliasCode);
      if (reg) {
        return {
          regency: reg,
          subHint: REGION_ALIASES[restParts] ? firstPart : restParts,
        };
      }
    }

    const fromRest = pickBestRegencyByName(restParts, flatRegencies);
    if (fromRest) {
      return { regency: fromRest, subHint: firstPart };
    }

    const fromFirst = pickBestRegencyByName(firstPart, flatRegencies);
    if (fromFirst) {
      return { regency: fromFirst, subHint: restParts };
    }
  }

  const normalized = normalizeText(rawInput);
  const aliasCode = REGION_ALIASES[normalized];
  if (aliasCode) {
    const reg = flatRegencies.find((r) => r.code === aliasCode);
    if (reg) return { regency: reg, subHint: null };
  }

  const directRegency = pickBestRegencyByName(normalized, flatRegencies);
  if (directRegency) {
    return { regency: directRegency, subHint: null };
  }

  // Try matching province name -> capital city regency
  const matchedProv = provinces.find(
    (p) => normalizeText(p.name) === normalized || normalizeText(p.name).includes(normalized),
  );
  if (matchedProv) {
    const capCode = PROVINCE_CAPITALS[matchedProv.code] ?? matchedProv.regencies?.[0]?.code;
    const reg = flatRegencies.find((r) => r.code === capCode);
    if (reg) return { regency: reg, subHint: null };
  }

  // Try space-separated tail tokens (e.g. "coblong bandung" or "lembang bandung barat")
  const tokens = normalized.split(' ').filter(Boolean);
  for (let i = 1; i < tokens.length; i += 1) {
    const tail = tokens.slice(i).join(' ');
    const head = tokens.slice(0, i).join(' ');
    const tailAlias = REGION_ALIASES[tail];
    if (tailAlias) {
      const reg = flatRegencies.find((r) => r.code === tailAlias);
      if (reg) return { regency: reg, subHint: head };
    }
    const tailReg = pickBestRegencyByName(tail, flatRegencies);
    if (tailReg) {
      return { regency: tailReg, subHint: head };
    }
  }

  return null;
}

async function fetchJson(url, { fetchFn = fetch, headers = {} } = {}) {
  const response = await fetchFn(url, {
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new WeatherError(`Layanan cuaca/wilayah mengembalikan status HTTP ${response.status}.`, 'HTTP_ERROR');
  }
  return response.json();
}

async function fetchWilayahList(endpointPath, fetchFn) {
  const cached = wilayahJsonCache.get(endpointPath);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const payload = await fetchJson(`${WILAYAH_API_BASE}/${endpointPath}`, { fetchFn });
  const list = Array.isArray(payload?.data) ? payload.data : [];
  wilayahJsonCache.set(endpointPath, { data: list, expiresAt: Date.now() + CACHE_TTL_MS });
  return list;
}

function findBestWilayahItem(items, hintNorm) {
  if (!Array.isArray(items) || items.length === 0) return null;
  if (!hintNorm) return items[0];

  const exact = items.find((item) => normalizeText(item.name) === hintNorm);
  if (exact) return exact;

  const starts = items.find((item) => normalizeText(item.name).startsWith(hintNorm));
  if (starts) return starts;

  const partial = items.find((item) => {
    const norm = normalizeText(item.name);
    return norm.includes(hintNorm) || hintNorm.includes(norm);
  });
  return partial ?? null;
}

async function resolveAdm4FromRegency(regencyCode, subHint, fetchFn) {
  const districts = await fetchWilayahList(`districts/${regencyCode}.json`, fetchFn);
  if (districts.length === 0) {
    throw new WeatherError('Data kecamatan untuk wilayah tersebut tidak tersedia.', 'LOCATION_NOT_FOUND');
  }

  const hintNorm = subHint ? normalizeText(subHint) : null;
  const matchedDistrict = findBestWilayahItem(districts, hintNorm);
  if (matchedDistrict) {
    const villages = await fetchWilayahList(`villages/${matchedDistrict.code}.json`, fetchFn);
    if (villages.length === 0) {
      throw new WeatherError('Data kelurahan/desa untuk wilayah tersebut tidak tersedia.', 'LOCATION_NOT_FOUND');
    }
    const matchedVillage = findBestWilayahItem(villages, hintNorm) ?? villages[0];
    return matchedVillage.code;
  }

  // Hint may be a kelurahan/desa directly inside one of the districts
  if (hintNorm) {
    for (const dist of districts.slice(0, 6)) {
      const villages = await fetchWilayahList(`villages/${dist.code}.json`, fetchFn);
      const matchedVillage = findBestWilayahItem(villages, hintNorm);
      if (matchedVillage) {
        return matchedVillage.code;
      }
    }
  }

  const firstDistrict = districts[0];
  const villages = await fetchWilayahList(`villages/${firstDistrict.code}.json`, fetchFn);
  if (villages.length === 0) {
    throw new WeatherError('Data kelurahan/desa tidak ditemukan untuk wilayah tersebut.', 'LOCATION_NOT_FOUND');
  }
  return villages[0].code;
}

async function fallbackLookupViaNominatim(rawInput, regions, fetchFn) {
  const url = `${NOMINATIM_SEARCH_URL}?format=jsonv2&addressdetails=1&countrycodes=id&limit=1&q=${encodeURIComponent(rawInput)}`;
  const results = await fetchJson(url, {
    fetchFn,
    headers: { 'User-Agent': 'MidwaveDiscordBot/1.0' },
  }).catch(() => []);

  const hit = Array.isArray(results) ? results[0] : null;
  const addr = hit?.address;
  if (!addr) return null;

  const subHint = addr.village ?? addr.suburb ?? addr.neighbourhood ?? addr.city_district ?? null;
  const regencyCandidate = addr.city ?? addr.county ?? addr.municipality ?? addr.state_district ?? addr.state ?? '';
  if (!regencyCandidate) return null;

  const matched = findRegencyAndSubHint(regencyCandidate, regions);
  if (!matched) return null;
  return {
    regency: matched.regency,
    subHint: subHint ?? normalizeText(rawInput),
  };
}

/**
 * Resolves a human-readable Indonesian location name (or direct ADM4 code) to a BMKG `adm4` code.
 * @param {string} locationInput
 * @param {{ fetchFn?: typeof fetch }} [options]
 * @returns {Promise<string>}
 */
export async function resolveBmkgAdm4(locationInput, { fetchFn = fetch } = {}) {
  const trimmed = String(locationInput ?? '').trim();
  if (!trimmed) {
    throw new WeatherError('Masukkan nama kota atau wilayah di Indonesia (contoh: `Jakarta`, `Bandung`, `Kemayoran`).', 'EMPTY_LOCATION');
  }
  if (trimmed.length > WEATHER_MAX_LOCATION_LENGTH) {
    throw new WeatherError(`Nama lokasi maksimal ${WEATHER_MAX_LOCATION_LENGTH} karakter.`, 'INVALID_LOCATION');
  }
  if (ADM4_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const cacheKey = normalizeText(trimmed);
  const cached = adm4Cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.adm4;
  }

  const regions = loadRegions();
  let match = findRegencyAndSubHint(trimmed, regions);
  if (!match) {
    match = await fallbackLookupViaNominatim(trimmed, regions, fetchFn);
  }
  if (!match?.regency) {
    throw new WeatherError(
      `Lokasi **${trimmed}** tidak ditemukan di daftar wilayah BMKG Indonesia. Coba nama kota/kabupaten lain, misalnya \`Jakarta\`, \`Bandung\`, atau \`Surabaya\`.`,
      'LOCATION_NOT_FOUND',
    );
  }

  const adm4 = await resolveAdm4FromRegency(match.regency.code, match.subHint, fetchFn);
  adm4Cache.set(cacheKey, { adm4, expiresAt: Date.now() + CACHE_TTL_MS });
  return adm4;
}

function getWeatherEmoji(desc) {
  const lower = normalizeText(desc);
  if (!lower) return '🌤️';
  if (lower.includes('petir')) return '⛈️';
  if (lower.includes('hujan lebat') || lower.includes('hujan sedang')) return '🌧️';
  if (lower.includes('hujan')) return '🌦️';
  if (lower.includes('kabut') || lower.includes('asap') || lower.includes('udara kabur')) return '🌫️';
  if (lower.includes('berawan tebal') || lower === 'berawan') return '☁️';
  if (lower.includes('cerah berawan')) return '⛅';
  if (lower.includes('cerah')) return '☀️';
  return '🌤️';
}

function formatLocalSlotTime(slot) {
  if (typeof slot?.local_datetime === 'string') {
    const match = slot.local_datetime.match(/\b(\d{2}:\d{2})/);
    if (match) return match[1];
  }
  if (typeof slot?.datetime === 'string') {
    const ms = Date.parse(slot.datetime);
    if (!Number.isNaN(ms)) {
      return new Intl.DateTimeFormat('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Jakarta',
      }).format(new Date(ms));
    }
  }
  return '-';
}

/**
 * Fetches BMKG weather forecast data for an Indonesian location string or ADM4 code.
 * @param {string} locationInput
 * @param {{ fetchFn?: typeof fetch, nowMs?: number }} [options]
 */
export async function fetchBmkgWeather(locationInput, { fetchFn = fetch, nowMs = Date.now() } = {}) {
  const adm4 = await resolveBmkgAdm4(locationInput, { fetchFn });
  const bmkgPayload = await fetchJson(
    `${BMKG_FORECAST_URL}?adm4=${encodeURIComponent(adm4)}`,
    { fetchFn },
  );

  const location = bmkgPayload?.lokasi ?? bmkgPayload?.data?.[0]?.lokasi ?? null;
  const days = bmkgPayload?.data?.[0]?.cuaca ?? [];
  const slots = days.flat().filter((entry) => entry && typeof entry === 'object');

  if (!location || slots.length === 0) {
    throw new WeatherError('Data prakiraan cuaca BMKG tidak tersedia untuk wilayah ini saat ini.', 'NO_FORECAST_DATA');
  }

  let currentIdx = 0;
  let bestDiff = Infinity;
  slots.forEach((slot, idx) => {
    const ms = Date.parse(slot.datetime ?? '');
    if (!Number.isNaN(ms)) {
      const diff = Math.abs(ms - nowMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        currentIdx = idx;
      }
    }
  });

  const current = slots[currentIdx];
  const upcoming = slots.slice(currentIdx + 1, currentIdx + 4);

  return {
    adm4,
    location,
    current,
    upcoming,
  };
}

/**
 * Builds the Midwave BMKG weather embed (no footer, `assets/icon/weather.png` thumbnail).
 * @param {Awaited<ReturnType<typeof fetchBmkgWeather>>} weatherData
 * @param {{ includeThumbnail?: boolean }} [options]
 */
export function buildWeatherEmbed(weatherData, { includeThumbnail = true } = {}) {
  const { location, current, upcoming } = weatherData;
  const emoji = getWeatherEmoji(current.weather_desc);

  const regionParts = [location.desa, location.kecamatan, location.kotkab, location.provinsi]
    .filter((v, idx, arr) => typeof v === 'string' && v.trim() && arr.indexOf(v) === idx);
  const locationLabel = regionParts.join(', ');
  const headlinePlace = location.kotkab || location.desa || 'Indonesia';

  const currentTimestampMs = Date.parse(current.datetime ?? '');
  const forecastTimeText = !Number.isNaN(currentTimestampMs)
    ? `<t:${Math.floor(currentTimestampMs / 1000)}:f>`
    : (current.local_datetime ?? '-');

  const embed = createBaseEmbed({
    title: `${emoji} Prakiraan Cuaca — ${headlinePlace}`,
    description:
      `${getEmoji('location')} **Lokasi:** ${locationLabel}\n` +
      `☁️ **Kondisi Saat Ini:** ${emoji} **${current.weather_desc ?? '-'}**\n` +
      `${getEmoji('source')} **Sumber:** BMKG (Badan Meteorologi, Klimatologi, dan Geofisika)`,
    color: COLORS.PRIMARY,
    includeThumbnail,
    iconName: 'weather',
  });

  embed.addFields(
    { name: `${getEmoji('temperature')} Suhu`, value: `${current.t ?? '-'}°C`, inline: true },
    { name: `${getEmoji('humidity')} Kelembapan`, value: `${current.hu ?? '-'}%`, inline: true },
    {
      name: `${getEmoji('wind')} Angin`,
      value: `${current.ws ?? '-'} km/jam${current.wd ? ` (${current.wd})` : ''}`,
      inline: true,
    },
    { name: '☁️ Tutupan Awan', value: `${current.tcc ?? '-'}%`, inline: true },
    { name: `${getEmoji('clock')} Waktu Prakiraan`, value: forecastTimeText, inline: true },
  );

  if (upcoming.length > 0) {
    const lines = upcoming.map((slot) => {
      const slotEmoji = getWeatherEmoji(slot.weather_desc);
      const timeStr = formatLocalSlotTime(slot);
      return `• **${timeStr}** — ${slotEmoji} ${slot.weather_desc ?? '-'} · **${slot.t ?? '-'}°C** · ${getEmoji('humidity')} ${slot.hu ?? '-'}%`;
    });
    embed.addFields({
      name: `${getEmoji('calendar')} Prakiraan Berikutnya (Per 3 Jam)`,
      value: lines.join('\n'),
      inline: false,
    });
  }

  return embed;
}
