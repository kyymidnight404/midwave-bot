import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoinFlipGame } from '../../src/games/CoinFlipGame.js';
import { DiceGame } from '../../src/games/DiceGame.js';
import { RPSGame, resolveRpsWinner } from '../../src/games/RPSGame.js';
import { GuessGame } from '../../src/games/GuessGame.js';
import { BOT_PLAYER_ID, GAME_MODES, MATCH_STATUS } from '../../src/utils/constants.js';
import { createSeededRng } from '../../src/utils/random.js';

const fixedPickRng = (val) => ({
  int: () => 1,
  pick: () => val,
  shuffle: (arr) => [...arr],
});

describe('CoinFlipGame', () => {
  it('handles solo win and loss deterministically', () => {
    const s1 = CoinFlipGame.create({ mode: GAME_MODES.SOLO }, ['p1', BOT_PLAYER_ID]);
    const win = CoinFlipGame.applyAction(s1, 'p1', { choice: 'heads' }, fixedPickRng('heads'));
    assert.equal(win.finished, true);
    assert.equal(win.result.winnerId, 'p1');

    const s2 = CoinFlipGame.create({ mode: GAME_MODES.SOLO }, ['p1', BOT_PLAYER_ID]);
    const loss = CoinFlipGame.applyAction(s2, 'p1', { choice: 'heads' }, fixedPickRng('tails'));
    assert.equal(loss.finished, true);
    assert.equal(loss.result.winnerId, BOT_PLAYER_ID);
  });

  it('evaluates all 8 multiplayer combinations (same prediction -> Draw, different -> winner) and hides secret choices', () => {
    const choices = ['heads', 'tails'];
    for (const c1 of choices) {
      for (const c2 of choices) {
        for (const coin of choices) {
          let state = CoinFlipGame.create({ mode: GAME_MODES.MULTIPLAYER }, ['p1', 'p2']);
          const step1 = CoinFlipGame.applyAction(state, 'p1', { choice: c1 }, fixedPickRng(coin));
          assert.equal(step1.finished, false);

          // Secret must NOT leak in public view before p2 chooses
          const pub = CoinFlipGame.getPublicView(step1.state);
          assert.equal(pub.boardOrInfo.toLowerCase().includes(c1), false);

          // p1 cannot change choice
          const dup = CoinFlipGame.applyAction(step1.state, 'p1', { choice: c2 }, fixedPickRng(coin));
          assert.ok(dup.error);

          const step2 = CoinFlipGame.applyAction(step1.state, 'p2', { choice: c2 }, fixedPickRng(coin));
          assert.equal(step2.finished, true);

          if (c1 === c2) {
            assert.equal(step2.result.isDraw, true);
            assert.equal(step2.result.winnerId, null);
          } else {
            assert.equal(step2.result.isDraw, false);
            assert.equal(step2.result.winnerId, c1 === coin ? 'p1' : 'p2');
          }
        }
      }
    }
  });
});

describe('DiceGame', () => {
  it('rolls valid dice in solo mode and enforces limits', () => {
    const rng = createSeededRng(99);
    const state = DiceGame.create({ mode: GAME_MODES.SOLO, count: 5, sides: 20 }, ['p1', BOT_PLAYER_ID], rng);
    const out = DiceGame.applyAction(state, 'p1', {}, rng);
    assert.equal(out.finished, true);
    const roll = out.state.rollsByPlayer.p1;
    assert.equal(roll.rolls.length, 5);
    assert.ok(roll.rolls.every((n) => n >= 1 && n <= 20));
    assert.equal(
      roll.total,
      roll.rolls.reduce((a, b) => a + b, 0),
    );

    assert.throws(() => DiceGame.create({ count: 11, sides: 6 }, ['p1', BOT_PLAYER_ID]));
    assert.throws(() => DiceGame.create({ count: 1, sides: 101 }, ['p1', BOT_PLAYER_ID]));
  });

  it('resolves multiplayer winner and draw immediately on creation', () => {
    // Sequence returning 6 then 2 -> p1 wins
    let idx = 0;
    const seq1 = [6, 2];
    const winState = DiceGame.create(
      { mode: GAME_MODES.MULTIPLAYER, count: 1, sides: 6 },
      ['p1', 'p2'],
      { int: () => seq1[idx++] },
    );
    assert.equal(winState.status, MATCH_STATUS.FINISHED);
    assert.equal(winState.result.winnerId, 'p1');
    assert.equal(winState.result.isDraw, false);

    // Equal totals -> draw
    const drawState = DiceGame.create(
      { mode: GAME_MODES.MULTIPLAYER, count: 2, sides: 6 },
      ['p1', 'p2'],
      { int: () => 4 },
    );
    assert.equal(drawState.status, MATCH_STATUS.FINISHED);
    assert.equal(drawState.result.isDraw, true);
  });
});

describe('RPSGame', () => {
  it('resolves all 9 RPS combinations accurately', () => {
    const expected = {
      'rock:rock': 'draw',
      'rock:scissors': 'p1',
      'rock:paper': 'p2',
      'paper:paper': 'draw',
      'paper:rock': 'p1',
      'paper:scissors': 'p2',
      'scissors:scissors': 'draw',
      'scissors:paper': 'p1',
      'scissors:rock': 'p2',
    };
    for (const [key, exp] of Object.entries(expected)) {
      const [c1, c2] = key.split(':');
      assert.equal(resolveRpsWinner(c1, c2), exp);
    }
  });

  it('keeps multiplayer choices secret until both players lock in', () => {
    const state = RPSGame.create({ mode: GAME_MODES.MULTIPLAYER }, ['p1', 'p2']);
    const s1 = RPSGame.applyAction(state, 'p1', { choice: 'rock' });
    assert.equal(s1.finished, false);

    const pub = RPSGame.getPublicView(s1.state);
    assert.equal(pub.boardOrInfo.toLowerCase().includes('rock'), false);

    const s2 = RPSGame.applyAction(s1.state, 'p2', { choice: 'scissors' });
    assert.equal(s2.finished, true);
    assert.equal(s2.result.winnerId, 'p1');
  });
});

describe('GuessGame', () => {
  it('configures Easy/Normal/Hard ranges and attempt limits accurately', () => {
    const rng = { int: (min, max) => max };
    const easy = GuessGame.create({ difficulty: 'easy', mode: GAME_MODES.SOLO }, ['p1', BOT_PLAYER_ID], rng);
    assert.deepEqual([easy.min, easy.max, easy.maxAttempts, easy.secret], [1, 50, 8, 50]);

    const normal = GuessGame.create({ difficulty: 'normal', mode: GAME_MODES.SOLO }, ['p1', BOT_PLAYER_ID], rng);
    assert.deepEqual([normal.min, normal.max, normal.maxAttempts, normal.secret], [1, 100, 10, 100]);

    const hard = GuessGame.create({ difficulty: 'hard', mode: GAME_MODES.SOLO }, ['p1', BOT_PLAYER_ID], rng);
    assert.deepEqual([hard.min, hard.max, hard.maxAttempts, hard.secret], [1, 200, 12, 200]);
  });

  it('provides Higher/Lower hints, hides secret, enforces turns, and handles exhaustion', () => {
    const rng = { int: () => 42 };
    let state = GuessGame.create({ difficulty: 'easy', mode: GAME_MODES.MULTIPLAYER }, ['p1', 'p2'], rng);

    // Out-of-turn blocked
    const wrongTurn = GuessGame.applyAction(state, 'p2', { number: 10 });
    assert.ok(wrongTurn.error);

    // Out-of-range blocked
    const outRange = GuessGame.applyAction(state, 'p1', { number: 51 });
    assert.ok(outRange.error);

    // Higher hint
    const g1 = GuessGame.applyAction(state, 'p1', { number: 20 });
    assert.equal(g1.state.lastHint, 'Higher');
    assert.equal(g1.state.currentTurn, 'p2');
    assert.equal(GuessGame.getPublicView(g1.state).boardOrInfo.includes('42'), false);

    // Lower hint
    const g2 = GuessGame.applyAction(g1.state, 'p2', { number: 49 });
    assert.equal(g2.state.lastHint, 'Lower');

    // Correct guess wins
    const g3 = GuessGame.applyAction(g2.state, 'p1', { number: 42 });
    assert.equal(g3.finished, true);
    assert.equal(g3.result.winnerId, 'p1');

    // Exhaustion in solo -> Bot wins; in multiplayer -> Draw
    let solo = GuessGame.create({ difficulty: 'easy', mode: GAME_MODES.SOLO }, ['p1', BOT_PLAYER_ID], rng);
    for (let i = 0; i < 8; i += 1) {
      const res = GuessGame.applyAction(solo, 'p1', { number: 1 });
      solo = res.state;
      if (i === 7) {
        assert.equal(res.finished, true);
        assert.equal(res.result.winnerId, BOT_PLAYER_ID);
      }
    }
  });
});
