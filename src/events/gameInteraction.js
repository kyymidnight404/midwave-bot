import { MessageFlags } from 'discord.js';
import { getEmoji } from '../config/emojis.js';
import { prisma as defaultPrisma } from '../services/prisma.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';
import {
  advanceQuizRound,
  joinQuizLobby,
  leaveQuizLobby,
  QUIZ_ROUND_SECONDS,
  QUIZ_TOTAL_QUESTIONS,
  resolveQuizRound,
  startGlobalQuizState,
  startQuizBattle,
  submitQuizAnswer,
} from '../games/engines/quizBattle.js';
import { applyRpsPick } from '../games/engines/rockPaperScissors.js';
import { applyTicTacToeMove } from '../games/engines/ticTacToe.js';
import { getPreparedQuizQuestions } from '../games/services/questionService.js';
import {
  addSessionParticipant,
  clearSessionTimers,
  findActiveChannelQuizSession,
  GAME_INACTIVITY_TTL_MS,
  getPersistedSession,
  hydrateSession,
  removeSessionParticipant,
  setSessionTimer,
  updatePersistedSession,
  withSessionLock,
} from '../games/services/sessionService.js';
import { GAME_CENTER_PREFIX, parseGameCustomId } from '../games/utils/customId.js';
import {
  buildChallengeMessage,
  buildGlobalQuizLobbyMessage,
  buildQuizCancelledMessage,
  buildQuizFinalMessage,
  buildQuizLobbyMessage,
  buildQuizQuestionMessage,
  buildQuizRoundResultMessage,
  buildRpsMessage,
  buildTicTacToeMessage,
} from '../games/utils/gameUi.js';

export const GAME_CENTER_CUSTOM_ID_PREFIX = GAME_CENTER_PREFIX;
export const DEFAULT_QUIZ_ROUND_MS = QUIZ_ROUND_SECONDS * 1000;
export const DEFAULT_QUIZ_INTERMISSION_MS = 3500;

const QUIZ_LETTER_MAP = Object.freeze({ a: 0, b: 1, c: 2, d: 3 });
const MAX_PROCESSED_QUIZ_MESSAGES = 500;
const processedQuizMessageIds = new Set();

function recordProcessedQuizMessage(messageId) {
  if (!messageId) return true;
  if (processedQuizMessageIds.has(messageId)) return false;
  if (processedQuizMessageIds.size >= MAX_PROCESSED_QUIZ_MESSAGES) {
    const oldest = processedQuizMessageIds.values().next().value;
    if (oldest !== undefined) {
      processedQuizMessageIds.delete(oldest);
    }
  }
  processedQuizMessageIds.add(messageId);
  return true;
}

/**
 * Parses a standalone chat message (`a`, `b`, `c`, or `d`, case-insensitive) into a quiz option index `0..3`.
 * Returns `null` for any other message so regular conversation is untouched.
 * @param {string} content
 * @returns {number | null}
 */
export function parseDirectQuizAnswerOption(content) {
  if (typeof content !== 'string') {
    return null;
  }
  const normalized = content.trim().toLowerCase();
  return Object.hasOwn(QUIZ_LETTER_MAP, normalized) ? QUIZ_LETTER_MAP[normalized] : null;
}

/**
 * Registers the round timeout timer for an active Quiz Battle round.
 * @param {string} sessionId
 * @param {number} roundNumber
 * @param {object} [context]
 */
export function scheduleQuizRoundTimer(sessionId, roundNumber, context = {}) {
  const roundDurationMs = context.quizRoundDurationMs ?? DEFAULT_QUIZ_ROUND_MS;
  const logger = context.logger ?? console;
  setSessionTimer(
    sessionId,
    'round',
    () => {
      resolveAndScheduleQuizRound(sessionId, roundNumber, context).catch((err) =>
        logger.error('[QuizBattle] Round timeout error:', sanitizeError(err)),
      );
    },
    roundDurationMs,
  );
}

const IGNORED_DISCORD_CODES = new Set([10008, 10062, 40060, 50001, 50013]);
const INACCESSIBLE_DISCORD_CODES = new Set([10008, 50001, 50013]);

async function replyEphemeral(interaction, message) {
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
    if (!IGNORED_DISCORD_CODES.has(err?.code)) {
      console.error('[GameCenter] Failed ephemeral reply:', sanitizeError(err));
    }
  }
}

function collectAvailableAttachmentNames(existingMsg, payloadFiles) {
  const names = new Set();
  const existingAtts = existingMsg?.attachments;
  if (existingAtts) {
    const iterable =
      typeof existingAtts.values === 'function' ? existingAtts.values() : Array.isArray(existingAtts) ? existingAtts : [];
    for (const att of iterable) {
      if (typeof att?.name === 'string' && att.name) {
        names.add(att.name);
      }
    }
  }
  if (Array.isArray(payloadFiles)) {
    for (const file of payloadFiles) {
      if (typeof file?.name === 'string' && file.name) {
        names.add(file.name);
      }
    }
  }
  return names;
}

function stripBrokenAttachmentUrls(embeds, existingMsg, payloadFiles) {
  const hasExplicitAttachmentState = existingMsg?.attachments != null || Array.isArray(payloadFiles);
  if (!hasExplicitAttachmentState || !Array.isArray(embeds)) {
    return embeds;
  }
  const available = collectAvailableAttachmentNames(existingMsg, payloadFiles);
  return embeds.map((e) => {
    const thumbUrl = e?.data?.thumbnail?.url;
    if (typeof e?.setThumbnail === 'function' && typeof thumbUrl === 'string' && thumbUrl.startsWith('attachment://')) {
      const fileName = thumbUrl.slice('attachment://'.length);
      if (!available.has(fileName)) {
        e.setThumbnail(null);
      }
    }
    const imageUrl = e?.data?.image?.url;
    if (typeof e?.setImage === 'function' && typeof imageUrl === 'string' && imageUrl.startsWith('attachment://')) {
      const fileName = imageUrl.slice('attachment://'.length);
      if (!available.has(fileName)) {
        e.setImage(null);
      }
    }
    return e;
  });
}

export async function safeUpdateMessage(messageOrInteraction, payload, isInteractionUpdate = false) {
  const existingMsg = isInteractionUpdate ? messageOrInteraction?.message : messageOrInteraction;
  let finalPayload = payload;
  if (Array.isArray(payload?.embeds)) {
    finalPayload = {
      ...payload,
      embeds: stripBrokenAttachmentUrls(payload.embeds, existingMsg, payload.files),
    };
  }

  try {
    if (isInteractionUpdate && typeof messageOrInteraction.update === 'function') {
      return await messageOrInteraction.update(finalPayload);
    }
    if (typeof messageOrInteraction.edit === 'function') {
      return await messageOrInteraction.edit(finalPayload);
    }
    return null;
  } catch (err) {
    if (INACCESSIBLE_DISCORD_CODES.has(err?.code)) {
      return { inaccessible: true };
    }
    if (!IGNORED_DISCORD_CODES.has(err?.code)) {
      throw err;
    }
    return null;
  }
}

async function resolveTargetMessage(session, interactionOrClient) {
  if (interactionOrClient?.message && interactionOrClient.message.id === session.messageId) {
    return interactionOrClient.message;
  }
  const client = interactionOrClient?.client ?? interactionOrClient;
  if (!client?.channels?.fetch || !session.channelId || !session.messageId) {
    return null;
  }
  try {
    const channel = await client.channels.fetch(session.channelId);
    if (!channel?.messages?.fetch) return null;
    return await channel.messages.fetch(session.messageId);
  } catch {
    return null;
  }
}

function buildUsernameMap(participants) {
  const map = {};
  for (const p of participants ?? []) {
    if (p.username) {
      map[p.userId] = p.username;
    }
  }
  return map;
}

function renderActiveBoard(session, status = session.status, forfeitedById = null) {
  if (session.gameType === 'ttt') {
    return buildTicTacToeMessage({
      sessionId: session.id,
      state: session.state,
      status,
      forfeitedById,
      includeThumbnail: true,
    });
  }
  if (session.gameType === 'rps') {
    return buildRpsMessage({
      sessionId: session.id,
      state: session.state,
      status,
      forfeitedById,
      includeThumbnail: true,
    });
  }
  return null;
}

async function handleMissingOrExpiredSession(interaction, session, prisma) {
  if (!session || (interaction.guildId && session.guildId !== interaction.guildId)) {
    await replyEphemeral(interaction, 'Sesi permainan ini tidak ditemukan atau sudah kedaluwarsa.');
    return true;
  }

  const isExpired =
    session.expiresAt &&
    new Date(session.expiresAt).getTime() < Date.now() &&
    (session.status === 'pending' || session.status === 'active');

  if (isExpired) {
    clearSessionTimers(session.id);
    const updated = await updatePersistedSession(
      session.id,
      { status: 'expired', ttlMs: null },
      prisma,
    );
    if (session.status === 'pending' && session.gameType !== 'quiz') {
      const opp = session.participants.find((p) => p.userId !== session.hostId);
      await safeUpdateMessage(
        interaction,
        buildChallengeMessage({
          sessionId: session.id,
          gameType: session.gameType,
          hostId: session.hostId,
          opponentId: opp?.userId ?? session.hostId,
          disabled: true,
          statusText: `${getEmoji('timer')} Tantangan telah kedaluwarsa.`,
        }),
        true,
      );
    } else if (session.gameType === 'quiz') {
      await safeUpdateMessage(
        interaction,
        session.state?.isGlobalChannelLobby
          ? buildGlobalQuizLobbyMessage({
              sessionId: session.id,
              disabled: true,
              statusOverride: 'expired',
            })
          : buildQuizLobbyMessage({
              sessionId: session.id,
              state: updated.state,
              disabled: true,
              cancelledText: `${getEmoji('timer')} Lobby Quiz Battle kedaluwarsa.`,
            }),
        true,
      );
    } else {
      const boardPayload = renderActiveBoard(updated, 'expired');
      if (boardPayload) {
        await safeUpdateMessage(interaction, boardPayload, true);
      }
    }
    return true;
  }

  if (session.status !== 'pending' && session.status !== 'active') {
    await replyEphemeral(interaction, 'Sesi permainan ini sudah selesai atau dibatalkan.');
    return true;
  }

  return false;
}

async function handleChallengeInteraction(interaction, parsed, context) {
  const prisma = context.prisma ?? defaultPrisma;
  const sessionId = parsed.targetId;

  await withSessionLock(sessionId, async () => {
    const session = await getPersistedSession(sessionId, prisma);
    if (await handleMissingOrExpiredSession(interaction, session, prisma)) {
      return;
    }
    if (session.status !== 'pending') {
      await replyEphemeral(interaction, 'Tantangan ini sudah diproses.');
      return;
    }

    const opponent = session.participants.find((p) => p.userId !== session.hostId);
    const userId = interaction.user?.id;
    if (!opponent || userId !== opponent.userId) {
      await replyEphemeral(interaction, 'Hanya pemain yang ditantang yang dapat merespons tantangan ini.');
      return;
    }

    if (parsed.action === 'decline') {
      await updatePersistedSession(sessionId, { status: 'cancelled', ttlMs: null }, prisma);
      await safeUpdateMessage(
        interaction,
        buildChallengeMessage({
          sessionId,
          gameType: session.gameType,
          hostId: session.hostId,
          opponentId: opponent.userId,
          disabled: true,
          statusText: `${getEmoji('error')} <@${opponent.userId}> menolak tantangan ini.`,
        }),
        true,
      );
      return;
    }

    if (parsed.action === 'accept') {
      const updated = await updatePersistedSession(
        sessionId,
        {
          status: 'active',
          currentTurnId: session.state?.currentTurnId ?? null,
          ttlMs: GAME_INACTIVITY_TTL_MS,
        },
        prisma,
      );
      const boardPayload = renderActiveBoard(updated, 'active');
      const res = await safeUpdateMessage(interaction, boardPayload, true);
      if (res?.inaccessible) {
        await updatePersistedSession(sessionId, { status: 'cancelled', ttlMs: null }, prisma);
      }
    }
  });
}

async function handleBoardOrRpsInteraction(interaction, parsed, context) {
  const prisma = context.prisma ?? defaultPrisma;
  const sessionId = parsed.targetId;
  const userId = interaction.user?.id;

  await withSessionLock(sessionId, async () => {
    const session = await getPersistedSession(sessionId, prisma);
    if (await handleMissingOrExpiredSession(interaction, session, prisma)) {
      return;
    }
    if (session.status !== 'active') {
      await replyEphemeral(interaction, 'Pertandingan belum dimulai atau sudah berakhir.');
      return;
    }

    const isParticipant = session.participants.some((p) => p.userId === userId);
    if (!isParticipant) {
      await replyEphemeral(interaction, 'Kamu tidak terdaftar dalam pertandingan ini.');
      return;
    }

    let nextState = session.state;
    let finished = false;
    let winnerId = null;
    let isDraw = false;
    let forfeitedById = null;
    let roundCompleted = true;

    if (parsed.action === 'forfeit') {
      const other = session.participants.find((p) => p.userId !== userId);
      winnerId = other?.userId ?? null;
      finished = true;
      forfeitedById = userId;
      nextState = {
        ...session.state,
        winnerId,
        isDraw: false,
      };
    } else if (parsed.scope === 'ttt' && parsed.action === 'move') {
      const cellIndex = Number(parsed.args[0]);
      const moveRes = applyTicTacToeMove(session.state, userId, cellIndex);
      if (!moveRes.ok) {
        await replyEphemeral(interaction, moveRes.error);
        return;
      }
      nextState = moveRes.state;
      finished = moveRes.finished;
      winnerId = moveRes.winnerId;
      isDraw = moveRes.isDraw;
    } else if (parsed.scope === 'rps' && parsed.action === 'pick') {
      const choice = parsed.args[0];
      const pickRes = applyRpsPick(session.state, userId, choice);
      if (!pickRes.ok) {
        await replyEphemeral(interaction, pickRes.error);
        return;
      }
      nextState = pickRes.state;
      finished = pickRes.finished;
      winnerId = pickRes.winnerId;
      isDraw = pickRes.isDraw;
      roundCompleted = pickRes.roundCompleted;
    } else {
      await replyEphemeral(interaction, 'Aksi permainan tidak dikenali.');
      return;
    }

    let updated;
    if (finished) {
      updated = await updatePersistedSession(
        sessionId,
        {
          status: 'finished',
          currentTurnId: null,
          winnerId,
          isDraw,
          state: nextState,
          ttlMs: null,
          finishedAt: new Date(),
        },
        prisma,
      );
    } else {
      updated = await updatePersistedSession(
        sessionId,
        {
          status: 'active',
          currentTurnId: nextState.currentTurnId ?? null,
          winnerId: null,
          isDraw: false,
          state: nextState,
          ttlMs: GAME_INACTIVITY_TTL_MS,
          finishedAt: null,
        },
        prisma,
      );
    }

    const payload = renderActiveBoard(updated, updated.status, forfeitedById);
    if (parsed.scope === 'rps' && parsed.action === 'pick' && !roundCompleted) {
      const targetMsg = await resolveTargetMessage(updated, interaction);
      if (targetMsg) {
        const res = await safeUpdateMessage(targetMsg, payload, false);
        if (!finished && res?.inaccessible) {
          await updatePersistedSession(sessionId, { status: 'cancelled', ttlMs: null }, prisma);
        }
      }
      const choiceLabels = { rock: '🪨 Rock', paper: '📄 Paper', scissors: '✂️ Scissors' };
      await interaction.reply({
        content: `Pilihanmu (**${choiceLabels[parsed.args[0]]}**) telah dicatat secara rahasia! Menunggu lawan memilih.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const res = await safeUpdateMessage(interaction, payload, true);
    if (!finished && res?.inaccessible) {
      await updatePersistedSession(sessionId, { status: 'cancelled', ttlMs: null }, prisma);
    }
  });
}

/**
 * Resolves a Quiz Battle round on timeout or after all players answer, then schedules intermission.
 */
export async function resolveAndScheduleQuizRound(sessionId, expectedRound, context = {}) {
  const prisma = context.prisma ?? defaultPrisma;
  const roundDurationMs = context.quizRoundDurationMs ?? DEFAULT_QUIZ_ROUND_MS;
  const intermissionMs = context.quizIntermissionMs ?? DEFAULT_QUIZ_INTERMISSION_MS;
  const logger = context.logger ?? console;

  let shouldScheduleNext = false;
  let updatedSession = null;

  await withSessionLock(sessionId, async () => {
    const session = await getPersistedSession(sessionId, prisma);
    if (!session || session.status !== 'active' || session.state?.round !== expectedRound) {
      return;
    }
    const resolved = resolveQuizRound(session.state);
    if (resolved.alreadyResolved) {
      return;
    }

    updatedSession = await updatePersistedSession(
      sessionId,
      { state: resolved.state, ttlMs: GAME_INACTIVITY_TTL_MS },
      prisma,
    );
    shouldScheduleNext = true;

    const targetMsg = await resolveTargetMessage(updatedSession, context.client);
    if (!targetMsg && context.client) {
      clearSessionTimers(sessionId);
      await updatePersistedSession(sessionId, { status: 'cancelled', ttlMs: null }, prisma);
      shouldScheduleNext = false;
      return;
    }
    if (targetMsg) {
      const res = await safeUpdateMessage(
        targetMsg,
        buildQuizRoundResultMessage({
          sessionId,
          state: updatedSession.state,
          summary: resolved.summary,
        }),
        false,
      );
      if (res?.inaccessible) {
        clearSessionTimers(sessionId);
        await updatePersistedSession(sessionId, { status: 'cancelled', ttlMs: null }, prisma);
        shouldScheduleNext = false;
      }
    }
  });

  if (shouldScheduleNext) {
    setSessionTimer(
      sessionId,
      'intermission',
      () => {
        advanceQuizStep(sessionId, expectedRound, {
          ...context,
          quizRoundDurationMs: roundDurationMs,
          quizIntermissionMs: intermissionMs,
        }).catch((err) => logger.error('[QuizBattle] Failed advancing round:', sanitizeError(err)));
      },
      intermissionMs,
    );
  }
}

/**
 * Advances to the next Quiz question or finalizes the match and records stats.
 */
export async function advanceQuizStep(sessionId, expectedRound, context = {}) {
  const prisma = context.prisma ?? defaultPrisma;
  const roundDurationMs = context.quizRoundDurationMs ?? DEFAULT_QUIZ_ROUND_MS;
  const logger = context.logger ?? console;

  let nextRoundToSchedule = null;

  await withSessionLock(sessionId, async () => {
    const session = await getPersistedSession(sessionId, prisma);
    if (!session || session.status !== 'active' || session.state?.round !== expectedRound) {
      return;
    }

    const adv = advanceQuizRound(session.state, Date.now(), roundDurationMs);
    if (!adv.ok) {
      return;
    }

    if (adv.finished) {
      clearSessionTimers(sessionId);
      const finalized = await updatePersistedSession(
        sessionId,
        {
          status: 'finished',
          currentTurnId: null,
          winnerId: adv.winnerId,
          isDraw: adv.isDraw,
          state: adv.state,
          ttlMs: null,
          finishedAt: new Date(),
        },
        prisma,
      );

      const targetMsg = await resolveTargetMessage(finalized, context.client);
      if (targetMsg) {
        await safeUpdateMessage(
          targetMsg,
          buildQuizFinalMessage({ state: adv.state, standings: adv.standings }),
          false,
        );
      }
      return;
    }

    const updated = await updatePersistedSession(
      sessionId,
      {
        status: 'active',
        winnerId: null,
        isDraw: false,
        state: adv.state,
        ttlMs: GAME_INACTIVITY_TTL_MS,
        finishedAt: null,
      },
      prisma,
    );

    nextRoundToSchedule = adv.state.round;
    const targetMsg = await resolveTargetMessage(updated, context.client);
    if (!targetMsg && context.client) {
      clearSessionTimers(sessionId);
      await updatePersistedSession(sessionId, { status: 'cancelled', ttlMs: null }, prisma);
      nextRoundToSchedule = null;
      return;
    }
    if (targetMsg) {
      const res = await safeUpdateMessage(
        targetMsg,
        buildQuizQuestionMessage({ sessionId, state: updated.state }),
        false,
      );
      if (res?.inaccessible) {
        clearSessionTimers(sessionId);
        await updatePersistedSession(sessionId, { status: 'cancelled', ttlMs: null }, prisma);
        nextRoundToSchedule = null;
      }
    }
  });

  if (nextRoundToSchedule !== null) {
    scheduleQuizRoundTimer(sessionId, nextRoundToSchedule, context);
  }
}

async function handleQuizInteraction(interaction, parsed, context) {
  const prisma = context.prisma ?? defaultPrisma;
  const sessionId = parsed.targetId;
  const userId = interaction.user?.id;
  const roundDurationMs = context.quizRoundDurationMs ?? DEFAULT_QUIZ_ROUND_MS;
  const logger = context.logger ?? console;

  let roundToSchedule = null;
  let roundToResolveImmediately = null;

  await withSessionLock(sessionId, async () => {
    const session = await getPersistedSession(sessionId, prisma);
    if (await handleMissingOrExpiredSession(interaction, session, prisma)) {
      return;
    }

    if (parsed.action === 'join') {
      const res = joinQuizLobby(session.state, userId);
      if (!res.ok) {
        await replyEphemeral(interaction, res.error);
        return;
      }
      await addSessionParticipant(
        sessionId,
        { userId, username: interaction.user?.username ?? null, role: 'player' },
        prisma,
      );
      const updated = await updatePersistedSession(
        sessionId,
        { state: res.state, ttlMs: GAME_INACTIVITY_TTL_MS },
        prisma,
      );
      await safeUpdateMessage(
        interaction,
        buildQuizLobbyMessage({ sessionId, state: updated.state }),
        true,
      );
      return;
    }

    if (parsed.action === 'leave') {
      const res = leaveQuizLobby(session.state, userId);
      if (!res.ok) {
        await replyEphemeral(interaction, res.error);
        return;
      }
      await removeSessionParticipant(sessionId, userId, prisma);
      const updated = await updatePersistedSession(
        sessionId,
        {
          hostId: res.state.hostId,
          status: res.cancelled ? 'cancelled' : 'pending',
          state: res.state,
          ttlMs: res.cancelled ? null : GAME_INACTIVITY_TTL_MS,
        },
        prisma,
      );
      await safeUpdateMessage(
        interaction,
        buildQuizLobbyMessage({
          sessionId,
          state: updated.state,
          disabled: res.cancelled,
          cancelledText: res.cancelled ? `${getEmoji('error')} Lobby dibatalkan karena semua pemain keluar.` : null,
        }),
        true,
      );
      return;
    }

    if (parsed.action === 'cancel') {
      if (userId !== session.state.hostId) {
        await replyEphemeral(interaction, 'Hanya Host yang dapat menghentikan Quiz Battle.');
        return;
      }
      const wasActive = session.status === 'active';
      clearSessionTimers(sessionId);
      const updated = await updatePersistedSession(
        sessionId,
        { status: 'cancelled', ttlMs: null },
        prisma,
      );
      await safeUpdateMessage(
        interaction,
        wasActive
          ? buildQuizCancelledMessage({ state: updated.state, cancelledById: userId })
          : buildQuizLobbyMessage({
              sessionId,
              state: updated.state,
              disabled: true,
              cancelledText: `${getEmoji('error')} Quiz Battle dibatalkan oleh Host (<@${userId}>).`,
            }),
        true,
      );
      return;
    }

    if (parsed.action === 'start_global') {
      if (session.status !== 'pending') {
        await replyEphemeral(interaction, 'Quiz ini sudah dimulai.');
        return;
      }

      const startRes = startGlobalQuizState(session.state, userId, Date.now(), roundDurationMs);
      if (!startRes.ok) {
        await replyEphemeral(interaction, startRes.error);
        return;
      }

      clearSessionTimers(sessionId);
      const updated = await updatePersistedSession(
        sessionId,
        { status: 'active', state: startRes.state, ttlMs: GAME_INACTIVITY_TTL_MS },
        prisma,
      );
      roundToSchedule = updated.state.round;

      const msgRes = await safeUpdateMessage(
        interaction,
        buildQuizQuestionMessage({ sessionId, state: updated.state }),
        true,
      );
      if (msgRes?.inaccessible) {
        clearSessionTimers(sessionId);
        await updatePersistedSession(sessionId, { status: 'cancelled', ttlMs: null }, prisma);
        roundToSchedule = null;
      }
      return;
    }

    if (parsed.action === 'start') {
      if (session.status !== 'pending') {
        await replyEphemeral(interaction, 'Quiz Battle ini sudah dimulai.');
        return;
      }
      const prepared = await getPreparedQuizQuestions({
        prisma,
        category: session.state.category,
        difficulty: session.state.difficulty,
        count: QUIZ_TOTAL_QUESTIONS,
      });
      const startRes = startQuizBattle(session.state, userId, prepared, Date.now(), roundDurationMs);
      if (!startRes.ok) {
        await replyEphemeral(interaction, startRes.error);
        return;
      }

      const updated = await updatePersistedSession(
        sessionId,
        { status: 'active', state: startRes.state, ttlMs: GAME_INACTIVITY_TTL_MS },
        prisma,
      );
      roundToSchedule = updated.state.round;

      const msgRes = await safeUpdateMessage(
        interaction,
        buildQuizQuestionMessage({ sessionId, state: updated.state }),
        true,
      );
      if (msgRes?.inaccessible) {
        clearSessionTimers(sessionId);
        await updatePersistedSession(sessionId, { status: 'cancelled', ttlMs: null }, prisma);
        roundToSchedule = null;
      }
      return;
    }

    if (parsed.action === 'ans') {
      if (session.status !== 'active') {
        await replyEphemeral(interaction, 'Quiz Battle ini belum dimulai atau sudah selesai.');
        return;
      }
      const buttonRound = Number(parsed.args[0]);
      const optionIndex = Number(parsed.args[1]);
      if (buttonRound !== session.state.round) {
        await replyEphemeral(interaction, 'Pertanyaan ronde tersebut sudah berakhir!');
        return;
      }

      const ansRes = submitQuizAnswer(session.state, userId, optionIndex);
      if (!ansRes.ok) {
        await replyEphemeral(interaction, ansRes.error);
        return;
      }

      const updated = await updatePersistedSession(
        sessionId,
        { state: ansRes.state, ttlMs: GAME_INACTIVITY_TTL_MS },
        prisma,
      );

      const letter = ['A', 'B', 'C', 'D'][optionIndex] ?? '?';
      await interaction.reply({
        content: `Jawaban **${letter}** tercatat! Tunggu akhir ronde untuk melihat jawaban benar.`,
        flags: MessageFlags.Ephemeral,
      });

      const targetMsg = await resolveTargetMessage(updated, interaction);
      if (targetMsg) {
        await safeUpdateMessage(
          targetMsg,
          buildQuizQuestionMessage({ sessionId, state: updated.state }),
          false,
        );
      }

      if (ansRes.allAnswered) {
        clearSessionTimers(sessionId);
        roundToResolveImmediately = updated.state.round;
      }
    }
  });

  if (roundToSchedule !== null) {
    scheduleQuizRoundTimer(sessionId, roundToSchedule, {
      ...context,
      client: interaction.client ?? context.client,
    });
  }

  if (roundToResolveImmediately !== null) {
    await resolveAndScheduleQuizRound(sessionId, roundToResolveImmediately, {
      ...context,
      client: interaction.client ?? context.client,
    });
  }
}

/**
 * Handles direct chat answers (`a`, `b`, `c`, `d` without prefix/slash) for an active Quiz in a channel.
 * Returns `true` when the message matched an active channel Quiz round.
 * @param {import('discord.js').Message} message
 * @param {object} [context]
 * @returns {Promise<boolean>}
 */
export async function handleQuizChatAnswer(message, context = {}) {
  if (message?.author?.bot || message?.webhookId || message?.system) {
    return false;
  }

  if (message?.id && processedQuizMessageIds.has(message.id)) {
    return false;
  }

  const optionIndex = parseDirectQuizAnswerOption(message?.content);
  if (optionIndex === null || !message?.guildId || !message?.channelId) {
    return false;
  }

  const prisma = context.prisma ?? defaultPrisma;
  if (!prisma?.gameSession) {
    return false;
  }

  const active = await findActiveChannelQuizSession(message.channelId, prisma);
  if (!active) {
    return false;
  }

  const userId = message.author?.id;
  if (!userId) {
    return false;
  }

  const roundDurationMs = context.quizRoundDurationMs ?? DEFAULT_QUIZ_ROUND_MS;
  const intermissionMs = context.quizIntermissionMs ?? DEFAULT_QUIZ_INTERMISSION_MS;
  const logger = context.logger ?? console;
  const client = message.client ?? context.client;

  let handled = false;
  let intermissionRoundToAdvance = null;

  await withSessionLock(active.id, async () => {
    if (message.id && processedQuizMessageIds.has(message.id)) {
      return;
    }

    const session = await getPersistedSession(active.id, prisma);
    if (
      !session ||
      session.status !== 'active' ||
      session.gameType !== 'quiz' ||
      session.state?.phase !== 'question' ||
      session.state?.roundResolved
    ) {
      return;
    }

    const autoJoin = typeof context.autoJoin === 'boolean' ? context.autoJoin : true;
    const ansRes = submitQuizAnswer(session.state, userId, optionIndex, { autoJoin });
    if (!ansRes.ok) {
      return;
    }

    recordProcessedQuizMessage(message.id);
    handled = true;

    if (ansRes.joined) {
      await addSessionParticipant(
        session.id,
        { userId, username: message.author?.username ?? null, role: 'player' },
        prisma,
      );
    }

    if (!ansRes.isCorrect) {
      if (ansRes.joined) {
        await updatePersistedSession(
          session.id,
          { state: ansRes.state, ttlMs: GAME_INACTIVITY_TTL_MS },
          prisma,
        );
      }
      if (typeof message.react === 'function') {
        await message.react('❌').catch(() => {});
      }
      return;
    }

    if (ansRes.allAnswered) {
      clearSessionTimers(session.id);
      const resolved = resolveQuizRound(ansRes.state);
      if (resolved.alreadyResolved) {
        return;
      }

      const updated = await updatePersistedSession(
        session.id,
        { state: resolved.state, ttlMs: GAME_INACTIVITY_TTL_MS },
        prisma,
      );

      if (typeof message.react === 'function') {
        await message.react('✅').catch(() => {});
      }

      const targetMsg = await resolveTargetMessage(updated, client);
      if (!targetMsg && client) {
        clearSessionTimers(session.id);
        await updatePersistedSession(session.id, { status: 'cancelled', ttlMs: null }, prisma);
        return;
      }
      if (targetMsg) {
        const res = await safeUpdateMessage(
          targetMsg,
          buildQuizRoundResultMessage({
            sessionId: session.id,
            state: updated.state,
            summary: resolved.summary,
          }),
          false,
        );
        if (res?.inaccessible) {
          clearSessionTimers(session.id);
          await updatePersistedSession(session.id, { status: 'cancelled', ttlMs: null }, prisma);
          return;
        }
      }

      intermissionRoundToAdvance = updated.state.round;
      return;
    }

    const updated = await updatePersistedSession(
      session.id,
      { state: ansRes.state, ttlMs: GAME_INACTIVITY_TTL_MS },
      prisma,
    );

    if (typeof message.react === 'function') {
      await message.react('✅').catch(() => {});
    }

    const targetMsg = await resolveTargetMessage(updated, client);
    if (targetMsg) {
      await safeUpdateMessage(
        targetMsg,
        buildQuizQuestionMessage({ sessionId: session.id, state: updated.state }),
        false,
      );
    }
  });

  if (intermissionRoundToAdvance !== null) {
    const advancingRound = intermissionRoundToAdvance;
    setSessionTimer(
      active.id,
      'intermission',
      () => {
        advanceQuizStep(active.id, advancingRound, {
          ...context,
          client,
          quizRoundDurationMs: roundDurationMs,
          quizIntermissionMs: intermissionMs,
        }).catch((err) => logger.error('[QuizBattle] Failed advancing round:', sanitizeError(err)));
      },
      intermissionMs,
    );
  }

  return handled;
}

/**
 * Recovers active Quiz Battle timers and expires stale sessions after a bot restart.
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   client?: import('discord.js').Client,
 *   logger?: Console,
 *   quizRoundDurationMs?: number,
 *   quizIntermissionMs?: number,
 * }} [context]
 */
export async function recoverGameCenterSessions(context = {}) {
  const prisma = context.prisma ?? defaultPrisma;
  const logger = context.logger ?? console;
  const now = new Date();

  const rows = await prisma.gameSession.findMany({
    where: { status: { in: ['pending', 'active'] } },
    include: { participants: true },
  });

  for (const row of rows) {
    const session = hydrateSession(row);
    const isExpired = session.expiresAt && new Date(session.expiresAt) < now;

    if (isExpired) {
      await updatePersistedSession(session.id, { status: 'expired', ttlMs: null }, prisma);
      const targetMsg = await resolveTargetMessage(session, context.client);
      if (targetMsg) {
        if (session.status === 'pending' && session.gameType !== 'quiz') {
          const opp = session.participants.find((p) => p.userId !== session.hostId);
          await safeUpdateMessage(
            targetMsg,
            buildChallengeMessage({
              sessionId: session.id,
              gameType: session.gameType,
              hostId: session.hostId,
              opponentId: opp?.userId ?? session.hostId,
              disabled: true,
              statusText: `${getEmoji('timer')} Tantangan telah kedaluwarsa.`,
            }),
            false,
          );
        } else if (session.gameType === 'quiz' && session.status === 'pending') {
          await safeUpdateMessage(
            targetMsg,
            session.state?.isGlobalChannelLobby
              ? buildGlobalQuizLobbyMessage({
                  sessionId: session.id,
                  disabled: true,
                  statusOverride: 'expired',
                })
              : buildQuizLobbyMessage({
                  sessionId: session.id,
                  state: session.state,
                  disabled: true,
                  cancelledText: `${getEmoji('timer')} Lobby Quiz Battle kedaluwarsa.`,
                }),
            false,
          );
        } else {
          const boardPayload = renderActiveBoard(session, 'expired');
          if (boardPayload) {
            await safeUpdateMessage(targetMsg, boardPayload, false);
          }
        }
      }
      continue;
    }

    if (session.gameType === 'quiz' && session.status === 'active' && session.state) {
      const round = session.state.round;
      if (session.state.phase === 'question') {
        const remainingMs = Math.max(0, (session.state.roundEndsAt ?? Date.now()) - Date.now());
        setSessionTimer(
          session.id,
          'round',
          () => {
            resolveAndScheduleQuizRound(session.id, round, context).catch((err) =>
              logger.error('[QuizBattle] Recovery round resolution error:', sanitizeError(err)),
            );
          },
          remainingMs,
        );
      } else if (session.state.phase === 'intermission') {
        setSessionTimer(
          session.id,
          'intermission',
          () => {
            advanceQuizStep(session.id, round, context).catch((err) =>
              logger.error('[QuizBattle] Recovery intermission advance error:', sanitizeError(err)),
            );
          },
          1000,
        );
      }
    }
  }
}

/**
 * Central button router for all Game Center interactions (`gc:*`).
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} [context]
 */
export async function handleGameCenterInteraction(interaction, context = {}) {
  const parsed = parseGameCustomId(interaction?.customId);
  if (!parsed) {
    return;
  }

  try {
    if (parsed.scope === 'challenge') {
      await handleChallengeInteraction(interaction, parsed, context);
      return;
    }
    if (parsed.scope === 'ttt' || parsed.scope === 'rps') {
      await handleBoardOrRpsInteraction(interaction, parsed, context);
      return;
    }
    if (parsed.scope === 'quiz') {
      await handleQuizInteraction(interaction, parsed, context);
      return;
    }
  } catch (err) {
    context.logger?.error?.('[GameCenter] Interaction error:', sanitizeError(err));
    await replyEphemeral(interaction, 'Terjadi gangguan saat memproses aksi permainan. Silakan coba lagi.');
  }
}
