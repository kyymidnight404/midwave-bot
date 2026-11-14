import dns from 'node:dns/promises';
import net from 'node:net';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from './errors.js';

export const PLATFORMS = Object.freeze({
  INSTAGRAM: 'instagram',
  TIKTOK: 'tiktok',
});

export const PLATFORM_LABELS = Object.freeze({
  [PLATFORMS.INSTAGRAM]: 'Instagram',
  [PLATFORMS.TIKTOK]: 'TikTok',
});

const PLATFORM_DOMAINS = Object.freeze([
  { platform: PLATFORMS.INSTAGRAM, domains: ['instagram.com', 'instagr.am'] },
  { platform: PLATFORMS.TIKTOK, domains: ['tiktok.com'] },
]);

const DISABLED_PLATFORM_DOMAINS = ['threads.net', 'threads.com'];

const SHORT_LINK_HOSTS = new Set([
  'instagr.am',
  'www.instagr.am',
  'vm.tiktok.com',
  'vt.tiktok.com',
  't.tiktok.com',
]);

/**
 * Checks whether a hostname equals or is a subdomain of a base domain.
 *
 * @param {string} hostname
 * @param {string} baseDomain
 * @returns {boolean}
 */
function matchesAllowedDomain(hostname, baseDomain) {
  return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
}

/**
 * Detects which supported platform owns the given hostname.
 *
 * @param {string} hostname
 * @returns {'instagram' | 'tiktok' | null}
 */
export function detectPlatformFromHost(hostname) {
  const cleanHost = hostname.toLowerCase().replace(/\.+$/, '');
  for (const entry of PLATFORM_DOMAINS) {
    if (entry.domains.some((domain) => matchesAllowedDomain(cleanHost, domain))) {
      return entry.platform;
    }
  }
  return null;
}

/**
 * Checks whether an IPv4 address falls into loopback, private, link-local, or reserved space.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((octet) => Number.parseInt(octet, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;

  return false;
}

/**
 * Checks whether an IPv4 or IPv6 address is private, loopback, link-local, or non-routable.
 *
 * @param {string} rawIp
 * @returns {boolean}
 */
export function isPrivateOrReservedIp(rawIp) {
  const ip = String(rawIp || '').trim().toLowerCase().split('%')[0];
  if (!ip) return true;

  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) {
    return isPrivateIpv4(ip);
  }
  if (ipVersion !== 6) {
    return true;
  }

  if (ip === '::' || ip === '::1') return true;

  // Handle IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) {
      return isPrivateIpv4(mapped);
    }
    const hexParts = mapped.split(':');
    if (hexParts.length === 2) {
      const high = Number.parseInt(hexParts[0], 16);
      const low = Number.parseInt(hexParts[1], 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        const reconstructed = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        return isPrivateIpv4(reconstructed);
      }
    }
    return true;
  }

  const firstHextet = Number.parseInt(ip.split(':')[0] || '0', 16);
  // fc00::/7 Unique Local, fe80::/10 Link-Local, ff00::/8 Multicast
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  if ((firstHextet & 0xffc0) === 0xfe80) return true;
  if ((firstHextet & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Verifies that a remote hostname resolves strictly to public, routable IP addresses.
 *
 * @param {string} hostname
 * @param {{ lookupFn?: typeof dns.lookup, allowPrivate?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function assertSafeRemoteHost(hostname, options = {}) {
  const { lookupFn = dns.lookup, allowPrivate = false } = options;
  const cleanHost = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');

  if (!cleanHost || cleanHost === 'localhost' || cleanHost.endsWith('.localhost')) {
    if (!allowPrivate) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
        'Tujuan URL mengarah ke host lokal yang tidak diizinkan.',
      );
    }
    return;
  }

  if (net.isIP(cleanHost) !== 0) {
    if (!allowPrivate && isPrivateOrReservedIp(cleanHost)) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
        'Tujuan URL mengarah ke alamat IP privat atau terlarang.',
      );
    }
    return;
  }

  let records;
  try {
    records = await lookupFn(cleanHost, { all: true });
  } catch (error) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Gagal memverifikasi domain tujuan. Pastikan tautan valid dan dapat diakses.',
      { retryable: true, cause: error },
    );
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      'Domain pada tautan tidak ditemukan.',
    );
  }

  if (!allowPrivate && records.some((record) => isPrivateOrReservedIp(record.address))) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      'Tujuan URL mengarah ke jaringan internal yang diblokir demi keamanan.',
    );
  }
}

/**
 * Parses, normalizes, and strictly validates a user-submitted media URL.
 * Enforces HTTPS, disallows credentials/custom ports/IPs, and checks the platform allowlist.
 *
 * @param {string} rawUrl
 * @returns {{
 *   normalizedUrl: string,
 *   url: URL,
 *   platform: 'instagram' | 'tiktok' | 'threads',
 *   hostname: string,
 *   isShortLink: boolean,
 * }}
 */
export function validateMediaUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'Masukkan tautan media yang valid.',
    );
  }

  const trimmed = rawUrl.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'Tautan tidak boleh kosong atau mengandung spasi.',
    );
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'Format URL tidak valid. Gunakan tautan lengkap diawali `https://`.',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'Hanya tautan `https://` yang diizinkan.',
    );
  }

  if (parsed.username || parsed.password) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'Tautan yang mengandung kredensial tidak diizinkan.',
    );
  }

  if (parsed.port && parsed.port !== '443') {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'Port kustom pada tautan tidak diizinkan.',
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!hostname || hostname === 'localhost' || net.isIP(hostname) !== 0) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      'Alamat IP langsung atau host lokal tidak diizinkan.',
    );
  }

  const platform = detectPlatformFromHost(hostname);
  if (!platform) {
    if (DISABLED_PLATFORM_DOMAINS.some((domain) => matchesAllowedDomain(hostname, domain))) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM,
        'Platform **Threads** belum tersedia pada downloader RapidAPI saat ini. Gunakan tautan publik **Instagram** atau **TikTok**.',
      );
    }

    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM,
      'Platform tidak didukung. Gunakan tautan publik dari **Instagram** atau **TikTok**.',
    );
  }

  if (!parsed.pathname || parsed.pathname === '/') {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      `Tautan ${PLATFORM_LABELS[platform]} harus mengarah langsung ke postingan, reel, atau video.`,
    );
  }

  parsed.hash = '';

  return {
    normalizedUrl: parsed.toString(),
    url: parsed,
    platform,
    hostname,
    isShortLink: SHORT_LINK_HOSTS.has(hostname),
  };
}

/**
 * Safely resolves short-link HTTP redirects step by step with SSRF and domain validation
 * on every redirect hop.
 *
 * @param {ReturnType<typeof validateMediaUrl>} validated
 * @param {{
 *   fetchFn?: typeof fetch,
 *   lookupFn?: typeof dns.lookup,
 *   timeoutMs?: number,
 *   maxHops?: number,
 * }} [options]
 * @returns {Promise<ReturnType<typeof validateMediaUrl>>}
 */
export async function resolveAndValidateRedirects(validated, options = {}) {
  const {
    fetchFn = fetch,
    lookupFn = dns.lookup,
    timeoutMs = 10_000,
    maxHops = 5,
  } = options;

  let current = validated;
  await assertSafeRemoteHost(current.hostname, { lookupFn });

  if (!current.isShortLink) {
    return current;
  }

  for (let hop = 0; hop < maxHops; hop += 1) {
    let response;
    try {
      response = await fetchFn(current.normalizedUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new DownloaderError(
          DOWNLOADER_ERROR_CODES.TIMEOUT,
          'Waktu habis saat memeriksa tautan pendek. Silakan coba lagi.',
          { retryable: true, cause: error },
        );
      }
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
        'Gagal mengikuti tautan pendek. Pastikan URL valid dan dapat diakses.',
        { retryable: true, cause: error },
      );
    } finally {
      try {
        await response?.body?.cancel();
      } catch {
        // Ignore stream cancellation cleanup error
      }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return current;
      }

      let nextUrl;
      try {
        nextUrl = new URL(location, current.normalizedUrl).toString();
      } catch {
        throw new DownloaderError(
          DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
          'Redirect tautan mengarah ke URL yang tidak valid.',
        );
      }

      const nextValidated = validateMediaUrl(nextUrl);
      await assertSafeRemoteHost(nextValidated.hostname, { lookupFn });
      current = nextValidated;

      if (!current.isShortLink) {
        return current;
      }
      continue;
    }

    return current;
  }

  throw new DownloaderError(
    DOWNLOADER_ERROR_CODES.INVALID_URL,
    'Terlalu banyak pengalihan (redirect) pada tautan pendek.',
  );
}
