import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng, defaultRng } from '../../src/utils/random.js';
import {
  isValidCoinChoice,
  isValidConnect4Column,
  isValidDifficulty,
  isValidRpsChoice,
  isValidTriviaCategory,
  isValidTriviaOption,
  isValidTttPosition,
  validateDiceConfig,
  validateOpponent,
} from '../../src/utils/validators.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import {
  buildErrorEmbed,
  buildGameEmbed,
  buildGamesListEmbed,
  buildHelpEmbed,
  buildLobbyEmbed,
  buildResultEmbed,
  hasLogoAsset,
} from '../../src/utils/embeds.js';
import { COLORS, EMBED_FOOTER, GAME_MODES, LOGO_ATTACHMENT_URL } from '../../src/utils/constants.js';

describe('Random Utilities', () => {
  it('createSeededRng is deterministic for the same seed', () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    const seqA = Array.from({ length: 10 }, () => a.int(1, 100));
    const seqB = Array.from({ length: 10 }, () => b.int(1, 100));
    assert.deepEqual(seqA, seqB);
  });

  it('defaultRng.int stays within inclusive bounds and shuffle preserves elements', () => {
    for (let i = 0; i < 50; i += 1) {
      const val = defaultRng.int(3, 7);
      assert.ok(val >= 3 && val <= 7);
    }
    const items = [1, 2, 3, 4, 5];
    const shuffled = defaultRng.shuffle(items);
    assert.deepEqual([...shuffled].sort(), items);
  });

  it('throws on invalid int range', () => {
    assert.throws(() => defaultRng.int(10, 5), RangeError);
    assert.throws(() => defaultRng.pick([]), RangeError);
  });
});

describe('Validators', () => {
  it('validates opponents properly', () => {
    assert.equal(validateOpponent('111', { id: '222', bot: false }).valid, true);
    assert.equal(validateOpponent('111', { id: '111', bot: false }).valid, false);
    assert.equal(validateOpponent('111', { id: '333', bot: true }).valid, false);
    assert.equal(validateOpponent('111', null).valid, false);
  });

  it('validates dice configuration limits', () => {
    assert.equal(validateDiceConfig(1, 6).valid, true);
    assert.equal(validateDiceConfig(10, 100).valid, true);
    assert.equal(validateDiceConfig(0, 6).valid, false);
    assert.equal(validateDiceConfig(11, 6).valid, false);
    assert.equal(validateDiceConfig(1, 1).valid, false);
    assert.equal(validateDiceConfig(1, 101).valid, false);
  });

  it('validates game choices and coordinates', () => {
    assert.equal(isValidDifficulty('easy'), true);
    assert.equal(isValidDifficulty('extreme'), false);
    assert.equal(isValidTriviaCategory('science'), true);
    assert.equal(isValidTriviaCategory('cooking'), false);
    assert.equal(isValidRpsChoice('rock'), true);
    assert.equal(isValidRpsChoice('lizard'), false);
    assert.equal(isValidCoinChoice('heads'), true);
    assert.equal(isValidCoinChoice('edge'), false);
    assert.equal(isValidTriviaOption('a'), true);
    assert.equal(isValidTriviaOption('E'), false);
    assert.equal(isValidTttPosition('b2'), true);
    assert.equal(isValidTttPosition('D1'), false);
    assert.equal(isValidConnect4Column(7), true);
    assert.equal(isValidConnect4Column(0), false);
    assert.equal(isValidConnect4Column(8), false);
  });
});

describe('CooldownManager', () => {
  it('enforces cooldown and expires after TTL', () => {
    let now = 1000;
    const cm = new CooldownManager(2000, () => now);
    assert.equal(cm.tryAcquire('u1:guess').allowed, true);
    const second = cm.tryAcquire('u1:guess');
    assert.equal(second.allowed, false);
    assert.equal(second.remainingMs, 2000);

    now = 3001;
    assert.equal(cm.tryAcquire('u1:guess').allowed, true);
  });
});

describe('Embed Design System', () => {
  it('includes Midnight Ocean colors, footer, and Midwave logo asset', () => {
    assert.equal(hasLogoAsset(), true);

    const lobby = buildLobbyEmbed({
      gameTitle: 'Tic Tac Toe',
      hostId: '100',
      opponentId: '200',
      status: 'Menunggu konfirmasi',
    }).toJSON();

    assert.equal(lobby.color, COLORS.SECONDARY);
    assert.equal(lobby.footer.text, EMBED_FOOTER);
    assert.equal(lobby.thumbnail.url, LOGO_ATTACHMENT_URL);

    const game = buildGameEmbed({
      gameTitle: 'Connect Four',
      mode: GAME_MODES.MULTIPLAYER,
      players: ['100', '200'],
      status: 'Berlangsung',
      currentTurn: '100',
      boardOrInfo: 'board',
    }).toJSON();
    assert.equal(game.color, COLORS.ACCENT);
    assert.equal(game.footer.text, EMBED_FOOTER);

    const result = buildResultEmbed({
      gameTitle: 'Connect Four',
      mode: GAME_MODES.MULTIPLAYER,
      players: ['100', '200'],
      winnerId: '100',
      loserId: '200',
      durationMs: 15_000,
      resultDescription: 'Menang!',
    }).toJSON();
    assert.equal(result.color, COLORS.SUCCESS);
    assert.equal(result.footer.text, EMBED_FOOTER);

    const err = buildErrorEmbed('Ada kesalahan').toJSON();
    assert.equal(err.color, COLORS.DANGER);

    const gamesList = buildGamesListEmbed().toJSON();
    assert.equal(gamesList.fields.length, 7);

    const help = buildHelpEmbed().toJSON();
    assert.equal(help.footer.text, EMBED_FOOTER);
  });
});
