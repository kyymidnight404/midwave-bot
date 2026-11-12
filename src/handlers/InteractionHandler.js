import { MessageFlags } from 'discord.js';
import { buildErrorEmbed } from '../utils/embeds.js';

const IGNORED_DISCORD_ERROR_CODES = new Set([10062, 40060]);

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
    if (!interaction || !interaction.isChatInputCommand()) {
      return;
    }

    const command = this.commandHandler.get(interaction.commandName);
    if (!command) {
      await safeReplyError(interaction, `Command \`/${interaction.commandName}\` tidak ditemukan.`);
      return;
    }

    const subcommand = interaction.options?.getSubcommand?.(false) ?? '';
    const cooldownKey = subcommand
      ? `${interaction.user.id}:${interaction.commandName}:${subcommand}`
      : `${interaction.user.id}:${interaction.commandName}`;
    const cooldownResult = this.cooldowns.tryAcquire(cooldownKey);
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
