const TIKTOK_URL_REGEX =
  /https?:\/\/(?:(?:www|m)\.)?(?:tiktok\.com\/(?:@[^/\s?#]+\/(?:video|photo)\/\d+|(?:v|embed)\/\d+|t\/[A-Za-z0-9_-]+)(?:[^\s<>]*)|(?:vm|vt)\.tiktok\.com\/[A-Za-z0-9_-]+(?:[^\s<>]*))/gi;

const INSTAGRAM_URL_REGEX =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|stories)\/[A-Za-z0-9._-]+(?:\/[^\s<>]*)?/gi;

const TRAILING_PUNCTUATION_REGEX = /[),.!?;:'"\]>]+$/;

/**
 * Strips trailing sentence punctuation from a matched URL while keeping valid query strings.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function cleanMatchedUrl(rawUrl) {
  return rawUrl.replace(TRAILING_PUNCTUATION_REGEX, '').trim();
}

/**
 * Normalizes a matched URL and ensures it uses HTTPS without embedded credentials.
 *
 * @param {string} rawUrl
 * @returns {string | null}
 */
function normalizeSafeSocialUrl(rawUrl) {
  const cleaned = cleanMatchedUrl(rawUrl);
  try {
    const parsed = new URL(cleaned);
    if (parsed.username || parsed.password) {
      return null;
    }
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    if (parsed.protocol !== 'https:' || !parsed.pathname || parsed.pathname === '/') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Detects valid TikTok and Instagram post/reel/story URLs inside a chat message.
 *
 * @param {string} content
 * @returns {Array<{ platform: 'tiktok' | 'instagram', url: string, index: number }>}
 */
export function detectMediaUrls(content) {
  if (typeof content !== 'string' || !content.trim()) {
    return [];
  }

  const matches = [];
  const seen = new Set();

  const collect = (regex, platform) => {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const normalized = normalizeSafeSocialUrl(match[0]);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        matches.push({ platform, url: normalized, index: match.index });
      }
    }
  };

  collect(TIKTOK_URL_REGEX, 'tiktok');
  collect(INSTAGRAM_URL_REGEX, 'instagram');

  matches.sort((a, b) => a.index - b.index);
  return matches;
}

/**
 * Convenience helper returning only the first detected TikTok or Instagram URL, if any.
 *
 * @param {string} content
 * @returns {{ platform: 'tiktok' | 'instagram', url: string, index: number } | null}
 */
export function detectFirstMediaUrl(content) {
  return detectMediaUrls(content)[0] || null;
}
