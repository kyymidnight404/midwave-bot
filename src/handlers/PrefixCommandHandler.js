import { PermissionFlagsBits } from 'discord.js';
import { DEFAULT_HANDLER_REGISTRY } from '../config/commandRegistry.js';
import animePrefixCommand from '../commands/prefix/anime.js';
import bratPrefixCommand from '../prefixCommands/brat.js';
import downloadPrefixCommand from '../prefixCommands/download.js';
import feedbackPrefixCommand from '../prefixCommands/feedback.js';
import igfCommand from '../prefixCommands/igf.js';
import lyricsPrefixCommand from '../prefixCommands/lyrics.js';
import qcPrefixCommand from '../prefixCommands/qc.js';
import quizCenterCommand from '../commands/quiz.js';
import rpsCenterCommand from '../commands/rps.js';
import sayPrefixCommand, { SAY_COOLDOWN_MS } from '../prefixCommands/say.js';
import tttCenterCommand from '../commands/ttt.js';
import { DOWNLOAD_COOLDOWN_MS } from '../services/downloader.js';
import { ANIME_COOLDOWN_MS } from '../services/animeService.js';
import { AI_COOLDOWN_MS } from '../services/gemini.js';
import { LYRICS_COOLDOWN_MS } from '../services/lyricsService.js';
import { SOCIAL_COOLDOWN_MS, SOCIAL_INTERACTIONS } from '../services/otakuGifsService.js';
import { PING_COOLDOWN_MS } from '../services/pingService.js';
import { WEATHER_COOLDOWN_MS } from '../services/weatherService.js';
import { handleQuizChatAnswer } from '../events/gameInteraction.js';
import { GAME_TYPES } from '../utils/constants.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';
import { executeGameCommand } from '../utils/gameDispatcher.js';
import { parsePrefixInvocation, resolvePrefix } from '../utils/prefixParser.js';
import { executeSocialAction } from '../utils/socialCommand.js';
import { MessageCommandAdapter, resolveUserFromMessage } from './MessageCommandAdapter.js';

const PREFIX_EXECUTORS = new Map([
  [igfCommand.name, igfCommand],
  [bratPrefixCommand.name, bratPrefixCommand],
  [downloadPrefixCommand.name, downloadPrefixCommand],
  [qcPrefixCommand.name, qcPrefixCommand],
  [sayPrefixCommand.name, sayPrefixCommand],
  [feedbackPrefixCommand.name, feedbackPrefixCommand],
  [quizCenterCommand.name, quizCenterCommand],
  ['ai', { execute: DEFAULT_HANDLER_REGISTRY.ai }],
  ['math', { execute: DEFAULT_HANDLER_REGISTRY.math }],
  ['menu', { execute: DEFAULT_HANDLER_REGISTRY.help }],
  ['donate', { execute: DEFAULT_HANDLER_REGISTRY.donate }],
  ['ping', { execute: DEFAULT_HANDLER_REGISTRY.ping }],
  ['knowledge', { execute: DEFAULT_HANDLER_REGISTRY.knowledge }],
  ['weather', { execute: DEFAULT_HANDLER_REGISTRY.weather }],
  [animePrefixCommand.name, animePrefixCommand],
  [lyricsPrefixCommand.name, lyricsPrefixCommand],
  ...Object.keys(SOCIAL_INTERACTIONS).map((cmd) => [
    cmd,
    { execute: (interaction, context) => executeSocialAction(interaction, cmd, context) },
  ]),
  ...Object.values(GAME_TYPES).map((gameType) => [
    gameType,
    {
      execute: (interaction, context) =>
        executeGameCommand(interaction, context, {
          forcedGameType: gameType,
          forcedAction: interaction.options.getSubcommand(false),
        }),
    },
  ]),
]);

import {
  PREFIX_ONLY_METADATA,
  registerPrefixCommandNames,
} from '../services/helpService.js';

export { PREFIX_ONLY_METADATA };

/**
 * Returns the set of all registered prefix command names.
 * @returns {Set<string>}
 */
export function getRegisteredPrefixCommandNames() {
  return new Set(PREFIX_EXECUTORS.keys());
}

registerPrefixCommandNames(PREFIX_EXECUTORS.keys());

const COMMAND_COOLDOWNS = Object.freeze({
  ai: AI_COOLDOWN_MS,
  anime: ANIME_COOLDOWN_MS,
  download: DOWNLOAD_COOLDOWN_MS,
  lyrics: LYRICS_COOLDOWN_MS,
  ping: PING_COOLDOWN_MS,
  say: SAY_COOLDOWN_MS,
  weather: WEATHER_COOLDOWN_MS,
  ...Object.fromEntries(Object.keys(SOCIAL_INTERACTIONS).map((cmd) => [cmd, SOCIAL_COOLDOWN_MS])),
});

const COMMANDS_REQUIRING_ATTACH_FILES = new Set([
  'brat',
  'donate',
  'download',
  'igf',
  'qc',
  'menu',
  GAME_TYPES.RPS,
  GAME_TYPES.COINFLIP,
  GAME_TYPES.TICTACTOE,
]);

const GAME_CENTER_CHALLENGE_EXECUTORS = new Map([
  [GAME_TYPES.TICTACTOE, tttCenterCommand],
  [GAME_TYPES.RPS, rpsCenterCommand],
]);

function isGameCenterDirectChallenge(parsed) {
  return (
    parsed?.subcommand === 'challenge' &&
    GAME_CENTER_CHALLENGE_EXECUTORS.has(parsed.commandName)
  );
}

function requiresAttachFiles(commandName, subcommand, isGameCenterChallenge = false) {
  if (isGameCenterChallenge) {
    return false;
  }
  if (commandName === 'brat' || commandName === 'donate' || commandName === 'download' || commandName === 'igf' || commandName === 'qc' || commandName === 'menu') {
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
   * @param {boolean} [canEmbedLinks]
   */
  async _safeReplyError(message, errorMessage, canEmbedLinks = true) {
    if (!canEmbedLinks) {
      await this._safeReplyPlain(message, errorMessage);
      return;
    }
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
   * @returns {Promise<{ allowed: boolean, canManageMessages: boolean, canEmbedLinks: boolean }>}
   */
  async _checkPermissions(message, commandName, subcommand, isGameCenterChallenge = false) {
    if (!message.guild || typeof message.channel?.permissionsFor !== 'function') {
      return { allowed: true, canManageMessages: false, canEmbedLinks: true, canAttachFiles: true };
    }

    const botMember =
      message.guild.members?.me ??
      (message.client?.user?.id ? message.guild.members?.cache?.get?.(message.client.user.id) : null);
    if (!botMember) {
      return { allowed: true, canManageMessages: false, canEmbedLinks: true, canAttachFiles: true };
    }

    const perms = message.channel.permissionsFor(botMember);
    if (!perms) {
      return { allowed: true, canManageMessages: false, canEmbedLinks: true, canAttachFiles: true };
    }

    if (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
      return { allowed: false, canManageMessages: false, canEmbedLinks: false, canAttachFiles: false };
    }

    const canEmbedLinks = Boolean(perms.has(PermissionFlagsBits.EmbedLinks));
    const canAttachFiles = Boolean(perms.has(PermissionFlagsBits.AttachFiles));
    if (commandName !== 'say' && !canEmbedLinks) {
      await this._safeReplyPlain(
        message,
        `Bot memerlukan izin **Embed Links** di channel ini untuk menjalankan \`${this.prefix}${commandName}\`.`,
      );
      return { allowed: false, canManageMessages: false, canEmbedLinks: false, canAttachFiles };
    }

    if (requiresAttachFiles(commandName, subcommand, isGameCenterChallenge) && !canAttachFiles) {
      await this._safeReplyError(
        message,
        `Bot memerlukan izin **Attach Files** di channel ini untuk menjalankan \`${this.prefix}${commandName}\`.`,
        canEmbedLinks,
      );
      return { allowed: false, canManageMessages: false, canEmbedLinks, canAttachFiles: false };
    }

    return {
      allowed: true,
      canManageMessages: Boolean(perms.has(PermissionFlagsBits.ManageMessages)),
      canEmbedLinks,
      canAttachFiles,
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
    const handlerStartTime = performance.now();

    if (await handleQuizChatAnswer(message, this.context)) {
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

    const isGcChallenge = isGameCenterDirectChallenge(parsed);
    const command = isGcChallenge
      ? GAME_CENTER_CHALLENGE_EXECUTORS.get(parsed.commandName)
      : (PREFIX_EXECUTORS.get(parsed.commandName) ?? this.commandHandler.get(parsed.commandName));
    if (!command) {
      return;
    }

    const permCheck = await this._checkPermissions(message, parsed.commandName, parsed.subcommand, isGcChallenge);
    if (!permCheck.allowed) {
      return;
    }

    const cooldownKey = parsed.subcommand
      ? `${message.author.id}:${parsed.commandName}:${parsed.subcommand}`
      : `${message.author.id}:${parsed.commandName}`;
    const specialCooldown = COMMAND_COOLDOWNS[parsed.commandName];
    const cooldownTtl =
      specialCooldown && this.cooldowns.defaultTtlMs > 0
        ? Math.max(this.cooldowns.defaultTtlMs, specialCooldown)
        : this.cooldowns.defaultTtlMs;
    const cooldownResult = this.cooldowns.tryAcquire(cooldownKey, cooldownTtl);
    if (!cooldownResult.allowed) {
      const waitSec = Math.max(0.5, cooldownResult.remainingMs / 1000).toFixed(1);
      await this._safeReplyError(
        message,
        `Terlalu cepat! Tunggu ${waitSec} detik sebelum menjalankan \`${this.prefix}${parsed.commandName}\` lagi.`,
        permCheck.canEmbedLinks,
      );
      return;
    }

    if (parsed.error) {
      await this._safeReplyError(message, parsed.error, permCheck.canEmbedLinks);
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

    if (parsed.options?.userId) {
      const targetUser = await resolveUserFromMessage(message, parsed.options.userId);
      if (!targetUser) {
        await this._safeReplyError(
          message,
          'Pengguna target tidak ditemukan. Mention pengguna Discord yang valid.',
        );
        return;
      }
      resolvedUsers.set(parsed.options.userId, targetUser);
    }

    const isSecretChoice =
      (parsed.commandName === GAME_TYPES.RPS && parsed.subcommand === 'choose') ||
      (parsed.commandName === GAME_TYPES.COINFLIP && parsed.subcommand === 'choose');

    const adapter = new MessageCommandAdapter({
      message,
      parsed,
      resolvedUsers,
      isSecretChoice,
      canManageMessages: permCheck.canManageMessages,
      canEmbedLinks: permCheck.canEmbedLinks,
      canAttachFiles: permCheck.canAttachFiles,
    });

    try {
      const execContext =
        parsed.commandName === 'ping'
          ? { ...this.context, handlerStartTime }
          : this.context;
      await command.execute(adapter, execContext);
    } catch (err) {
      this.logger.error(
        `[PrefixCommandHandler] Error executing ${this.prefix}${parsed.commandName}:`,
        sanitizeError(err),
      );
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
