import { defaultRng } from '../../utils/random.js';

export const WIN_LINES = Object.freeze([
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]);

/**
 * Checks whether the 3x3 board has a winner or draw.
 * @param {(string | null)[]} board
 * @returns {{ winner: string | null, line: number[] | null, isDraw: boolean }}
 */
export function evaluateTicTacToeBoard(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line, isDraw: false };
    }
  }
  const isDraw = board.every((cell) => cell !== null);
  return { winner: null, line: null, isDraw };
}

/**
 * Returns indices of empty squares.
 * @param {(string | null)[]} board
 * @returns {number[]}
 */
export function getLegalTttMoves(board) {
  const moves = [];
  for (let i = 0; i < 9; i += 1) {
    if (board[i] === null) moves.push(i);
  }
  return moves;
}

function findImmediateWinningMove(board, mark) {
  for (const idx of getLegalTttMoves(board)) {
    board[idx] = mark;
    const { winner } = evaluateTicTacToeBoard(board);
    board[idx] = null;
    if (winner === mark) return idx;
  }
  return -1;
}

function minimax(board, depth, isMaximizing, aiMark, humanMark, alpha, beta) {
  const { winner, isDraw } = evaluateTicTacToeBoard(board);
  if (winner === aiMark) return 10 - depth;
  if (winner === humanMark) return depth - 10;
  if (isDraw) return 0;

  if (isMaximizing) {
    let best = -Infinity;
    for (let i = 0; i < 9; i += 1) {
      if (board[i] !== null) continue;
      board[i] = aiMark;
      const score = minimax(board, depth + 1, false, aiMark, humanMark, alpha, beta);
      board[i] = null;
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (beta <= alpha) break;
    }
    return best;
  }

  let best = Infinity;
  for (let i = 0; i < 9; i += 1) {
    if (board[i] !== null) continue;
    board[i] = humanMark;
    const score = minimax(board, depth + 1, true, aiMark, humanMark, alpha, beta);
    board[i] = null;
    if (score < best) best = score;
    if (best < beta) beta = best;
    if (beta <= alpha) break;
  }
  return best;
}

/**
 * Chooses a legal move index (0..8) for Tic Tac Toe AI.
 * @param {(string | null)[]} board
 * @param {'easy' | 'normal' | 'hard'} difficulty
 * @param {string} [aiMark='O']
 * @param {object} [rng]
 * @returns {number}
 */
export function chooseTicTacToeMove(board, difficulty = 'normal', aiMark = 'O', rng = defaultRng) {
  const legal = getLegalTttMoves(board);
  if (legal.length === 0) return -1;

  const humanMark = aiMark === 'O' ? 'X' : 'O';
  const work = [...board];

  if (difficulty === 'easy') {
    return rng.pick(legal);
  }

  if (difficulty === 'normal') {
    const winMove = findImmediateWinningMove(work, aiMark);
    if (winMove !== -1) return winMove;

    const blockMove = findImmediateWinningMove(work, humanMark);
    if (blockMove !== -1) return blockMove;

    if (work[4] === null && rng.int(0, 1) === 1) return 4;
    return rng.pick(legal);
  }

  // Hard: Minimax with alpha-beta pruning
  // Fast path if board is completely empty (center or corner is optimal)
  if (legal.length === 9) {
    return 4;
  }

  let bestScore = -Infinity;
  let bestMoves = [];

  for (const idx of legal) {
    work[idx] = aiMark;
    const score = minimax(work, 0, false, aiMark, humanMark, -Infinity, Infinity);
    work[idx] = null;
    if (score > bestScore) {
      bestScore = score;
      bestMoves = [idx];
    } else if (score === bestScore) {
      bestMoves.push(idx);
    }
  }

  return rng.pick(bestMoves);
}
