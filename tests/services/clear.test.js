import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { EMOJIS } from '../../src/config/emojis.js';
import { createBotApp } from '../../src/index.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import {
  ClearValidationError,
  DISCORD_BULK_DELETE_MAX_AGE_MS,
  validateClearAmount,
} from '../../src/prefixCommands/clear.js';
import { discoverHelpEntries } from '../../src/services/helpService.js';

function createChannelMock({
  id = 'ch-clear-1',
  name = 'general',
  storedMessages = [],
  botPermissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ]),
  isDM = false,
  supportsBulkDelete = true,
  fetchError = null,
  bulkDeleteError = null,
  ignoreFetchLimit = false,
} = {}) {
  const fetchCalls = [];
  const bulkDeleteCalls = [];
  const sentMessages = [];
  const individualDeletedIds = [];

  const messageMap = new Map();
  for (const m of storedMessages) {
    const entry = {
      ...m,
      async delete() {
        individualDeletedIds.push(m.id);
        messageMap.delete(m.id);
        return this;
      },
    };
    messageMap.set(m.id, entry);
  }

  const channel = {
    id,
    name,
    isTextBased: () => true,
    isDMBased: () => isDM,
    permissionsFor: () => botPermissions,
    sentMessages,
    fetchCalls,
    bulkDeleteCalls,
    individualDeletedIds,
    _messageMap: messageMap,
    async send(payload) {
      sentMessages.push(payload);
      return { id: `sent-${sentMessages.length}`, channelId: id, payload };
    },
    messages: {
      async fetch(options = {}) {
        fetchCalls.push(options);
        if (fetchError) {
          throw fetchError;
        }
        const limit = typeof options.limit === 'number' ? options.limit : 50;
        const all = [...messageMap.values()].filter((m) => m.id !== options.before);
        // Newest first (assuming storedMessages provided newest -> oldest or sorted descending by createdTimestamp)
        const sorted = all.sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0));
        const sliced = ignoreFetchLimit ? sorted : sorted.slice(0, limit);
        return new Collection(sliced.map((m) => [m.id, m]));
      },
    },
  };

  if (supportsBulkDelete) {
    channel.bulkDelete = async (items, filterOld = false) => {
      bulkDeleteCalls.push({ items, filterOld });
      if (bulkDeleteError) {
        throw bulkDeleteError;
      }
      const list = Array.isArray(items) ? items : Array.from(items?.values?.() ?? []);
      const deleted = new Collection();
      for (const item of list) {
        const msgId = typeof item === 'string' ? item : item?.id;
        const found = messageMap.get(msgId);
        if (found) {
          messageMap.delete(msgId);
          deleted.set(msgId, found);
        }
      }
      return deleted;
    };
  }

  return channel;
}

function createMockMessage({
  id = 'cmd-msg-1',
  content,
  authorId = 'user-1',
  isBot = false,
  memberPermissions = new PermissionsBitField([PermissionFlagsBits.Administrator]),
  botPermissions = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ManageMessages,
  ]),
  channel,
  inGuild = true,
  deletable = true,
  deleteShouldFail = false,
} = {}) {
  const replies = [];
  let commandDeleted = false;

  return {
    id,
    content,
    author: {
      id: authorId,
      bot: isBot,
      username: `user-${authorId}`,
    },
    member: inGuild ? { id: authorId, permissions: memberPermissions } : null,
    channelId: channel.id,
    channel,
    guildId: inGuild ? 'guild-1' : null,
    guild: inGuild
      ? {
          id: 'guild-1',
          members: {
            me: { id: 'bot-1', permissions: botPermissions },
          },
        }
      : null,
    client: { user: { id: 'bot-1' } },
    deletable,
    async delete() {
      if (deleteShouldFail) {
        throw new Error('Cannot delete command message');
      }
      commandDeleted = true;
      return this;
    },
    async reply(payload) {
      replies.push(payload);
      return { id: `reply-${replies.length}`, payload };
    },
    getReplies: () => replies,
    wasCommandDeleted: () => commandDeleted,
  };
}

function makeMessages(count, { baseTime = Date.now(), ageMs = 1_000, includeBots = false } = {}) {
  const msgs = [];
  for (let i = 0; i < count; i += 1) {
    msgs.push({
      id: `m-${i + 1}`,
      createdTimestamp: baseTime - ageMs - i * 1_000,
      author: { id: includeBots && i % 2 === 0 ? 'other-bot' : `u-${i}`, bot: includeBots && i % 2 === 0 },
    });
  }
  return msgs;
}

async function createTestApp(nowFn = () => Date.now()) {
  return createBotApp({
    cooldowns: new CooldownManager(0, nowFn),
    skipTempCleanup: true,
    logger: { log() {}, warn() {}, error() {} },
  });
}

describe('MIDWAVE !clear (Administrator Only) Command', () => {
  it('validates amount strictly between 1 and 100 integers', () => {
    assert.equal(validateClearAmount('1'), 1);
    assert.equal(validateClearAmount('10'), 10);
    assert.equal(validateClearAmount('50'), 50);
    assert.equal(validateClearAmount('100'), 100);
    assert.equal(validateClearAmount('  25  '), 25);

    for (const invalid of ['', '   ', null, undefined, 'abc', '0', '-5', '1.5', '101', '999', '10 extra']) {
      assert.throws(() => validateClearAmount(invalid), ClearValidationError);
    }
  });

  it('allows Administrator to bulk-delete up to requested count (10/50/100) including other bot messages and cleans up command', async () => {
    const app = await createTestApp();
    const now = Date.now();
    const channel = createChannelMock({
      name: 'mod-log',
      storedMessages: makeMessages(15, { baseTime: now, includeBots: true }),
    });
    const msg = createMockMessage({
      content: '!clear 10',
      channel,
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
    });

    await app.prefixCommandHandler.handle(msg);

    assert.equal(channel.fetchCalls.length, 1);
    assert.deepEqual(channel.fetchCalls[0], { limit: 10, before: msg.id });
    assert.equal(channel.bulkDeleteCalls.length, 1);
    assert.equal(channel.bulkDeleteCalls[0].filterOld, true);
    assert.equal(channel.bulkDeleteCalls[0].items.length, 10);
    assert.equal(channel._messageMap.size, 5); // 15 - 10 = 5 untouched
    assert.equal(msg.wasCommandDeleted(), true);
    assert.equal(channel.sentMessages.length, 1);

    const embed = channel.sentMessages[0].embeds[0].toJSON();
    assert.ok(embed.title.startsWith(EMOJIS.delete));
    assert.match(embed.description, /10 pesan/);
    assert.match(embed.description, /#mod-log/);

    // Also test 50 & 100 bounds
    const ch100 = createChannelMock({ storedMessages: makeMessages(120, { baseTime: now }) });
    const msg100 = createMockMessage({ content: '!clear 100', channel: ch100 });
    await app.prefixCommandHandler.handle(msg100);
    assert.equal(ch100.bulkDeleteCalls[0].items.length, 100);
    assert.equal(ch100._messageMap.size, 20);
  });

  it('rejects normal members, moderators with ManageMessages (without Administrator), and other bots before fetching', async () => {
    const app = await createTestApp();

    // Normal member
    const chMember = createChannelMock({ storedMessages: makeMessages(5) });
    const memberMsg = createMockMessage({
      content: '!clear 5',
      channel: chMember,
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.SendMessages]),
    });
    await app.prefixCommandHandler.handle(memberMsg);
    assert.equal(chMember.fetchCalls.length, 0);
    assert.equal(chMember.bulkDeleteCalls.length, 0);
    assert.equal(memberMsg.wasCommandDeleted(), false);
    assert.match(memberMsg.getReplies()[0].embeds[0].toJSON().description, /Administrator/i);

    // Moderator with ManageMessages only (NO Administrator)
    const chMod = createChannelMock({ storedMessages: makeMessages(5) });
    const modMsg = createMockMessage({
      content: '!clear 5',
      channel: chMod,
      memberPermissions: new PermissionsBitField([
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels,
      ]),
    });
    await app.prefixCommandHandler.handle(modMsg);
    assert.equal(chMod.fetchCalls.length, 0);
    assert.equal(chMod.bulkDeleteCalls.length, 0);
    assert.equal(modMsg.wasCommandDeleted(), false);
    assert.match(modMsg.getReplies()[0].embeds[0].toJSON().description, /Administrator/i);

    // Another bot
    const chBot = createChannelMock({ storedMessages: makeMessages(5) });
    const botMsg = createMockMessage({
      content: '!clear 5',
      isBot: true,
      channel: chBot,
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
    });
    await app.prefixCommandHandler.handle(botMsg);
    assert.equal(chBot.fetchCalls.length, 0);
    assert.equal(chBot.bulkDeleteCalls.length, 0);
    assert.equal(botMsg.getReplies().length, 0);
  });

  it('rejects DM usage and rejects when bot lacks ManageMessages permission', async () => {
    const app = await createTestApp();

    // DM usage
    const dmChannel = createChannelMock({ isDM: true });
    const dmMsg = createMockMessage({
      content: '!clear 5',
      channel: dmChannel,
      inGuild: false,
    });
    await app.prefixCommandHandler.handle(dmMsg);
    assert.equal(dmChannel.fetchCalls.length, 0);
    assert.equal(dmChannel.bulkDeleteCalls.length, 0);
    assert.match(dmMsg.getReplies()[0].embeds[0].toJSON().description, /DM|server/i);

    // Bot missing ManageMessages
    const noPermBits = new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]);
    const chNoPerm = createChannelMock({
      storedMessages: makeMessages(5),
      botPermissions: noPermBits,
    });
    const noPermMsg = createMockMessage({
      content: '!clear 5',
      channel: chNoPerm,
      botPermissions: noPermBits,
    });
    await app.prefixCommandHandler.handle(noPermMsg);
    assert.equal(chNoPerm.fetchCalls.length, 0);
    assert.equal(chNoPerm.bulkDeleteCalls.length, 0);
    assert.match(noPermMsg.getReplies()[0].embeds[0].toJSON().description, /Manage Messages/i);
  });

  it('rejects invalid amounts (!clear, !clear abc, !clear 0, !clear 101) without deleting any messages', async () => {
    const app = await createTestApp();
    for (const content of ['!clear', '!clear abc', '!clear 0', '!clear 101']) {
      const ch = createChannelMock({ storedMessages: makeMessages(5) });
      const msg = createMockMessage({ content, channel: ch });
      await app.prefixCommandHandler.handle(msg);
      assert.equal(ch.fetchCalls.length, 0, `Expected no fetch for ${content}`);
      assert.equal(ch.bulkDeleteCalls.length, 0, `Expected no bulkDelete for ${content}`);
      assert.equal(msg.wasCommandDeleted(), false);
      assert.equal(msg.getReplies().length, 1);
      assert.match(msg.getReplies()[0].embeds[0].toJSON().description, /!clear <jumlah>/i);
    }
  });

  it('handles messages older than 14 days safely without individual deletion fallback', async () => {
    const app = await createTestApp();
    const now = Date.now();
    const fifteenDaysMs = DISCORD_BULK_DELETE_MAX_AGE_MS + 24 * 60 * 60 * 1000;

    // Mixed: 3 recent (<14d) + 2 old (>14d)
    const mixedMessages = [
      ...makeMessages(3, { baseTime: now, ageMs: 1_000 }),
      { id: 'old-1', createdTimestamp: now - fifteenDaysMs },
      { id: 'old-2', createdTimestamp: now - fifteenDaysMs - 5_000 },
    ];
    const chMixed = createChannelMock({ storedMessages: mixedMessages });
    const msgMixed = createMockMessage({ content: '!clear 5', channel: chMixed });
    await app.prefixCommandHandler.handle(msgMixed);

    assert.equal(chMixed.bulkDeleteCalls.length, 1);
    assert.equal(chMixed.bulkDeleteCalls[0].items.length, 3);
    assert.equal(chMixed.individualDeletedIds.length, 0); // Must NOT individually delete old messages!
    assert.equal(chMixed._messageMap.has('old-1'), true);
    assert.equal(chMixed._messageMap.has('old-2'), true);
    const mixedEmbed = chMixed.sentMessages[0].embeds[0].toJSON();
    assert.match(mixedEmbed.description, /3 pesan/);
    assert.match(mixedEmbed.description, /2 pesan/);
    assert.match(mixedEmbed.description, /14 hari/);

    // All >14d: bulkDelete must not even be called
    const chAllOld = createChannelMock({
      storedMessages: [
        { id: 'old-a', createdTimestamp: now - fifteenDaysMs },
        { id: 'old-b', createdTimestamp: now - fifteenDaysMs - 10_000 },
      ],
    });
    const msgAllOld = createMockMessage({ content: '!clear 10', channel: chAllOld });
    await app.prefixCommandHandler.handle(msgAllOld);
    assert.equal(chAllOld.bulkDeleteCalls.length, 0);
    assert.equal(chAllOld.individualDeletedIds.length, 0);
    const allOldEmbed = chAllOld.sentMessages[0].embeds[0].toJSON();
    assert.match(allOldEmbed.description, /2 pesan/);
    assert.match(allOldEmbed.description, /14 hari/);
  });

  it('never deletes more messages than requested even if channel fetch returns extra items', async () => {
    const app = await createTestApp();
    const ch = createChannelMock({
      storedMessages: makeMessages(25),
      ignoreFetchLimit: true,
    });
    const msg = createMockMessage({ content: '!clear 10', channel: ch });

    await app.prefixCommandHandler.handle(msg);

    assert.equal(ch.bulkDeleteCalls.length, 1);
    assert.equal(ch.bulkDeleteCalls[0].items.length, 10);
    assert.equal(ch._messageMap.size, 15);
  });

  it('handles Discord API errors (50013, 429, unsupported channel) safely without crashing', async () => {
    const app = await createTestApp();

    const permErr = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const chPermErr = createChannelMock({ storedMessages: makeMessages(3), bulkDeleteError: permErr });
    const msgPermErr = createMockMessage({ content: '!clear 3', channel: chPermErr });
    await app.prefixCommandHandler.handle(msgPermErr);
    assert.match(msgPermErr.getReplies()[0].embeds[0].toJSON().description, /Manage Messages/i);

    const rateErr = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const chRateErr = createChannelMock({ storedMessages: makeMessages(3), bulkDeleteError: rateErr });
    const msgRateErr = createMockMessage({ content: '!clear 3', channel: chRateErr });
    await app.prefixCommandHandler.handle(msgRateErr);
    assert.equal(chRateErr.bulkDeleteCalls.length, 1); // No aggressive retry loop
    assert.match(msgRateErr.getReplies()[0].embeds[0].toJSON().description, /rate limit/i);

    const chUnsupported = createChannelMock({ supportsBulkDelete: false });
    const msgUnsupported = createMockMessage({ content: '!clear 3', channel: chUnsupported });
    await app.prefixCommandHandler.handle(msgUnsupported);
    assert.match(msgUnsupported.getReplies()[0].embeds[0].toJSON().description, /tidak mendukung/i);
  });

  it('shows !clear in Help only for Administrators and hides it from normal users and non-admin moderators', () => {
    const userEntries = discoverHelpEntries({ memberPermissions: null, prefix: '!' });
    const modEntries = discoverHelpEntries({
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageMessages]),
      prefix: '!',
    });
    const adminEntries = discoverHelpEntries({
      memberPermissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
      prefix: '!',
    });

    assert.equal(userEntries.some((e) => e.id === 'prefix:clear'), false);
    assert.equal(modEntries.some((e) => e.id === 'prefix:clear'), false);

    const clearHelp = adminEntries.find((e) => e.id === 'prefix:clear');
    assert.ok(clearHelp);
    assert.equal(clearHelp.category, 'media_utilities');
    assert.match(clearHelp.line, /!clear <jumlah>/);
    assert.match(clearHelp.line, /Administrator Only/i);
  });
});
