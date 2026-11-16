import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { AttachmentBuilder, MessageFlags } from 'discord.js';
import {
  formatQcTimestamp,
  loadQcAssets,
  QC_ATTACHMENT_NAME,
  QC_DEFAULT_TIMEZONE,
  QC_EMOJI_ASSETS,
  QC_ICON_ASSETS,
  QC_MAX_LENGTH,
  QC_MIN_HEIGHT,
  QC_WIDTH,
  renderQcPng,
  resolveQcTimeZone,
  validateQcText,
} from '../../src/utils/qcGenerator.js';
import qcCommand, {
  execute as executeQc,
  extractQcSourceFromMessage,
} from '../../src/prefixCommands/qc.js';
import mediaCommand from '../../src/commands/media.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { PrefixCommandHandler } from '../../src/handlers/PrefixCommandHandler.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createMockSlashInteraction(text, action = 'qc') {
  const events = [];
  return {
    commandName: 'media',
    user: { id: 'u1' },
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    options: {
      getSubcommand: () => action,
      getSubcommandGroup: () => null,
      getString: (name) => {
        if (name === 'action') return action;
        if (name === 'text') return text;
        return null;
      },
    },
    async deferReply(opts = {}) {
      events.push({ type: 'deferReply', payload: opts });
    },
    async reply(payload) {
      events.push({ type: 'reply', payload });
      return payload;
    },
    async editReply(payload) {
      events.push({ type: 'editReply', payload });
      return payload;
    },
    getEvents: () => events,
  };
}

function createMockContextMenuInteraction(targetMessage) {
  const events = [];
  return {
    commandName: 'Generate QC',
    user: { id: 'u1' },
    targetMessage,
    isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => true,
    async deferReply(opts = {}) {
      events.push({ type: 'deferReply', payload: opts });
    },
    async reply(payload) {
      events.push({ type: 'reply', payload });
      return payload;
    },
    async editReply(payload) {
      events.push({ type: 'editReply', payload });
      return payload;
    },
    getEvents: () => events,
  };
}

describe('QC (WhatsApp Chat Screenshot) Generator & Commands', () => {
  it('loads all 7 local RGBA emoji PNGs (>=128px, 1:1 ratio) and 7 icon PNGs without external URLs', () => {
    assert.equal(QC_EMOJI_ASSETS.length, 7);
    for (const spec of QC_EMOJI_ASSETS) {
      assert.ok(existsSync(spec.path), `Missing emoji PNG asset: ${spec.path}`);
      const buf = readFileSync(spec.path);
      assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `Invalid PNG signature: ${spec.name}`);
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      const colorType = buf.readUInt8(25);
      assert.ok(width >= 128 && height >= 128, `${spec.name} must be high-res >= 128x128`);
      assert.equal(width, height, `${spec.name} must preserve 1:1 aspect ratio`);
      assert.equal(colorType, 6, `${spec.name} must be RGBA PNG with transparent background`);
    }

    const expectedIcons = ['dropdown', 'reply', 'copy', 'pin', 'forward', 'delete', 'select'];
    assert.deepEqual(Object.keys(QC_ICON_ASSETS).sort(), [...expectedIcons].sort());
    for (const key of expectedIcons) {
      const iconPath = QC_ICON_ASSETS[key];
      assert.ok(existsSync(iconPath), `Missing icon PNG asset: ${iconPath}`);
      const buf = readFileSync(iconPath);
      assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `Invalid PNG signature for icon: ${key}`);
      assert.ok(buf.readUInt32BE(16) >= 72 && buf.readUInt32BE(20) >= 72, `${key} icon must be >= 72x72`);
    }

    const loaded = loadQcAssets();
    assert.equal(loaded.reactionEmojis.length, 7);
    assert.equal(Object.keys(loaded.icons).length, 7);

    // Ensure every emoji asset has transparent corners (no white box background) and opaque interior artwork
    const probeCanvas = createCanvas(64, 64);
    const probeCtx = probeCanvas.getContext('2d');
    for (const img of loaded.reactionEmojis) {
      probeCtx.clearRect(0, 0, 64, 64);
      probeCtx.drawImage(img, 0, 0, 64, 64);
      const corners = [
        probeCtx.getImageData(0, 0, 1, 1).data[3],
        probeCtx.getImageData(63, 0, 1, 1).data[3],
        probeCtx.getImageData(0, 63, 1, 1).data[3],
        probeCtx.getImageData(63, 63, 1, 1).data[3],
      ];
      assert.deepEqual(corners, [0, 0, 0, 0], 'Expected transparent corners on 3D emoji PNG');
      const centerAlpha = probeCtx.getImageData(32, 32, 1, 1).data[3];
      assert.ok(centerAlpha > 200, 'Expected opaque 3D artwork at canvas center');
    }

    // Ensure rendering makes zero external fetch calls
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('QC rendering must not call external URLs');
    };
    try {
      const png = renderQcPng('Test offline rendering ❤️🤝👍👎🔥🥰👏');
      assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('validates text input, preserves newlines, and enforces max length', () => {
    assert.throws(() => validateQcText(''), /kosong/i);
    assert.throws(() => validateQcText('   \n\t '), /kosong/i);
    assert.throws(() => validateQcText(null), /wajib diisi/i);
    assert.throws(() => validateQcText('a'.repeat(QC_MAX_LENGTH + 1)), /maksimal/i);

    assert.equal(validateQcText('  halo\r\ndunia  '), 'halo\ndunia');
    assert.equal(validateQcText('a'.repeat(QC_MAX_LENGTH)).length, QC_MAX_LENGTH);
  });

  it('formats dynamic 24-hour HH:mm timestamps defaulting to Asia/Jakarta even when host TZ is UTC', () => {
    assert.equal(resolveQcTimeZone('Invalid/Zone'), QC_DEFAULT_TIMEZONE);
    // 13:04 UTC == 20:04 Asia/Jakarta (UTC+7)
    const sampleDate = new Date('2026-11-14T13:04:00Z');
    assert.equal(formatQcTimestamp(sampleDate, 'Asia/Jakarta'), '20:04');
    // 17:00 UTC == 00:00 Asia/Jakarta
    assert.equal(formatQcTimestamp(new Date('2026-11-14T17:00:00Z'), 'Asia/Jakarta'), '00:00');

    const prevTz = process.env.TZ;
    const prevBotTz = process.env.BOT_TIMEZONE;
    try {
      process.env.TZ = 'UTC';
      delete process.env.BOT_TIMEZONE;
      assert.equal(resolveQcTimeZone(), 'Asia/Jakarta');
      assert.equal(formatQcTimestamp(new Date('2026-11-14T11:42:00Z')), '18:42');

      process.env.BOT_TIMEZONE = 'Asia/Makassar';
      assert.equal(resolveQcTimeZone(), 'Asia/Makassar');
      assert.equal(formatQcTimestamp(new Date('2026-11-14T11:42:00Z')), '19:42');
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
      if (prevBotTz === undefined) delete process.env.BOT_TIMEZONE;
      else process.env.BOT_TIMEZONE = prevBotTz;
    }
  });

  it('renders 1080x1080 PNG for short/medium text and dynamically expands canvas height for long text', () => {
    const shortPng = renderQcPng('hi ❤️', {
      timestamp: new Date('2026-11-14T13:04:00Z'),
      timeZone: 'Asia/Jakarta',
    });
    assert.ok(shortPng.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(shortPng.readUInt32BE(16), QC_WIDTH);
    assert.equal(shortPng.readUInt32BE(20), QC_MIN_HEIGHT);

    const mediumPng = renderQcPng('Halo, apa kabar? ❤️🤝👍👎🔥🥰👏');
    assert.ok(mediumPng.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(mediumPng.readUInt32BE(16), QC_WIDTH);
    assert.equal(mediumPng.readUInt32BE(20), QC_MIN_HEIGHT);

    const longText = Array.from({ length: 24 }, (_, idx) =>
      `Baris pesan ke-${idx + 1}: itu aku baru dengerin sekali lagunya terus keinget kamu. 🔥`,
    ).join('\n');
    const longPng = renderQcPng(longText);
    assert.ok(longPng.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(longPng.readUInt32BE(16), QC_WIDTH);
    assert.ok(
      longPng.readUInt32BE(20) > QC_MIN_HEIGHT,
      `Expected canvas height > ${QC_MIN_HEIGHT} for long multiline message, got ${longPng.readUInt32BE(20)}`,
    );
  });

  it('extracts only text without historical timestamp, username, or avatar', () => {
    const originalTime = new Date('2024-05-01T08:15:00Z').getTime();
    const extracted = extractQcSourceFromMessage({
      content: 'Pesan asli dari reply',
      cleanContent: 'Pesan asli dari reply',
      createdTimestamp: originalTime,
      author: { username: 'SecretUser', globalName: 'SecretDisplay', avatar: 'secret-hash' },
    });

    assert.deepEqual(extracted, {
      rawText: 'Pesan asli dari reply',
    });
    assert.equal('timestamp' in extracted, false);
    assert.equal('username' in extracted, false);
    assert.equal('avatar' in extracted, false);
    assert.throws(() => extractQcSourceFromMessage({ content: '', cleanContent: '' }), /tidak memiliki teks/i);
  });

  it('handles /media action:qc slash command via InteractionHandler', async () => {
    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();
    assert.equal(qcCommand.name, 'qc');
    assert.equal(mediaCommand.data.name, 'media');
    assert.equal(commandHandler.get('qc'), undefined);
    assert.ok(commandHandler.get('media'));
    assert.equal(commandHandler.get('Generate QC'), undefined);

    const capturedTimestamps = [];
    const handler = new InteractionHandler({
      commandHandler,
      cooldowns: new CooldownManager(0),
      context: {
        renderQcPng: (text, opts) => {
          capturedTimestamps.push(opts.timestamp);
          return renderQcPng(text, opts);
        },
      },
    });

    // Slash /media action:qc
    const slashInteraction = createMockSlashInteraction('Halo dunia!');
    await handler.handle(slashInteraction);
    const slashEvents = slashInteraction.getEvents();
    assert.equal(slashEvents[0].type, 'deferReply');
    assert.equal(slashEvents[1].type, 'editReply');
    const slashAttachment = slashEvents[1].payload.files[0];
    assert.ok(slashAttachment instanceof AttachmentBuilder);
    assert.equal(slashAttachment.name, QC_ATTACHMENT_NAME);
    assert.ok(slashAttachment.attachment.subarray(0, 8).equals(PNG_SIGNATURE));

    // Invalid empty slash input and omitted optional text reply ephemerally
    const emptySlash = createMockSlashInteraction('   ');
    await executeQc(emptySlash);
    assert.equal(emptySlash.getEvents()[0].type, 'reply');
    assert.equal(emptySlash.getEvents()[0].payload.flags, MessageFlags.Ephemeral);

    const missingTextSlash = createMockSlashInteraction(null);
    await handler.handle(missingTextSlash);
    assert.equal(missingTextSlash.getEvents()[0].type, 'reply');
    assert.equal(missingTextSlash.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
  });

  it('handles !qc manual text, !qc reply mode, and missing reply error via PrefixCommandHandler', async () => {
    assert.deepEqual(parsePrefixInvocation('!qc'), {
      commandName: 'qc',
      subcommand: null,
      options: {},
    });
    assert.deepEqual(parsePrefixInvocation('!qc Halo, apa kabar?'), {
      commandName: 'qc',
      subcommand: null,
      options: { text: 'Halo, apa kabar?' },
    });

    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();

    const capturedOpts = [];
    const prefixHandler = new PrefixCommandHandler({
      commandHandler,
      cooldowns: new CooldownManager(0),
      prefix: '!',
      context: {
        renderQcPng: (text, opts) => {
          capturedOpts.push({ text, timestamp: opts.timestamp });
          return renderQcPng(text, opts);
        },
      },
    });

    // 1. Manual text mode uses current execution timestamp
    const manualReplies = [];
    const beforeManualMs = Date.now();
    await prefixHandler.handle({
      id: 'm1',
      content: '!qc Halo, apa kabar?',
      author: { id: 'u1', bot: false },
      channelId: 'ch1',
      channel: { sendTyping: async () => {} },
      async reply(payload) {
        manualReplies.push(payload);
        return payload;
      },
    });
    const afterManualMs = Date.now();
    assert.equal(manualReplies[0].files[0].name, QC_ATTACHMENT_NAME);
    assert.equal(capturedOpts[0].text, 'Halo, apa kabar?');
    const manualTimestampMs =
      capturedOpts[0].timestamp instanceof Date ? capturedOpts[0].timestamp.getTime() : capturedOpts[0].timestamp;
    assert.ok(
      manualTimestampMs >= beforeManualMs && manualTimestampMs <= afterManualMs,
      `Expected live manual timestamp between ${beforeManualMs} and ${afterManualMs}, got ${manualTimestampMs}`,
    );

    // 2. Reply mode uses current execution timestamp (not old replied createdTimestamp)
    const repliedTime = new Date('2024-05-01T11:45:00Z').getTime();
    const replyModeReplies = [];
    const beforeReplyMs = Date.now();
    await prefixHandler.handle({
      id: 'm2',
      content: '!qc',
      author: { id: 'u1', bot: false },
      channelId: 'ch1',
      reference: { messageId: 'ref-1' },
      channel: { sendTyping: async () => {} },
      async fetchReference() {
        return {
          id: 'ref-1',
          content: 'Isi pesan yang direply',
          cleanContent: 'Isi pesan yang direply',
          createdTimestamp: repliedTime,
          author: { username: 'HiddenUser', avatar: 'hidden' },
        };
      },
      async reply(payload) {
        replyModeReplies.push(payload);
        return payload;
      },
    });
    const afterReplyMs = Date.now();
    assert.equal(replyModeReplies[0].files[0].name, QC_ATTACHMENT_NAME);
    assert.equal(capturedOpts[1].text, 'Isi pesan yang direply');
    const replyTimestampMs =
      capturedOpts[1].timestamp instanceof Date ? capturedOpts[1].timestamp.getTime() : capturedOpts[1].timestamp;
    assert.notEqual(replyTimestampMs, repliedTime);
    assert.ok(
      replyTimestampMs >= beforeReplyMs && replyTimestampMs <= afterReplyMs,
      `Expected live reply timestamp between ${beforeReplyMs} and ${afterReplyMs}, got ${replyTimestampMs}`,
    );

    // 3. !qc without text and without reply returns helpful error embed
    const missingReplies = [];
    await prefixHandler.handle({
      id: 'm3',
      content: '!qc',
      author: { id: 'u1', bot: false },
      channelId: 'ch1',
      channel: { sendTyping: async () => {} },
      async reply(payload) {
        missingReplies.push(payload);
        return payload;
      },
    });
    assert.match(missingReplies[0].embeds[0].toJSON().description, /reply sebuah pesan/i);
  });
});
