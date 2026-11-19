import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from './errors.js';

export const PLATFORMS = Object.freeze({
  YOUTUBE: 'youtube',
  TIKTOK: 'tiktok',
  INSTAGRAM: 'instagram',
  FACEBOOK: 'facebook',
  TWITTER: 'twitter',
  REDDIT: 'reddit',
  TWITCH: 'twitch',
  SOUNDCLOUD: 'soundcloud',
  VIMEO: 'vimeo',
  DAILYMOTION: 'dailymotion',
  BILIBILI: 'bilibili',
  WEB: 'web',
});

export const PLATFORM_LABELS = Object.freeze({
  [PLATFORMS.YOUTUBE]: 'YouTube',
  [PLATFORMS.TIKTOK]: 'TikTok',
  [PLATFORMS.INSTAGRAM]: 'Instagram',
  [PLATFORMS.FACEBOOK]: 'Facebook',
  [PLATFORMS.TWITTER]: 'X / Twitter',
  [PLATFORMS.REDDIT]: 'Reddit',
  [PLATFORMS.TWITCH]: 'Twitch',
  [PLATFORMS.SOUNDCLOUD]: 'SoundCloud',
  [PLATFORMS.VIMEO]: 'Vimeo',
  [PLATFORMS.DAILYMOTION]: 'Dailymotion',
  [PLATFORMS.BILIBILI]: 'Bilibili',
  [PLATFORMS.WEB]: 'Web Media',
});

const PLATFORM_DOMAINS = Object.freeze([
  { platform: PLATFORMS.YOUTUBE, domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'] },
  { platform: PLATFORMS.TIKTOK, domains: ['tiktok.com', 'tiktokv.com'] },
  { platform: PLATFORMS.INSTAGRAM, domains: ['instagram.com', 'instagr.am'] },
  { platform: PLATFORMS.FACEBOOK, domains: ['facebook.com', 'fb.watch', 'fb.com'] },
  {
    platform: PLATFORMS.TWITTER,
    domains: ['twitter.com', 'x.com', 't.co', 'fxtwitter.com', 'vxtwitter.com'],
  },
  { platform: PLATFORMS.REDDIT, domains: ['reddit.com', 'redd.it', 'v.redd.it'] },
  { platform: PLATFORMS.TWITCH, domains: ['twitch.tv'] },
  { platform: PLATFORMS.SOUNDCLOUD, domains: ['soundcloud.com', 'sndcdn.com'] },
  { platform: PLATFORMS.VIMEO, domains: ['vimeo.com'] },
  { platform: PLATFORMS.DAILYMOTION, domains: ['dailymotion.com', 'dai.ly'] },
  { platform: PLATFORMS.BILIBILI, domains: ['bilibili.com', 'b23.tv', 'bilibili.tv'] },
]);

const SHORT_LINK_HOSTS = new Set([
  'youtu.be',
  'instagr.am',
  'www.instagr.am',
  'vm.tiktok.com',
  'vt.tiktok.com',
  't.tiktok.com',
  'fb.watch',
  't.co',
  'redd.it',
  'on.soundcloud.com',
  'dai.ly',
  'b23.tv',
]);

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.lan', '.home'];

const TRACKING_QUERY_PARAMS = new Set([
  'igsh',
  'igshid',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  '_t',
  '_r',
  'is_from_webapp',
  'sender_device',
  'fbclid',
]);

const INSTAGRAM_SHORTCODE_RE = /^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

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
 * Detects which known platform owns the given hostname, or returns `null` for other public domains.
 *
 * @param {string} hostname
 * @returns {string | null}
 */
export function detectPlatformFromHost(hostname) {
  const cleanHost = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  for (const entry of PLATFORM_DOMAINS) {
    if (entry.domains.some((domain) => matchesAllowedDomain(cleanHost, domain))) {
      return entry.platform;
    }
  }
  return null;
}

/**
 * Resolves a human-readable platform label from yt-dlp extractor key or detected platform.
 *
 * @param {string | null | undefined} extractorKey
 * @param {string | null | undefined} fallbackPlatform
 * @param {string | null | undefined} hostname
 * @returns {string}
 */
export function resolvePlatformLabel(extractorKey, fallbackPlatform = PLATFORMS.WEB, hostname = '') {
  const ext = String(extractorKey || '').trim().toLowerCase();
  if (ext.includes('youtube')) return PLATFORM_LABELS[PLATFORMS.YOUTUBE];
  if (ext.includes('tiktok')) return PLATFORM_LABELS[PLATFORMS.TIKTOK];
  if (ext.includes('instagram')) return PLATFORM_LABELS[PLATFORMS.INSTAGRAM];
  if (ext.includes('facebook')) return PLATFORM_LABELS[PLATFORMS.FACEBOOK];
  if (ext.includes('twitter') || ext === 'x') return PLATFORM_LABELS[PLATFORMS.TWITTER];
  if (ext.includes('reddit')) return PLATFORM_LABELS[PLATFORMS.REDDIT];
  if (ext.includes('twitch')) return PLATFORM_LABELS[PLATFORMS.TWITCH];
  if (ext.includes('soundcloud')) return PLATFORM_LABELS[PLATFORMS.SOUNDCLOUD];
  if (ext.includes('vimeo')) return PLATFORM_LABELS[PLATFORMS.VIMEO];
  if (ext.includes('dailymotion')) return PLATFORM_LABELS[PLATFORMS.DAILYMOTION];
  if (ext.includes('bilibili')) return PLATFORM_LABELS[PLATFORMS.BILIBILI];

  if (fallbackPlatform && fallbackPlatform !== PLATFORMS.WEB && PLATFORM_LABELS[fallbackPlatform]) {
    return PLATFORM_LABELS[fallbackPlatform];
  }
  if (extractorKey && typeof extractorKey === 'string') {
    return extractorKey.replace(/:.*$/, '').trim() || PLATFORM_LABELS[PLATFORMS.WEB];
  }
  return hostname ? hostname.replace(/^www\./i, '') : PLATFORM_LABELS[PLATFORMS.WEB];
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

  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;

  return false;
}

/**
 * Expands an IPv6 address (including compressed `::` and embedded IPv4) into 8 16-bit hextets.
 *
 * @param {string} ip
 * @returns {number[] | null}
 */
function expandIpv6(ip) {
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const parsePart = (part) => {
    if (!part) return [];
    const tokens = part.split(':');
    const out = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.includes('.')) {
        if (i !== tokens.length - 1 || !net.isIPv4(token)) return null;
        const octets = token.split('.').map((n) => Number.parseInt(n, 10));
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        out.push(Number.parseInt(token, 16));
      }
    }
    return out;
  };

  const left = parsePart(halves[0]);
  if (!left) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const right = parsePart(halves[1]);
  if (!right) return null;

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...Array(missing).fill(0), ...right];
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

  const h = expandIpv6(ip);
  if (!h) return true;

  const firstSevenZero =
    h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && h[6] === 0;
  if (firstSevenZero && (h[7] === 0 || h[7] === 1)) return true;

  const firstSixZero =
    h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0;
  if (firstSixZero) return true;

  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    const reconstructed = `${(h[6] >> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >> 8) & 0xff}.${h[7] & 0xff}`;
    return isPrivateIpv4(reconstructed);
  }

  if (h[0] === 0x0064 && h[1] === 0xff9b) {
    if (h[2] === 0x0001) return true;
    if (h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) return true;
  }

  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true;
  if (h[0] === 0x2001 && h[1] === 0x0000) return true;
  if (h[0] === 0x2001 && h[1] === 0x0002 && h[2] === 0x0000) return true;
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  if (h[0] === 0x2002) return true;

  if ((h[0] & 0xfe00) === 0xfc00) return true;
  if ((h[0] & 0xffc0) === 0xfe80) return true;
  if ((h[0] & 0xffc0) === 0xfec0) return true;
  if ((h[0] & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Checks whether a hostname looks like a local/internal network target.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isInternalHostname(hostname) {
  const clean = String(hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!clean) return true;
  if (clean === 'localhost' || !clean.includes('.')) return true;
  return INTERNAL_SUFFIXES.some((suffix) => clean.endsWith(suffix));
}

/**
 * Verifies that a remote hostname resolves strictly to public, routable IP addresses.
 *
 * @param {string} hostname
 * @param {{ lookupFn?: typeof dns.lookup, allowPrivate?: boolean }} [options]
 * @returns {Promise<{ hostname: string, address: string, family: number, addresses: Array<{ address: string, family: number }> } | void>}
 */
export async function assertSafeRemoteHost(hostname, options = {}) {
  const { lookupFn = dns.lookup, allowPrivate = false } = options;
  const cleanHost = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

  if (!cleanHost || isInternalHostname(cleanHost)) {
    if (!allowPrivate) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
        'Tujuan URL mengarah ke host lokal atau jaringan internal yang tidak diizinkan.',
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
    const family = net.isIP(cleanHost);
    return { hostname: cleanHost, address: cleanHost, family, addresses: [{ address: cleanHost, family }] };
  }

  let records;
  try {
    records = await lookupFn(cleanHost, { all: true });
  } catch (error) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NETWORK_ERROR,
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

  const primary = records[0];
  return {
    hostname: cleanHost,
    address: primary.address,
    family: primary.family || net.isIP(primary.address),
    addresses: records.map((r) => ({ address: r.address, family: r.family || net.isIP(r.address) })),
  };
}

function isLoginWallUrl(platform, pathname) {
  const lowerPath = String(pathname || '').toLowerCase();
  if (platform === PLATFORMS.INSTAGRAM) {
    return lowerPath.startsWith('/accounts/login') || lowerPath.startsWith('/challenge');
  }
  if (platform === PLATFORMS.TIKTOK) {
    return lowerPath === '/login' || lowerPath.startsWith('/login/');
  }
  return false;
}

/**
 * Extracts Instagram post/reel/IGTV shortcode from a URL or pathname.
 *
 * @param {string | URL} input
 * @returns {string | null}
 */
export function extractInstagramShortcode(input) {
  if (!input) return null;
  try {
    const parsed = input instanceof URL ? input : new URL(String(input).trim());
    const match = parsed.pathname.match(INSTAGRAM_SHORTCODE_RE);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Parses, normalizes, and validates a user-submitted media URL.
 * Enforces HTTP/HTTPS only, rejects credentials/custom ports/IP literals/internal hosts,
 * and identifies known media platforms while letting yt-dlp validate extraction for other public URLs.
 *
 * @param {string} rawUrl
 * @returns {{
 *   normalizedUrl: string,
 *   url: URL,
 *   platform: string,
 *   platformLabel: string,
 *   hostname: string,
 *   isShortLink: boolean,
 *   shortcode: string | null,
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
      'Format URL tidak valid. Gunakan tautan lengkap diawali `https://` atau `http://`.',
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'Hanya tautan `https://` atau `http://` yang diizinkan.',
    );
  }

  if (parsed.username || parsed.password) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'Tautan yang mengandung kredensial tidak diizinkan.',
    );
  }

  if (parsed.port && parsed.port !== '443' && parsed.port !== '80') {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      'Port kustom pada tautan tidak diizinkan.',
    );
  }

  const rawHostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!rawHostname || net.isIP(rawHostname) !== 0 || isInternalHostname(rawHostname)) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      'Alamat IP langsung, localhost, atau host jaringan internal tidak diizinkan.',
    );
  }

  const detectedPlatform = detectPlatformFromHost(rawHostname);
  const platform = detectedPlatform ?? PLATFORMS.WEB;
  const platformLabel = resolvePlatformLabel(null, platform, rawHostname);

  if (detectedPlatform && (!parsed.pathname || parsed.pathname === '/') && !parsed.search) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.INVALID_URL,
      `Tautan ${platformLabel} harus mengarah langsung ke video, postingan, atau media.`,
    );
  }

  if (isLoginWallUrl(platform, parsed.pathname)) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
      'Konten memerlukan login atau bersifat privat pada platform sumber.',
    );
  }

  for (const param of TRACKING_QUERY_PARAMS) {
    parsed.searchParams.delete(param);
  }
  parsed.hash = '';

  return {
    normalizedUrl: parsed.toString(),
    url: parsed,
    platform,
    platformLabel,
    hostname: rawHostname,
    isShortLink: SHORT_LINK_HOSTS.has(rawHostname),
    shortcode: platform === PLATFORMS.INSTAGRAM ? extractInstagramShortcode(parsed) : null,
  };
}

/**
 * Creates an HTTP/HTTPS agent that pins socket connections to the already-validated IP
 * while preserving TLS SNI and certificate validation for HTTPS.
 *
 * @param {string} expectedHost
 * @param {{ address: string, family: number, addresses?: Array<{ address: string, family: number }> }} resolved
 * @param {'http:' | 'https:'} [protocol]
 * @returns {https.Agent | http.Agent}
 */
export function createPinnedAgent(expectedHost, resolved, protocol = 'https:') {
  const cleanExpected = String(expectedHost || '').toLowerCase();
  const AgentCtor = protocol === 'http:' ? http.Agent : https.Agent;
  return new AgentCtor({
    lookup: (hostname, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (String(hostname || '').toLowerCase() !== cleanExpected) {
        callback(new Error(`DNS pinning host mismatch: ${hostname}`));
        return;
      }
      if (opts && typeof opts === 'object' && opts.all) {
        const list = resolved.addresses?.length
          ? resolved.addresses
          : [{ address: resolved.address, family: resolved.family || 4 }];
        callback(null, list);
        return;
      }
      callback(null, resolved.address, resolved.family || 4);
    },
  });
}

export function createPinnedHttpsAgent(expectedHost, resolved) {
  return createPinnedAgent(expectedHost, resolved, 'https:');
}

function pinnedRedirectProbe(
  targetUrl,
  resolved,
  { timeoutMs, headers, httpsRequestFn = https.request, httpRequestFn = http.request },
) {
  const parsed = new URL(targetUrl);
  const isHttp = parsed.protocol === 'http:';
  const agent = createPinnedAgent(parsed.hostname, resolved, parsed.protocol);
  const requestFn = isHttp ? httpRequestFn : httpsRequestFn;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      agent.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const reqOpts = {
      method: 'GET',
      agent,
      headers,
      ...(isHttp ? {} : { servername: parsed.hostname, rejectUnauthorized: true }),
    };

    const req = requestFn(parsed, reqOpts, (res) => {
      const status = res.statusCode ?? 0;
      const rawLoc = res.headers?.location;
      const location = Array.isArray(rawLoc) ? rawLoc[0] : rawLoc ?? null;
      res.destroy();
      finish(null, { status, location });
    });

    req.setTimeout(timeoutMs, () => {
      const timeoutErr = new Error('Short-link redirect probe timed out');
      timeoutErr.name = 'TimeoutError';
      req.destroy(timeoutErr);
    });

    req.on('error', (err) => finish(err));
    req.end();
  });
}

/**
 * Safely resolves DNS and validates short-link HTTP redirects step by step with SSRF checks
 * on every redirect hop before passing the final URL to yt-dlp.
 *
 * @param {ReturnType<typeof validateMediaUrl>} validated
 * @param {{
 *   fetchFn?: typeof fetch,
 *   httpsRequestFn?: typeof https.request,
 *   httpRequestFn?: typeof http.request,
 *   lookupFn?: typeof dns.lookup,
 *   timeoutMs?: number,
 *   maxHops?: number,
 * }} [options]
 * @returns {Promise<ReturnType<typeof validateMediaUrl>>}
 */
export async function resolveAndValidateRedirects(validated, options = {}) {
  const {
    fetchFn = null,
    httpsRequestFn = https.request,
    httpRequestFn = http.request,
    lookupFn = dns.lookup,
    timeoutMs = 10_000,
    maxHops = 5,
  } = options;

  let current = validated;
  let resolvedHost = await assertSafeRemoteHost(current.hostname, { lookupFn });

  if (!current.isShortLink) {
    return current;
  }

  const probeHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };

  for (let hop = 0; hop < maxHops; hop += 1) {
    let status = 0;
    let location = null;

    if (fetchFn) {
      let response;
      try {
        response = await fetchFn(current.normalizedUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: probeHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        location = response.headers.get('location');
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new DownloaderError(
            DOWNLOADER_ERROR_CODES.TIMEOUT,
            'Waktu habis saat memeriksa tautan pendek. Silakan coba lagi.',
            { retryable: true, cause: error },
          );
        }
        throw new DownloaderError(
          DOWNLOADER_ERROR_CODES.NETWORK_ERROR,
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
    } else {
      try {
        const probe = await pinnedRedirectProbe(current.normalizedUrl, resolvedHost, {
          timeoutMs,
          headers: probeHeaders,
          httpsRequestFn,
          httpRequestFn,
        });
        status = probe.status;
        location = probe.location;
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new DownloaderError(
            DOWNLOADER_ERROR_CODES.TIMEOUT,
            'Waktu habis saat memeriksa tautan pendek. Silakan coba lagi.',
            { retryable: true, cause: error },
          );
        }
        throw new DownloaderError(
          DOWNLOADER_ERROR_CODES.NETWORK_ERROR,
          'Gagal mengikuti tautan pendek. Pastikan URL valid dan dapat diakses.',
          { retryable: true, cause: error },
        );
      }
    }

    if (status >= 300 && status < 400) {
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
      resolvedHost = await assertSafeRemoteHost(nextValidated.hostname, { lookupFn });
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
