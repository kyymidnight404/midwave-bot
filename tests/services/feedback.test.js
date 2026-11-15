import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { PrefixCommandHandler } from '../../src/handlers/PrefixCommandHandler.js';
import {
  clearFeedbackStateForTests,
  FEEDBACK_CATEGORIES,
  FEEDBACK_COOLDOWN_MS,
  FEEDBACK_CUSTOM_ID_PREFIX,
  isStaffMember,
  validateFeedbackInput,
} from '../../src/services/feedbackService.js';
import { CooldownManager } from '../../src/utils/cooldown.js';

function createMockGuildChannel({
  id = '999888777666555444',
  name = 'staff-feedback',
  botPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ],
  everyoneCanView = false,
  sendError = null,
} = {}) {
  const sentMessages = [];
  const everyoneRole = { id: 'everyone' };
  const botMember = { id: 'bot-1' };

  return {
    id,
    name,
    sentMessages,
    isTextBased: () => true,
    guild: {
      id: 'guild-1',
      name: 'Midwave HQ',
      members: { me: botMember },
      roles: { everyone: everyoneRole },
    },
    permissionsFor(target) {
      if (target === botMember) {
        return { has: (perm) => botPerms.includes(perm) };
      }
      if (target === everyoneRole) {
        return { has: (perm) => (perm === PermissionFlagsBits.ViewChannel ? everyoneCanView : false) };
      }
      return { has: () => false };
    },
    async send(payload) {
      if (sendError) throw sendError;
      const msg = { id: `staff-msg-${sentMessages.length + 1}`, ...payload };
      sentMessages.push(msg);
      return msg;
    },
  };
}

function createMockClient(staffChannel = null) {
  const cache = new Map();
  if (staffChannel) cache.set(staffChannel.id, staffChannel);

  return {
    user: { id: 'bot-1', tag: 'Midwave#0001' },
    channels: {
      cache,
      async fetch(id) {
        return cache.get(id) ?? null;
      },
    },
  };
}

function createMockPrefixMessage({
  content = '!feedback',
  userId = '111222333444555666',
  username = 'reporter',
  attachments = [],
  client,
} = {}) {
  const replies = [];
  const channelSends = [];

  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content,
    author: { id: userId, username, tag: `${username}#0001`, bot: false },
    member: { permissions: { has: () => true } },
    guild: {
      id: 'guild-1',
      name: 'Midwave HQ',
      members: { me: { id: 'bot-1' } },
    },
    channel: {
      id: 'public-channel-1',
      permissionsFor: () => ({
        has: (perm) =>
          [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
          ].includes(perm),
      }),
      async send(payload) {
        channelSends.push(payload);
        return { id: 'pub-msg-1', ...payload };
      },
    },
    attachments: new Map(attachments.map((a, idx) => [String(idx), a])),
    mentions: { users: new Map() },
    client,
    replies,
    channelSends,
    async reply(payload) {
      replies.push(payload);
      return { id: 'prompt-msg-1', ...payload };
    },
  };
}

function extractCustomIdsFromRows(components = []) {
  const ids = [];
  for (const row of components) {
    const json = typeof row.toJSON === 'function' ? row.toJSON() : row;
    for (const comp of json.components || []) {
      if (comp.custom_id) ids.push(comp.custom_id);
    }
  }
  return ids;
}

describe('Feedback & Reports System (!feedback)', () => {
  beforeEach(() => {
    clearFeedbackStateForTests();
  });

  it('validates feedback input and rejects empty, oversized, or invalid screenshot URLs', () => {
    assert.equal(validateFeedbackInput({ category: 'unknown', subject: 'abc', description: 'valid description' }).valid, false);
    assert.equal(validateFeedbackInput({ category: 'bug', subject: '   ', description: 'valid description' }).valid, false);
    assert.equal(validateFeedbackInput({ category: 'bug', subject: 'a'.repeat(101), description: 'valid description' }).valid, false);
    assert.equal(validateFeedbackInput({ category: 'bug', subject: 'Valid', description: 'b'.repeat(1001) }).valid, false);
    assert.equal(
      validateFeedbackInput({
        category: 'bug',
        subject: 'Valid',
        description: 'Valid description here',
        screenshotUrl: 'javascript:alert(1)',
      }).valid,
      false,
    );

    const ok = validateFeedbackInput({
      category: 'feature',
      subject: 'Add dark mode',
      description: 'Please add dark mode support to cards.',
      screenshotUrl: 'https://example.com/screen.png',
    });
    assert.equal(ok.valid, true);
    assert.equal(ok.data.category, 'feature');
  });

  it('executes !feedback, supports all 4 categories, opens modal, submits to staff channel, and sends ephemeral confirmation', async () => {
    const staffChannel = createMockGuildChannel();
    const client = createMockClient(staffChannel);
    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();

    let now = 1_000_000;
    const cooldowns = new CooldownManager(2_000, () => now);
    const env = { FEEDBACK_CHANNEL_ID: staffChannel.id, FEEDBACK_STAFF_ROLE_IDS: '777888999000111222' };
    const context = { client, cooldowns, env, logger: { error() {}, warn() {}, log() {} } };

    const interactionHandler = new InteractionHandler({ commandHandler, cooldowns, context });
    const prefixHandler = new PrefixCommandHandler({ commandHandler, cooldowns, prefix: '!', context });

    for (const categoryId of Object.keys(FEEDBACK_CATEGORIES)) {
      now += FEEDBACK_COOLDOWN_MS + 1_000;
      const msg = createMockPrefixMessage({
        content: '!feedback',
        userId: `10000000000000000${Object.keys(FEEDBACK_CATEGORIES).indexOf(categoryId)}`,
        username: `user_${categoryId}`,
        client,
      });

      await prefixHandler.handle(msg);
      assert.equal(msg.replies.length, 1);
      const promptReply = msg.replies[0];
      assert.equal(promptReply.embeds[0].data.title, 'Midwave Feedback & Reports');

      const [selectCustomId, openCustomId] = extractCustomIdsFromRows(promptReply.components);
      assert.ok(selectCustomId.startsWith(`${FEEDBACK_CUSTOM_ID_PREFIX}:category:`));
      assert.ok(openCustomId.startsWith(`${FEEDBACK_CUSTOM_ID_PREFIX}:open:`));

      // Non-owner cannot select category
      const nonOwnerReplies = [];
      await interactionHandler.handle({
        customId: selectCustomId,
        user: { id: '999999999999999999' },
        values: [categoryId],
        isStringSelectMenu: () => true,
        isButton: () => false,
        isModalSubmit: () => false,
        async reply(p) {
          nonOwnerReplies.push(p);
        },
      });
      assert.equal(nonOwnerReplies.length, 1);
      assert.equal(nonOwnerReplies[0].flags, MessageFlags.Ephemeral);

      // Owner selects category
      let updatedPrompt = null;
      await interactionHandler.handle({
        customId: selectCustomId,
        user: msg.author,
        values: [categoryId],
        isStringSelectMenu: () => true,
        isButton: () => false,
        isModalSubmit: () => false,
        async update(p) {
          updatedPrompt = p;
        },
      });
      assert.ok(updatedPrompt.embeds[0].data.description.includes(FEEDBACK_CATEGORIES[categoryId].label));

      // Owner clicks Submit Feedback -> shows Modal
      let shownModal = null;
      await interactionHandler.handle({
        customId: openCustomId,
        user: msg.author,
        isStringSelectMenu: () => false,
        isButton: () => true,
        isModalSubmit: () => false,
        async showModal(modal) {
          shownModal = modal;
        },
      });
      assert.ok(shownModal);
      const modalJson = shownModal.toJSON();
      assert.ok(modalJson.custom_id.startsWith(`${FEEDBACK_CUSTOM_ID_PREFIX}:submit:`));

      // Owner submits Modal
      const modalReplies = [];
      await interactionHandler.handle({
        customId: modalJson.custom_id,
        user: msg.author,
        guild: msg.guild,
        client,
        fields: {
          getTextInputValue(fieldId) {
            if (fieldId === 'subject') return `Test ${categoryId} subject`;
            if (fieldId === 'description') return `Detailed description for ${categoryId} report.`;
            if (fieldId === 'screenshot_url') return 'https://example.com/proof.png';
            return '';
          },
        },
        isStringSelectMenu: () => false,
        isButton: () => false,
        isModalSubmit: () => true,
        async reply(p) {
          modalReplies.push(p);
        },
      });

      // User receives ephemeral confirmation with Report ID, no public channel leak
      assert.equal(modalReplies.length, 1);
      assert.equal(modalReplies[0].flags, MessageFlags.Ephemeral);
      assert.match(modalReplies[0].embeds[0].data.description, /FB-[A-F0-9]{6}/);
      assert.equal(msg.channelSends.length, 0);
    }

    // All 4 reports landed in staff channel
    assert.equal(staffChannel.sentMessages.length, 4);
    const firstReport = staffChannel.sentMessages[0];
    const fieldNames = firstReport.embeds[0].data.fields.map((f) => f.name);
    assert.deepEqual(fieldNames, ['Kategori', 'Status', 'Waktu Laporan', 'Pelapor', 'Server Asal']);
    assert.equal(firstReport.embeds[0].data.image.url, 'https://example.com/proof.png');
  });

  it('enforces staff permissions and updates report status embed + staff identity', async () => {
    assert.equal(isStaffMember({ permissions: { has: () => true } }, {}), true);
    assert.equal(
      isStaffMember(
        { permissions: { has: () => false }, roles: { cache: new Set(['777888999000111222']) } },
        { FEEDBACK_STAFF_ROLE_IDS: '777888999000111222' },
      ),
      true,
    );
    assert.equal(
      isStaffMember(
        { permissions: { has: () => false }, roles: { cache: new Set(['111']) } },
        { FEEDBACK_STAFF_ROLE_IDS: '777888999000111222' },
      ),
      false,
    );

    const staffChannel = createMockGuildChannel();
    const client = createMockClient(staffChannel);
    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();
    const cooldowns = new CooldownManager();
    const env = { FEEDBACK_CHANNEL_ID: staffChannel.id, FEEDBACK_STAFF_ROLE_IDS: '777888999000111222' };
    const context = { client, cooldowns, env, logger: { error() {}, warn() {}, log() {} } };

    const interactionHandler = new InteractionHandler({ commandHandler, cooldowns, context });
    const prefixHandler = new PrefixCommandHandler({ commandHandler, cooldowns, prefix: '!', context });

    const msg = createMockPrefixMessage({ client });
    await prefixHandler.handle(msg);
    const [selectId, openId] = extractCustomIdsFromRows(msg.replies[0].components);

    await interactionHandler.handle({
      customId: selectId,
      user: msg.author,
      values: ['bug'],
      isStringSelectMenu: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      async update() {},
    });

    let modalCustomId = '';
    await interactionHandler.handle({
      customId: openId,
      user: msg.author,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      async showModal(m) {
        modalCustomId = m.toJSON().custom_id;
      },
    });

    await interactionHandler.handle({
      customId: modalCustomId,
      user: msg.author,
      guild: msg.guild,
      client,
      fields: {
        getTextInputValue(id) {
          if (id === 'subject') return 'Bot crash on command';
          if (id === 'description') return 'Steps to reproduce the crash in detail.';
          return '';
        },
      },
      isStringSelectMenu: () => false,
      isButton: () => false,
      isModalSubmit: () => true,
      async reply() {},
    });

    const staffMsg = staffChannel.sentMessages[0];
    const [reviewId, resolveId, rejectId] = extractCustomIdsFromRows(staffMsg.components);

    // Non-staff user is rejected ephemerally
    const unauthReplies = [];
    await interactionHandler.handle({
      customId: reviewId,
      user: { id: '333', username: 'member' },
      member: { permissions: { has: () => false }, roles: { cache: new Set() } },
      message: staffMsg,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      async reply(p) {
        unauthReplies.push(p);
      },
    });
    assert.equal(unauthReplies.length, 1);
    assert.equal(unauthReplies[0].flags, MessageFlags.Ephemeral);

    // Staff marks Reviewing -> Resolved -> Rejected
    for (const [btnId, expectedStatus] of [
      [reviewId, '🔵 Reviewing'],
      [resolveId, '🟢 Resolved'],
      [rejectId, '🔴 Rejected'],
    ]) {
      let updated = null;
      let followUp = null;
      await interactionHandler.handle({
        customId: btnId,
        user: { id: '444', username: 'mod_user', tag: 'mod_user#0001' },
        member: { permissions: { has: () => false }, roles: { cache: new Set(['777888999000111222']) } },
        message: staffMsg,
        isStringSelectMenu: () => false,
        isButton: () => true,
        isModalSubmit: () => false,
        async update(p) {
          updated = p;
        },
        async followUp(p) {
          followUp = p;
        },
      });

      const statusField = updated.embeds[0].data.fields.find((f) => f.name === 'Status');
      const staffField = updated.embeds[0].data.fields.find((f) => f.name === 'Diproses Oleh');
      assert.equal(statusField.value, expectedStatus);
      assert.ok(staffField.value.includes('<@444>'));
      assert.equal(followUp.flags, MessageFlags.Ephemeral);
    }
  });

  it('handles missing/invalid FEEDBACK_CHANNEL_ID, missing bot permissions, cooldown, and API errors without crashing', async () => {
    const errorsLogged = [];
    const logger = {
      error: (...args) => errorsLogged.push(args.join(' ')),
      warn: () => {},
      log: () => {},
    };

    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();
    let now = 5_000_000;
    const cooldowns = new CooldownManager(2_000, () => now);

    // 1. Missing FEEDBACK_CHANNEL_ID
    const clientNoChan = createMockClient(null);
    const prefixNoChan = new PrefixCommandHandler({
      commandHandler,
      cooldowns,
      prefix: '!',
      context: { client: clientNoChan, cooldowns, env: {}, logger },
    });
    const msg1 = createMockPrefixMessage({ client: clientNoChan, userId: '200000000000000001' });
    await prefixNoChan.handle(msg1);
    assert.match(msg1.replies[0].embeds[0].data.description, /belum dikonfigurasi/i);
    assert.ok(errorsLogged.some((e) => e.includes('FEEDBACK_CHANNEL_ID')));

    // 2. Bot missing permissions in feedback channel
    const noPermChannel = createMockGuildChannel({ botPerms: [PermissionFlagsBits.ViewChannel] });
    const clientNoPerm = createMockClient(noPermChannel);
    const prefixNoPerm = new PrefixCommandHandler({
      commandHandler,
      cooldowns,
      prefix: '!',
      context: {
        client: clientNoPerm,
        cooldowns,
        env: { FEEDBACK_CHANNEL_ID: noPermChannel.id },
        logger,
      },
    });
    const msg2 = createMockPrefixMessage({ client: clientNoPerm, userId: '200000000000000002' });
    await prefixNoPerm.handle(msg2);
    assert.match(msg2.replies[0].embeds[0].data.description, /tidak memiliki izin/i);
    assert.ok(errorsLogged.some((e) => e.includes('ViewChannel')));

    // 3. Cooldown + Discord send API failure + double submission
    const failingChannel = createMockGuildChannel({ sendError: new Error('50013 Missing Access') });
    const clientFail = createMockClient(failingChannel);
    const ctxFail = {
      client: clientFail,
      cooldowns,
      env: { FEEDBACK_CHANNEL_ID: failingChannel.id },
      logger,
    };
    const ihFail = new InteractionHandler({ commandHandler, cooldowns, context: ctxFail });
    const phFail = new PrefixCommandHandler({ commandHandler, cooldowns, prefix: '!', context: ctxFail });

    const msg3 = createMockPrefixMessage({ client: clientFail, userId: '200000000000000003' });
    await phFail.handle(msg3);
    const [selectId, openId] = extractCustomIdsFromRows(msg3.replies[0].components);

    await ihFail.handle({
      customId: selectId,
      user: msg3.author,
      values: ['general'],
      isStringSelectMenu: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      async update() {},
    });

    let modalId = '';
    await ihFail.handle({
      customId: openId,
      user: msg3.author,
      isStringSelectMenu: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      async showModal(m) {
        modalId = m.toJSON().custom_id;
      },
    });

    const failReplies = [];
    await ihFail.handle({
      customId: modalId,
      user: msg3.author,
      guild: msg3.guild,
      client: clientFail,
      fields: {
        getTextInputValue(id) {
          if (id === 'subject') return 'Test failure';
          if (id === 'description') return 'Testing API failure handling cleanly.';
          return '';
        },
      },
      isStringSelectMenu: () => false,
      isButton: () => false,
      isModalSubmit: () => true,
      async reply(p) {
        failReplies.push(p);
      },
    });
    assert.equal(failReplies.length, 1);
    assert.equal(failReplies[0].flags, MessageFlags.Ephemeral);

    // Cooldown check: next !feedback within 60s is blocked
    now += 5_000;
    const msg4 = createMockPrefixMessage({ client: clientFail, userId: '200000000000000003' });
    await phFail.handle(msg4);
    assert.match(msg4.replies[0].embeds[0].data.description, /Tunggu \d+ detik/);
  });
});
