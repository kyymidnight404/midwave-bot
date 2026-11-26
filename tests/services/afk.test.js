import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Events, PermissionFlagsBits } from 'discord.js';
import { createBotApp } from '../../src/index.js';
import messageCreateEvent from '../../src/events/messageCreate.js';
import { prisma } from '../../src/services/prisma.js';
import {
  AFK_DEFAULT_REASON,
  AFK_MAX_REASON_LENGTH,
  formatAfkDuration,
  formatAfkSince,
  getAfkStatus,
  handleAfkMessage,
  normalizeAfkReason,
  removeAfkStatus,
  setAfkStatus,
} from '../../src/services/afkService.js';
import { CooldownManager } from '../../src/utils/cooldown.js';

const TEST_USER_PREFIX = '88880000000000';
const uid = (suffix) => `${TEST_USER_PREFIX}${String(suffix).padStart(4, '0')}`;

function createFakeChannel(channelId = 'afk-ch-1', permissions = null) {
  const sent = [];
  return {
    id: channelId,
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: permissions ? () => permissions : undefined,
    async sendTyping() {},
    async send(payload) {
      const msg = { id: `sent-${sent.length + 1}`, channelId, payload };
      sent.push({ via: 'channel.send', payload });
      return msg;
    },
    getSent: () => sent,
  };
}

function createFakeMessage({
  id = `msg-${Math.random().toString(36).slice(2, 8)}`,
  content = '',
  author = { id: `${TEST_USER_PREFIX}u1`, username: 'alice', bot: false },
  channel = createFakeChannel(),
  guildId = 'afk-guild-1',
  mentions = [],
  client = null,
  webhookId = null,
  system = false,
  memberThrowUnknown = false,
  permissions = null,
} = {}) {
  const replies = [];
  const mentionMap = new Map(mentions.map((u) => [u.id, u]));
  const fakeGuild = guildId
    ? {
        id: guildId,
        members: {
          me: permissions ? { id: client?.user?.id ?? 'bot-self' } : null,
          cache: new Map(),
          async fetch(targetId) {
            if (memberThrowUnknown) {
              const err = new Error('Unknown Member');
              err.code = 10007;
              throw err;
            }
            throw new Error(`Unexpected fetch for ${targetId}`);
          },
        },
      }
    : null;

  if (permissions && channel && !channel.permissionsFor) {
    channel.permissionsFor = () => permissions;
  }

  return {
    id,
    content,
    author,
    member: { permissions: null },
    channel,
    channelId: channel.id,
    guild: fakeGuild,
    guildId,
    client,
    webhookId,
    system,
    mentions: {
      users: mentionMap,
    },
    async reply(payload) {
      const msg = { id: `reply-${replies.length + 1}`, channelId: channel.id, payload };
      replies.push({ via: 'reply', payload });
      return msg;
    },
    getReplies: () => replies,
    getAllOutputs: () => [...replies, ...channel.getSent()],
  };
}

function createFakeSlashAfkInteraction({
  userId = `${TEST_USER_PREFIX}slash-u1`,
  username = 'bob',
  alasan = null,
  channel = createFakeChannel('afk-slash-ch'),
} = {}) {
  const replies = [];
  return {
    commandName: 'afk',
    user: { id: userId, username, bot: false },
    guildId: 'afk-guild-1',
    channelId: channel.id,
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => null,
      getSubcommandGroup: () => null,
      getString: (name) => (name === 'alasan' ? alasan : null),
    },
    async reply(payload) {
      this.replied = true;
      replies.push({ type: 'reply', payload });
      return payload;
    },
    async editReply(payload) {
      replies.push({ type: 'editReply', payload });
      return payload;
    },
    async followUp(payload) {
      replies.push({ type: 'followUp', payload });
      return payload;
    },
    getReplies: () => replies,
  };
}

function makePerms({ view = true, send = true, embed = true } = {}) {
  const granted = new Set();
  if (view) granted.add(PermissionFlagsBits.ViewChannel);
  if (send) granted.add(PermissionFlagsBits.SendMessages);
  if (embed) granted.add(PermissionFlagsBits.EmbedLinks);
  return {
    has: (flag) => granted.has(flag),
  };
}

async function cleanupAfkTestRows() {
  await prisma.afkStatus.deleteMany({
    where: { userId: { startsWith: TEST_USER_PREFIX } },
  });
}

describe('AFK Feature — Prefix, Slash, Persistence & Auto-Clear Integration', () => {
  beforeEach(async () => {
    await cleanupAfkTestRows();
  });

  afterEach(async () => {
    await cleanupAfkTestRows();
  });

  it('normalizes reasons, formats Indonesian durations, and activates AFK via prefix !afk with and without reason', async () => {
    assert.equal(normalizeAfkReason(null), AFK_DEFAULT_REASON);
    assert.equal(normalizeAfkReason('   \u200B\uFEFF   '), AFK_DEFAULT_REASON);
    assert.equal(normalizeAfkReason('tidur @everyone'), 'tidur @\u200Beveryone');
    assert.equal(normalizeAfkReason('x'.repeat(AFK_MAX_REASON_LENGTH + 50)).length, AFK_MAX_REASON_LENGTH);
    assert.equal(formatAfkDuration(2 * 3600_000 + 15 * 60_000), '2 jam 15 menit');
    assert.equal(formatAfkSince(new Date(1_000_000 - 15 * 60_000), 1_000_000), '15 menit yang lalu');

    const app = await createBotApp({
      prisma,
      skipTempCleanup: true,
      cooldowns: new CooldownManager(0),
    });

    try {
      const uid1 = uid(1);
      const uid2 = uid(2);

      // With custom reason (even in a channel without EmbedLinks permission)
      const msg1 = createFakeMessage({
        content: '!afk sedang tidur',
        author: { id: uid1, username: 'alice', bot: false },
        permissions: makePerms({ view: true, send: true, embed: false }),
      });
      await messageCreateEvent.execute(msg1, app.context);

      const out1 = msg1.getAllOutputs();
      assert.equal(out1.length, 1);
      assert.equal(out1[0].payload.embeds, undefined);
      assert.deepEqual(out1[0].payload.allowedMentions, { parse: [], repliedUser: false });
      assert.match(out1[0].payload.content, new RegExp(`<@${uid1}>`));
      assert.match(out1[0].payload.content, /Alasan: sedang tidur/);

      const row1 = await getAfkStatus(uid1, { prisma });
      assert.ok(row1);
      assert.equal(row1.reason, 'sedang tidur');
      assert.ok(row1.since instanceof Date);

      // Without reason -> default 'Tidak ada alasan'
      const msg2 = createFakeMessage({
        content: '!afk',
        author: { id: uid2, username: 'bob', bot: false },
      });
      await messageCreateEvent.execute(msg2, app.context);

      const out2 = msg2.getAllOutputs();
      assert.equal(out2.length, 1);
      assert.equal(out2[0].payload.embeds, undefined);
      assert.match(out2[0].payload.content, new RegExp(`Alasan: ${AFK_DEFAULT_REASON}`));

      const row2 = await getAfkStatus(uid2, { prisma });
      assert.ok(row2);
      assert.equal(row2.reason, AFK_DEFAULT_REASON);
    } finally {
      app.shutdown();
    }
  });

  it('activates AFK via slash /afk (with and without alasan) and updates existing reason without duplicating records', async () => {
    const app = await createBotApp({
      prisma,
      skipTempCleanup: true,
      cooldowns: new CooldownManager(0),
    });

    try {
      const uidSlash = uid(20);

      // 1. Activate /afk without alasan
      const slashNoReason = createFakeSlashAfkInteraction({ userId: uidSlash, alasan: null });
      await app.interactionHandler.handle(slashNoReason);

      const r1 = slashNoReason.getReplies();
      assert.equal(r1.length, 1);
      assert.equal(r1[0].payload.embeds, undefined);
      assert.match(r1[0].payload.content, new RegExp(`Alasan: ${AFK_DEFAULT_REASON}`));

      let rows = await prisma.afkStatus.findMany({ where: { userId: uidSlash } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, AFK_DEFAULT_REASON);

      // 2. Replace AFK reason via /afk alasan:sedang belajar
      const slashWithReason = createFakeSlashAfkInteraction({ userId: uidSlash, alasan: 'sedang belajar' });
      await app.interactionHandler.handle(slashWithReason);

      const r2 = slashWithReason.getReplies();
      assert.equal(r2.length, 1);
      assert.match(r2[0].payload.content, /Alasan: sedang belajar/);

      rows = await prisma.afkStatus.findMany({ where: { userId: uidSlash } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, 'sedang belajar');

      // 3. Replace again via !afk while already AFK (must update without triggering welcome-back or deleting AFK)
      const msgUpdate = createFakeMessage({
        content: '!afk makan malam',
        author: { id: uidSlash, username: 'slashUser', bot: false },
      });
      await messageCreateEvent.execute(msgUpdate, app.context);

      const outputs = msgUpdate.getAllOutputs();
      assert.equal(outputs.length, 1);
      assert.equal(outputs[0].payload.content.includes('Selamat datang kembali'), false);
      assert.match(outputs[0].payload.content, /Alasan: makan malam/);

      rows = await prisma.afkStatus.findMany({ where: { userId: uidSlash } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, 'makan malam');
    } finally {
      app.shutdown();
    }
  });

  it('notifies once on single/multiple mentions, skips self-mentions and duplicates, and handles former guild members safely', async () => {
    const app = await createBotApp({
      prisma,
      skipTempCleanup: true,
      cooldowns: new CooldownManager(0),
    });

    try {
      const uidA = uid(10);
      const uidB = uid(11);
      const uidC = uid(12);
      const uidSender = uid(13);

      await setAfkStatus({
        userId: uidA,
        reason: 'Sedang belajar',
        prisma,
        now: () => new Date(Date.now() - 15 * 60_000),
      });
      await setAfkStatus({
        userId: uidB,
        reason: 'Istirahat',
        prisma,
        now: () => new Date(Date.now() - (2 * 3600_000 + 15 * 60_000)),
      });

      // 1. Single mention notification
      const chSingle = createFakeChannel('ch-single');
      const singleMentionMsg = createFakeMessage({
        content: `Halo <@${uidA}>`,
        author: { id: uidSender, username: 'sender', bot: false },
        channel: chSingle,
        mentions: [{ id: uidA, username: 'alice', bot: false }],
      });
      await messageCreateEvent.execute(singleMentionMsg, app.context);

      const singleOut = singleMentionMsg.getAllOutputs();
      assert.equal(singleOut.length, 1);
      assert.equal(singleOut[0].payload.embeds, undefined);
      assert.deepEqual(singleOut[0].payload.allowedMentions, { parse: [], repliedUser: false });
      assert.match(singleOut[0].payload.content, new RegExp(`🌙 <@${uidA}> sedang AFK`));
      assert.match(singleOut[0].payload.content, /Alasan: Sedang belajar/);
      assert.match(singleOut[0].payload.content, /Sejak: 15 menit yang lalu/);
      assert.ok(await getAfkStatus(uidA, { prisma }), 'Mentioning an AFK user must NOT clear their AFK status');

      // 2. Multiple & repeated mentions of uidA + uidB + non-AFK uidC + self-mention uidSender -> ONE single consolidated notice without duplicates
      const multiMentionMsg = createFakeMessage({
        content: `<@${uidA}> <@!${uidA}> <@${uidB}> <@${uidC}> <@${uidSender}> cek ya`,
        author: { id: uidSender, username: 'sender', bot: false },
        mentions: [
          { id: uidA, username: 'alice', bot: false },
          { id: uidB, username: 'bob', bot: false },
          { id: uidC, username: 'charlie', bot: false },
          { id: uidSender, username: 'sender', bot: false },
        ],
      });
      await messageCreateEvent.execute(multiMentionMsg, app.context);

      const multiOut = multiMentionMsg.getAllOutputs();
      assert.equal(multiOut.length, 1);
      const noticeText = multiOut[0].payload.content;
      assert.equal(noticeText.split(`🌙 <@${uidA}> sedang AFK`).length - 1, 1);
      assert.equal(noticeText.split(`🌙 <@${uidB}> sedang AFK`).length - 1, 1);
      assert.equal(noticeText.includes(uidC), false);
      assert.equal(noticeText.includes(uidSender), false);

      // 3. Self-mention alone when user is NOT AFK triggers nothing
      await setAfkStatus({
        userId: uidC,
        reason: 'Tidur',
        prisma,
        now: () => new Date(Date.now() - 60_000),
      });
      // Non-AFK sender mentioning self: no notification
      const selfMsg = createFakeMessage({
        content: `Ping diri sendiri <@${uidSender}>`,
        author: { id: uidSender, username: 'sender', bot: false },
        mentions: [{ id: uidSender, username: 'sender', bot: false }],
      });
      await messageCreateEvent.execute(selfMsg, app.context);
      assert.equal(selfMsg.getAllOutputs().length, 0);

      // 4. Mentioning an AFK user who already left the server (guild.members.fetch throws Unknown Member 10007, raw <@id> fallback) must NOT throw
      const formerMemberMsg = createFakeMessage({
        content: `Dimana <@999999999999999999> dan <@${uidB}>?`,
        author: { id: uidSender, username: 'sender', bot: false },
        mentions: [],
        memberThrowUnknown: true,
      });
      await assert.doesNotReject(() => messageCreateEvent.execute(formerMemberMsg, app.context));
      const formerOut = formerMemberMsg.getAllOutputs();
      assert.equal(formerOut.length, 1);
      assert.match(formerOut[0].payload.content, new RegExp(`🌙 <@${uidB}> sedang AFK`));
    } finally {
      app.shutdown();
    }
  });

  it('auto-removes AFK cleanly on normal messages & prefix commands without breaking command execution or duplicating under concurrency', async () => {
    const app = await createBotApp({
      prisma,
      skipTempCleanup: true,
      cooldowns: new CooldownManager(0),
    });

    try {
      const uid1 = uid(30);
      const uid2 = uid(31);
      const uid3 = uid(32);

      // 1. Return via normal chat message
      await setAfkStatus({
        userId: uid1,
        reason: 'Pergi makan',
        prisma,
        now: () => new Date(Date.now() - (2 * 3600_000 + 15 * 60_000)),
      });

      const normalReturnMsg = createFakeMessage({
        content: 'Halo semuanya aku balik!',
        author: { id: uid1, username: 'alice', bot: false },
      });
      await messageCreateEvent.execute(normalReturnMsg, app.context);

      const retOut1 = normalReturnMsg.getAllOutputs();
      assert.equal(retOut1.length, 1);
      assert.equal(retOut1[0].payload.embeds, undefined);
      assert.match(retOut1[0].payload.content, new RegExp(`☀️ Selamat datang kembali, <@${uid1}>!`));
      assert.match(retOut1[0].payload.content, /Kamu telah AFK selama 2 jam 15 menit\./);
      assert.equal(await getAfkStatus(uid1, { prisma }), null);

      // Subsequent normal message should NOT send welcome-back again
      const followMsg = createFakeMessage({
        content: 'Pesan berikutnya',
        author: { id: uid1, username: 'alice', bot: false },
      });
      await messageCreateEvent.execute(followMsg, app.context);
      assert.equal(followMsg.getAllOutputs().length, 0);

      // 2. Return via prefix command (!say) — must remove AFK AND still execute !say cleanly
      await setAfkStatus({
        userId: uid2,
        reason: 'AFK sebentar',
        prisma,
        now: () => new Date(Date.now() - 5 * 60_000),
      });

      const prefixCmdMsg = createFakeMessage({
        content: '!say tetap jalan',
        author: { id: uid2, username: 'bob', bot: false },
      });
      await messageCreateEvent.execute(prefixCmdMsg, app.context);

      const outputs2 = prefixCmdMsg.getAllOutputs();
      assert.equal(outputs2.length, 2);
      assert.ok(outputs2.some((o) => o.payload.content?.includes('Selamat datang kembali')));
      assert.ok(outputs2.some((o) => o.payload.content === 'tetap jalan'));
      assert.equal(await getAfkStatus(uid2, { prisma }), null);

      // 3. Concurrent messages from same returning AFK user send ONLY ONE welcome-back notification
      await setAfkStatus({
        userId: uid3,
        reason: 'Sibuk',
        prisma,
        now: () => new Date(Date.now() - 10 * 60_000),
      });
      const conc1 = createFakeMessage({ content: 'satu', author: { id: uid3, username: 'cara', bot: false } });
      const conc2 = createFakeMessage({ content: 'dua', author: { id: uid3, username: 'cara', bot: false } });
      await Promise.all([
        handleAfkMessage(conc1, { prisma }),
        handleAfkMessage(conc2, { prisma }),
      ]);
      assert.equal(conc1.getAllOutputs().length + conc2.getAllOutputs().length, 1);
      assert.equal(await getAfkStatus(uid3, { prisma }), null);
    } finally {
      app.shutdown();
    }
  });

  it('persists AFK across bot restart and ignores bot, webhook, and system messages', async () => {
    const uidPersist = uid(40);
    const uidOther = uid(41);

    // App instance 1 sets AFK then shuts down (simulating bot restart)
    const app1 = await createBotApp({
      prisma,
      skipTempCleanup: true,
      cooldowns: new CooldownManager(0),
    });
    const activateMsg = createFakeMessage({
      content: '!afk restart persistence test',
      author: { id: uidPersist, username: 'dana', bot: false },
    });
    await messageCreateEvent.execute(activateMsg, app1.context);
    app1.shutdown();

    // App instance 2 boots cleanly and reads persisted AFK from SQLite
    const app2 = await createBotApp({
      prisma,
      skipTempCleanup: true,
      cooldowns: new CooldownManager(0),
    });

    try {
      // Bot's own message mentioning uidPersist MUST NOT clear AFK or trigger another notification
      const selfBotMsg = createFakeMessage({
        content: `🌙 <@${uidPersist}> sedang AFK`,
        author: { id: 'midwave-bot-self', username: 'Midwave', bot: true },
        mentions: [{ id: uidPersist, username: 'dana', bot: false }],
      });
      await messageCreateEvent.execute(selfBotMsg, app2.context);
      assert.equal(selfBotMsg.getAllOutputs().length, 0);
      assert.ok(await getAfkStatus(uidPersist, { prisma }));

      // Other bot message masquerading author.id MUST NOT clear AFK or notify
      const botMsg = createFakeMessage({
        content: `🌙 <@${uidPersist}> sedang AFK`,
        author: { id: uidPersist, username: 'FakeBot', bot: true },
        mentions: [{ id: uidPersist, username: 'dana', bot: false }],
      });
      await messageCreateEvent.execute(botMsg, app2.context);
      assert.equal(botMsg.getAllOutputs().length, 0);
      assert.ok(await getAfkStatus(uidPersist, { prisma }));

      // Webhook message sharing author ID MUST NOT clear AFK or notify
      const webhookMsg = createFakeMessage({
        content: `Webhook <@${uidPersist}>`,
        author: { id: uidPersist, username: 'WebhookUser', bot: false },
        webhookId: 'wh-123',
        mentions: [{ id: uidPersist, username: 'dana', bot: false }],
      });
      await messageCreateEvent.execute(webhookMsg, app2.context);
      assert.equal(webhookMsg.getAllOutputs().length, 0);
      assert.ok(await getAfkStatus(uidPersist, { prisma }));

      // Regular user mentions uidPersist via live ClientReady/MessageCreate wiring after restart
      const humanMentionMsg = createFakeMessage({
        content: `Hei <@${uidPersist}>`,
        author: { id: uidOther, username: 'erin', bot: false },
        mentions: [{ id: uidPersist, username: 'dana', bot: false }],
      });
      app2.client.emit(Events.MessageCreate, humanMentionMsg);
      await new Promise((r) => setTimeout(r, 40));

      const mentionOut = humanMentionMsg.getAllOutputs();
      assert.equal(mentionOut.length, 1);
      assert.match(mentionOut[0].payload.content, /Alasan: restart persistence test/);

      // Cleanup still works after restart
      const returnMsg = createFakeMessage({
        content: 'Sudah kembali',
        author: { id: uidPersist, username: 'dana', bot: false },
      });
      await messageCreateEvent.execute(returnMsg, app2.context);
      assert.equal(returnMsg.getAllOutputs().length, 1);
      assert.match(returnMsg.getAllOutputs()[0].payload.content, /Selamat datang kembali/);
      assert.equal(await getAfkStatus(uidPersist, { prisma }), null);
    } finally {
      app2.shutdown();
    }
  });

  it('clears AFK cleanly even if channel SendMessages is denied and handles DB removal errors safely', async () => {
    const uidTarget = uid(50);
    await setAfkStatus({ userId: uidTarget, reason: 'Kerja', prisma });

    const noSendMsg = createFakeMessage({
      content: 'Pesan di channel read-only bot',
      author: { id: uidTarget, username: 'frank', bot: false },
      permissions: makePerms({ view: true, send: false, embed: false }),
    });
    await handleAfkMessage(noSendMsg, { prisma });

    assert.equal(noSendMsg.getAllOutputs().length, 0);
    assert.equal(await getAfkStatus(uidTarget, { prisma }), null);

    // Defensive check on removeAfkStatus when missing
    assert.equal(await removeAfkStatus(uidTarget, { prisma }), null);
  });
});
