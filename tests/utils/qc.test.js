import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandType, AttachmentBuilder, MessageFlags } from 'discord.js';
import {
  formatQcTimestamp,
  QC_ATTACHMENT_NAME,
  QC_DEFAULT_TIMEZONE,
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
} from '../../src/commands/qc.js';
import generateQcContextCommand from '../../src/commands/generateQcContext.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { PrefixCommandHandler } from '../../src/handlers/PrefixCommandHandler.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createMockSlashInteraction(text) {
  const events = [];
  return {
    commandName: 'qc',
    user: { id: 'u1' },
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    options: {
      getString: (name) => (name === 'text' ? text : null),
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
  it('validates text input, preserves newlines, and enforces max length', () => {
    assert.throws(() => validateQcText(''), /kosong/i);
    assert.throws(() => validateQcText('   \n\t '), /kosong/i);
    assert.throws(() => validateQcText(null), /wajib diisi/i);
    assert.throws(() => validateQcText('a'.repeat(QC_MAX_LENGTH + 1)), /maksimal/i);

    assert.equal(validateQcText('  halo\r\ndunia  '), 'halo\ndunia');
    assert.equal(validateQcText('a'.repeat(QC_MAX_LENGTH)).length, QC_MAX_LENGTH);
  });

  it('formats dynamic 24-hour HH:mm timestamps defaulting to Asia/Jakarta', () => {
    assert.equal(resolveQcTimeZone('Invalid/Zone'), QC_DEFAULT_TIMEZONE);
    // 13:04 UTC == 20:04 Asia/Jakarta (UTC+7)
    const sampleDate = new Date('2026-11-14T13:04:00Z');
    assert.equal(formatQcTimestamp(sampleDate, 'Asia/Jakarta'), '20:04');
    // 17:00 UTC == 00:00 Asia/Jakarta
    assert.equal(formatQcTimestamp(new Date('2026-11-14T17:00:00Z'), 'Asia/Jakarta'), '00:00');
  });

  it('renders 1080x1080 PNG for short text and dynamically expands canvas height for long text', () => {
    const shortPng = renderQcPng('Halo, apa kabar? ❤️🔥', {
      timestamp: new Date('2026-11-14T13:04:00Z'),
      timeZone: 'Asia/Jakarta',
    });
    assert.ok(shortPng.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(shortPng.readUInt32BE(16), QC_WIDTH);
    assert.equal(shortPng.readUInt32BE(20), QC_MIN_HEIGHT);

    const longText = Array.from({ length: 24 }, (_, idx) =>
      `Baris pesan ke-${idx + 1}: itu aku baru dengerin sekali lagunya terus keinget kamu.`,
    ).join('\n');
    const longPng = renderQcPng(longText);
    assert.ok(longPng.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(longPng.readUInt32BE(16), QC_WIDTH);
    assert.ok(
      longPng.readUInt32BE(20) > QC_MIN_HEIGHT,
      `Expected canvas height > ${QC_MIN_HEIGHT} for long multiline message, got ${longPng.readUInt32BE(20)}`,
    );
  });

  it('extracts only text and original timestamp without username or avatar', () => {
    const originalTime = new Date('2026-11-14T08:15:00Z').getTime();
    const extracted = extractQcSourceFromMessage({
      content: 'Pesan asli dari reply',
      cleanContent: 'Pesan asli dari reply',
      createdTimestamp: originalTime,
      author: { username: 'SecretUser', globalName: 'SecretDisplay', avatar: 'secret-hash' },
    });

    assert.deepEqual(extracted, {
      rawText: 'Pesan asli dari reply',
      timestamp: originalTime,
    });
    assert.equal('username' in extracted, false);
    assert.equal('avatar' in extracted, false);
    assert.throws(() => extractQcSourceFromMessage({ content: '', cleanContent: '' }), /tidak memiliki teks/i);
  });

  it('handles /qc slash command and Generate QC context menu via InteractionHandler', async () => {
    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();
    assert.equal(qcCommand.data.name, 'qc');
    assert.equal(generateQcContextCommand.data.name, 'Generate QC');
    assert.equal(generateQcContextCommand.data.type, ApplicationCommandType.Message);

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

    // Slash /qc
    const slashInteraction = createMockSlashInteraction('Halo dunia!');
    await handler.handle(slashInteraction);
    const slashEvents = slashInteraction.getEvents();
    assert.equal(slashEvents[0].type, 'deferReply');
    assert.equal(slashEvents[1].type, 'editReply');
    const slashAttachment = slashEvents[1].payload.files[0];
    assert.ok(slashAttachment instanceof AttachmentBuilder);
    assert.equal(slashAttachment.name, QC_ATTACHMENT_NAME);
    assert.ok(slashAttachment.attachment.subarray(0, 8).equals(PNG_SIGNATURE));

    // Message Context Menu "Generate QC" uses original message timestamp
    const targetCreated = new Date('2026-11-14T05:30:00Z').getTime();
    const ctxInteraction = createMockContextMenuInteraction({
      content: 'Pesan dari context menu',
      cleanContent: 'Pesan dari context menu',
      createdTimestamp: targetCreated,
    });
    await handler.handle(ctxInteraction);
    assert.equal(capturedTimestamps[1], targetCreated);
    assert.equal(ctxInteraction.getEvents()[1].payload.files[0].name, QC_ATTACHMENT_NAME);

    // Invalid empty slash input replies ephemerally
    const emptySlash = createMockSlashInteraction('   ');
    await executeQc(emptySlash);
    assert.equal(emptySlash.getEvents()[0].type, 'reply');
    assert.equal(emptySlash.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
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

    // 1. Manual text mode
    const manualReplies = [];
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
    assert.equal(manualReplies[0].files[0].name, QC_ATTACHMENT_NAME);
    assert.equal(capturedOpts[0].text, 'Halo, apa kabar?');

    // 2. Reply mode uses original replied message timestamp
    const repliedTime = new Date('2026-11-14T11:45:00Z').getTime();
    const replyModeReplies = [];
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
    assert.equal(replyModeReplies[0].files[0].name, QC_ATTACHMENT_NAME);
    assert.equal(capturedOpts[1].text, 'Isi pesan yang direply');
    assert.equal(capturedOpts[1].timestamp, repliedTime);

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
