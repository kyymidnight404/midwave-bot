import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TicTacToeGame } from '../../src/games/TicTacToeGame.js';
import { chooseTicTacToeMove, evaluateTicTacToeBoard, WIN_LINES } from '../../src/games/ai/ticTacToeAI.js';
import { BOT_PLAYER_ID, GAME_MODES, TTT_POSITIONS } from '../../src/utils/constants.js';
import { createSeededRng } from '../../src/utils/random.js';

describe('TicTacToeGame', () => {
  it('detects all 8 winning lines and draw condition', () => {
    for (const line of WIN_LINES) {
      const board = Array(9).fill(null);
      for (const idx of line) board[idx] = 'X';
      const evalRes = evaluateTicTacToeBoard(board);
      assert.equal(evalRes.winner, 'X');
      assert.equal(evalRes.isDraw, false);
    }

    // Standard draw board: X O X / X O O / O X X
    const drawBoard = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'];
    const drawEval = evaluateTicTacToeBoard(drawBoard);
    assert.equal(drawEval.winner, null);
    assert.equal(drawEval.isDraw, true);
  });

  it('enforces turns, prevents overwriting occupied squares, and runs multiplayer win', () => {
    let state = TicTacToeGame.create({ mode: GAME_MODES.MULTIPLAYER }, ['p1', 'p2']);
    state = TicTacToeGame.applyAction(state, 'p1', { position: 'A1' }).state;

    // Out-of-turn blocked
    assert.ok(TicTacToeGame.applyAction(state, 'p1', { position: 'B1' }).error);
    // Occupied square blocked
    assert.ok(TicTacToeGame.applyAction(state, 'p2', { position: 'A1' }).error);

    state = TicTacToeGame.applyAction(state, 'p2', { position: 'A2' }).state;
    state = TicTacToeGame.applyAction(state, 'p1', { position: 'B1' }).state;
    state = TicTacToeGame.applyAction(state, 'p2', { position: 'B2' }).state;
    const win = TicTacToeGame.applyAction(state, 'p1', { position: 'C1' });
    assert.equal(win.finished, true);
    assert.equal(win.result.winnerId, 'p1');
  });

  it('Hard Minimax AI never loses against any human move sequence', () => {
    const rng = createSeededRng(123);

    function verifyMinimaxUnbeatable(board, humanTurn) {
      const evalRes = evaluateTicTacToeBoard(board);
      if (evalRes.winner === 'X') {
        assert.fail(`Human beat Hard Minimax on board: ${board.join(',')}`);
      }
      if (evalRes.winner === 'O' || evalRes.isDraw) return;

      if (humanTurn) {
        for (let i = 0; i < 9; i += 1) {
          if (board[i] !== null) continue;
          const next = [...board];
          next[i] = 'X';
          verifyMinimaxUnbeatable(next, false);
        }
      } else {
        const aiIdx = chooseTicTacToeMove(board, 'hard', 'O', rng);
        assert.equal(board[aiIdx], null);
        const next = [...board];
        next[aiIdx] = 'O';
        verifyMinimaxUnbeatable(next, true);
      }
    }

    // Check every possible opening move by human
    for (let i = 0; i < 9; i += 1) {
      const board = Array(9).fill(null);
      board[i] = 'X';
      verifyMinimaxUnbeatable(board, false);
    }

    // Also verify solo flow via TicTacToeGame
    let solo = TicTacToeGame.create({ mode: GAME_MODES.SOLO, difficulty: 'hard' }, ['p1', BOT_PLAYER_ID]);
    const step = TicTacToeGame.applyAction(solo, 'p1', { position: TTT_POSITIONS[0] }, rng);
    assert.equal(step.finished, false);
    assert.equal(step.state.board.filter((c) => c === 'O').length, 1);
  });
});
