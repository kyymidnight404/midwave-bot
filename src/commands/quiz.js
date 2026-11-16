import { MessageFlags } from 'discord.js';
import { prisma as defaultPrisma } from '../services/prisma.js';
import { buildErrorEmbed, getLogoFiles } from '../utils/embeds.js';
import { createQuizLobbyState } from '../games/engines/quizBattle.js';
import { ensureQuizQuestionsSeeded } from '../games/services/questionService.js';
import { GAME_CENTER_TYPES } from '../games/services/scoreService.js';
import {
  createPersistedSession,
  findActiveUserSession,
  GAME_INACTIVITY_TTL_MS,
  updatePersistedSession,
  withSessionLock,
} from '../games/services/sessionService.js';
import { buildQuizLobbyMessage } from '../games/utils/gameUi.js';

export default {
  name: 'quiz',
  /**
   * Executes `!quiz [category] [difficulty]` to open a Quiz Battle lobby (2-10 players).
   * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
   * @param {object} [context]
   */
  async execute(interaction, context = {}) {
    const prisma = context.prisma ?? defaultPrisma;
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [buildErrorEmbed('Command `!quiz` hanya dapat digunakan di dalam server.')],
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    const hostUser = interaction.user;
    const category = interaction.options?.getString?.('category', false) ?? 'all';
    const difficulty = interaction.options?.getString?.('difficulty', false) ?? 'all';
    let lobbyState = null;

    const session = await withSessionLock(`create:${guildId}:${hostUser.id}`, async () => {
      const active = await findActiveUserSession(guildId, hostUser.id, prisma);
      if (active) {
        await interaction.reply({
          embeds: [buildErrorEmbed('Kamu masih memiliki sesi Game Center aktif atau menunggu di server ini.')],
          flags: MessageFlags.Ephemeral,
        });
        return null;
      }

      await ensureQuizQuestionsSeeded(prisma);
      lobbyState = createQuizLobbyState({
        hostId: hostUser.id,
        category,
        difficulty,
      });

      return createPersistedSession({
        prisma,
        guildId,
        channelId: interaction.channelId,
        gameType: GAME_CENTER_TYPES.QUIZ,
        status: 'pending',
        hostId: hostUser.id,
        state: lobbyState,
        participants: [
          { userId: hostUser.id, username: hostUser.username ?? null, role: 'host' },
        ],
        ttlMs: GAME_INACTIVITY_TTL_MS,
      });
    });

    if (!session) {
      return null;
    }

    const canAttach = interaction.canAttachFiles !== false;
    const payload = buildQuizLobbyMessage({
      sessionId: session.id,
      state: lobbyState,
      includeThumbnail: canAttach,
    });

    const sentMsg = await interaction.reply({
      ...payload,
      files: canAttach ? getLogoFiles() : [],
    });

    if (sentMsg?.id) {
      await updatePersistedSession(session.id, { messageId: sentMsg.id }, prisma);
    }

    return session;
  },
};
