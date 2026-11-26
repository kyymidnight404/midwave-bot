import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  AFK_COOLDOWN_MS,
  AFK_MAX_REASON_LENGTH,
  SAFE_AFK_MENTION_OPTIONS,
  buildAfkEnabledMessage,
  setAfkStatus,
} from '../services/afkService.js';
import { prisma as defaultPrisma } from '../services/prisma.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

export const data = new SlashCommandBuilder()
  .setName('afk')
  .setDescription('Atur status AFK kamu beserta alasannya')
  .addStringOption((option) =>
    option
      .setName('alasan')
      .setDescription(`Alasan AFK (opsional, maksimal ${AFK_MAX_REASON_LENGTH} karakter)`)
      .setRequired(false)
      .setMaxLength(AFK_MAX_REASON_LENGTH),
  );

/**
 * Executes `/afk` and `!afk` through the shared AFK service with plain-text responses.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
 * @param {{ prisma?: import('@prisma/client').PrismaClient, logger?: Console, now?: () => Date }} [context]
 */
export async function execute(interaction, context = {}) {
  if (interaction?.user?.bot) {
    return;
  }

  const userId = interaction?.user?.id;
  if (!userId) {
    return;
  }

  const rawReason = interaction.options?.getString?.('alasan', false) ?? '';
  const prisma = context?.prisma ?? defaultPrisma;
  const logger = context?.logger ?? console;

  try {
    const record = await setAfkStatus({
      userId,
      reason: rawReason,
      prisma,
      now: context?.now,
    });

    await interaction.reply({
      content: buildAfkEnabledMessage(record),
      allowedMentions: {
        parse: [...SAFE_AFK_MENTION_OPTIONS.parse],
        repliedUser: SAFE_AFK_MENTION_OPTIONS.repliedUser,
      },
    });
  } catch (error) {
    logger?.error?.('[AFK] Failed saving AFK status:', sanitizeError(error));
    try {
      await interaction.reply({
        content: 'Gagal menyimpan status AFK saat ini. Silakan coba lagi.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: {
          parse: [...SAFE_AFK_MENTION_OPTIONS.parse],
          repliedUser: SAFE_AFK_MENTION_OPTIONS.repliedUser,
        },
      });
    } catch {
      // Ignore secondary delivery failure
    }
  }
}

export { AFK_COOLDOWN_MS };
export default { data, execute, AFK_COOLDOWN_MS };
