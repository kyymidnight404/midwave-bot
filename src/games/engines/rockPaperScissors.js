export const RPS_OPTIONS = Object.freeze(['rock', 'paper', 'scissors']);
export const RPS_WIN_TARGET = 2; // Best of 3 (first to 2 round wins)

const BEATS = Object.freeze({
  rock: 'scissors',
  paper: 'rock',
  scissors: 'paper',
});

/**
 * Creates the initial serializable state for a Best-of-3 RPS match.
 * @param {{ hostId: string, opponentId: string }} params
 */
export function createRpsMatchState({ hostId, opponentId }) {
  return {
    player1Id: hostId,
    player2Id: opponentId,
    round: 1,
    scores: { [hostId]: 0, [opponentId]: 0 },
    roundChoices: {},
    history: [],
    winnerId: null,
    isDraw: false,
  };
}

/**
 * Resolves a single RPS pair.
 * @param {'rock'|'paper'|'scissors'} choice1
 * @param {'rock'|'paper'|'scissors'} choice2
 * @returns {'p1'|'p2'|'draw'}
 */
export function resolveRpsRoundPair(choice1, choice2) {
  if (choice1 === choice2) {
    return 'draw';
  }
  return BEATS[choice1] === choice2 ? 'p1' : 'p2';
}

/**
 * Applies a player's hidden RPS pick for the current round.
 * Prevents changing choice once submitted and only reveals picks once both players choose.
 * @param {object} state
 * @param {string} userId
 * @param {'rock'|'paper'|'scissors'} choice
 */
export function applyRpsPick(state, userId, choice) {
  if (!state || state.winnerId || state.isDraw) {
    return { ok: false, error: 'Pertandingan Rock Paper Scissors ini sudah berakhir.' };
  }
  if (userId !== state.player1Id && userId !== state.player2Id) {
    return { ok: false, error: 'Kamu tidak terdaftar dalam pertandingan ini.' };
  }
  if (!RPS_OPTIONS.includes(choice)) {
    return { ok: false, error: 'Pilihan tidak valid.' };
  }
  if (Object.hasOwn(state.roundChoices, userId)) {
    return {
      ok: false,
      error: 'Kamu sudah mengirim pilihan pada ronde ini dan tidak dapat mengubahnya.',
    };
  }

  const nextChoices = { ...state.roundChoices, [userId]: choice };
  const c1 = nextChoices[state.player1Id];
  const c2 = nextChoices[state.player2Id];

  if (!c1 || !c2) {
    return {
      ok: true,
      state: { ...state, roundChoices: nextChoices },
      roundCompleted: false,
      finished: false,
      lastRound: null,
    };
  }

  const outcome = resolveRpsRoundPair(c1, c2);
  const nextScores = { ...state.scores };
  let roundWinnerId = null;

  if (outcome === 'p1') {
    nextScores[state.player1Id] += 1;
    roundWinnerId = state.player1Id;
  } else if (outcome === 'p2') {
    nextScores[state.player2Id] += 1;
    roundWinnerId = state.player2Id;
  }

  const lastRound = {
    round: state.round,
    choices: { [state.player1Id]: c1, [state.player2Id]: c2 },
    winnerId: roundWinnerId,
    isDraw: outcome === 'draw',
  };

  let winnerId = null;
  if (nextScores[state.player1Id] >= RPS_WIN_TARGET) {
    winnerId = state.player1Id;
  } else if (nextScores[state.player2Id] >= RPS_WIN_TARGET) {
    winnerId = state.player2Id;
  }

  const finished = winnerId !== null;
  const nextState = {
    ...state,
    round: finished ? state.round : state.round + 1,
    scores: nextScores,
    roundChoices: finished ? nextChoices : {},
    history: [...state.history, lastRound],
    winnerId,
    isDraw: false,
  };

  return {
    ok: true,
    state: nextState,
    roundCompleted: true,
    lastRound,
    finished,
    winnerId,
    isDraw: false,
  };
}
