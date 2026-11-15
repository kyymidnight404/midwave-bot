import { MessageFlags } from 'discord.js';
import { DOWNLOAD_COOLDOWN_MS } from '../services/downloader.js';
import { AI_COOLDOWN_MS } from '../services/gemini.js';
import { LYRICS_COOLDOWN_MS } from '../services/lyricsService.js';
import { SOCIAL_COOLDOWN_MS } from '../services/otakuGifsService.js';
import {
  FEEDBACK_CUSTOM_ID_PREFIX,
  handleFeedbackInteraction,
} from '../services/feedbackService.js';
import { buildErrorEmbed } from '../utils/embeds.js';

const IGNORED_DISCORD_ERROR_CODES = new Set([10062, 40060]);
const COMMAND_COOLDOWNS = Object.freeze({
  ai: AI_COOLDOWN_MS,
  download: DOWNLOAD_COOLDOWN_MS,
  lyrics: LYRICS_COOLDOWN_MS,
  social: SOCIAL_COOLDOWN_MS,
});

const ACTION_COOLDOWN_COMMANDS = new Set(['game', 'media', 'social']);

/**
 * Safely sends an ephemeral error reply regardless of interaction acknowledgement state.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} message
 */
export async function safeReplyError(interaction, message) {
  const payload = {
    embeds: [buildErrorEmbed(message)],
    flags: MessageFlags.Ephemeral,
  };

  try {
    if (interaction.deferred) {
      await interaction.editReply({ embeds: payload.embeds });
    } else if (interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    if (!IGNORED_DISCORD_ERROR_CODES.has(err?.code)) {
      console.error('[InteractionHandler] Failed to send error response:', err);
    }
  }
}

/**
 * Central router and error boundary for Discord interactions.
 */
export class InteractionHandler {
  /**
   * @param {{
   *   commandHandler: import('./CommandHandler.js').CommandHandler,
   *   cooldowns: import('../utils/cooldown.js').CooldownManager,
   *   context?: object,
   *   logger?: Console,
   * }} deps
   */
  constructor({ commandHandler, cooldowns, context = {}, logger = console }) {
    this.commandHandler = commandHandler;
    this.cooldowns = cooldowns;
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
   * Handles a single Discord interaction safely.
   * @param {import('discord.js').Interaction} interaction
   */
  async handle(interaction) {
    if (!interaction) {
      return;
    }

    const isFeedbackComponent =
      typeof interaction.customId === 'string' &&
      interaction.customId.startsWith(`${FEEDBACK_CUSTOM_ID_PREFIX}:`) &&
      (interaction.isButton?.() ||
        interaction.isStringSelectMenu?.() ||
        interaction.isModalSubmit?.());

    if (isFeedbackComponent) {
      await handleFeedbackInteraction(interaction, {
        ...this.context,
        cooldowns: this.cooldowns,
        logger: this.logger,
      });
      return;
    }

    const isSlash = typeof interaction?.isChatInputCommand === 'function' && interaction.isChatInputCommand();
    const isContextMenu =
      typeof interaction?.isMessageContextMenuCommand === 'function' &&
      interaction.isMessageContextMenuCommand();
    if (!isSlash && !isContextMenu) {
      return;
    }

    const command = this.commandHandler.get(interaction.commandName);
    if (!command) {
      await safeReplyError(interaction, `Command \`${isSlash ? '/' : ''}${interaction.commandName}\` tidak ditemukan.`);
      return;
    }

    const subcommand = interaction.options?.getSubcommand?.(false) ?? '';
    const subcommandGroup = interaction.options?.getSubcommandGroup?.(false) ?? '';
    const actionOption =
      !subcommand && (ACTION_COOLDOWN_COMMANDS.has(interaction.commandName) || command.config?.type === 'choice')
        ? (interaction.options?.getString?.(command.config?.actionOptionName || 'action', false)?.trim().toLowerCase() ?? '')
        : '';
    const actionPart = [subcommandGroup, subcommand || actionOption].filter(Boolean).join(':');
    const cooldownKey = actionPart
      ? `${interaction.user.id}:${interaction.commandName}:${actionPart}`
      : `${interaction.user.id}:${interaction.commandName}`;

    const matchedSubcommand = subcommand
      ? (subcommandGroup
          ? command.config?.groups?.find((g) => g.name === subcommandGroup)?.subcommands?.find((s) => s.name === subcommand)
          : command.config?.subcommands?.find((s) => s.name === subcommand))
      : null;
    const mappedActionHandler =
      matchedSubcommand?.handler ??
      command.config?.actionHandlers?.[actionOption] ??
      command.config?.handler ??
      '';
    const normalizedHandlerBase = mappedActionHandler.includes('.')
      ? mappedActionHandler.split('.').pop()
      : mappedActionHandler;
    const cooldownTarget =
      (interaction.commandName === 'media' && (subcommand || actionOption)) ||
      (normalizedHandlerBase && Object.hasOwn(COMMAND_COOLDOWNS, normalizedHandlerBase)
        ? normalizedHandlerBase
        : interaction.commandName);
    const specialCooldown = COMMAND_COOLDOWNS[cooldownTarget];
    const cooldownTtl =
      specialCooldown && this.cooldowns.defaultTtlMs > 0
        ? Math.max(this.cooldowns.defaultTtlMs, specialCooldown)
        : this.cooldowns.defaultTtlMs;
    const cooldownResult = this.cooldowns.tryAcquire(cooldownKey, cooldownTtl);
    if (!cooldownResult.allowed) {
      const waitSec = Math.max(0.5, cooldownResult.remainingMs / 1000).toFixed(1);
      await safeReplyError(
        interaction,
        `Terlalu cepat! Tunggu ${waitSec} detik sebelum menjalankan \`/${interaction.commandName}\` lagi.`,
      );
      return;
    }

    try {
      await command.execute(interaction, this.context);
    } catch (err) {
      if (IGNORED_DISCORD_ERROR_CODES.has(err?.code)) {
        this.logger.warn?.(`[InteractionHandler] Ignored Discord interaction timing error (${err.code}) on /${interaction.commandName}`);
        return;
      }
      this.logger.error(`[InteractionHandler] Error executing /${interaction.commandName}:`, err);
      await safeReplyError(
        interaction,
        'Terjadi gangguan saat memproses perintah ini. Silakan coba lagi.',
      );
    }
  }
}
