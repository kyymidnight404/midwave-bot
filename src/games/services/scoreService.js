export const GAME_CENTER_TYPES = Object.freeze({
  TTT: 'ttt',
  QUIZ: 'quiz',
  RPS: 'rps',
});

export const GAME_CENTER_LABELS = Object.freeze({
  ttt: 'Tic Tac Toe',
  quiz: 'Quiz Battle',
  rps: 'Rock Paper Scissors',
});

export const MATCH_POINTS = Object.freeze({
  WIN: 25,
  DRAW: 10,
  LOSS: 0,
});

/**
 * Calculates win rate percentage safely without dividing by zero.
 * @param {number} wins
 * @param {number} matches
 * @returns {number}
 */
export function calculateWinRate(wins, matches) {
  if (!Number.isFinite(matches) || matches <= 0 || !Number.isFinite(wins) || wins <= 0) {
    return 0;
  }
  return Number(((wins / matches) * 100).toFixed(1));
}
