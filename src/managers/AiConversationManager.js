import {
  AI_MAX_HISTORY_CHARS,
  AI_MAX_HISTORY_MESSAGES,
  trimConversationHistory,
} from '../services/gemini.js';

export const DEFAULT_AI_CONVERSATION_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_AI_MAX_CONVERSATIONS = 500;
export const DEFAULT_AI_CLEANUP_INTERVAL_MS = 60 * 1000;

/**
 * Ephemeral, RAM-only short-term conversation context store for `/ai` and `!ai`.
 * Automatically expires idle threads, caps total stored turns and memory usage,
 * and never persists personal data or user profiles to disk.
 */
export class AiConversationManager {
  /**
   * @param {{
   *   ttlMs?: number,
   *   maxMessages?: number,
   *   maxChars?: number,
   *   maxConversations?: number,
   *   nowFn?: () => number,
   * }} [options]
   */
  constructor({
    ttlMs = DEFAULT_AI_CONVERSATION_TTL_MS,
    maxMessages = AI_MAX_HISTORY_MESSAGES,
    maxChars = AI_MAX_HISTORY_CHARS,
    maxConversations = DEFAULT_AI_MAX_CONVERSATIONS,
    cleanupIntervalMs = DEFAULT_AI_CLEANUP_INTERVAL_MS,
    nowFn = () => Date.now(),
  } = {}) {
    this.ttlMs = Math.max(0, ttlMs);
    this.maxMessages = Math.max(2, maxMessages);
    this.maxChars = Math.max(200, maxChars);
    this.maxConversations = Math.max(10, maxConversations);
    this.cleanupIntervalMs = Math.max(0, cleanupIntervalMs);
    this.nowFn = nowFn;
    /** @type {Map<string, { messages: Array<{ role: string, content: string }>, updatedAt: number }>} */
    this.conversations = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this.cleanupTimer = null;
  }

  /**
   * Starts a non-blocking periodic cleanup sweep while conversations are active in RAM.
   */
  ensureCleanupTimer() {
    if (
      this.cleanupIntervalMs <= 0 ||
      this.ttlMs <= 0 ||
      this.cleanupTimer ||
      this.conversations.size === 0
    ) {
      return;
    }
    this.cleanupTimer = setInterval(() => {
      this.pruneExpired();
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  /**
   * Stops the periodic cleanup sweep when no conversations remain or on shutdown.
   */
  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Builds a normalized isolation key scoped to guild/DM, channel, and user.
   * @param {{ guildId?: string | null, channelId?: string | null, userId?: string | null }} [scope]
   * @returns {string | null}
   */
  buildScopeKey({ guildId = null, channelId = null, userId = null } = {}) {
    if (!userId || typeof userId !== 'string') {
      return null;
    }
    const guildPart = typeof guildId === 'string' && guildId ? guildId : 'dm';
    const channelPart = typeof channelId === 'string' && channelId ? channelId : 'global';
    return `${guildPart}:${channelPart}:${userId}`;
  }

  /**
   * Removes expired conversations based on `ttlMs`.
   */
  pruneExpired() {
    if (this.ttlMs <= 0 || this.conversations.size === 0) {
      this.stopCleanupTimer();
      return;
    }
    const now = this.nowFn();
    for (const [key, entry] of this.conversations.entries()) {
      if (now - entry.updatedAt >= this.ttlMs) {
        this.conversations.delete(key);
      }
    }
    if (this.conversations.size === 0) {
      this.stopCleanupTimer();
    }
  }

  /**
   * Returns active trimmed conversation history for the given scope, or `[]` if idle/expired.
   * @param {{ guildId?: string | null, channelId?: string | null, userId?: string | null }} [scope]
   * @returns {Array<{ role: string, content: string }>}
   */
  getHistory(scope = {}) {
    const key = this.buildScopeKey(scope);
    if (!key) {
      return [];
    }

    const entry = this.conversations.get(key);
    if (!entry) {
      return [];
    }

    const now = this.nowFn();
    if (this.ttlMs > 0 && now - entry.updatedAt >= this.ttlMs) {
      this.conversations.delete(key);
      return [];
    }

    return entry.messages.map((item) => ({ ...item }));
  }

  /**
   * Appends a completed user/model exchange into ephemeral RAM history.
   * @param {{ guildId?: string | null, channelId?: string | null, userId?: string | null }} scope
   * @param {string} userText
   * @param {string} modelText
   */
  appendTurn(scope, userText, modelText) {
    const key = this.buildScopeKey(scope);
    if (!key) {
      return;
    }

    const cleanUser = typeof userText === 'string' ? userText.trim() : '';
    const cleanModel = typeof modelText === 'string' ? modelText.trim() : '';
    if (!cleanUser || !cleanModel) {
      return;
    }

    this.pruneExpired();

    const existing = this.conversations.get(key)?.messages ?? [];
    const trimmed = trimConversationHistory(
      [
        ...existing,
        { role: 'user', content: cleanUser },
        { role: 'model', content: cleanModel },
      ],
      { maxMessages: this.maxMessages, maxChars: this.maxChars },
    );

    if (this.conversations.has(key)) {
      this.conversations.delete(key);
    } else if (this.conversations.size >= this.maxConversations) {
      const oldestKey = this.conversations.keys().next().value;
      if (oldestKey !== undefined) {
        this.conversations.delete(oldestKey);
      }
    }

    this.conversations.set(key, {
      messages: trimmed,
      updatedAt: this.nowFn(),
    });
    this.ensureCleanupTimer();
  }

  /**
   * Clears history for a single conversation scope.
   * @param {{ guildId?: string | null, channelId?: string | null, userId?: string | null }} scope
   * @returns {boolean} True if an active conversation entry was removed.
   */
  clearConversation(scope = {}) {
    const key = this.buildScopeKey(scope);
    if (!key) {
      return false;
    }
    const removed = this.conversations.delete(key);
    if (this.conversations.size === 0) {
      this.stopCleanupTimer();
    }
    return removed;
  }

  /**
   * Clears all ephemeral AI conversation state from RAM.
   */
  clear() {
    this.conversations.clear();
    this.stopCleanupTimer();
  }

  /**
   * Returns diagnostic counts without exposing conversation content.
   * @returns {{ activeConversationsCount: number }}
   */
  getStats() {
    this.pruneExpired();
    return {
      activeConversationsCount: this.conversations.size,
    };
  }
}
