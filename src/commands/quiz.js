import { MessageFlags } from 'discord.js';
import { prisma as defaultPrisma } from '../services/prisma.js';
import { buildErrorEmbed, getIconFiles } from '../utils/embeds.js';
import {
  DEFAULT_QUIZ_ROUND_MS,
  scheduleQuizRoundTimer,
} from '../events/gameInteraction.js';
import {
  createDirectQuizState,
  QUIZ_TOTAL_QUESTIONS,
} from '../games/engines/quizBattle.js';
import { ensureQuizQuestionsSeeded, getPreparedQuizQuestions } from '../games/services/questionService.js';
import { GAME_CENTER_TYPES } from '../games/services/scoreService.js';
import {
  createPersistedSession,
  findActiveChannelQuizSession,
  findActiveUserSession,
  GAME_INACTIVITY_TTL_MS,
  updatePersistedSession,
  withSessionLock,
} from '../games/services/sessionService.js';
import { buildQuizQuestionMessage } from '../games/utils/gameUi.js';

export default {
  name: 'quiz',
  /**
   * Executes `!quiz [category] [difficulty]` and starts Round 1 immediately.
   * Players answer by typing `a`, `b`, `c`, or `d` directly in chat.
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
    const roundDurationMs = context.quizRoundDurationMs ?? DEFAULT_QUIZ_ROUND_MS;
    let activeState = null;

    const session = await withSessionLock(`quiz:channel:${guildId}:${interaction.channelId}`, async () => {
      const existingChannelQuiz = await findActiveChannelQuizSession(interaction.channelId, prisma);
      if (existingChannelQuiz) {
        await interaction.reply({
          embeds: [
            buildErrorEmbed(
              'Masih ada sesi Quiz yang sedang berlangsung di channel ini. Ketik `a`, `b`, `c`, atau `d` di chat untuk ikut menjawab!',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return null;
      }

      const active = await findActiveUserSession(guildId, hostUser.id, prisma);
      if (active) {
        await interaction.reply({
          embeds: [buildErrorEmbed('Kamu masih memiliki sesi Game Center aktif atau menunggu di server ini.')],
          flags: MessageFlags.Ephemeral,
        });
        return null;
      }

      await ensureQuizQuestionsSeeded(prisma);
      const prepared = await getPreparedQuizQuestions({
        prisma,
        category,
        difficulty,
        count: QUIZ_TOTAL_QUESTIONS,
      });
      activeState = createDirectQuizState({
        hostId: hostUser.id,
        category,
        difficulty,
        preparedQuestions: prepared,
        nowMs: Date.now(),
        roundDurationMs,
      });

      return createPersistedSession({
        prisma,
        guildId,
        channelId: interaction.channelId,
        gameType: GAME_CENTER_TYPES.QUIZ,
        status: 'active',
        hostId: hostUser.id,
        state: activeState,
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
    const payload = buildQuizQuestionMessage({
      sessionId: session.id,
      state: activeState,
      includeThumbnail: canAttach,
    });

    const sentMsg = await interaction.reply({
      ...payload,
      files: canAttach ? getIconFiles('quiz') : [],
    });

    if (sentMsg?.id) {
      await updatePersistedSession(session.id, { messageId: sentMsg.id }, prisma);
    }

    scheduleQuizRoundTimer(session.id, activeState.round, {
      ...context,
      client: interaction.client ?? interaction.message?.client ?? context.client,
    });

    return session;
  },
};
