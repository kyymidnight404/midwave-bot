import { MessageFlags } from 'discord.js';
import { prisma as defaultPrisma } from '../services/prisma.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { getUserProfileStats } from '../games/services/leaderboardService.js';
import { buildProfileMessage } from '../games/utils/gameUi.js';

export default {
  name: 'profile',
  /**
   * Executes `!profile [@user]` to view Game Center statistics for a user in the current guild.
   * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
   * @param {object} [context]
   */
  async execute(interaction, context = {}) {
    const prisma = context.prisma ?? defaultPrisma;
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [buildErrorEmbed('Command `!profile` hanya dapat digunakan di dalam server.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser = interaction.options?.getUser?.('user', false) ?? interaction.user;
    const profile = await getUserProfileStats({
      prisma,
      guildId,
      userId: targetUser.id,
    });

    const payload = buildProfileMessage({
      targetUser,
      profile,
    });

    await interaction.reply(payload);
  },
};
