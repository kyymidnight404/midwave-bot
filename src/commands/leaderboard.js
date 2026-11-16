import { MessageFlags } from 'discord.js';
import { prisma as defaultPrisma } from '../services/prisma.js';
import { buildErrorEmbed, getLogoFiles } from '../utils/embeds.js';
import {
  getGuildLeaderboard,
  normalizeLeaderboardFilter,
} from '../games/services/leaderboardService.js';
import { buildLeaderboardMessage } from '../games/utils/gameUi.js';

export default {
  name: 'lb',
  /**
   * Executes `!lb [ttt|connect4|quiz|rps]` to view guild leaderboards.
   * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
   * @param {object} [context]
   */
  async execute(interaction, context = {}) {
    const prisma = context.prisma ?? defaultPrisma;
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [buildErrorEmbed('Command `!lb` hanya dapat digunakan di dalam server.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const rawFilter = interaction.options?.getString?.('game', false) ?? 'all';
    const gameType = normalizeLeaderboardFilter(rawFilter);
    if (!gameType) {
      await interaction.reply({
        embeds: [
          buildErrorEmbed(
            'Kategori leaderboard tidak valid. Gunakan `!lb`, `!lb ttt`, `!lb connect4`, `!lb quiz`, atau `!lb rps`.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const leaderboard = await getGuildLeaderboard({
      prisma,
      guildId,
      gameType,
      page: 1,
    });

    const canAttach = interaction.canAttachFiles !== false;
    const payload = buildLeaderboardMessage({
      requesterId: interaction.user.id,
      leaderboard,
      includeThumbnail: canAttach,
    });

    await interaction.reply({
      ...payload,
      files: canAttach ? getLogoFiles() : [],
    });
  },
};
