export const CONNECT4_ROWS = 6;
export const CONNECT4_COLS = 7;

/**
 * Creates the initial serializable state for a 7x6 Connect Four match.
 * @param {{ hostId: string, opponentId: string }} params
 */
export function createConnectFourState({ hostId, opponentId }) {
  return {
    board: Array.from({ length: CONNECT4_ROWS }, () => Array(CONNECT4_COLS).fill(null)),
    players: { R: hostId, Y: opponentId },
    currentTurn: 'R',
    currentTurnId: hostId,
    moveCount: 0,
    lastMove: null,
    winnerSymbol: null,
    winnerId: null,
    winningCells: null,
    isDraw: false,
  };
}

/**
 * Returns the lowest empty row index in `colIndex` (`0..6`), or `-1` if full.
 * @param {(string | null)[][]} board
 * @param {number} colIndex
 */
export function findAvailableConnect4Row(board, colIndex) {
  for (let row = CONNECT4_ROWS - 1; row >= 0; row -= 1) {
    if (board[row][colIndex] === null) {
      return row;
    }
  }
  return -1;
}

/**
 * Checks if `symbol` has 4 consecutive pieces horizontally, vertically, or diagonally.
 * @param {(string | null)[][]} board
 * @param {'R' | 'Y'} symbol
 * @returns {[number, number][] | null}
 */
export function findConnect4WinningLine(board, symbol) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  for (let r = 0; r < CONNECT4_ROWS; r += 1) {
    for (let c = 0; c < CONNECT4_COLS; c += 1) {
      if (board[r][c] !== symbol) continue;
      for (const [dr, dc] of directions) {
        const line = [[r, c]];
        for (let step = 1; step < 4; step += 1) {
          const nr = r + dr * step;
          const nc = c + dc * step;
          if (
            nr < 0 ||
            nr >= CONNECT4_ROWS ||
            nc < 0 ||
            nc >= CONNECT4_COLS ||
            board[nr][nc] !== symbol
          ) {
            break;
          }
          line.push([nr, nc]);
        }
        if (line.length === 4) {
          return line;
        }
      }
    }
  }
  return null;
}

/**
 * Validates and drops a piece into column `colIndex` (`0..6`).
 * @param {object} state
 * @param {string} userId
 * @param {number} colIndex
 */
export function applyConnectFourDrop(state, userId, colIndex) {
  if (!state || state.winnerId || state.isDraw) {
    return { ok: false, error: 'Pertandingan Connect Four ini sudah berakhir.' };
  }
  if (userId !== state.players.R && userId !== state.players.Y) {
    return { ok: false, error: 'Kamu tidak terdaftar dalam pertandingan ini.' };
  }
  if (userId !== state.currentTurnId) {
    return { ok: false, error: 'Sekarang bukan giliranmu!' };
  }
  if (!Number.isInteger(colIndex) || colIndex < 0 || colIndex >= CONNECT4_COLS) {
    return { ok: false, error: 'Nomor kolom tidak valid (pilih 1–7).' };
  }

  const targetRow = findAvailableConnect4Row(state.board, colIndex);
  if (targetRow === -1) {
    return { ok: false, error: `Kolom ${colIndex + 1} sudah penuh! Pilih kolom lain.` };
  }

  const nextBoard = state.board.map((row) => [...row]);
  const symbol = state.currentTurn;
  nextBoard[targetRow][colIndex] = symbol;

  const winningCells = findConnect4WinningLine(nextBoard, symbol);
  const nextMoveCount = state.moveCount + 1;
  const isDraw = !winningCells && nextMoveCount >= CONNECT4_ROWS * CONNECT4_COLS;
  const finished = Boolean(winningCells) || isDraw;
  const winnerId = winningCells ? state.players[symbol] : null;
  const nextTurn = symbol === 'R' ? 'Y' : 'R';

  const nextState = {
    ...state,
    board: nextBoard,
    moveCount: nextMoveCount,
    lastMove: { row: targetRow, col: colIndex, symbol },
    currentTurn: finished ? state.currentTurn : nextTurn,
    currentTurnId: finished ? null : state.players[nextTurn],
    winnerSymbol: winningCells ? symbol : null,
    winnerId,
    winningCells,
    isDraw,
  };

  return {
    ok: true,
    state: nextState,
    row: targetRow,
    col: colIndex,
    finished,
    winnerId,
    isDraw,
  };
}
