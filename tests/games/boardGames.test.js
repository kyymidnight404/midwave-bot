import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { TicTacToeGame } from '../../src/games/TicTacToeGame.js';
import { chooseTicTacToeMove, evaluateTicTacToeBoard, WIN_LINES } from '../../src/games/ai/ticTacToeAI.js';
import { ConnectFourGame } from '../../src/games/ConnectFourGame.js';
import {
  chooseConnect4Move,
  createEmptyConnect4Board,
  hasConnect4Win,
} from '../../src/games/ai/connectFourAI.js';
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

describe('ConnectFourGame', () => {
  it('detects horizontal, vertical, both diagonal wins, and draw', () => {
    // Horizontal win
    const h = createEmptyConnect4Board();
    h[5][1] = 1;
    h[5][2] = 1;
    h[5][3] = 1;
    h[5][4] = 1;
    assert.equal(hasConnect4Win(h, 1), true);

    // Vertical win
    const v = createEmptyConnect4Board();
    v[5][0] = 2;
    v[4][0] = 2;
    v[3][0] = 2;
    v[2][0] = 2;
    assert.equal(hasConnect4Win(v, 2), true);

    // Diagonal \ win
    const d1 = createEmptyConnect4Board();
    d1[2][1] = 1;
    d1[3][2] = 1;
    d1[4][3] = 1;
    d1[5][4] = 1;
    assert.equal(hasConnect4Win(d1, 1), true);

    // Diagonal / win
    const d2 = createEmptyConnect4Board();
    d2[5][1] = 2;
    d2[4][2] = 2;
    d2[3][3] = 2;
    d2[2][4] = 2;
    assert.equal(hasConnect4Win(d2, 2), true);
  });

  it('enforces gravity, full column rejection, turn order, and detects full-board draw', () => {
    let state = ConnectFourGame.create({ mode: GAME_MODES.MULTIPLAYER }, ['p1', 'p2']);

    // Drop 6 pieces in column 1 -> fills column 1
    for (let i = 0; i < 6; i += 1) {
      const player = i % 2 === 0 ? 'p1' : 'p2';
      const out = ConnectFourGame.applyAction(state, player, { column: 1 });
      assert.equal(out.finished, false);
      state = out.state;
    }

    // 7th drop in column 1 fails
    const fullColErr = ConnectFourGame.applyAction(state, 'p1', { column: 1 });
    assert.ok(fullColErr.error);

    // Test draw detection on an almost-full draw board (1 cell left at top of col 7)
    // Pattern per column avoids any 4-in-a-row horizontally, vertically, or diagonally:
    // Row 0..5 alternating blocks of 3x3:
    // Cols 0,1,2 and 4,5,6: [1,1,2,2,1,1] / [2,2,1,1,2,2] etc.
    const drawTemplate = [
      [1, 2, 1, 2, 1, 2, 0], // leave (0,6) empty for final move by p1
      [1, 2, 1, 2, 1, 2, 1],
      [2, 1, 2, 1, 2, 1, 2],
      [2, 1, 2, 1, 2, 1, 2],
      [1, 2, 1, 2, 1, 2, 1],
      [1, 2, 1, 2, 1, 2, 1],
    ];
    assert.equal(hasConnect4Win(drawTemplate, 1), false);
    assert.equal(hasConnect4Win(drawTemplate, 2), false);

    const nearDrawState = {
      ...ConnectFourGame.create({ mode: GAME_MODES.MULTIPLAYER }, ['p1', 'p2']),
      board: drawTemplate,
      currentTurn: 'p1',
    };
    const drawOut = ConnectFourGame.applyAction(nearDrawState, 'p1', { column: 7 });
    assert.equal(drawOut.finished, true);
    assert.equal(drawOut.result.isDraw, true);
  });

  it('Connect Four AI always picks legal moves, takes wins, blocks threats, and stays within time budget', () => {
    const rng = createSeededRng(77);

    // Immediate win detection
    const winBoard = createEmptyConnect4Board();
    winBoard[5][0] = 2;
    winBoard[5][1] = 2;
    winBoard[5][2] = 2;
    assert.equal(chooseConnect4Move(winBoard, 'hard', 2, rng), 3);

    // Immediate block detection
    const blockBoard = createEmptyConnect4Board();
    blockBoard[5][2] = 1;
    blockBoard[4][2] = 1;
    blockBoard[3][2] = 1;
    assert.equal(chooseConnect4Move(blockBoard, 'hard', 2, rng), 2);

    // Time budget assertion on empty/complex boards
    const empty = createEmptyConnect4Board();
    const start = performance.now();
    const move = chooseConnect4Move(empty, 'hard', 2, rng);
    const elapsed = performance.now() - start;
    assert.ok(move >= 0 && move <= 6);
    assert.ok(elapsed < 100, `Hard AI move took ${elapsed.toFixed(2)} ms (> 100 ms budget)`);

    // Solo match flow
    const solo = ConnectFourGame.create({ mode: GAME_MODES.SOLO, difficulty: 'normal' }, ['p1', BOT_PLAYER_ID]);
    const step = ConnectFourGame.applyAction(solo, 'p1', { column: 4 }, rng);
    assert.equal(step.finished, false);
    assert.equal(step.state.board.flat().filter((c) => c !== 0).length, 2);
  });
});
