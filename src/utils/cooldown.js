import { TIMEOUTS } from './constants.js';

const CANONICAL_MEDIA_ACTIONS = new Set(['download', 'qc', 'brat', 'lyrics']);
const CANONICAL_UTILITY_ACTIONS = new Set([
  'ping',
  'help',
  'menu',
  'feedback',
  'avatar',
  'banner',
  'say',
  'clear',
  'emojis',
  'donate',
  'about',
  'igf',
]);

/**
 * Maps equivalent Slash, Prefix, and AutoDownloader command entry points onto a single
 * shared cooldown key per user so limits cannot be bypassed across interfaces (`MW-SEC-013`).
 *
 * @param {string} commandName
 * @param {string} [actionPart]
 * @returns {string}
 */
export function resolveCanonicalCooldownKey(commandName, actionPart = '') {
  const cmd = String(commandName || '').trim().toLowerCase();
  const action = String(actionPart || '').trim().toLowerCase();

  if (cmd === 'autodownload' || cmd === 'download' || cmd === 'dl') {
    return 'media:download';
  }
  if (cmd === 'media' && action) {
    const baseAction = action.split(':').pop();
    if (baseAction === 'download' || baseAction === 'dl') return 'media:download';
    if (CANONICAL_MEDIA_ACTIONS.has(baseAction)) return `media:${baseAction}`;
    return `media:${action}`;
  }
  if (CANONICAL_MEDIA_ACTIONS.has(cmd)) {
    return `media:${cmd}`;
  }

  if (cmd === 'utility' && action) {
    const baseAction = action.split(':').pop();
    return baseAction === 'menu' || baseAction === 'help' ? 'utility:help' : `utility:${action}`;
  }
  if (CANONICAL_UTILITY_ACTIONS.has(cmd)) {
    return cmd === 'menu' || cmd === 'help' ? 'utility:help' : `utility:${cmd}`;
  }

  return action ? `${cmd}:${action}` : cmd;
}

/**
 * In-memory per-user command cooldown tracker.
 * Prevents command spam without any persistent storage.
 */
export class CooldownManager {
  /**
   * @param {number} [defaultTtlMs]
   * @param {() => number} [nowFn]
   */
  constructor(defaultTtlMs = TIMEOUTS.COOLDOWN_MS, nowFn = () => Date.now()) {
    this.defaultTtlMs = defaultTtlMs;
    this.nowFn = nowFn;
    /** @type {Map<string, number>} */
    this.cooldowns = new Map();
  }

  /**
   * Checks whether a key is currently on cooldown without consuming it.
   * @param {string} key
   * @returns {{ onCooldown: boolean, remainingMs: number }}
   */
  check(key) {
    const expiresAt = this.cooldowns.get(key);
    if (expiresAt === undefined) {
      return { onCooldown: false, remainingMs: 0 };
    }
    const remainingMs = expiresAt - this.nowFn();
    if (remainingMs <= 0) {
      this.cooldowns.delete(key);
      return { onCooldown: false, remainingMs: 0 };
    }
    return { onCooldown: true, remainingMs };
  }

  /**
   * Checks cooldown and, if clear, sets a new expiration.
   * @param {string} key
   * @param {number} [ttlMs]
   * @returns {{ allowed: boolean, remainingMs: number }}
   */
  tryAcquire(key, ttlMs = this.defaultTtlMs) {
    const status = this.check(key);
    if (status.onCooldown) {
      return { allowed: false, remainingMs: status.remainingMs };
    }
    this.cooldowns.set(key, this.nowFn() + ttlMs);
    this.pruneExpired();
    return { allowed: true, remainingMs: 0 };
  }

  /**
   * Removes expired entries to keep memory bounded.
   */
  pruneExpired() {
    if (this.cooldowns.size <= 500) return;
    const now = this.nowFn();
    for (const [key, expiresAt] of this.cooldowns.entries()) {
      if (expiresAt <= now) {
        this.cooldowns.delete(key);
      }
    }
  }

  /**
   * Clears all cooldown entries.
   */
  clear() {
    this.cooldowns.clear();
  }
}
