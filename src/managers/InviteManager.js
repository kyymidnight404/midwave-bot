import { randomUUID } from 'node:crypto';
import { TIMEOUTS } from '../utils/constants.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

/**
 * Manages temporary multiplayer game invitations in RAM with automatic TTL expiration.
 */
export class InviteManager {
  /**
   * @param {{
   *   sessionManager: import('./SessionManager.js').SessionManager,
   *   defaultTtlMs?: number,
   *   nowFn?: () => number,
   * }} options
   */
  constructor({ sessionManager, defaultTtlMs = TIMEOUTS.INVITE_MS, nowFn = () => Date.now() }) {
    this.sessionManager = sessionManager;
    this.defaultTtlMs = defaultTtlMs;
    this.nowFn = nowFn;

    /** @type {Map<string, object>} */
    this.pendingInvites = new Map();
  }

  /**
   * Creates a new multiplayer invitation.
   * @param {{
   *   gameType: string,
   *   channelId: string,
   *   hostId: string,
   *   opponentId: string,
   *   config?: object,
   *   ttlMs?: number,
   *   onExpire?: (invite: object) => Promise<void> | void,
   * }} params
   * @returns {object}
   */
  createInvite({
    gameType,
    channelId,
    hostId,
    opponentId,
    config = {},
    ttlMs = this.defaultTtlMs,
    onExpire = null,
  }) {
    if (this.sessionManager.hasActiveSession(hostId)) {
      throw new Error('Kamu masih memiliki pertandingan aktif. Selesaikan atau batalkan dengan `/game action:cancel`.');
    }
    if (this.sessionManager.hasActiveSession(opponentId)) {
      throw new Error('Lawan yang ditantang sedang berada di pertandingan lain.');
    }
    if (this.getOutgoingInvite(hostId)) {
      throw new Error('Kamu masih memiliki undangan yang menunggu respons. Batalkan dulu dengan `/game action:cancel`.');
    }
    if (this.getIncomingInvite(opponentId)) {
      throw new Error('Pemain tersebut sudah memiliki undangan lain yang menunggu konfirmasi.');
    }

    const now = this.nowFn();
    const inviteId = randomUUID().slice(0, 8);
    const invite = {
      inviteId,
      gameType,
      channelId,
      hostId,
      opponentId,
      config: { ...config },
      createdAt: now,
      expiresAt: now + ttlMs,
      lobbyMessageRef: null,
      onExpire,
      timer: null,
    };

    this.pendingInvites.set(inviteId, invite);

    if (ttlMs > 0) {
      invite.timer = setTimeout(() => {
        const expired = this._deleteInvite(inviteId);
        if (expired && typeof expired.onExpire === 'function') {
          Promise.resolve(expired.onExpire(expired)).catch((err) => {
            console.error(`[InviteManager] Expiration callback error for ${inviteId}:`, sanitizeError(err));
          });
        }
      }, ttlMs);
      invite.timer?.unref?.();
    }

    return invite;
  }

  /**
   * Finds the latest incoming pending invite addressed to `opponentId`.
   * @param {string} opponentId
   * @returns {object | undefined}
   */
  getIncomingInvite(opponentId) {
    let latest;
    for (const invite of this.pendingInvites.values()) {
      if (invite.opponentId === opponentId) {
        if (!latest || invite.createdAt > latest.createdAt) {
          latest = invite;
        }
      }
    }
    return latest;
  }

  /**
   * Finds an outgoing pending invite created by `hostId`.
   * @param {string} hostId
   * @returns {object | undefined}
   */
  getOutgoingInvite(hostId) {
    for (const invite of this.pendingInvites.values()) {
      if (invite.hostId === hostId) {
        return invite;
      }
    }
    return undefined;
  }

  /**
   * Finds any pending invite where `userId` is either host or opponent.
   * @param {string} userId
   * @returns {object | undefined}
   */
  getInviteForUser(userId) {
    return this.getOutgoingInvite(userId) ?? this.getIncomingInvite(userId);
  }

  /**
   * Associates a public lobby message reference with a pending invite.
   * @param {string} inviteId
   * @param {{ channelId: string, messageId: string }} ref
   */
  setLobbyMessageRef(inviteId, ref) {
    const invite = this.pendingInvites.get(inviteId);
    if (!invite) return;
    invite.lobbyMessageRef = ref;
  }

  /**
   * Accepts an incoming invite addressed to `opponentId`.
   * Re-checks active session conflicts before removing the invite.
   * @param {string} opponentId
   * @returns {object}
   */
  acceptInvite(opponentId) {
    const invite = this.getIncomingInvite(opponentId);
    if (!invite) {
      throw new Error('Tidak ada undangan aktif yang ditujukan untukmu.');
    }
    if (this.sessionManager.hasActiveSession(invite.hostId)) {
      this._deleteInvite(invite.inviteId);
      throw new Error('Undangan tidak valid lagi karena host sudah masuk ke pertandingan lain.');
    }
    if (this.sessionManager.hasActiveSession(opponentId)) {
      throw new Error('Kamu sedang berada di pertandingan aktif. Selesaikan atau batalkan terlebih dahulu.');
    }
    return this._deleteInvite(invite.inviteId);
  }

  /**
   * Declines an incoming invite addressed to `opponentId`.
   * @param {string} opponentId
   * @returns {object}
   */
  declineInvite(opponentId) {
    const invite = this.getIncomingInvite(opponentId);
    if (!invite) {
      throw new Error('Tidak ada undangan aktif yang ditujukan untukmu.');
    }
    return this._deleteInvite(invite.inviteId);
  }

  /**
   * Cancels a pending outgoing invite hosted by `hostId`.
   * @param {string} hostId
   * @returns {object | null}
   */
  cancelOutgoingInvite(hostId) {
    const invite = this.getOutgoingInvite(hostId);
    if (!invite) return null;
    return this._deleteInvite(invite.inviteId);
  }

  /**
   * Clears all pending invites and their timers.
   */
  clearAll() {
    for (const invite of this.pendingInvites.values()) {
      if (invite.timer) {
        clearTimeout(invite.timer);
        invite.timer = null;
      }
    }
    this.pendingInvites.clear();
  }

  /**
   * @returns {number}
   */
  get count() {
    return this.pendingInvites.size;
  }

  /**
   * @private
   * @param {string} inviteId
   */
  _deleteInvite(inviteId) {
    const invite = this.pendingInvites.get(inviteId);
    if (!invite) return null;
    this.pendingInvites.delete(inviteId);
    if (invite.timer) {
      clearTimeout(invite.timer);
      invite.timer = null;
    }
    return invite;
  }
}
