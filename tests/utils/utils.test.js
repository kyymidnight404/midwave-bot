import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng, defaultRng } from '../../src/utils/random.js';
import {
  isValidCoinChoice,
  isValidDifficulty,
  isValidQuizCategory,
  isValidRpsChoice,
  isValidTttPosition,
  validateOpponent,
} from '../../src/utils/validators.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import {
  buildDownloadProcessingEmbed,
  buildDownloadSuccessEmbed,
  buildErrorEmbed,
  buildGameEmbed,
  buildGamesListEmbed,
  buildHelpEmbed,
  buildInfoEmbed,
  buildLobbyEmbed,
  buildResultEmbed,
  buildStatusEmbed,
  buildSuccessEmbed,
  buildWarningEmbed,
  createBaseEmbed,
  hasLogoAsset,
} from '../../src/utils/embeds.js';
import { buildLyricsEmbed } from '../../src/utils/lyricsFormatter.js';
import { buildMathEmbed } from '../../src/commands/math.js';
import { buildSocialEmbed } from '../../src/utils/socialCommand.js';
import { buildWebSearchEmbed } from '../../src/utils/aiFormatter.js';
import { COLORS as CONFIG_COLORS, DEFAULT_EMBED_COLOR, EMBED_COLOR_HEX } from '../../src/config/colors.js';
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

  it('validates game choices and coordinates', () => {
    assert.equal(isValidDifficulty('easy'), true);
    assert.equal(isValidDifficulty('extreme'), false);
    assert.equal(isValidQuizCategory('science'), true);
    assert.equal(isValidQuizCategory('cooking'), false);
    assert.equal(isValidRpsChoice('rock'), true);
    assert.equal(isValidRpsChoice('lizard'), false);
    assert.equal(isValidCoinChoice('heads'), true);
    assert.equal(isValidCoinChoice('edge'), false);
    assert.equal(isValidTttPosition('b2'), true);
    assert.equal(isValidTttPosition('D1'), false);
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

    assert.equal(lobby.color, COLORS.PRIMARY);
    assert.equal(lobby.footer, undefined);
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
    assert.equal(game.footer, undefined);

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
    assert.equal(result.footer, undefined);

    const err = buildErrorEmbed('Ada kesalahan').toJSON();
    assert.equal(err.color, COLORS.DANGER);

    const gamesList = buildGamesListEmbed().toJSON();
    assert.equal(gamesList.fields.length, 3);

    const help = buildHelpEmbed().toJSON();
    assert.equal(help.footer, undefined);
  });

  it('enforces official Midwave global embed colors, status builders, and optional footer/timestamp', () => {
    assert.equal(EMBED_COLOR_HEX.PRIMARY, '#70B1FC');
    assert.equal(EMBED_COLOR_HEX.SECONDARY, '#477FDC');
    assert.equal(EMBED_COLOR_HEX.SUCCESS, '#57F287');
    assert.equal(EMBED_COLOR_HEX.ERROR, '#ED4245');
    assert.equal(EMBED_COLOR_HEX.WARNING, '#FEE75C');
    assert.equal(EMBED_COLOR_HEX.INFO, '#70B1FC');

    assert.equal(CONFIG_COLORS.PRIMARY, 0x70b1fc);
    assert.equal(CONFIG_COLORS.SECONDARY, 0x477fdc);
    assert.equal(CONFIG_COLORS.SUCCESS, 0x57f287);
    assert.equal(CONFIG_COLORS.ERROR, 0xed4245);
    assert.equal(CONFIG_COLORS.WARNING, 0xfee75c);
    assert.equal(CONFIG_COLORS.INFO, 0x70b1fc);
    assert.equal(DEFAULT_EMBED_COLOR, 0x70b1fc);
    assert.equal(COLORS.PRIMARY, CONFIG_COLORS.PRIMARY);

    const defaultEmbed = createBaseEmbed({ title: 'Default' }).toJSON();
    assert.equal(defaultEmbed.color, 0x70b1fc);

    const customEmbed = createBaseEmbed({
      title: 'Custom',
      color: 0x477fdc,
      includeFooter: true,
      timestamp: true,
    }).toJSON();
    assert.equal(customEmbed.color, 0x477fdc);
    assert.equal(customEmbed.footer.text, EMBED_FOOTER);
    assert.ok(customEmbed.timestamp);

    assert.equal(buildSuccessEmbed('Sukses').toJSON().color, 0x57f287);
    assert.equal(buildErrorEmbed('Gagal').toJSON().color, 0xed4245);
    assert.equal(buildWarningEmbed('Peringatan').toJSON().color, 0xfee75c);
    assert.equal(buildInfoEmbed('Info', 'Detail').toJSON().color, 0x70b1fc);
  });

  it('produces consistent global semantic colors across command and feature embed builders', () => {
    assert.equal(buildGamesListEmbed().toJSON().color, CONFIG_COLORS.PRIMARY);
    assert.equal(buildHelpEmbed().toJSON().color, CONFIG_COLORS.PRIMARY);
    assert.equal(
      buildStatusEmbed({
        sessionId: 'sess-1',
        gameType: 'tictactoe',
        mode: GAME_MODES.SOLO,
        players: ['100'],
        currentTurn: '100',
        status: 'active',
        startedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }).toJSON().color,
      CONFIG_COLORS.PRIMARY,
    );

    assert.equal(
      buildDownloadProcessingEmbed({ platformLabel: 'TikTok' }).toJSON().color,
      CONFIG_COLORS.INFO,
    );
    assert.equal(
      buildDownloadSuccessEmbed({
        platformLabel: 'TikTok',
        mediaType: 'Video',
        fileFormat: 'MP4',
        formattedSize: '1.2 MB',
        requesterId: '100',
      }).toJSON().color,
      CONFIG_COLORS.SUCCESS,
    );

    assert.equal(
      buildLyricsEmbed(
        { title: 'Song', artist: 'Artist', sourceName: 'LRCLIB' },
        { pages: ['Line 1'], pageIndex: 0 },
      ).toJSON().color,
      CONFIG_COLORS.PRIMARY,
    );
    assert.equal(
      buildMathEmbed({ input: '2+2', formattedResult: '4' }).toJSON().color,
      CONFIG_COLORS.PRIMARY,
    );
    assert.equal(
      buildSocialEmbed({ message: 'Hug!', gifUrl: 'https://example.com/hug.gif' }).toJSON().color,
      CONFIG_COLORS.PRIMARY,
    );
    assert.equal(
      buildWebSearchEmbed({ description: 'Hasil pencarian', mode: 'web_search' }).toJSON().color,
      CONFIG_COLORS.PRIMARY,
    );
    assert.equal(
      buildWebSearchEmbed({ description: 'Fallback', mode: 'fallback' }).toJSON().color,
      CONFIG_COLORS.WARNING,
    );
  });
});
