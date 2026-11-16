import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTicTacToeMove,
  createTicTacToeState,
} from '../../src/games/engines/ticTacToe.js';
import {
  applyRpsPick,
  createRpsMatchState,
  resolveRpsRoundPair,
} from '../../src/games/engines/rockPaperScissors.js';
import {
  advanceQuizRound,
  createDirectQuizState,
  createQuizLobbyState,
  joinQuizLobby,
  leaveQuizLobby,
  QUIZ_MAX_PLAYERS,
  QUIZ_POINTS_CORRECT,
  QUIZ_WINNER_BONUS,
  resolveQuizRound,
  startQuizBattle,
  submitQuizAnswer,
} from '../../src/games/engines/quizBattle.js';
import { shuffleQuestionOptions } from '../../src/games/services/questionService.js';
import { calculateWinRate } from '../../src/games/services/scoreService.js';

describe('Game Center: Tic Tac Toe Engine', () => {
  it('detects horizontal, vertical, and diagonal wins', () => {
    // Horizontal win on top row: X at 0,1,2; O at 3,4
    let s = createTicTacToeState({ hostId: 'p1', opponentId: 'p2' });
    s = applyTicTacToeMove(s, 'p1', 0).state;
    s = applyTicTacToeMove(s, 'p2', 3).state;
    s = applyTicTacToeMove(s, 'p1', 1).state;
    s = applyTicTacToeMove(s, 'p2', 4).state;
    const hWin = applyTicTacToeMove(s, 'p1', 2);
    assert.equal(hWin.finished, true);
    assert.equal(hWin.winnerId, 'p1');
    assert.deepEqual(hWin.state.winningLine, [0, 1, 2]);

    // Vertical win on middle column: X at 1,4,7; O at 0,2
    s = createTicTacToeState({ hostId: 'p1', opponentId: 'p2' });
    s = applyTicTacToeMove(s, 'p1', 1).state;
    s = applyTicTacToeMove(s, 'p2', 0).state;
    s = applyTicTacToeMove(s, 'p1', 4).state;
    s = applyTicTacToeMove(s, 'p2', 2).state;
    const vWin = applyTicTacToeMove(s, 'p1', 7);
    assert.equal(vWin.finished, true);
    assert.equal(vWin.winnerId, 'p1');
    assert.deepEqual(vWin.state.winningLine, [1, 4, 7]);

    // Diagonal win (2,4,6) for O
    s = createTicTacToeState({ hostId: 'p1', opponentId: 'p2' });
    s = applyTicTacToeMove(s, 'p1', 0).state;
    s = applyTicTacToeMove(s, 'p2', 2).state;
    s = applyTicTacToeMove(s, 'p1', 1).state;
    s = applyTicTacToeMove(s, 'p2', 4).state;
    s = applyTicTacToeMove(s, 'p1', 5).state;
    const dWin = applyTicTacToeMove(s, 'p2', 6);
    assert.equal(dWin.finished, true);
    assert.equal(dWin.winnerId, 'p2');
    assert.deepEqual(dWin.state.winningLine, [2, 4, 6]);
  });

  it('detects draw and rejects invalid turns, outsiders, and occupied cells', () => {
    let s = createTicTacToeState({ hostId: 'p1', opponentId: 'p2' });

    // Wrong turn (p2 tries to move first)
    const wrongTurn = applyTicTacToeMove(s, 'p2', 0);
    assert.equal(wrongTurn.ok, false);

    // Outsider
    const outsider = applyTicTacToeMove(s, 'outsider', 0);
    assert.equal(outsider.ok, false);

    // Move to 0, then try occupied cell 0
    s = applyTicTacToeMove(s, 'p1', 0).state;
    const occupied = applyTicTacToeMove(s, 'p2', 0);
    assert.equal(occupied.ok, false);

    // Play out full draw:
    // X O X
    // X O O
    // O X X
    const moves = [
      ['p2', 1],
      ['p1', 2],
      ['p2', 4],
      ['p1', 3],
      ['p2', 5],
      ['p1', 7],
      ['p2', 6],
    ];
    for (const [player, cell] of moves) {
      s = applyTicTacToeMove(s, player, cell).state;
    }
    const drawRes = applyTicTacToeMove(s, 'p1', 8);
    assert.equal(drawRes.ok, true);
    assert.equal(drawRes.finished, true);
    assert.equal(drawRes.isDraw, true);
    assert.equal(drawRes.winnerId, null);
  });
});

describe('Game Center: Rock Paper Scissors (Best of 3) Engine', () => {
  it('evaluates all 9 combinations and prevents revealing/changing picks until both choose', () => {
    const combos = [
      ['rock', 'rock', 'draw'],
      ['rock', 'paper', 'p2'],
      ['rock', 'scissors', 'p1'],
      ['paper', 'rock', 'p1'],
      ['paper', 'paper', 'draw'],
      ['paper', 'scissors', 'p2'],
      ['scissors', 'rock', 'p2'],
      ['scissors', 'paper', 'p1'],
      ['scissors', 'scissors', 'draw'],
    ];
    for (const [c1, c2, expected] of combos) {
      assert.equal(resolveRpsRoundPair(c1, c2), expected);
    }

    let s = createRpsMatchState({ hostId: 'p1', opponentId: 'p2' });
    const pick1 = applyRpsPick(s, 'p1', 'rock');
    assert.equal(pick1.ok, true);
    assert.equal(pick1.roundCompleted, false);
    s = pick1.state;

    // Duplicate / changing pick in same round must be rejected
    assert.equal(applyRpsPick(s, 'p1', 'paper').ok, false);

    // Round 1 tie
    const r1 = applyRpsPick(s, 'p2', 'rock');
    assert.equal(r1.roundCompleted, true);
    assert.equal(r1.lastRound.isDraw, true);
    assert.equal(r1.finished, false);
    s = r1.state;

    // Round 2 p1 wins (1-0)
    s = applyRpsPick(s, 'p1', 'paper').state;
    const r2 = applyRpsPick(s, 'p2', 'rock');
    assert.equal(r2.state.scores.p1, 1);
    assert.equal(r2.finished, false);
    s = r2.state;

    // Round 3 p1 wins again (2-0) -> Best of 3 match ends
    s = applyRpsPick(s, 'p1', 'scissors').state;
    const r3 = applyRpsPick(s, 'p2', 'paper');
    assert.equal(r3.finished, true);
    assert.equal(r3.winnerId, 'p1');
    assert.equal(r3.state.scores.p1, 2);
  });
});

describe('Game Center: Quiz Battle Engine & Utilities', () => {
  it('enforces lobby join/leave/bounds (2-10), round correct-count tally, duplicate answer rejection, and zero bonus points', () => {
    assert.equal(QUIZ_POINTS_CORRECT, 1);
    assert.equal(QUIZ_WINNER_BONUS, 0);
    let lobby = createQuizLobbyState({ hostId: 'host' });

    // Cannot start with < 2 players
    const questions = [
      { id: 1, category: 'general', difficulty: 'easy', question: 'Q1', options: ['A', 'B', 'C', 'D'], correctIndex: 1 },
      { id: 2, category: 'general', difficulty: 'easy', question: 'Q2', options: ['A', 'B', 'C', 'D'], correctIndex: 2 },
    ];
    assert.equal(startQuizBattle(lobby, 'host', questions).ok, false);

    // Non-host cannot start
    lobby = joinQuizLobby(lobby, 'p2').state;
    assert.equal(startQuizBattle(lobby, 'p2', questions).ok, false);

    // Duplicate join rejected
    assert.equal(joinQuizLobby(lobby, 'p2').ok, false);

    // Fill up to 10 players and verify 11th is rejected
    let fullLobby = lobby;
    for (let i = 3; i <= QUIZ_MAX_PLAYERS; i += 1) {
      fullLobby = joinQuizLobby(fullLobby, `p${i}`).state;
    }
    assert.equal(fullLobby.players.length, QUIZ_MAX_PLAYERS);
    assert.equal(joinQuizLobby(fullLobby, 'p11').ok, false);

    // Leave transfers host when host leaves
    const afterHostLeave = leaveQuizLobby(lobby, 'host');
    assert.equal(afterHostLeave.ok, true);
    assert.equal(afterHostLeave.state.hostId, 'p2');

    // Start 2-player quiz match
    let match = startQuizBattle(lobby, 'host', questions).state;
    assert.equal(match.phase, 'question');

    // Outsider cannot answer
    assert.equal(submitQuizAnswer(match, 'outsider', 1).ok, false);

    // Host answers correctly (1), p2 answers wrong (0)
    const a1 = submitQuizAnswer(match, 'host', 1);
    assert.equal(a1.ok, true);
    assert.equal(a1.allAnswered, false);
    match = a1.state;

    // Host cannot answer twice in the same round
    assert.equal(submitQuizAnswer(match, 'host', 2).ok, false);

    const a2 = submitQuizAnswer(match, 'p2', 0);
    assert.equal(a2.allAnswered, true);
    match = a2.state;

    // Resolve round 1
    const res1 = resolveQuizRound(match);
    assert.equal(res1.ok, true);
    assert.equal(res1.state.scores.host, QUIZ_POINTS_CORRECT);
    assert.equal(res1.state.scores.p2, 0);
    // Idempotent resolution guard
    assert.equal(resolveQuizRound(res1.state).alreadyResolved, true);

    // Advance to round 2 -> simulate timeout for both players
    match = advanceQuizRound(res1.state).state;
    assert.equal(match.round, 2);
    const res2 = resolveQuizRound(match);
    assert.equal(res2.state.scores.host, QUIZ_POINTS_CORRECT);
    assert.equal(res2.state.scores.p2, 0);

    // Finalize match -> winner gets +5 bonus
    const finalRes = advanceQuizRound(res2.state);
    assert.equal(finalRes.finished, true);
    assert.equal(finalRes.winnerId, 'host');
    assert.equal(finalRes.state.scores.host, QUIZ_POINTS_CORRECT + QUIZ_WINNER_BONUS);
  });

  it('supports direct-start solo and drop-in multiplayer Quiz Battle via autoJoin', () => {
    const questions = [
      { id: 1, category: 'science', difficulty: 'easy', question: 'Q1', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
      { id: 2, category: 'science', difficulty: 'easy', question: 'Q2', options: ['A', 'B', 'C', 'D'], correctIndex: 3 },
    ];
    let state = createDirectQuizState({ hostId: 'host', preparedQuestions: questions });
    assert.equal(state.phase, 'question');
    assert.equal(state.round, 1);
    assert.deepEqual(state.players, ['host']);

    // Drop-in second player answers first in round 1
    const p2Ans = submitQuizAnswer(state, 'p2', 2, { autoJoin: true });
    assert.equal(p2Ans.ok, true);
    assert.equal(p2Ans.joined, true);
    assert.equal(p2Ans.allAnswered, false);
    state = p2Ans.state;

    // Host answers round 1 -> allAnswered becomes true
    const hostAns = submitQuizAnswer(state, 'host', 0, { autoJoin: true });
    assert.equal(hostAns.ok, true);
    assert.equal(hostAns.joined, false);
    assert.equal(hostAns.allAnswered, true);
    state = resolveQuizRound(hostAns.state).state;
    assert.equal(state.scores.host, QUIZ_POINTS_CORRECT);
    assert.equal(state.scores.p2, 0);

    // Solo finish check (1 player finishes without artificial +5 bonus)
    let solo = createDirectQuizState({ hostId: 'soloUser', preparedQuestions: [questions[0]] });
    solo = submitQuizAnswer(solo, 'soloUser', 0, { autoJoin: true }).state;
    solo = resolveQuizRound(solo).state;
    const soloDone = advanceQuizRound(solo);
    assert.equal(soloDone.finished, true);
    assert.equal(soloDone.winnerId, 'soloUser');
    assert.equal(soloDone.state.scores.soloUser, QUIZ_POINTS_CORRECT);
  });

  it('shuffles question options while preserving the exact correct answer and computes win rate safely', () => {
    const opts = ['Wrong 1', 'Right Answer', 'Wrong 2', 'Wrong 3'];
    const shuffled = shuffleQuestionOptions(opts, 1);
    assert.equal(shuffled.options.length, 4);
    assert.equal(shuffled.options[shuffled.correctIndex], 'Right Answer');

    // Zero division guard
    assert.equal(calculateWinRate(0, 0), 0);
    assert.equal(calculateWinRate(5, 0), 0);
    assert.equal(calculateWinRate(3, 4), 75);
  });
});
