import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { COLORS } from '../../src/config/colors.js';
import { EMOJIS } from '../../src/config/emojis.js';
import { commandStructure } from '../../src/config/commandStructure.js';
import { createBotApp } from '../../src/index.js';
import { CooldownManager } from '../../src/utils/cooldown.js';

function createFakeChannel(channelId, deletedMessageIds = new Set()) {
  const messages = new Map();
  let nextMsgId = 1000;

  return {
    id: channelId,
    isTextBased: () => true,
    messages: {
      async fetch(messageId) {
        if (deletedMessageIds.has(messageId)) {
          const err = new Error('Unknown Message');
          err.code = 10008;
          throw err;
        }
        const msg = messages.get(messageId);
        if (!msg) {
          const err = new Error('Unknown Message');
          err.code = 10008;
          throw err;
        }
        return msg;
      },
    },
    async send(payload) {
      const id = String(++nextMsgId);
      const msg = {
        id,
        channelId,
        payload,
        edits: [],
        async edit(newPayload) {
          if (deletedMessageIds.has(id)) {
            const err = new Error('Unknown Message');
            err.code = 10008;
            throw err;
          }
          this.payload = newPayload;
          this.edits.push(newPayload);
          return this;
        },
      };
      messages.set(id, msg);
      return msg;
    },
    _storeMessage(id, payload) {
      const msg = {
        id,
        channelId,
        payload,
        edits: [],
        async edit(newPayload) {
          if (deletedMessageIds.has(id)) {
            const err = new Error('Unknown Message');
            err.code = 10008;
            throw err;
          }
          this.payload = newPayload;
          this.edits.push(newPayload);
          return this;
        },
      };
      messages.set(id, msg);
      return msg;
    },
    _messages: messages,
  };
}

function createFakeClient(channel) {
  return {
    channels: {
      async fetch(id) {
        if (id === channel.id) return channel;
        throw new Error(`Unknown channel ${id}`);
      },
    },
    once() {},
    on() {},
    destroy() {},
  };
}

let msgSeq = 500;
function createMockCommandInteraction({
  commandName,
  subcommand = null,
  userId = 'u1',
  channel,
  options = {},
}) {
  let replyMsg = null;
  const replies = [];
  return {
    commandName,
    user: { id: userId },
    guildId: 'guild-1',
    channelId: channel.id,
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => null,
      getString: (name) => options[name] ?? (name === 'action' ? subcommand : null),
      getInteger: (name) => options[name] ?? null,
      getUser: (name) => options[name] ?? null,
    },
    async deferReply(opts = {}) {
      this.deferred = true;
      replies.push({ type: 'deferReply', payload: opts });
    },
    async reply(payload) {
      this.replied = true;
      replies.push({ type: 'reply', payload });
      if (!payload.flags) {
        replyMsg = channel._storeMessage(String(++msgSeq), payload);
      }
      return replyMsg;
    },
    async editReply(payload) {
      replies.push({ type: 'editReply', payload });
      if (!this.deferred || !replies.find((r) => r.type === 'deferReply')?.payload?.flags) {
        replyMsg = channel._storeMessage(String(++msgSeq), payload);
      }
      return replyMsg;
    },
    async followUp(payload) {
      replies.push({ type: 'followUp', payload });
    },
    async fetchReply() {
      return replyMsg;
    },
    getReplies: () => replies,
  };
}

describe('Integration: Slash Commands & End-to-End Flows', () => {
  it('registers all enabled Discord commands within API limits (no duplicates or option ordering violations)', async () => {
    const app = await createBotApp();
    const payloads = app.commandHandler.toJSON();
    const names = payloads.map((c) => c.name).sort();
    const expectedNames = commandStructure.commands
      .filter((c) => c.enabled !== false)
      .map((c) => c.name)
      .sort();
    assert.deepEqual(names, expectedNames);
    assert.ok(names.includes('autorole'));
    assert.equal(names.includes('game'), false);
    assert.equal(names.includes('invite'), false);
    assert.equal(names.includes('Generate QC'), false);
    assert.equal(new Set(payloads.map((c) => c.name)).size, expectedNames.length);

    for (const cmd of payloads) {
      assert.ok(/^[a-z0-9_-]{1,32}$/.test(cmd.name), `Invalid command name ${cmd.name}`);
      assert.ok(cmd.description && cmd.description.length <= 100);
      const options = cmd.options ?? [];
      assert.ok(options.length <= 25);
      let seenOptional = false;
      for (const opt of options) {
        if (opt.required) {
          assert.equal(seenOptional, false, `Required option ${opt.name} on /${cmd.name} must precede optional options`);
        } else {
          seenOptional = true;
        }
        if (Array.isArray(opt.choices)) {
          assert.ok(opt.choices.length <= 25, `Too many choices on /${cmd.name}.${opt.name}`);
        }
      }
    }
    app.shutdown();
  });

  it('executes /help cleanly', async () => {
    const channel = createFakeChannel('ch-help');
    const client = createFakeClient(channel);
    const app = await createBotApp({
      client,
      cooldowns: new CooldownManager(0),
    });

    const helpInt = createMockCommandInteraction({ commandName: 'help', userId: 'p1', channel });
    await app.interactionHandler.handle(helpInt);
    assert.equal(helpInt.getReplies().length, 1);

    app.shutdown();
  });

  it('dispatches all 4 /media actions (qc, brat, lyrics, download) and validates action-specific optional params', async () => {
    const channel = createFakeChannel('ch-media');
    const client = createFakeClient(channel);
    const app = await createBotApp({
      client,
      cooldowns: new CooldownManager(0),
    });

    app.interactionHandler.context.searchLyrics = async ({ query }) => ({
      title: query,
      artist: 'Midwave',
      album: 'Test',
      thumbnailUrl: null,
      lyrics: 'Sample lyrics line 1',
      sourceName: 'LRCLIB',
      sourceUrl: 'https://lrclib.net/api/get/1',
      cached: false,
    });

    const runMedia = async ({ action, ...options }) => {
      const interaction = createMockCommandInteraction({
        commandName: 'media',
        subcommand: action,
        userId: 'u-media-1',
        channel,
        options,
      });
      await app.interactionHandler.handle(interaction);
      return interaction.getReplies();
    };

    // 1. qc
    const qcEvents = await runMedia({ action: 'qc', text: 'Halo media qc!' });
    assert.equal(qcEvents[0].type, 'deferReply');
    assert.equal(qcEvents[1].type, 'editReply');
    assert.equal(qcEvents[1].payload.files[0].name, 'midwave-qc.png');

    // 2. brat
    const bratEvents = await runMedia({ action: 'brat', text: 'midwave consolidated' });
    assert.equal(bratEvents[0].type, 'deferReply');
    assert.equal(bratEvents[1].type, 'editReply');
    assert.equal(bratEvents[1].payload.files[0].name, 'midwave-brat.png');

    // 3. lyrics (missing query -> ephemeral; valid query -> paginated embed)
    const lyricsMissing = await runMedia({ action: 'lyrics' });
    assert.equal(lyricsMissing[0].type, 'reply');
    assert.equal(lyricsMissing[0].payload.flags, MessageFlags.Ephemeral);

    const lyricsOk = await runMedia({ action: 'lyrics', query: 'Ocean' });
    assert.equal(lyricsOk[0].type, 'deferReply');
    assert.equal(lyricsOk[1].type, 'editReply');

    // 4. download (missing url -> ephemeral without failing other actions)
    const downloadMissing = await runMedia({ action: 'download' });
    assert.equal(downloadMissing[0].type, 'reply');
    assert.equal(downloadMissing[0].payload.flags, MessageFlags.Ephemeral);

    // 5. invalid action
    const invalidMedia = await runMedia({ action: 'unknown' });
    assert.equal(invalidMedia[0].type, 'reply');
    assert.equal(invalidMedia[0].payload.flags, MessageFlags.Ephemeral);

    app.shutdown();
  });

  it('dispatches /media download and prefix !download cleanly', async () => {
    const channel = createFakeChannel('ch-download');
    const client = createFakeClient(channel);
    const app = await createBotApp({
      client,
      cooldowns: new CooldownManager(0),
    });
    const mockDownload = async ({ url }) => ({
      platformLabel: 'TikTok',
      mediaType: 'Video',
      fileFormat: 'MP4',
      formattedSize: '1.2 MB',
      truncatedCount: 0,
      items: [{ filePath: 'package.json', fileName: 'video.mp4' }],
      jobDir: null,
      sourceUrl: url,
    });
    app.interactionHandler.context.downloadMedia = mockDownload;
    app.prefixCommandHandler.context.downloadMedia = mockDownload;

    const slashInteraction = createMockCommandInteraction({
      commandName: 'media',
      subcommand: 'download',
      userId: 'dl-slash-user',
      username: 'SlashDL',
      channel,
      options: { url: 'https://vt.tiktok.com/ZSp4TETHK/' },
    });
    await app.interactionHandler.handle(slashInteraction);
    const slashLast = slashInteraction.getReplies().at(-1);
    assert.equal(slashLast.type, 'editReply');
    assert.equal(slashLast.payload.embeds, undefined);
    assert.equal(slashLast.payload.content, `${EMOJIS.success} TikTok\n\nMP4 · 1.2 MB`);
    assert.equal(slashLast.payload.files.length, 1);

    const replies = [];
    const prefixMessage = {
      id: 'dl-prefix-msg',
      content: '!download https://vt.tiktok.com/ZSp4TETHK/',
      author: { id: 'dl-prefix-user', username: 'PrefixDL', bot: false },
      guildId: 'guild-1',
      channelId: 'ch-1',
      channel: {
        sendTyping: async () => {},
        send: async (payload) => {
          replies.push(payload);
          return { id: 'sent-1', edit: async (p) => replies.push(p) };
        },
      },
      reply: async (payload) => {
        replies.push(payload);
        return { id: 'reply-1', edit: async (p) => replies.push(p) };
      },
    };
    await app.prefixCommandHandler.handle(prefixMessage);
    assert.ok(replies.length >= 1);
    assert.equal(replies.at(-1).embeds, undefined);
    assert.equal(replies.at(-1).content, `${EMOJIS.success} TikTok\n\nMP4 · 1.2 MB`);
    assert.equal(replies.at(-1).files.length, 1);

    app.shutdown();
  });

  it('executes /donate with Midwave embed theme and two Discord Link Buttons', async () => {
    const app = await createBotApp({ cooldownMs: 0 });
    const channel = createFakeChannel('ch-donate');
    const interaction = createMockCommandInteraction({
      commandName: 'donate',
      userId: 'user-donate',
      channel,
    });

    await app.interactionHandler.handle(interaction);
    const replies = interaction.getReplies();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].type, 'reply');

    const payload = replies[0].payload;
    assert.equal(payload.embeds.length, 1);
    const embedJson = payload.embeds[0].toJSON();
    assert.equal(embedJson.color, COLORS.PRIMARY);
    assert.equal(embedJson.title, '☕ Buy Me a Coffee?');
    assert.equal(
      embedJson.description,
      'Enjoying Midwave? Consider buying me a coffee! Every little support helps keep this project alive. Thank you for being here! 💙',
    );
    assert.equal(embedJson.footer?.text, 'Thank you for supporting Midwave!');

    assert.equal(payload.components.length, 1);
    const rowJson = payload.components[0].toJSON();
    assert.equal(rowJson.components.length, 2);

    const [saweriaBtn, kofiBtn] = rowJson.components;
    assert.equal(saweriaBtn.style, ButtonStyle.Link);
    assert.equal(saweriaBtn.label, '🇮🇩 Donate via Saweria');
    assert.equal(saweriaBtn.url, 'https://saweria.co/kyymidnight');
    assert.equal(saweriaBtn.custom_id, undefined);

    assert.equal(kofiBtn.style, ButtonStyle.Link);
    assert.equal(kofiBtn.label, '🌍 Donate via Ko-fi');
    assert.equal(kofiBtn.url, 'https://ko-fi.com/kyymidnight');
    assert.equal(kofiBtn.custom_id, undefined);

    app.shutdown();
  });
});
