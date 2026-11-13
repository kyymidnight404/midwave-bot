import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { AttachmentBuilder, MessageFlags } from 'discord.js';
import {
  BRAT_ATTACHMENT_NAME,
  BRAT_BG_COLOR,
  BRAT_MAX_LENGTH,
  BRAT_PADDING,
  BRAT_SIZE,
  BRAT_TEXT_COLOR,
  buildBratSvg,
  escapeSvgText,
  layoutBratText,
  renderBratPng,
  renderBratPngAsync,
  validateBratText,
} from '../../src/utils/bratGenerator.js';
import {
  resolveBratEmojiAssets,
  toTwemojiCodePoints,
  tokenizeBratUnits,
} from '../../src/utils/bratEmoji.js';
import bratCommand, { data as bratData, execute as executeBrat } from '../../src/commands/brat.js';
import { createBotApp } from '../../src/index.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePngRgbaPixels(pngBuffer) {
  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  const colorType = pngBuffer[25];
  assert.equal(colorType, 6, 'Expected 8-bit RGBA PNG');

  const idatChunks = [];
  let offset = 8;
  while (offset < pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') {
      idatChunks.push(pngBuffer.subarray(offset + 8, offset + 8 + length));
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const bpp = 4;
  const stride = width * bpp;
  const rgba = Buffer.alloc(height * stride);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const outRow = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[rowStart + 1 + i];
      const a = i >= bpp ? rgba[outRow + i - bpp] : 0;
      const b = y > 0 ? rgba[outRow - stride + i] : 0;
      const c = y > 0 && i >= bpp ? rgba[outRow - stride + i - bpp] : 0;
      let val = x;
      if (filter === 1) val = (x + a) & 0xff;
      else if (filter === 2) val = (x + b) & 0xff;
      else if (filter === 3) val = (x + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (x + paeth(a, b, c)) & 0xff;
      rgba[outRow + i] = val;
    }
  }

  return { width, height, rgba };
}

function createMockInteraction({ text = '', userId = 'u1' } = {}) {
  const events = [];
  return {
    commandName: 'brat',
    user: { id: userId },
    guildId: 'guild-1',
    channelId: 'ch-1',
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => null,
      getString: (name) => (name === 'text' ? text : null),
    },
    async deferReply(opts = {}) {
      this.deferred = true;
      events.push({ type: 'deferReply', payload: opts });
    },
    async reply(payload) {
      this.replied = true;
      events.push({ type: 'reply', payload });
      return payload;
    },
    async editReply(payload) {
      events.push({ type: 'editReply', payload });
      return payload;
    },
    async followUp(payload) {
      events.push({ type: 'followUp', payload });
      return payload;
    },
    getEvents: () => events,
  };
}

describe('Brat Generator utility & /brat command', () => {
  it('rejects empty, non-string, and whitespace-only text', () => {
    assert.throws(() => validateBratText(''), /wajib diisi|kosong/i);
    assert.throws(() => validateBratText('   \t\n  '), /kosong/i);
    assert.throws(() => validateBratText(null), /wajib diisi/i);
  });

  it('enforces the 100 character maximum limit and lowercases valid text', () => {
    const exact100 = 'A'.repeat(BRAT_MAX_LENGTH);
    const normalized = validateBratText(exact100);
    assert.equal(normalized.length, BRAT_MAX_LENGTH);
    assert.equal(normalized, 'a'.repeat(BRAT_MAX_LENGTH));

    const overLimit = 'a'.repeat(BRAT_MAX_LENGTH + 1);
    assert.throws(() => validateBratText(overLimit), /maksimal 100 karakter/i);
  });

  it('escapes SVG special characters and strips control chars to prevent SVG injection', () => {
    const malicious = `<script>alert("xss")</script> & 'test'\x00\x07`;
    const escaped = escapeSvgText(malicious);
    assert.equal(
      escaped,
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#39;test&#39;',
    );

    const svg = buildBratSvg(malicious);
    assert.ok(!svg.includes('<script>'));
    assert.ok(!svg.includes('"xss"'));
    assert.ok(svg.includes('&lt;'));
    assert.ok(svg.includes('&gt;'));
    assert.ok(svg.includes('&quot;'));
    assert.ok(svg.includes('&amp;'));
    assert.ok(svg.includes('&#39;'));
    assert.equal(BRAT_BG_COLOR, '#FFFFFF');
    assert.equal(BRAT_TEXT_COLOR, '#000000');
    assert.ok(BRAT_PADDING >= 40 && BRAT_PADDING <= 52);
    assert.ok(svg.includes('<rect width="1024" height="1024" fill="#FFFFFF" />'));
    assert.ok(svg.includes('<text fill="#000000"'));
    assert.ok(svg.includes('font-weight="400"'));
    assert.ok(svg.includes('text-anchor="start"'));
    assert.ok(svg.includes(`<tspan x="${BRAT_PADDING}"`));
    assert.ok(!svg.includes('text-anchor="middle"'));
    assert.ok(!svg.includes('#8ACE00'));
    assert.ok(svg.includes('<feGaussianBlur'));

    const shortSvg = buildBratSvg('<a>&"\'');
    assert.ok(shortSvg.includes('&lt;a&gt;&amp;&quot;&#39;'));
  });

  it('wraps long multiline and unspaced 100-char strings within canvas bounds', () => {
    const longPhrase =
      'midwave discord bot utility brat generator with automatic font scaling and multiline wrapping';
    const layout = layoutBratText(validateBratText(longPhrase));
    assert.ok(layout.lines.length >= 3);
    assert.ok(layout.fontSize < 260);
    assert.ok(
      (layout.lines.length - 1) * layout.lineHeight + Math.round(layout.fontSize * 1.06) <=
        BRAT_SIZE - BRAT_PADDING * 2,
    );

    const unspaced = 'm'.repeat(BRAT_MAX_LENGTH);
    const unspacedLayout = layoutBratText(validateBratText(unspaced));
    assert.ok(unspacedLayout.lines.length >= 4);
    assert.ok(
      (unspacedLayout.lines.length - 1) * unspacedLayout.lineHeight +
        Math.round(unspacedLayout.fontSize * 1.06) <=
        BRAT_SIZE - BRAT_PADDING * 2,
    );
  });

  it('renders a valid 1024x1024 white-theme PNG with top-left text alignment and multiline wrap', () => {
    const pngShort = renderBratPng('test');
    assert.ok(Buffer.isBuffer(pngShort));
    assert.ok(pngShort.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(pngShort.readUInt32BE(16), BRAT_SIZE);
    assert.equal(pngShort.readUInt32BE(20), BRAT_SIZE);

    const { rgba } = decodePngRgbaPixels(pngShort);
    // Corner pixels must be solid white (#FFFFFF).
    assert.deepEqual([...rgba.subarray(0, 4)], [255, 255, 255, 255]);
    const lastIdx = (BRAT_SIZE * BRAT_SIZE - 1) * 4;
    assert.deepEqual([...rgba.subarray(lastIdx, lastIdx + 4)], [255, 255, 255, 255]);

    // Short text "test" must sit exclusively in the top-left area, NOT centered or in bottom half.
    let darkTopLeft = 0;
    let darkBottomHalf = 0;
    let darkFarRight = 0;
    for (let y = 0; y < BRAT_SIZE; y += 2) {
      for (let x = 0; x < BRAT_SIZE; x += 2) {
        const idx = (y * BRAT_SIZE + x) * 4;
        const isDark = rgba[idx] < 64 && rgba[idx + 1] < 64 && rgba[idx + 2] < 64;
        if (!isDark) continue;
        if (x < 600 && y < 400) darkTopLeft++;
        if (y >= 512) darkBottomHalf++;
        if (x >= 700) darkFarRight++;
      }
    }
    assert.ok(darkTopLeft > 100, 'Expected black text pixels in top-left quadrant');
    assert.equal(darkBottomHalf, 0, 'Short text must stay at top-left, not centered vertically');
    assert.equal(darkFarRight, 0, 'Short text must stay at top-left, not overflow right');

    const pngLong = renderBratPng('ya allah aku malas nian buat ngantor');
    assert.ok(Buffer.isBuffer(pngLong));
    assert.ok(pngLong.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(pngLong.readUInt32BE(16), BRAT_SIZE);
    assert.equal(pngLong.readUInt32BE(20), BRAT_SIZE);
  });

  it('wraps renderer errors cleanly without leaking sensitive info', () => {
    class FailingResvg {
      constructor() {
        throw new Error('simulated native crash');
      }
    }

    assert.throws(
      () => renderBratPng('midnight ocean', { resvgClass: FailingResvg }),
      /Gagal merender gambar Brat: simulated native crash/,
    );
  });

  it('registers /brat command with required text option (max 100)', async () => {
    const app = await createBotApp();
    const json = app.commandHandler.toJSON();
    const bratCmd = json.find((cmd) => cmd.name === 'brat');
    assert.ok(bratCmd, '/brat must be registered');
    assert.equal(bratCmd.options.length, 1);
    assert.equal(bratCmd.options[0].name, 'text');
    assert.equal(bratCmd.options[0].required, true);
    assert.equal(bratCmd.options[0].max_length, BRAT_MAX_LENGTH);
    assert.equal(bratData.name, 'brat');
    app.shutdown();
  });

  it('defers reply and edits reply with midwave-brat.png attachment on valid input', async () => {
    const interaction = createMockInteraction({ text: 'Midnight Ocean' });
    await executeBrat(interaction);

    const events = interaction.getEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'deferReply');
    assert.equal(events[1].type, 'editReply');

    const [attachment] = events[1].payload.files;
    assert.ok(attachment instanceof AttachmentBuilder);
    assert.equal(attachment.name, BRAT_ATTACHMENT_NAME);
    assert.ok(Buffer.isBuffer(attachment.attachment));
    assert.equal(attachment.attachment.readUInt32BE(16), BRAT_SIZE);
    assert.equal(attachment.attachment.readUInt32BE(20), BRAT_SIZE);
  });

  it('replies ephemerally on whitespace input and sends clean error embed when rendering fails', async () => {
    const emptyInteraction = createMockInteraction({ text: '   ' });
    await executeBrat(emptyInteraction);
    const emptyEvents = emptyInteraction.getEvents();
    assert.equal(emptyEvents.length, 1);
    assert.equal(emptyEvents[0].type, 'reply');
    assert.equal(emptyEvents[0].payload.flags, MessageFlags.Ephemeral);

    const failInteraction = createMockInteraction({ text: 'valid text' });
    await executeBrat(failInteraction, {
      renderBratPng: () => {
        throw new Error('SECRET_ENV_SHOULD_NOT_LEAK');
      },
    });

    const failEvents = failInteraction.getEvents();
    assert.equal(failEvents.length, 2);
    assert.equal(failEvents[0].type, 'deferReply');
    assert.equal(failEvents[1].type, 'editReply');
    const serialized = JSON.stringify(failEvents[1].payload.embeds[0].toJSON());
    assert.ok(serialized.includes('Gagal merender gambar Brat'));
    assert.ok(!serialized.includes('SECRET_ENV_SHOULD_NOT_LEAK'));
  });

  it('enforces cooldown on /brat through InteractionHandler', async () => {
    const commandHandler = new CommandHandler();
    commandHandler.commands.set('brat', bratCommand);
    const cooldowns = new CooldownManager(5000);
    const handler = new InteractionHandler({
      commandHandler,
      gameManager: {},
      cooldowns,
      context: {
        renderBratPng: () => PNG_SIGNATURE,
      },
    });

    const first = createMockInteraction({ text: 'first call', userId: 'u-cool' });
    await handler.handle(first);
    assert.equal(first.getEvents()[0].type, 'deferReply');

    const second = createMockInteraction({ text: 'second call', userId: 'u-cool' });
    await handler.handle(second);
    assert.equal(second.getEvents()[0].type, 'reply');
    assert.equal(second.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
    const errEmbed = second.getEvents()[0].payload.embeds[0].toJSON();
    assert.match(errEmbed.description, /Tunggu/i);
  });

  it('tokenizes Unicode emojis, ZWJ/keycap/flag sequences, and Discord custom emojis intact', () => {
    const tokens = tokenizeBratUnits(
      'pajak \u{1F972} \u2764\uFE0F 1\uFE0F\u20E3 \u{1F3F3}\uFE0F\u200D\u{1F308} \u{1F1EE}\u{1F1E9} <:wave:123456789012345678>',
    );
    const emojis = tokens.filter((t) => t.type !== 'text');
    assert.equal(emojis.length, 6);
    assert.equal(emojis[0].codePoint, '1f972');
    assert.equal(emojis[1].codePoint, '2764');
    assert.equal(emojis[2].codePoint, '31-20e3');
    assert.equal(emojis[3].codePoint, '1f3f3-fe0f-200d-1f308');
    assert.equal(emojis[3].fallbackCodePoint, '1f3f3-200d-1f308');
    assert.equal(emojis[4].codePoint, '1f1ee-1f1e9');
    assert.equal(emojis[5].type, 'custom-emoji');
    assert.equal(emojis[5].id, '123456789012345678');

    assert.deepEqual(toTwemojiCodePoints('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'), {
      primary: '1f468-200d-1f469-200d-1f467',
      fallback: null,
    });

    // Long unspaced emoji strings must wrap cleanly across lines without splitting surrogate pairs or ZWJ graphemes.
    const unspacedSurrogates = '\u{1F525}'.repeat(45);
    const surrogateLayout = layoutBratText(validateBratText(unspacedSurrogates));
    assert.ok(surrogateLayout.lines.length >= 2);
    assert.equal(surrogateLayout.lines.join(''), unspacedSurrogates);

    const unspacedZwj = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'.repeat(12);
    const zwjLayout = layoutBratText(validateBratText(unspacedZwj));
    assert.equal(zwjLayout.lines.join(''), unspacedZwj);
  });

  it('resolves, caches, validates, and gracefully falls back for emoji assets', async () => {
    const sampleSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="#FFCC4D"/></svg>';
    const samplePng = Buffer.concat([PNG_SIGNATURE, Buffer.from([0, 0, 0, 0])]);
    const requestedUrls = [];
    const cache = new Map();

    const mockFetch = async (url) => {
      requestedUrls.push(url);
      if (url.endsWith('/1f972.svg')) {
        return {
          ok: true,
          headers: new Headers({ 'content-length': String(sampleSvg.length) }),
          arrayBuffer: async () => Buffer.from(sampleSvg, 'utf8'),
        };
      }
      if (url.endsWith('/1f3f3-fe0f-200d-1f308.svg')) {
        return { ok: false, status: 404 };
      }
      if (url.endsWith('/1f3f3-200d-1f308.svg')) {
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => Buffer.from(sampleSvg, 'utf8'),
        };
      }
      if (url.includes('/emojis/123456789012345678.png')) {
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => samplePng,
        };
      }
      if (url.includes('/emojis/999999999999999999.png')) {
        // Invalid non-PNG payload must be rejected safely.
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => Buffer.from('not-a-png', 'utf8'),
        };
      }
      throw new Error('network error');
    };

    const text =
      'hi \u{1F972} \u{1F972} \u{1F3F3}\uFE0F\u200D\u{1F308} <:ok:123456789012345678> <:bad:999999999999999999> \u{1F525}';
    const assets = await resolveBratEmojiAssets(text, { fetchFn: mockFetch, cache });

    assert.ok(assets.get('unicode:1f972')?.startsWith('data:image/svg+xml;base64,'));
    assert.ok(assets.get('unicode:1f3f3-fe0f-200d-1f308')?.startsWith('data:image/svg+xml;base64,'));
    assert.ok(assets.get('custom:123456789012345678')?.startsWith('data:image/png;base64,'));
    assert.equal(assets.has('custom:999999999999999999'), false);
    assert.equal(assets.has('unicode:1f525'), false);

    // Repeated 1f972 in the same text only triggers one fetch; second call hits cache.
    const countAfterFirst = requestedUrls.length;
    const cachedAssets = await resolveBratEmojiAssets('\u{1F972}', { fetchFn: mockFetch, cache });
    assert.equal(cachedAssets.get('unicode:1f972'), assets.get('unicode:1f972'));
    assert.equal(requestedUrls.length, countAfterFirst);
  });

  it('renders inline color emojis in 1024x1024 PNG and falls back cleanly when missing', async () => {
    const emojiSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="#FFCC4D"/><path fill="#5DADEC" d="M25 24c0 3-2 5-5 5s-5-2-5-5 5-9 5-9 5 6 5 9z"/></svg>';
    const cache = new Map();
    const mockFetch = async (url) => {
      if (url.endsWith('/1f972.svg')) {
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => Buffer.from(emojiSvg, 'utf8'),
        };
      }
      return { ok: false, status: 404 };
    };

    const input = 'pajak terosss \u{1F972} pungutan <:missing:123456789012345678>';
    const assets = await resolveBratEmojiAssets(validateBratText(input), { fetchFn: mockFetch, cache });
    const svg = buildBratSvg(input, { emojiAssets: assets });
    assert.ok(svg.includes('<image '));
    assert.ok(svg.includes('xml:space="preserve"'));
    assert.ok(svg.includes(':missing:'));

    const png = await renderBratPngAsync(input, { fetchFn: mockFetch, cache });
    assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(png.readUInt32BE(16), BRAT_SIZE);
    assert.equal(png.readUInt32BE(20), BRAT_SIZE);

    const { rgba } = decodePngRgbaPixels(png);
    let coloredPixels = 0;
    let darkTextPixels = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const [r, g, b] = [rgba[i], rgba[i + 1], rgba[i + 2]];
      if (r > 240 && g > 240 && b > 240) continue;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 25) {
        coloredPixels++;
      } else if (r < 64 && g < 64 && b < 64) {
        darkTextPixels++;
      }
    }
    assert.ok(coloredPixels > 500, 'Expected colored pixels from rendered inline emoji');
    assert.ok(darkTextPixels > 500, 'Expected dark pixels from rendered text');
  });

  it('keeps single-word inputs top-left, single-line when possible, and proportionally scaled', () => {
    const shortWord = layoutBratText(validateBratText('test'));
    const mediumWord = layoutBratText(validateBratText('midnight'));
    const longWord = layoutBratText(validateBratText('pungutannnnnnnnn'));
    const veryLongWord = layoutBratText(validateBratText('supercalifragilisticexpialidocious'));

    assert.equal(shortWord.lines.length, 1);
    assert.equal(mediumWord.lines.length, 1);
    assert.equal(longWord.lines.length, 1);
    assert.equal(veryLongWord.lines.length, 1);

    assert.ok(shortWord.fontSize >= mediumWord.fontSize);
    assert.ok(mediumWord.fontSize > longWord.fontSize);
    assert.ok(longWord.fontSize > veryLongWord.fontSize);

    const svg = buildBratSvg('test');
    assert.ok(svg.includes(`x="${BRAT_PADDING}"`));
    assert.ok(svg.includes('text-anchor="start"'));
    assert.ok(!svg.includes('text-anchor="middle"'));
  });
});
