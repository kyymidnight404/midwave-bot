export const TTT_WIN_LINES = Object.freeze([
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
 * Creates the initial serializable state for a 2-player Tic Tac Toe match.
 * @param {{ hostId: string, opponentId: string }} params
 */
export function createTicTacToeState({ hostId, opponentId }) {
  return {
    board: Array(9).fill(null),
    players: { X: hostId, O: opponentId },
    currentTurn: 'X',
    currentTurnId: hostId,
    moveCount: 0,
    winnerSymbol: null,
    winnerId: null,
    winningLine: null,
    isDraw: false,
  };
}

/**
 * Evaluates a 9-cell Tic Tac Toe board for win or draw.
 * @param {(string | null)[]} board
 */
export function evaluateTicTacToeBoard(board) {
  for (const line of TTT_WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { status: 'win', winnerSymbol: board[a], line };
    }
  }
  if (board.every((cell) => cell !== null)) {
    return { status: 'draw', winnerSymbol: null, line: null };
  }
  return { status: 'ongoing', winnerSymbol: null, line: null };
}

/**
 * Validates and applies a Tic Tac Toe move on cell `0..8`.
 * @param {object} state
 * @param {string} userId
 * @param {number} cellIndex
 */
export function applyTicTacToeMove(state, userId, cellIndex) {
  if (!state || state.winnerId || state.isDraw) {
    return { ok: false, error: 'Pertandingan Tic Tac Toe ini sudah berakhir.' };
  }
  if (userId !== state.players.X && userId !== state.players.O) {
    return { ok: false, error: 'Kamu tidak terdaftar dalam pertandingan ini.' };
  }
  if (userId !== state.currentTurnId) {
    return { ok: false, error: 'Sekarang bukan giliranmu!' };
  }
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 8) {
    return { ok: false, error: 'Posisi papan tidak valid.' };
  }
  if (state.board[cellIndex] !== null) {
    return { ok: false, error: 'Posisi ini sudah terisi! Pilih kotak lain.' };
  }

  const nextBoard = [...state.board];
  const symbol = state.currentTurn;
  nextBoard[cellIndex] = symbol;

  const evalResult = evaluateTicTacToeBoard(nextBoard);
  const finished = evalResult.status !== 'ongoing';
  const nextTurn = symbol === 'X' ? 'O' : 'X';
  const winnerId = evalResult.status === 'win' ? state.players[evalResult.winnerSymbol] : null;
  const isDraw = evalResult.status === 'draw';

  const nextState = {
    ...state,
    board: nextBoard,
    moveCount: state.moveCount + 1,
    currentTurn: finished ? state.currentTurn : nextTurn,
    currentTurnId: finished ? null : state.players[nextTurn],
    winnerSymbol: evalResult.winnerSymbol,
    winnerId,
    winningLine: evalResult.line,
    isDraw,
  };

  return {
    ok: true,
    state: nextState,
    finished,
    winnerId,
    isDraw,
  };
}
