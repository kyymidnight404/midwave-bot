import { performance } from 'node:perf_hooks';
import { CONNECT4_CONFIG } from '../../utils/constants.js';
import { defaultRng } from '../../utils/random.js';

const { ROWS, COLS } = CONNECT4_CONFIG;
// Search center columns first for maximum alpha-beta pruning efficiency
const CENTER_ORDER = [3, 2, 4, 1, 5, 0, 6];
const WIN_SCORE = 1_000_000;

/**
 * Creates an empty 6x7 Connect Four board (0 = empty, 1 = P1, 2 = P2).
 * @returns {number[][]}
 */
export function createEmptyConnect4Board() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

/**
 * Returns 0-based indices of columns that still have at least one empty cell.
 * @param {number[][]} board
 * @returns {number[]}
 */
export function getLegalConnect4Columns(board) {
  const cols = [];
  for (const col of CENTER_ORDER) {
    if (board[0][col] === 0) cols.push(col);
  }
  return cols;
}

/**
 * Finds the lowest empty row index (0..5) in `col`, or -1 if full.
 * @param {number[][]} board
 * @param {number} col
 * @returns {number}
 */
export function findDropRow(board, col) {
  if (col < 0 || col >= COLS) return -1;
  for (let r = ROWS - 1; r >= 0; r -= 1) {
    if (board[r][col] === 0) return r;
  }
  return -1;
}

/**
 * Checks if `mark` has 4 connected pieces on `board`.
 * @param {number[][]} board
 * @param {number} mark
 * @returns {boolean}
 */
export function hasConnect4Win(board, mark) {
  // Horizontal
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c <= COLS - 4; c += 1) {
      if (
        board[r][c] === mark &&
        board[r][c + 1] === mark &&
        board[r][c + 2] === mark &&
        board[r][c + 3] === mark
      ) {
        return true;
      }
    }
  }
  // Vertical
  for (let r = 0; r <= ROWS - 4; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      if (
        board[r][c] === mark &&
        board[r + 1][c] === mark &&
        board[r + 2][c] === mark &&
        board[r + 3][c] === mark
      ) {
        return true;
      }
    }
  }
  // Diagonal down-right (\)
  for (let r = 0; r <= ROWS - 4; r += 1) {
    for (let c = 0; c <= COLS - 4; c += 1) {
      if (
        board[r][c] === mark &&
        board[r + 1][c + 1] === mark &&
        board[r + 2][c + 2] === mark &&
        board[r + 3][c + 3] === mark
      ) {
        return true;
      }
    }
  }
  // Diagonal up-right (/)
  for (let r = 3; r < ROWS; r += 1) {
    for (let c = 0; c <= COLS - 4; c += 1) {
      if (
        board[r][c] === mark &&
        board[r - 1][c + 1] === mark &&
        board[r - 2][c + 2] === mark &&
        board[r - 3][c + 3] === mark
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if the board is completely full (draw if no winner).
 * @param {number[][]} board
 * @returns {boolean}
 */
export function isConnect4BoardFull(board) {
  for (let c = 0; c < COLS; c += 1) {
    if (board[0][c] === 0) return false;
  }
  return true;
}

function scoreWindow(a, b, c, d, aiMark, oppMark) {
  let aiCount = 0;
  let oppCount = 0;
  let emptyCount = 0;

  if (a === aiMark) aiCount += 1;
  else if (a === oppMark) oppCount += 1;
  else emptyCount += 1;

  if (b === aiMark) aiCount += 1;
  else if (b === oppMark) oppCount += 1;
  else emptyCount += 1;

  if (c === aiMark) aiCount += 1;
  else if (c === oppMark) oppCount += 1;
  else emptyCount += 1;

  if (d === aiMark) aiCount += 1;
  else if (d === oppMark) oppCount += 1;
  else emptyCount += 1;

  if (aiCount === 4) return 10_000;
  if (oppCount === 4) return -10_000;
  if (aiCount === 3 && emptyCount === 1) return 18;
  if (aiCount === 2 && emptyCount === 2) return 4;
  if (oppCount === 3 && emptyCount === 1) return -22;
  if (oppCount === 2 && emptyCount === 2) return -3;
  return 0;
}

/**
 * Heuristic board evaluation from `aiMark`'s perspective.
 * @param {number[][]} board
 * @param {number} aiMark
 * @param {number} oppMark
 * @returns {number}
 */
export function evaluateConnect4Position(board, aiMark, oppMark) {
  let score = 0;

  // Center column control bonus
  const centerCol = Math.floor(COLS / 2);
  let centerCount = 0;
  for (let r = 0; r < ROWS; r += 1) {
    if (board[r][centerCol] === aiMark) centerCount += 1;
    else if (board[r][centerCol] === oppMark) centerCount -= 1;
  }
  score += centerCount * 6;

  // Horizontal windows
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c <= COLS - 4; c += 1) {
      score += scoreWindow(board[r][c], board[r][c + 1], board[r][c + 2], board[r][c + 3], aiMark, oppMark);
    }
  }
  // Vertical windows
  for (let r = 0; r <= ROWS - 4; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      score += scoreWindow(board[r][c], board[r + 1][c], board[r + 2][c], board[r + 3][c], aiMark, oppMark);
    }
  }
  // Diagonal down-right
  for (let r = 0; r <= ROWS - 4; r += 1) {
    for (let c = 0; c <= COLS - 4; c += 1) {
      score += scoreWindow(
        board[r][c],
        board[r + 1][c + 1],
        board[r + 2][c + 2],
        board[r + 3][c + 3],
        aiMark,
        oppMark,
      );
    }
  }
  // Diagonal up-right
  for (let r = 3; r < ROWS; r += 1) {
    for (let c = 0; c <= COLS - 4; c += 1) {
      score += scoreWindow(
        board[r][c],
        board[r - 1][c + 1],
        board[r - 2][c + 2],
        board[r - 3][c + 3],
        aiMark,
        oppMark,
      );
    }
  }

  return score;
}

function findImmediateWinCol(board, mark) {
  for (const col of CENTER_ORDER) {
    const row = findDropRow(board, col);
    if (row === -1) continue;
    board[row][col] = mark;
    const won = hasConnect4Win(board, mark);
    board[row][col] = 0;
    if (won) return col;
  }
  return -1;
}

function alphaBeta(board, depth, alpha, beta, maximizing, aiMark, oppMark, ctx) {
  ctx.nodes += 1;
  if ((ctx.nodes & 255) === 0 && performance.now() >= ctx.deadline) {
    ctx.aborted = true;
    return 0;
  }

  if (hasConnect4Win(board, aiMark)) return WIN_SCORE + depth;
  if (hasConnect4Win(board, oppMark)) return -WIN_SCORE - depth;
  const legal = getLegalConnect4Columns(board);
  if (legal.length === 0) return 0;
  if (depth === 0) return evaluateConnect4Position(board, aiMark, oppMark);

  if (maximizing) {
    let value = -Infinity;
    for (const col of legal) {
      const row = findDropRow(board, col);
      board[row][col] = aiMark;
      const evalScore = alphaBeta(board, depth - 1, alpha, beta, false, aiMark, oppMark, ctx);
      board[row][col] = 0;
      if (ctx.aborted) return 0;
      if (evalScore > value) value = evalScore;
      if (value > alpha) alpha = value;
      if (alpha >= beta) break;
    }
    return value;
  }

  let value = Infinity;
  for (const col of legal) {
    const row = findDropRow(board, col);
    board[row][col] = oppMark;
    const evalScore = alphaBeta(board, depth - 1, alpha, beta, true, aiMark, oppMark, ctx);
    board[row][col] = 0;
    if (ctx.aborted) return 0;
    if (evalScore < value) value = evalScore;
    if (value < beta) beta = value;
    if (alpha >= beta) break;
  }
  return value;
}

function searchBestColumn(board, maxDepth, timeBudgetMs, aiMark, oppMark, preferredOrder) {
  const deadline = performance.now() + timeBudgetMs;
  let bestCol = preferredOrder[0];

  // Iterative deepening ensures a valid best move is ready even if budget expires at deeper ply
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const ctx = { deadline, aborted: false, nodes: 0 };
    let depthBestCol = bestCol;
    let depthBestScore = -Infinity;

    // Put previous iteration's best move first to sharpen pruning
    const orderedCols = [bestCol, ...preferredOrder.filter((c) => c !== bestCol)];

    for (const col of orderedCols) {
      const row = findDropRow(board, col);
      if (row === -1) continue;
      board[row][col] = aiMark;
      const score = alphaBeta(board, depth - 1, -Infinity, Infinity, false, aiMark, oppMark, ctx);
      board[row][col] = 0;
      if (ctx.aborted) break;
      if (score > depthBestScore) {
        depthBestScore = score;
        depthBestCol = col;
      }
    }

    if (ctx.aborted) break;
    bestCol = depthBestCol;
    if (depthBestScore >= WIN_SCORE) break;
  }

  return bestCol;
}

/**
 * Chooses a 0-based legal column index (0..6) for Connect Four AI.
 * @param {number[][]} board
 * @param {'easy' | 'normal' | 'hard'} [difficulty='normal']
 * @param {number} [aiMark=2]
 * @param {object} [rng]
 * @param {{ maxDepth?: number, timeBudgetMs?: number }} [overrides]
 * @returns {number}
 */
export function chooseConnect4Move(
  board,
  difficulty = 'normal',
  aiMark = 2,
  rng = defaultRng,
  overrides = {},
) {
  const legal = getLegalConnect4Columns(board);
  if (legal.length === 0) return -1;

  const oppMark = aiMark === 2 ? 1 : 2;
  const work = board.map((row) => [...row]);

  if (difficulty === 'easy') {
    return rng.pick(legal);
  }

  // Always take an immediate win or block an immediate opponent win in Normal/Hard
  const immediateWin = findImmediateWinCol(work, aiMark);
  if (immediateWin !== -1) return immediateWin;

  const immediateBlock = findImmediateWinCol(work, oppMark);
  if (immediateBlock !== -1) return immediateBlock;

  if (difficulty === 'normal') {
    return searchBestColumn(
      work,
      overrides.maxDepth ?? 2,
      overrides.timeBudgetMs ?? 30,
      aiMark,
      oppMark,
      legal,
    );
  }

  // Hard: iterative deepening alpha-beta with strict time budget (maxDepth 6, 50ms budget tuned via bench-c4)
  return searchBestColumn(
    work,
    overrides.maxDepth ?? 6,
    overrides.timeBudgetMs ?? 50,
    aiMark,
    oppMark,
    legal,
  );
}
