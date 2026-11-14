import {
  BOT_PLAYER_ID,
  DIFFICULTY_LABELS,
  GAME_MODES,
  MATCH_STATUS,
  TRIVIA_CATEGORY_LABELS,
  TRIVIA_CONFIG,
} from '../utils/constants.js';
import { defaultRng } from '../utils/random.js';
import {
  isValidDifficulty,
  isValidTriviaCategory,
  isValidTriviaOption,
} from '../utils/validators.js';
import { selectTriviaQuestions } from './TriviaBank.js';

const LETTERS = TRIVIA_CONFIG.OPTION_LETTERS;

function formatOptionsList(question) {
  return question.options
    .map((opt, idx) => `**${LETTERS[idx]}.** ${opt}`)
    .join('\n');
}

function buildFinalResult(state) {
  const humanPlayers = state.players.filter((p) => p !== BOT_PLAYER_ID);
  const totalRounds = state.questions.length;

  if (state.mode === GAME_MODES.SOLO) {
    const playerId = humanPlayers[0];
    const score = state.scores[playerId] ?? 0;
    const passed = score >= Math.ceil(totalRounds / 2);
    return {
      winnerId: passed ? playerId : BOT_PLAYER_ID,
      loserId: passed ? BOT_PLAYER_ID : playerId,
      isDraw: false,
      finalScore: `<@${playerId}>: **${score}/${totalRounds}**`,
      description: `Kuis selesai! Kamu menjawab benar **${score} dari ${totalRounds}** pertanyaan.`,
    };
  }

  const [p1, p2] = humanPlayers;
  const s1 = state.scores[p1] ?? 0;
  const s2 = state.scores[p2] ?? 0;
  const scoreLine = `<@${p1}>: **${s1}** | <@${p2}>: **${s2}** (dari ${totalRounds} soal)`;

  if (s1 === s2) {
    return {
      winnerId: null,
      loserId: null,
      isDraw: true,
      finalScore: scoreLine,
      description: `Skor imbang **${s1}–${s2}**! Pertandingan berakhir **Draw**.`,
    };
  }

  const winnerId = s1 > s2 ? p1 : p2;
  const loserId = winnerId === p1 ? p2 : p1;
  return {
    winnerId,
    loserId,
    isDraw: false,
    finalScore: scoreLine,
    description: `<@${winnerId}> memenangkan Trivia Quiz dengan skor **${state.scores[winnerId]}** melawan **${state.scores[loserId]}**!`,
  };
}

/**
 * Pure Trivia Quiz game engine (Solo & 2-player Multiplayer).
 */
export const TriviaGame = {
  create(config, players, rng = defaultRng) {
    const category = isValidTriviaCategory(config?.category) ? config.category : 'general';
    const difficulty = isValidDifficulty(config?.difficulty) ? config.difficulty : 'normal';
    const mode = config?.mode ?? (players.includes(BOT_PLAYER_ID) ? GAME_MODES.SOLO : GAME_MODES.MULTIPLAYER);

    const questions = Array.isArray(config?.questions)
      ? config.questions
      : selectTriviaQuestions({
          category,
          difficulty,
          count: TRIVIA_CONFIG.ROUNDS_PER_MATCH,
          rng,
        });

    const scores = {};
    for (const p of players) {
      if (p !== BOT_PLAYER_ID) scores[p] = 0;
    }

    return {
      mode,
      category,
      difficulty,
      players: [...players],
      currentTurn: null,
      questions,
      currentRoundIndex: 0,
      scores,
      lockedPlayers: [],
      lastRoundSummary: null,
      lastPlayerFeedback: {},
      status: MATCH_STATUS.ACTIVE,
      result: null,
    };
  },

  applyAction(state, playerId, action) {
    if (state.status !== MATCH_STATUS.ACTIVE) {
      return { error: 'Pertandingan Trivia sudah selesai.' };
    }
    if (!state.players.includes(playerId)) {
      return { error: 'Kamu bukan peserta pertandingan ini.' };
    }

    const rawOption = String(action?.option ?? '').toUpperCase();
    if (!isValidTriviaOption(rawOption)) {
      return { error: 'Pilihan jawaban harus A, B, C, atau D.' };
    }

    if (state.lockedPlayers.includes(playerId)) {
      return {
        error: 'Jawabanmu pada ronde ini sudah terkunci karena salah. Tunggu ronde berikutnya!',
      };
    }

    const optionIndex = LETTERS.indexOf(rawOption);
    const question = state.questions[state.currentRoundIndex];
    const isCorrect = optionIndex === question.answerIndex;
    const correctLetter = LETTERS[question.answerIndex];
    const correctText = question.options[question.answerIndex];

    if (state.mode === GAME_MODES.SOLO) {
      const nextScores = { ...state.scores };
      if (isCorrect) {
        nextScores[playerId] = (nextScores[playerId] ?? 0) + 1;
      }

      const summary = isCorrect
        ? `Ronde ${state.currentRoundIndex + 1}: **Benar!** (+1 poin)`
        : `Ronde ${state.currentRoundIndex + 1}: **Salah.** Jawaban benar: **${correctLetter}. ${correctText}**`;

      const nextRoundIndex = state.currentRoundIndex + 1;
      const finished = nextRoundIndex >= state.questions.length;

      const nextState = {
        ...state,
        scores: nextScores,
        currentRoundIndex: finished ? state.currentRoundIndex : nextRoundIndex,
        lockedPlayers: [],
        lastRoundSummary: summary,
        lastPlayerFeedback: {
          [playerId]: {
            correct: isCorrect,
            chosenLetter: rawOption,
            correctLetter,
            correctText,
            locked: false,
          },
        },
        status: finished ? MATCH_STATUS.FINISHED : MATCH_STATUS.ACTIVE,
      };

      if (finished) {
        nextState.result = buildFinalResult(nextState);
        return { state: nextState, finished: true, roundAdvanced: true, result: nextState.result };
      }

      return { state: nextState, finished: false, roundAdvanced: true };
    }

    // Multiplayer mode
    if (isCorrect) {
      const nextScores = {
        ...state.scores,
        [playerId]: (state.scores[playerId] ?? 0) + 1,
      };
      const summary = `Ronde ${state.currentRoundIndex + 1}: <@${playerId}> menjawab **benar** paling cepat (+1 poin)! Jawaban: **${correctLetter}. ${correctText}**`;
      const nextRoundIndex = state.currentRoundIndex + 1;
      const finished = nextRoundIndex >= state.questions.length;

      const nextState = {
        ...state,
        scores: nextScores,
        currentRoundIndex: finished ? state.currentRoundIndex : nextRoundIndex,
        lockedPlayers: [],
        lastRoundSummary: summary,
        lastPlayerFeedback: {
          ...state.lastPlayerFeedback,
          [playerId]: {
            correct: true,
            chosenLetter: rawOption,
            correctLetter,
            correctText,
            locked: false,
          },
        },
        status: finished ? MATCH_STATUS.FINISHED : MATCH_STATUS.ACTIVE,
      };

      if (finished) {
        nextState.result = buildFinalResult(nextState);
        return { state: nextState, finished: true, roundAdvanced: true, result: nextState.result };
      }

      return { state: nextState, finished: false, roundAdvanced: true };
    }

    // Wrong answer in multiplayer: lock player for the remainder of the round
    const nextLocked = [...state.lockedPlayers, playerId];
    const humanPlayers = state.players.filter((p) => p !== BOT_PLAYER_ID);
    const allLocked = nextLocked.length >= humanPlayers.length;

    if (allLocked) {
      const summary = `Ronde ${state.currentRoundIndex + 1}: Semua pemain menjawab salah. Ronde dilewati (Jawaban: **${correctLetter}. ${correctText}**).`;
      const nextRoundIndex = state.currentRoundIndex + 1;
      const finished = nextRoundIndex >= state.questions.length;

      const nextState = {
        ...state,
        currentRoundIndex: finished ? state.currentRoundIndex : nextRoundIndex,
        lockedPlayers: [],
        lastRoundSummary: summary,
        lastPlayerFeedback: {
          ...state.lastPlayerFeedback,
          [playerId]: {
            correct: false,
            chosenLetter: rawOption,
            locked: true,
            roundSkipped: true,
          },
        },
        status: finished ? MATCH_STATUS.FINISHED : MATCH_STATUS.ACTIVE,
      };

      if (finished) {
        nextState.result = buildFinalResult(nextState);
        return { state: nextState, finished: true, roundAdvanced: true, result: nextState.result };
      }

      return { state: nextState, finished: false, roundAdvanced: true };
    }

    const nextState = {
      ...state,
      lockedPlayers: nextLocked,
      lastPlayerFeedback: {
        ...state.lastPlayerFeedback,
        [playerId]: {
          correct: false,
          chosenLetter: rawOption,
          locked: true,
          roundSkipped: false,
        },
      },
    };
    return { state: nextState, finished: false, roundAdvanced: false };
  },

  /**
   * Advances or finishes the Trivia match when the 20-second round timer expires.
   * @param {object} state
   */
  advanceRoundOnTimeout(state) {
    if (state.status !== MATCH_STATUS.ACTIVE) {
      return { state, finished: true, result: state.result };
    }

    const question = state.questions[state.currentRoundIndex];
    const correctLetter = LETTERS[question.answerIndex];
    const correctText = question.options[question.answerIndex];
    const summary = `Ronde ${state.currentRoundIndex + 1}: Waktu habis (20 detik)! Tidak ada poin. Jawaban: **${correctLetter}. ${correctText}**`;

    const nextRoundIndex = state.currentRoundIndex + 1;
    const finished = nextRoundIndex >= state.questions.length;

    const nextState = {
      ...state,
      currentRoundIndex: finished ? state.currentRoundIndex : nextRoundIndex,
      lockedPlayers: [],
      lastRoundSummary: summary,
      status: finished ? MATCH_STATUS.FINISHED : MATCH_STATUS.ACTIVE,
    };

    if (finished) {
      nextState.result = buildFinalResult(nextState);
      return { state: nextState, finished: true, result: nextState.result };
    }

    return { state: nextState, finished: false };
  },

  /**
   * Public view never exposes the current round's answerIndex.
   */
  getPublicView(state) {
    const categoryLabel = TRIVIA_CATEGORY_LABELS[state.category] ?? state.category;
    const difficultyLabel = DIFFICULTY_LABELS[state.difficulty] ?? state.difficulty;
    const scoreLines = Object.entries(state.scores)
      .map(([pid, score]) => `<@${pid}>: **${score}**`)
      .join(' | ');

    if (state.status === MATCH_STATUS.FINISHED) {
      const lines = [
        `Kategori: **${categoryLabel}** | Difficulty: **${difficultyLabel}**`,
        `Skor: ${scoreLines}`,
      ];
      if (state.lastRoundSummary) {
        lines.push('', state.lastRoundSummary);
      }

      return {
        mode: state.mode,
        players: state.players,
        status: 'Selesai',
        currentTurn: null,
        boardOrInfo: lines.join('\n'),
      };
    }

    const q = state.questions[state.currentRoundIndex];
    const lines = [
      `Kategori: **${categoryLabel}** | Difficulty: **${difficultyLabel}**`,
      `Ronde: **${state.currentRoundIndex + 1}/${state.questions.length}** | Skor: ${scoreLines}`,
    ];

    if (state.lastRoundSummary) {
      lines.push(`> ${state.lastRoundSummary}`);
    }

    lines.push('', `**${q.question}**`, formatOptionsList(q));

    if (state.mode === GAME_MODES.MULTIPLAYER) {
      lines.push('', '⏱️ Batas waktu ronde: **20 detik** (jawaban benar tercepat mendapat poin)');
    }

    return {
      mode: state.mode,
      players: state.players,
      status: `Ronde ${state.currentRoundIndex + 1}/${state.questions.length}`,
      currentTurn: null,
      boardOrInfo: lines.join('\n'),
      instructions: 'Jawab secara privat dengan `/game action:answer game:trivia answer:<A|B|C|D>`.',
    };
  },

  getPrivateView(state, playerId) {
    return {
      score: state.scores[playerId] ?? 0,
      locked: state.lockedPlayers.includes(playerId),
      feedback: state.lastPlayerFeedback[playerId] ?? null,
    };
  },
};
