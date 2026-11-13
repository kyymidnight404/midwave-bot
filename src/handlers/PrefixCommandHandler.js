import { PermissionFlagsBits } from 'discord.js';
import { AI_COOLDOWN_MS } from '../services/gemini.js';
import { GAME_MODES, GAME_TYPES } from '../utils/constants.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { parsePrefixInvocation, resolvePrefix } from '../utils/prefixParser.js';
import { MessageCommandAdapter, resolveUserFromMessage } from './MessageCommandAdapter.js';
import igfCommand from '../prefixCommands/igf.js';

const PREFIX_ONLY_COMMANDS = new Map([[igfCommand.name, igfCommand]]);

const COMMANDS_REQUIRING_ATTACH_FILES = new Set([
  'brat',
  'igf',
  'games',
  'help',
  'invite',
  GAME_TYPES.GUESS,
  GAME_TYPES.RPS,
  GAME_TYPES.TRIVIA,
  GAME_TYPES.COINFLIP,
  GAME_TYPES.DICE,
  GAME_TYPES.TICTACTOE,
  GAME_TYPES.CONNECT4,
]);

function requiresAttachFiles(commandName, subcommand) {
  if (commandName === 'brat' || commandName === 'igf' || commandName === 'games' || commandName === 'help') {
    return true;
  }
  if (commandName === 'invite' && subcommand === 'accept') {
    return true;
  }
  if (COMMANDS_REQUIRING_ATTACH_FILES.has(commandName)) {
    return subcommand === 'solo' || subcommand === 'challenge';
  }
  return false;
}

/**
 * Central router, permission validator, and error boundary for `!` prefix commands.
 */
export class PrefixCommandHandler {
  /**
   * @param {{
   *   commandHandler: import('./CommandHandler.js').CommandHandler,
   *   cooldowns: import('../utils/cooldown.js').CooldownManager,
   *   prefix?: string,
   *   context?: object,
   *   logger?: Console,
   * }} deps
   */
  constructor({ commandHandler, cooldowns, prefix = '!', context = {}, logger = console }) {
    this.commandHandler = commandHandler;
    this.cooldowns = cooldowns;
    this.prefix = resolvePrefix(prefix);
    this.context = context;
    this.logger = logger;
  }

  /**
   * Updates the shared runtime context passed to command executors.
   * @param {object} context
   */
  setContext(context) {
    this.context = context;
  }

  /**
   * @param {import('discord.js').Message} message
   * @param {string} content
   */
  async _safeReplyPlain(message, content) {
    try {
      if (typeof message.reply === 'function') {
        await message.reply({ content, allowedMentions: { repliedUser: false } });
      } else if (typeof message.channel?.send === 'function') {
        await message.channel.send({ content });
      }
    } catch {
      // Ignore secondary delivery failures
    }
  }

  /**
   * @param {import('discord.js').Message} message
   * @param {string} errorMessage
   */
  async _safeReplyError(message, errorMessage) {
    const payload = {
      embeds: [buildErrorEmbed(errorMessage)],
      allowedMentions: { repliedUser: false },
    };
    try {
      if (typeof message.reply === 'function') {
        await message.reply(payload);
      } else if (typeof message.channel?.send === 'function') {
        await message.channel.send(payload);
      }
    } catch {
      // Ignore secondary delivery failures
    }
  }

  /**
   * Checks whether the bot has required channel permissions in a guild text channel.
   * Returns `allowed: false` when missing mandatory send/embed/attach rights.
   * @param {import('discord.js').Message} message
   * @param {string} commandName
   * @param {string | null} subcommand
   * @returns {Promise<{ allowed: boolean, canManageMessages: boolean }>}
   */
  async _checkPermissions(message, commandName, subcommand) {
    if (!message.guild || typeof message.channel?.permissionsFor !== 'function') {
      return { allowed: true, canManageMessages: false };
    }

    const botMember =
      message.guild.members?.me ??
      (message.client?.user?.id ? message.guild.members?.cache?.get?.(message.client.user.id) : null);
    if (!botMember) {
      return { allowed: true, canManageMessages: false };
    }

    const perms = message.channel.permissionsFor(botMember);
    if (!perms) {
      return { allowed: true, canManageMessages: false };
    }

    if (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
      return { allowed: false, canManageMessages: false };
    }

    if (!perms.has(PermissionFlagsBits.EmbedLinks)) {
      await this._safeReplyPlain(
        message,
        `Bot memerlukan izin **Embed Links** di channel ini untuk menjalankan \`${this.prefix}${commandName}\`.`,
      );
      return { allowed: false, canManageMessages: false };
    }

    if (requiresAttachFiles(commandName, subcommand) && !perms.has(PermissionFlagsBits.AttachFiles)) {
      await this._safeReplyError(
        message,
        `Bot memerlukan izin **Attach Files** di channel ini untuk menjalankan \`${this.prefix}${commandName}\`.`,
      );
      return { allowed: false, canManageMessages: false };
    }

    return {
      allowed: true,
      canManageMessages: Boolean(perms.has(PermissionFlagsBits.ManageMessages)),
    };
  }

  /**
   * Handles a single Discord messageCreate event safely.
   * @param {import('discord.js').Message} message
   */
  async handle(message) {
    if (
      !message ||
      message.author?.bot ||
      message.webhookId ||
      message.system ||
      typeof message.content !== 'string'
    ) {
      return;
    }

    const parsed = parsePrefixInvocation(message.content, {
      prefix: this.prefix,
      userId: message.author?.id ?? null,
      gameManager: this.context?.gameManager ?? null,
    });

    if (!parsed) {
      return;
    }

    const command = this.commandHandler.get(parsed.commandName) ?? PREFIX_ONLY_COMMANDS.get(parsed.commandName);
    if (!command) {
      return;
    }

    const permCheck = await this._checkPermissions(message, parsed.commandName, parsed.subcommand);
    if (!permCheck.allowed) {
      return;
    }

    const cooldownKey = parsed.subcommand
      ? `${message.author.id}:${parsed.commandName}:${parsed.subcommand}`
      : `${message.author.id}:${parsed.commandName}`;
    const cooldownTtl =
      parsed.commandName === 'ai' && this.cooldowns.defaultTtlMs > 0
        ? Math.max(this.cooldowns.defaultTtlMs, AI_COOLDOWN_MS)
        : this.cooldowns.defaultTtlMs;
    const cooldownResult = this.cooldowns.tryAcquire(cooldownKey, cooldownTtl);
    if (!cooldownResult.allowed) {
      const waitSec = Math.max(0.5, cooldownResult.remainingMs / 1000).toFixed(1);
      await this._safeReplyError(
        message,
        `Terlalu cepat! Tunggu ${waitSec} detik sebelum menjalankan \`${this.prefix}${parsed.commandName}\` lagi.`,
      );
      return;
    }

    if (parsed.error) {
      await this._safeReplyError(message, parsed.error);
      return;
    }

    const resolvedUsers = new Map();
    if (parsed.options?.opponentId) {
      const opponentUser = await resolveUserFromMessage(message, parsed.options.opponentId);
      if (!opponentUser) {
        await this._safeReplyError(
          message,
          'Pemain lawan tidak ditemukan. Mention pengguna yang valid di server ini.',
        );
        return;
      }
      resolvedUsers.set(parsed.options.opponentId, opponentUser);
    }

    const status = this.context?.gameManager?.getStatus?.(message.author.id);
    const isActiveMultiplayerTrivia =
      status?.type === 'session' &&
      status.session.gameType === GAME_TYPES.TRIVIA &&
      status.session.mode === GAME_MODES.MULTIPLAYER;

    const isSecretChoice =
      (parsed.commandName === GAME_TYPES.RPS && parsed.subcommand === 'choose') ||
      (parsed.commandName === GAME_TYPES.COINFLIP && parsed.subcommand === 'choose') ||
      (parsed.commandName === GAME_TYPES.TRIVIA &&
        parsed.subcommand === 'answer' &&
        isActiveMultiplayerTrivia);

    const adapter = new MessageCommandAdapter({
      message,
      parsed,
      resolvedUsers,
      isSecretChoice,
      canManageMessages: permCheck.canManageMessages,
    });

    try {
      await command.execute(adapter, this.context);
    } catch (err) {
      this.logger.error(`[PrefixCommandHandler] Error executing ${this.prefix}${parsed.commandName}:`, err);
      const errEmbed = buildErrorEmbed('Terjadi gangguan saat memproses perintah ini. Silakan coba lagi.');
      try {
        if (adapter.deferred) {
          await adapter.editReply({ embeds: [errEmbed] });
        } else {
          await adapter.reply({ embeds: [errEmbed] });
        }
      } catch {
        // Ignore secondary error reply failures
      }
    }
  }
}
