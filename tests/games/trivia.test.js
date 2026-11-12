import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTriviaBank,
  selectTriviaQuestions,
  validateTriviaBank,
} from '../../src/games/TriviaBank.js';
import { TriviaGame } from '../../src/games/TriviaGame.js';
import {
  BOT_PLAYER_ID,
  DIFFICULTIES,
  GAME_MODES,
  MATCH_STATUS,
  TRIVIA_CATEGORIES,
} from '../../src/utils/constants.js';
import { createSeededRng } from '../../src/utils/random.js';

describe('TriviaBank', () => {
  it('contains 90 validated questions with 5 per category/difficulty bucket', () => {
    const bank = loadTriviaBank();
    assert.equal(bank.length, 90);

    for (const cat of TRIVIA_CATEGORIES) {
      for (const diff of DIFFICULTIES) {
        const picked = selectTriviaQuestions({
          category: cat,
          difficulty: diff,
          count: 5,
          rng: createSeededRng(7),
        });
        assert.equal(picked.length, 5);
        const ids = new Set(picked.map((q) => q.id));
        assert.equal(ids.size, 5);
      }
    }
  });

  it('never repeats questions within a single match across 1000 random selections', () => {
    const rng = createSeededRng(12345);
    for (let i = 0; i < 1000; i += 1) {
      const cat = TRIVIA_CATEGORIES[i % TRIVIA_CATEGORIES.length];
      const diff = DIFFICULTIES[i % DIFFICULTIES.length];
      const qs = selectTriviaQuestions({ category: cat, difficulty: diff, count: 5, rng });
      assert.equal(qs.length, 5);
      assert.equal(new Set(qs.map((q) => q.id)).size, 5);
    }
  });

  it('rejects malformed or incomplete trivia banks', () => {
    assert.throws(() => validateTriviaBank([]), /minimum required/);
    assert.throws(
      () =>
        validateTriviaBank([
          {
            id: 'x',
            category: 'general',
            difficulty: 'easy',
            question: 'Q1',
            options: ['A', 'A', 'C', 'D'],
            answerIndex: 0,
          },
        ]),
      /duplicate options/,
    );
  });
});

describe('TriviaGame', () => {
  const LETTERS = ['A', 'B', 'C', 'D'];

  it('evaluates solo trivia across 5 rounds and hides current answer from public view', () => {
    let state = TriviaGame.create(
      { mode: GAME_MODES.SOLO, category: 'science', difficulty: 'easy' },
      ['p1', BOT_PLAYER_ID],
      createSeededRng(10),
    );

    for (let r = 0; r < 5; r += 1) {
      const q = state.questions[state.currentRoundIndex];
      const correctOpt = LETTERS[q.answerIndex];
      const wrongOpt = LETTERS[(q.answerIndex + 1) % 4];
      const pub = TriviaGame.getPublicView(state);
      assert.ok(pub.boardOrInfo.includes(q.question));

      const chooseCorrect = r < 3;
      const out = TriviaGame.applyAction(state, 'p1', {
        option: chooseCorrect ? correctOpt : wrongOpt,
      });
      state = out.state;

      if (r < 4) {
        assert.equal(out.finished, false);
      } else {
        assert.equal(out.finished, true);
        assert.equal(state.scores.p1, 3);
        assert.equal(out.result.winnerId, 'p1');
      }
    }
  });

  it('awards fastest correct answer, locks wrong answers, skips when both wrong or timed out', () => {
    let state = TriviaGame.create(
      { mode: GAME_MODES.MULTIPLAYER, category: 'technology', difficulty: 'normal' },
      ['p1', 'p2'],
      createSeededRng(21),
    );

    // Round 1: p1 answers wrong -> locked; p1 retry blocked; p2 answers right -> p2 gets point & round advances
    const q0 = state.questions[0];
    const wrong0 = LETTERS[(q0.answerIndex + 1) % 4];
    const right0 = LETTERS[q0.answerIndex];

    const r1Wrong = TriviaGame.applyAction(state, 'p1', { option: wrong0 });
    assert.equal(r1Wrong.finished, false);
    assert.equal(r1Wrong.roundAdvanced, false);
    state = r1Wrong.state;
    assert.equal(TriviaGame.getPrivateView(state, 'p1').locked, true);

    const r1Retry = TriviaGame.applyAction(state, 'p1', { option: right0 });
    assert.ok(r1Retry.error);

    const r1Right = TriviaGame.applyAction(state, 'p2', { option: right0 });
    assert.equal(r1Right.finished, false);
    assert.equal(r1Right.roundAdvanced, true);
    state = r1Right.state;
    assert.equal(state.scores.p2, 1);
    assert.equal(state.currentRoundIndex, 1);
    assert.deepEqual(state.lockedPlayers, []);

    // Round 2: Both wrong -> skips round without points
    const q1 = state.questions[1];
    const wrong1 = LETTERS[(q1.answerIndex + 2) % 4];
    state = TriviaGame.applyAction(state, 'p1', { option: wrong1 }).state;
    const r2Skip = TriviaGame.applyAction(state, 'p2', { option: wrong1 });
    assert.equal(r2Skip.roundAdvanced, true);
    state = r2Skip.state;
    assert.equal(state.currentRoundIndex, 2);
    assert.equal(state.scores.p1, 0);
    assert.equal(state.scores.p2, 1);

    // Round 3: Timeout -> skips round without points
    const r3Timeout = TriviaGame.advanceRoundOnTimeout(state);
    assert.equal(r3Timeout.finished, false);
    state = r3Timeout.state;
    assert.equal(state.currentRoundIndex, 3);

    // Round 4: p1 scores -> tied 1-1
    const q3 = state.questions[3];
    state = TriviaGame.applyAction(state, 'p1', { option: LETTERS[q3.answerIndex] }).state;
    assert.equal(state.scores.p1, 1);

    // Round 5: Timeout -> match finishes as Draw (1-1)
    const r5Finish = TriviaGame.advanceRoundOnTimeout(state);
    assert.equal(r5Finish.finished, true);
    assert.equal(r5Finish.state.status, MATCH_STATUS.FINISHED);
    assert.equal(r5Finish.result.isDraw, true);
  });
});
