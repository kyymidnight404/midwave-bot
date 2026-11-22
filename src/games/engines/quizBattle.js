export const QUIZ_MIN_PLAYERS = 2;
export const QUIZ_MAX_PLAYERS = 10;
export const QUIZ_TOTAL_QUESTIONS = 10;
export const QUIZ_ROUND_SECONDS = 20;
export const QUIZ_POINTS_CORRECT = 1;
export const QUIZ_POINTS_WRONG = 0;
export const QUIZ_WINNER_BONUS = 0;

const SAFE_ATTACHMENT_IMAGE_RE = /^attachment:\/\/([a-zA-Z0-9._-]+)$/;

/**
 * Validates and normalizes an optional quiz question image URL (`https:`, `http:`, or safe `attachment://<name>`).
 * Returns `null` when absent or invalid so quiz UI degrades safely without broken images.
 * @param {unknown} rawUrl
 * @returns {string | null}
 */
export function sanitizeQuizImageUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  const attMatch = trimmed.match(SAFE_ATTACHMENT_IMAGE_RE);
  if (attMatch) {
    return `attachment://${attMatch[1]}`;
  }

  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname) {
      if (parsed.username || parsed.password) {
        return null;
      }
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Creates the initial serializable lobby state for Quiz Battle.
 * @param {{ hostId: string, category?: string, difficulty?: string }} params
 */
export function createQuizLobbyState({ hostId, category = 'all', difficulty = 'all' }) {
  return {
    phase: 'lobby', // 'lobby' | 'question' | 'intermission' | 'finished'
    hostId,
    category,
    difficulty,
    allowAutoJoin: false,
    allowRetryOnWrong: false,
    players: [hostId],
    scores: { [hostId]: 0 },
    round: 0,
    totalQuestions: QUIZ_TOTAL_QUESTIONS,
    questions: [],
    roundAnswers: {},
    roundResolved: false,
    roundEndsAt: null,
    lastRoundSummary: null,
    winnerId: null,
    winnerIds: [],
    isDraw: false,
  };
}

/**
 * Creates a ready-to-play active Quiz state starting immediately at Round 1.
 * @param {{
 *   hostId: string,
 *   category?: string,
 *   difficulty?: string,
 *   preparedQuestions: Array<object>,
 *   nowMs?: number,
 *   roundDurationMs?: number,
 *   allowAutoJoin?: boolean,
 *   allowRetryOnWrong?: boolean,
 * }} params
 */
export function createDirectQuizState({
  hostId,
  category = 'all',
  difficulty = 'all',
  preparedQuestions,
  nowMs = Date.now(),
  roundDurationMs = QUIZ_ROUND_SECONDS * 1000,
  allowAutoJoin = true,
  allowRetryOnWrong = true,
}) {
  if (!Array.isArray(preparedQuestions) || preparedQuestions.length === 0) {
    throw new Error('Tidak ada soal quiz yang tersedia untuk filter ini.');
  }

  return {
    ...createQuizLobbyState({ hostId, category, difficulty }),
    phase: 'question',
    allowAutoJoin,
    allowRetryOnWrong,
    round: 1,
    totalQuestions: preparedQuestions.length,
    questions: preparedQuestions,
    roundEndsAt: nowMs + roundDurationMs,
  };
}

/**
 * Creates a pending Global Channel Quiz Lobby state before the host clicks Start Quiz.
 * Anyone in the channel can answer once started.
 */
export function createGlobalQuizLobbyState({
  hostId,
  category = 'all',
  difficulty = 'all',
  preparedQuestions,
}) {
  if (!Array.isArray(preparedQuestions) || preparedQuestions.length === 0) {
    throw new Error('Tidak ada soal quiz yang tersedia untuk filter ini.');
  }

  return {
    ...createQuizLobbyState({ hostId, category, difficulty }),
    phase: 'lobby',
    isGlobalChannelLobby: true,
    allowAutoJoin: true,
    allowRetryOnWrong: true,
    round: 0,
    totalQuestions: preparedQuestions.length,
    questions: preparedQuestions,
    roundEndsAt: null,
  };
}

/**
 * Starts a pending Global Channel Quiz Lobby at Question 1.
 */
export function startGlobalQuizState(
  state,
  actorId,
  nowMs = Date.now(),
  roundDurationMs = QUIZ_ROUND_SECONDS * 1000,
) {
  if (!state || state.phase !== 'lobby') {
    return { ok: false, error: 'Quiz ini sudah dimulai atau berakhir.' };
  }
  if (actorId !== state.hostId) {
    return { ok: false, error: 'Hanya pembuat sesi yang dapat memulai Quiz.' };
  }
  if (!Array.isArray(state.questions) || state.questions.length === 0) {
    return { ok: false, error: 'Tidak ada soal quiz yang tersedia.' };
  }

  return {
    ok: true,
    state: {
      ...state,
      phase: 'question',
      round: 1,
      roundAnswers: {},
      roundResolved: false,
      roundEndsAt: nowMs + roundDurationMs,
      lastRoundSummary: null,
    },
  };
}

/**
 * Adds a player to the Quiz Battle lobby.
 * @param {object} state
 * @param {string} userId
 */
export function joinQuizLobby(state, userId) {
  if (!state || state.phase !== 'lobby') {
    return { ok: false, error: 'Lobby Quiz Battle sudah dimulai atau berakhir.' };
  }
  if (state.players.includes(userId)) {
    return { ok: false, error: 'Kamu sudah bergabung di lobby ini.' };
  }
  if (state.players.length >= QUIZ_MAX_PLAYERS) {
    return { ok: false, error: `Lobby sudah penuh (maksimal ${QUIZ_MAX_PLAYERS} pemain).` };
  }

  return {
    ok: true,
    state: {
      ...state,
      players: [...state.players, userId],
      scores: { ...state.scores, [userId]: 0 },
    },
  };
}

/**
 * Removes a player from the Quiz Battle lobby. Transfers host or cancels if empty.
 * @param {object} state
 * @param {string} userId
 */
export function leaveQuizLobby(state, userId) {
  if (!state || state.phase !== 'lobby') {
    return { ok: false, error: 'Tidak dapat keluar karena Quiz Battle sudah dimulai atau selesai.' };
  }
  if (!state.players.includes(userId)) {
    return { ok: false, error: 'Kamu tidak berada di lobby ini.' };
  }

  const nextPlayers = state.players.filter((id) => id !== userId);
  const nextScores = { ...state.scores };
  delete nextScores[userId];

  if (nextPlayers.length === 0) {
    return {
      ok: true,
      cancelled: true,
      state: { ...state, players: [], scores: {}, phase: 'finished' },
    };
  }

  const nextHostId = state.hostId === userId ? nextPlayers[0] : state.hostId;
  return {
    ok: true,
    cancelled: false,
    state: {
      ...state,
      hostId: nextHostId,
      players: nextPlayers,
      scores: nextScores,
    },
  };
}

/**
 * Starts the Quiz Battle match with shuffled prepared questions.
 * @param {object} state
 * @param {string} actorId
 * @param {Array<object>} preparedQuestions
 * @param {number} [nowMs]
 * @param {number} [roundDurationMs]
 */
export function startQuizBattle(
  state,
  actorId,
  preparedQuestions,
  nowMs = Date.now(),
  roundDurationMs = QUIZ_ROUND_SECONDS * 1000,
) {
  if (!state || state.phase !== 'lobby') {
    return { ok: false, error: 'Quiz Battle sudah dimulai atau berakhir.' };
  }
  if (actorId !== state.hostId) {
    return { ok: false, error: 'Hanya Host lobby yang dapat memulai Quiz Battle.' };
  }
  if (state.players.length < QUIZ_MIN_PLAYERS) {
    return {
      ok: false,
      error: `Minimal ${QUIZ_MIN_PLAYERS} pemain untuk memulai Quiz Battle! (Saat ini: ${state.players.length})`,
    };
  }
  if (!Array.isArray(preparedQuestions) || preparedQuestions.length === 0) {
    return { ok: false, error: 'Tidak ada soal quiz yang tersedia untuk filter ini.' };
  }

  return {
    ok: true,
    state: {
      ...state,
      phase: 'question',
      round: 1,
      totalQuestions: preparedQuestions.length,
      questions: preparedQuestions,
      roundAnswers: {},
      roundResolved: false,
      roundEndsAt: nowMs + roundDurationMs,
      lastRoundSummary: null,
    },
  };
}

/**
 * Submits a player's answer (`0..3`) for the active Quiz round.
 * In direct retry mode (`allowRetryOnWrong`), wrong answers do not lock out the player or end the round,
 * while a correct answer immediately marks the round ready to resolve once.
 *
 * @param {object} state
 * @param {string} userId
 * @param {number} optionIndex
 * @param {{ autoJoin?: boolean, allowRetryOnWrong?: boolean }} [options]
 */
export function submitQuizAnswer(state, userId, optionIndex, { autoJoin = false, allowRetryOnWrong } = {}) {
  if (!state || state.phase !== 'question' || state.roundResolved) {
    return { ok: false, error: 'Ronde pertanyaan ini sudah berakhir.' };
  }
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 3) {
    return { ok: false, error: 'Pilihan jawaban tidak valid.' };
  }

  const canAutoJoin =
    typeof state.allowAutoJoin === 'boolean' ? state.allowAutoJoin && Boolean(autoJoin) : Boolean(autoJoin);

  let nextPlayers = state.players;
  let nextScores = state.scores;
  let joined = false;

  if (!nextPlayers.includes(userId)) {
    if (!canAutoJoin) {
      return { ok: false, isParticipant: false, error: 'Kamu tidak terdaftar dalam Quiz Battle ini.' };
    }
    if (nextPlayers.length >= QUIZ_MAX_PLAYERS) {
      return { ok: false, isParticipant: false, error: `Quiz sudah mencapai batas maksimal ${QUIZ_MAX_PLAYERS} pemain.` };
    }
    nextPlayers = [...nextPlayers, userId];
    nextScores = { ...nextScores, [userId]: 0 };
    joined = true;
  }

  const currentQ = state.questions?.[state.round - 1];
  const isCorrect = Boolean(currentQ && optionIndex === currentQ.correctIndex);
  const retryEnabled = allowRetryOnWrong ?? state.allowRetryOnWrong === true;

  if (retryEnabled) {
    if (!isCorrect) {
      return {
        ok: true,
        joined,
        isParticipant: true,
        isCorrect: false,
        allAnswered: false,
        state: joined
          ? {
              ...state,
              players: nextPlayers,
              scores: nextScores,
            }
          : state,
      };
    }

    const nextAnswers = { ...state.roundAnswers, [userId]: optionIndex };
    return {
      ok: true,
      joined,
      isParticipant: true,
      isCorrect: true,
      allAnswered: true,
      state: {
        ...state,
        players: nextPlayers,
        scores: nextScores,
        roundAnswers: nextAnswers,
      },
    };
  }

  if (Object.hasOwn(state.roundAnswers, userId)) {
    return { ok: false, isParticipant: true, error: 'Kamu sudah menjawab ronde ini dan tidak dapat mengubah jawaban!' };
  }

  const nextAnswers = { ...state.roundAnswers, [userId]: optionIndex };
  const allAnswered = nextPlayers.every((id) => Object.hasOwn(nextAnswers, id));

  return {
    ok: true,
    joined,
    isParticipant: true,
    isCorrect,
    state: {
      ...state,
      players: nextPlayers,
      scores: nextScores,
      roundAnswers: nextAnswers,
    },
    allAnswered,
  };
}

/**
 * Resolves the current Quiz round, tallying +1 per correct answer without awarding global/bonus points.
 * @param {object} state
 */
export function resolveQuizRound(state) {
  if (!state || state.roundResolved || state.phase !== 'question') {
    return { ok: false, alreadyResolved: true, state };
  }

  const currentQ = state.questions[state.round - 1];
  const nextScores = { ...state.scores };
  const correctPlayerIds = [];
  const wrongPlayerIds = [];
  const timeoutPlayerIds = [];

  for (const playerId of state.players) {
    if (!Object.hasOwn(state.roundAnswers, playerId)) {
      timeoutPlayerIds.push(playerId);
      nextScores[playerId] = (nextScores[playerId] ?? 0) + QUIZ_POINTS_WRONG;
      continue;
    }

    const picked = state.roundAnswers[playerId];
    if (picked === currentQ.correctIndex) {
      correctPlayerIds.push(playerId);
      nextScores[playerId] = (nextScores[playerId] ?? 0) + QUIZ_POINTS_CORRECT;
    } else {
      wrongPlayerIds.push(playerId);
      nextScores[playerId] = (nextScores[playerId] ?? 0) + QUIZ_POINTS_WRONG;
    }
  }

  const standings = getSortedQuizStandings(state.players, nextScores);
  const lastRoundSummary = {
    round: state.round,
    correctIndex: currentQ.correctIndex,
    correctOption: currentQ.options[currentQ.correctIndex],
    correctPlayerIds,
    wrongPlayerIds,
    timeoutPlayerIds,
    standings,
  };

  return {
    ok: true,
    alreadyResolved: false,
    state: {
      ...state,
      phase: 'intermission',
      scores: nextScores,
      roundResolved: true,
      lastRoundSummary,
    },
    summary: lastRoundSummary,
  };
}

/**
 * Advances to the next round or finishes the Quiz Battle without awarding bonus points.
 * @param {object} state
 * @param {number} [nowMs]
 * @param {number} [roundDurationMs]
 */
export function advanceQuizRound(
  state,
  nowMs = Date.now(),
  roundDurationMs = QUIZ_ROUND_SECONDS * 1000,
) {
  if (!state || !state.roundResolved) {
    return { ok: false, error: 'Ronde saat ini belum diselesaikan.' };
  }

  if (state.round < state.totalQuestions) {
    return {
      ok: true,
      finished: false,
      state: {
        ...state,
        phase: 'question',
        round: state.round + 1,
        roundAnswers: {},
        roundResolved: false,
        roundEndsAt: nowMs + roundDurationMs,
      },
    };
  }

  const finalScores = { ...state.scores };
  const maxScore = Math.max(...state.players.map((id) => finalScores[id] ?? 0));
  const topPlayers = state.players.filter((id) => (finalScores[id] ?? 0) === maxScore);

  let winnerId = null;
  let isDraw = false;

  if (state.players.length === 1) {
    winnerId = maxScore > 0 ? state.players[0] : null;
  } else if (maxScore > 0 && topPlayers.length === 1) {
    winnerId = topPlayers[0];
  } else {
    isDraw = true;
  }

  const standings = getSortedQuizStandings(state.players, finalScores);

  return {
    ok: true,
    finished: true,
    winnerId,
    isDraw,
    standings,
    state: {
      ...state,
      phase: 'finished',
      scores: finalScores,
      winnerId,
      winnerIds: topPlayers,
      isDraw,
      lastRoundSummary: state.lastRoundSummary
        ? { ...state.lastRoundSummary, standings }
        : null,
    },
  };
}

/**
 * Returns players sorted descending by score.
 * @param {string[]} players
 * @param {Record<string, number>} scores
 */
export function getSortedQuizStandings(players, scores) {
  return [...players]
    .map((userId) => ({ userId, score: scores[userId] ?? 0 }))
    .sort((a, b) => b.score - a.score);
}
