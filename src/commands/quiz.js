import { MessageFlags } from 'discord.js';
import { prisma as defaultPrisma } from '../services/prisma.js';
import { buildErrorEmbed, getIconFiles } from '../utils/embeds.js';
import {
  createGlobalQuizLobbyState,
  QUIZ_TOTAL_QUESTIONS,
} from '../games/engines/quizBattle.js';
import { ensureQuizQuestionsSeeded, getPreparedQuizQuestions } from '../games/services/questionService.js';
import { GAME_CENTER_TYPES } from '../games/services/scoreService.js';
import {
  CHALLENGE_TTL_MS,
  createPersistedSession,
  findActiveChannelQuizSession,
  findActiveUserSession,
  setSessionTimer,
  updatePersistedSession,
  withSessionLock,
} from '../games/services/sessionService.js';
import { buildGlobalQuizLobbyMessage } from '../games/utils/gameUi.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

export default {
  name: 'quiz',
  /**
   * Executes `!quiz [category] [difficulty]` and opens the Global Channel Quiz Lobby.
   * Only the session creator can start the quiz via the Start Quiz button.
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
    const lobbyTtlMs = context.quizLobbyTtlMs ?? context.lobbyTtlMs ?? CHALLENGE_TTL_MS;
    let lobbyState = null;

    const session = await withSessionLock(`quiz:channel:${guildId}:${interaction.channelId}`, async () => {
      const existingChannelQuiz = await findActiveChannelQuizSession(
        interaction.channelId,
        prisma,
        { includePending: true },
      );
      if (existingChannelQuiz) {
        await interaction.reply({
          embeds: [
            buildErrorEmbed(
              existingChannelQuiz.status === 'pending'
                ? 'Sudah ada Quiz Lobby yang terbuka di channel ini. Tunggu pembuat sesi menekan **Start Quiz**.'
                : 'Masih ada sesi Quiz yang sedang berlangsung di channel ini. Ketik `a`, `b`, `c`, atau `d` di chat untuk ikut menjawab!',
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
      lobbyState = createGlobalQuizLobbyState({
        hostId: hostUser.id,
        category,
        difficulty,
        preparedQuestions: prepared,
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
        ttlMs: lobbyTtlMs,
      });
    });

    if (!session) {
      return null;
    }

    const canAttach = interaction.canAttachFiles !== false;
    const iconFiles = canAttach ? getIconFiles('quiz') : [];
    const hasIcon = iconFiles.length > 0;
    const payload = buildGlobalQuizLobbyMessage({
      sessionId: session.id,
      includeThumbnail: hasIcon,
    });

    let sentMsg;
    try {
      sentMsg = await interaction.reply({
        ...payload,
        files: iconFiles,
      });
    } catch (replyErr) {
      if (iconFiles.length === 0) {
        throw replyErr;
      }
      sentMsg = await interaction.reply(
        buildGlobalQuizLobbyMessage({
          sessionId: session.id,
          includeThumbnail: false,
        }),
      );
    }

    if (sentMsg?.id) {
      await updatePersistedSession(session.id, { messageId: sentMsg.id }, prisma);
    }

    const client = interaction.client ?? interaction.message?.client ?? context.client;
    if (lobbyTtlMs > 0) {
      setSessionTimer(
        session.id,
        'lobby_expire',
        async () => {
          await withSessionLock(session.id, async () => {
            try {
              const latest = await prisma.gameSession.findUnique({ where: { id: session.id } });
              if (!latest || latest.status !== 'pending') return;
              await updatePersistedSession(session.id, { status: 'expired', ttlMs: null }, prisma);
              if (typeof sentMsg?.edit === 'function') {
                await sentMsg.edit(
                  buildGlobalQuizLobbyMessage({
                    sessionId: session.id,
                    disabled: true,
                    statusOverride: 'expired',
                    includeThumbnail: hasIcon,
                  }),
                ).catch(() => {});
              } else if (client?.channels?.fetch && latest.channelId && latest.messageId) {
                const ch = await client.channels.fetch(latest.channelId).catch(() => null);
                const msg = await ch?.messages?.fetch?.(latest.messageId).catch(() => null);
                if (msg) {
                  await msg.edit(
                    buildGlobalQuizLobbyMessage({
                      sessionId: session.id,
                      disabled: true,
                      statusOverride: 'expired',
                      includeThumbnail: hasIcon,
                    }),
                  ).catch(() => {});
                }
              }
            } catch (err) {
              context.logger?.warn?.('[QuizLobby] Expire cleanup error:', sanitizeError(err));
            }
          });
        },
        lobbyTtlMs,
      );
    }

    return session;
  },
};
