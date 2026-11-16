import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoinFlipGame } from '../../src/games/CoinFlipGame.js';
import { RPSGame, resolveRpsWinner } from '../../src/games/RPSGame.js';
import { BOT_PLAYER_ID, GAME_MODES } from '../../src/utils/constants.js';

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
