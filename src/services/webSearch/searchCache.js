/**
 * In-memory TTL cache for normalized web search queries.
 * Dynamic topics (news, prices, scores) use base TTL (~15 min), while semi-stable
 * topics (software versions, docs) use a longer TTL (~30 min).
 */
export class WebSearchCache {
  /**
   * @param {{
   *   dynamicTtlMs?: number,
   *   semiStableTtlMs?: number,
   *   maxEntries?: number,
   *   nowFn?: () => number,
   * }} [options]
   */
  constructor({
    dynamicTtlMs = 900_000,
    semiStableTtlMs = 1_800_000,
    maxEntries = 200,
    nowFn = () => Date.now(),
  } = {}) {
    this.dynamicTtlMs = dynamicTtlMs;
    this.semiStableTtlMs = Math.max(dynamicTtlMs, semiStableTtlMs);
    this.maxEntries = maxEntries;
    this.nowFn = nowFn;
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this.store = new Map();
  }

  /**
   * @param {string} key
   * @returns {any | null}
   */
  get(key) {
    try {
      if (!key) return null;
      const entry = this.store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= this.nowFn()) {
        this.store.delete(key);
        return null;
      }
      return entry.value;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} key
   * @param {any} value
   * @param {'dynamic' | 'semi_stable'} [category]
   */
  set(key, value, category = 'dynamic') {
    try {
      if (!key) return;
      const ttlMs = category === 'semi_stable' ? this.semiStableTtlMs : this.dynamicTtlMs;
      this.pruneIfNeeded();
      this.store.set(key, {
        value,
        expiresAt: this.nowFn() + ttlMs,
      });
    } catch {
      // Cache errors must never interrupt user responses
    }
  }

  pruneIfNeeded() {
    const now = this.nowFn();
    for (const [k, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(k);
      }
    }
    while (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  clear() {
    this.store.clear();
  }
}

/**
 * Sliding-window global rate limiter to protect Tavily API quota from bursts.
 */
export class GlobalSearchRateLimiter {
  /**
   * @param {{ maxRequests?: number, windowMs?: number, nowFn?: () => number }} [options]
   */
  constructor({ maxRequests = 20, windowMs = 60_000, nowFn = () => Date.now() } = {}) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.nowFn = nowFn;
    /** @type {number[]} */
    this.timestamps = [];
  }

  /**
   * @returns {{ allowed: boolean, retryAfterMs: number }}
   */
  tryAcquire() {
    const now = this.nowFn();
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxRequests) {
      const retryAfterMs = Math.max(1000, this.timestamps[0] + this.windowMs - now);
      return { allowed: false, retryAfterMs };
    }
    this.timestamps.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  clear() {
    this.timestamps.length = 0;
  }
}
