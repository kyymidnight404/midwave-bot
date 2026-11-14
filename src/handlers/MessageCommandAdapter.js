import { MessageFlags } from 'discord.js';
import { COLORS } from '../utils/constants.js';

/**
 * Resolves a Discord User object by ID from message mentions, cache, or API fetch.
 * @param {import('discord.js').Message} message
 * @param {string} userId
 * @returns {Promise<import('discord.js').User | null>}
 */
export async function resolveUserFromMessage(message, userId) {
  if (!userId) {
    return null;
  }

  const mentioned = message.mentions?.users?.get?.(userId);
  if (mentioned) {
    return mentioned;
  }

  const cachedUser = message.client?.users?.cache?.get?.(userId);
  if (cachedUser) {
    return cachedUser;
  }

  if (message.guild?.members?.fetch) {
    try {
      const member = await message.guild.members.fetch(userId);
      if (member?.user) {
        return member.user;
      }
    } catch {
      // Fall through to client.users.fetch
    }
  }

  if (message.client?.users?.fetch) {
    try {
      return await message.client.users.fetch(userId);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Adapts a Discord Message into a ChatInputCommandInteraction-compatible facade
 * so existing slash command handlers, SessionManager, and InviteManager work seamlessly.
 */
export class MessageCommandAdapter {
  /**
   * @param {{
   *   message: import('discord.js').Message,
   *   parsed: { commandName: string, subcommand: string | null, options: Record<string, any> },
   *   resolvedUsers?: Map<string, import('discord.js').User>,
   *   isSecretChoice?: boolean,
   *   canManageMessages?: boolean,
   *   canEmbedLinks?: boolean,
   * }} params
   */
  constructor({
    message,
    parsed,
    resolvedUsers = new Map(),
    isSecretChoice = false,
    canManageMessages = false,
    canEmbedLinks = true,
  }) {
    this.message = message;
    this.parsed = parsed;
    this.resolvedUsers = resolvedUsers;
    this.isSecretChoice = isSecretChoice;
    this.canManageMessages = canManageMessages;
    this.canEmbedLinks = canEmbedLinks;

    this.id = message.id ?? null;
    this.commandName = parsed.commandName;
    this.user = message.author;
    this.member = message.member ?? null;
    this.memberPermissions = message.member?.permissions ?? null;
    this.guildId = message.guildId ?? message.guild?.id ?? null;
    this.channelId = message.channelId ?? message.channel?.id ?? null;
    this.deferred = false;
    this.replied = false;
    this._ephemeral = false;
    this._publicReplyMsg = null;

    this.options = {
      getSubcommand: (required = false) => {
        if (!this.parsed.subcommand && required) {
          throw new Error(`Missing subcommand for ${this.commandName}`);
        }
        return this.parsed.subcommand ?? null;
      },
      getString: (name, required = false) => {
        const val = this.parsed.options?.[name] ?? null;
        if (val === null && required) {
          throw new Error(`Missing string option: ${name}`);
        }
        return typeof val === 'string' ? val : null;
      },
      getInteger: (name, required = false) => {
        const val = this.parsed.options?.[name] ?? null;
        if (val === null && required) {
          throw new Error(`Missing integer option: ${name}`);
        }
        return typeof val === 'number' ? val : null;
      },
      getUser: (name, required = false) => {
        const targetId =
          this.parsed.options?.[`${name}Id`] ??
          this.parsed.options?.[name] ??
          null;
        const userObj = targetId ? this.resolvedUsers.get(targetId) ?? null : null;
        if (!userObj && required) {
          throw new Error(`Missing user option: ${name}`);
        }
        return userObj;
      },
    };
  }

  /**
   * @returns {boolean}
   */
  isChatInputCommand() {
    return true;
  }

  /**
   * @param {{ flags?: number }} [opts]
   */
  async deferReply(opts = {}) {
    this.deferred = true;
    if (opts?.flags === MessageFlags.Ephemeral) {
      this._ephemeral = true;
      return;
    }
    await this.message.channel?.sendTyping?.().catch(() => {});
  }

  /**
   * @param {object} payload
   */
  async reply(payload) {
    this.replied = true;
    return this._dispatchResponse(payload, false);
  }

  /**
   * @param {object} payload
   */
  async editReply(payload) {
    this.replied = true;
    return this._dispatchResponse(payload, true);
  }

  /**
   * @param {object} payload
   */
  async followUp(payload) {
    return this._dispatchResponse(payload, false);
  }

  /**
   * @returns {Promise<import('discord.js').Message | null>}
   */
  async fetchReply() {
    return this._publicReplyMsg;
  }

  /**
   * @param {object} payload
   * @returns {boolean}
   */
  _isErrorPayload(payload) {
    if (!Array.isArray(payload?.embeds) || payload.embeds.length === 0) {
      return false;
    }
    return payload.embeds.some((embed) => {
      const color = embed?.data?.color ?? embed?.color;
      return color === COLORS.DANGER;
    });
  }

  /**
   * @param {object} payload
   * @returns {object}
   */
  _sanitizePayload(payload) {
    const { flags: _ignoredFlags, ...rest } = payload ?? {};
    return {
      ...rest,
      allowedMentions: rest.allowedMentions ?? { repliedUser: false },
    };
  }

  /**
   * @param {object} payload
   * @param {boolean} allowEditExisting
   */
  async _dispatchResponse(payload, allowEditExisting) {
    const cleanPayload = this._sanitizePayload(payload);
    const shouldKeepSecret = this.isSecretChoice && !this._isErrorPayload(payload);

    if (shouldKeepSecret) {
      if (this.canManageMessages && this.message.deletable !== false) {
        await this.message.delete?.().catch(() => {});
      }

      if (typeof this.message.author?.send === 'function') {
        try {
          return await this.message.author.send(cleanPayload);
        } catch {
          // User DMs closed; acknowledge in channel without echoing the secret choice.
        }
      }

      return this._sendPublic({
        content: `${this.message.author}, pilihan rahasiamu telah diproses secara privat.`,
        allowedMentions: { repliedUser: false },
      });
    }

    if (allowEditExisting && this._publicReplyMsg && typeof this._publicReplyMsg.edit === 'function') {
      try {
        return await this._publicReplyMsg.edit(cleanPayload);
      } catch {
        // Fall through to sending a fresh public message if previous reply was deleted.
      }
    }

    return this._sendPublic(cleanPayload);
  }

  /**
   * @param {object} cleanPayload
   */
  async _sendPublic(cleanPayload) {
    let sent = null;
    if (typeof this.message.reply === 'function') {
      try {
        sent = await this.message.reply(cleanPayload);
      } catch {
        // Original trigger message may have been deleted; fall back to channel.send.
      }
    }

    if (!sent && typeof this.message.channel?.send === 'function') {
      sent = await this.message.channel.send(cleanPayload);
    }

    if (sent) {
      this._publicReplyMsg = sent;
    }
    return sent;
  }
}
