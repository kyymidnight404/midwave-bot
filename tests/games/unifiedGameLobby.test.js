import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ComponentType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { COLORS } from '../../src/config/colors.js';
import { createBotApp } from '../../src/index.js';
import { prisma } from '../../src/services/prisma.js';
import { clearAllGameCenterTimers, getPersistedSession } from '../../src/games/services/sessionService.js';
import { ensureQuizQuestionsSeeded } from '../../src/games/services/questionService.js';
import { CooldownManager } from '../../src/utils/cooldown.js';

const GUILD_ID = 'gc_unified_lobby_guild';
const HOST_ID = '100000000000000001';
const OPP_ID = '200000000000000002';
const OTHER_ID = '300000000000000003';
const BOT_USER_ID = '400000000000000004';
const DEPARTED_ID = '500000000000000005';

function createChannelMock(channelId, memberDirectory) {
  const messages = new Map();
  let seq = 100;

  return {
    id: channelId,
    isTextBased: () => true,
    permissionsFor: () =>
      new Set([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ]),
    messages: {
      async fetch(id) {
        const found = messages.get(id);
        if (!found) {
          throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        }
        return found;
      },
    },
    async send(payload) {
      const id = String(++seq);
      const msg = {
        id,
        channelId,
        payload,
        edits: [],
        async edit(next) {
          this.payload = { ...this.payload, ...next };
          this.edits.push(next);
          return this;
        },
      };
      messages.set(id, msg);
      return msg;
    },
    _messages: messages,
  };
}

function createFakeClient(channelsMap, membersMap) {
  return {
    user: { id: 'bot-midwave' },
    channels: {
      async fetch(id) {
        return channelsMap.get(id) ?? null;
      },
    },
    users: {
      cache: membersMap,
      async fetch(id) {
        const u = membersMap.get(id);
        if (!u) throw new Error('Unknown User');
        return u;
      },
    },
    on() {},
    once() {},
    destroy() {},
  };
}

function createPrefixMsg({ content, author, channel, mentions = [], membersMap, client }) {
  const replies = [];
  const reactions = [];
  const mentionMap = new Map(mentions.map((u) => [u.id, u]));

  return {
    id: `m-${Math.random().toString(36).slice(2, 9)}`,
    content,
    author,
    guildId: GUILD_ID,
    channelId: channel.id,
    channel,
    client,
    mentions: { users: mentionMap },
    guild: {
      id: GUILD_ID,
      members: {
        me: { id: 'bot-midwave' },
        async fetch(id) {
          const u = membersMap.get(id);
          if (!u) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
          return { id: u.id, user: u };
        },
      },
    },
    async react(emoji) {
      reactions.push(emoji);
    },
    getReactions: () => reactions,
    async reply(payload) {
      const sent = await channel.send(payload);
      replies.push(sent);
      return sent;
    },
    getReplies: () => replies,
  };
}

function createComponentInteraction({
  customId,
  user,
  message,
  values = [],
  isSelectMenu = false,
  membersMap,
  client,
}) {
  const responses = [];
  return {
    customId,
    user,
    values,
    guildId: GUILD_ID,
    channelId: message.channelId,
    message,
    client,
    users: membersMap,
    members: {
      get: (id) => (membersMap.has(id) ? { id, user: membersMap.get(id) } : null),
    },
    guild: {
      id: GUILD_ID,
      members: {
        async fetch(id) {
          const u = membersMap.get(id);
          if (!u) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
          return { id: u.id, user: u };
        },
      },
    },
    deferred: false,
    replied: false,
    isButton: () => !isSelectMenu,
    isUserSelectMenu: () => isSelectMenu,
    isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => false,
    async update(payload) {
      this.replied = true;
      await message.edit(payload);
      responses.push({ type: 'update', payload });
      return message;
    },
    async reply(payload) {
      this.replied = true;
      responses.push({ type: 'reply', payload });
      return payload;
    },
    async editReply(payload) {
      responses.push({ type: 'editReply', payload });
      return payload;
    },
    async followUp(payload) {
      responses.push({ type: 'followUp', payload });
      return payload;
    },
    getResponses: () => responses,
  };
}

async function cleanupUnifiedLobbyGuild() {
  clearAllGameCenterTimers();
  await prisma.gameSession.deleteMany({ where: { guildId: GUILD_ID } });
}

async function createLobbyHarness(options = {}) {
  const membersMap = new Map([
    [HOST_ID, { id: HOST_ID, username: 'HostUser', bot: false }],
    [OPP_ID, { id: OPP_ID, username: 'OppUser', bot: false }],
    [OTHER_ID, { id: OTHER_ID, username: 'OtherUser', bot: false }],
    [BOT_USER_ID, { id: BOT_USER_ID, username: 'SomeBot', bot: true }],
  ]);
  const ch1 = createChannelMock('ch-lobby-1', membersMap);
  const ch2 = createChannelMock('ch-lobby-2', membersMap);
  const channelsMap = new Map([
    [ch1.id, ch1],
    [ch2.id, ch2],
  ]);
  const client = createFakeClient(channelsMap, membersMap);

  const app = await createBotApp({
    client,
    prisma,
    cooldowns: new CooldownManager(0),
    skipTempCleanup: true,
  });

  if (options.lobbyTtlMs !== undefined) {
    app.context.lobbyTtlMs = options.lobbyTtlMs;
  }
  if (options.quizRoundDurationMs !== undefined) {
    app.context.quizRoundDurationMs = options.quizRoundDurationMs;
  }
  if (options.quizIntermissionMs !== undefined) {
    app.context.quizIntermissionMs = options.quizIntermissionMs;
  }

  return { app, ch1, ch2, membersMap, client };
}

describe('MIDWAVE Unified Prefix Game Lobby System', () => {
  before(async () => {
    await ensureQuizQuestionsSeeded(prisma);
    await cleanupUnifiedLobbyGuild();
  });

  after(async () => {
    await cleanupUnifiedLobbyGuild();
  });

  it('displays consistent lobby UI for !ttt, !rps, !coinflip without throwing errors when no opponent is provided', async () => {
    await cleanupUnifiedLobbyGuild();
    const { app, ch1, membersMap, client } = await createLobbyHarness();
    const host = membersMap.get(HOST_ID);

    try {
      const cases = [
        { cmd: '!ttt', title: 'Tic Tac Toe', icon: 'attachment://tic-tac-toe.png', hasSolo: false },
        { cmd: '!rps', title: 'Rock Paper Scissors', icon: 'attachment://rps.png', hasSolo: true },
        { cmd: '!coinflip', title: 'Coin Flip', icon: 'attachment://coinflip.png', hasSolo: true },
      ];

      for (const tc of cases) {
        const trigger = createPrefixMsg({ content: tc.cmd, author: host, channel: ch1, membersMap, client });
        await app.prefixCommandHandler.handle(trigger);
        const lobbyMsg = trigger.getReplies()[0];
        const embed = lobbyMsg.payload.embeds[0].toJSON();

        assert.equal(embed.title, tc.title);
        assert.equal(embed.color, COLORS.PRIMARY);
        assert.equal(embed.thumbnail?.url, tc.icon);
        assert.ok(embed.description.split('\n\n').length >= 2);
        assert.equal(lobbyMsg.payload.components.length, 2);

        // Row 1: UserSelectMenu for opponent selection
        const selectRow = lobbyMsg.payload.components[0].toJSON();
        assert.equal(selectRow.components[0].type, ComponentType.UserSelect);

        // Row 2: Start disabled before selecting opponent/solo
        const actionRow = lobbyMsg.payload.components[1].toJSON();
        const startBtn = actionRow.components.find((c) => c.label === 'Start');
        const soloBtn = actionRow.components.find((c) => c.label === 'Solo Mode');
        const cancelBtn = actionRow.components.find((c) => c.label === 'Cancel');
        assert.ok(startBtn);
        assert.equal(startBtn.disabled, true);
        assert.equal(Boolean(soloBtn), tc.hasSolo);

        // Cancel cleanly to release host lobby lock for next iteration
        await app.interactionHandler.handle(
          createComponentInteraction({
            customId: cancelBtn.custom_id,
            user: host,
            message: lobbyMsg,
            membersMap,
            client,
          }),
        );
      }
    } finally {
      app.shutdown();
    }
  });

  it('validates opponent selection (rejects self, bot, outsider, left-server), enforces host-only controls, and transitions !ttt in-place on Start', async () => {
    await cleanupUnifiedLobbyGuild();
    const { app, ch1, membersMap, client } = await createLobbyHarness();
    const host = membersMap.get(HOST_ID);
    const opp = membersMap.get(OPP_ID);
    const other = membersMap.get(OTHER_ID);
    const botUser = membersMap.get(BOT_USER_ID);

    try {
      const msg = createPrefixMsg({ content: '!ttt', author: host, channel: ch1, membersMap, client });
      await app.prefixCommandHandler.handle(msg);
      const lobbyMsg = msg.getReplies()[0];

      const selectId = lobbyMsg.payload.components[0].toJSON().components[0].custom_id;
      const startId = lobbyMsg.payload.components[1].toJSON().components.find((c) => c.label === 'Start').custom_id;
      const messagesCountBefore = ch1._messages.size;

      // Duplicate lobby by same host blocked cleanly
      const dupLobbyMsg = createPrefixMsg({ content: '!rps', author: host, channel: ch1, membersMap, client });
      await app.prefixCommandHandler.handle(dupLobbyMsg);
      assert.match(dupLobbyMsg.getReplies()[0].payload.embeds[0].data.description, /lobby permainan/i);

      // Non-host cannot select opponent or click Start
      const nonHostSelect = createComponentInteraction({
        customId: selectId,
        user: other,
        message: lobbyMsg,
        values: [opp.id],
        isSelectMenu: true,
        membersMap,
        client,
      });
      await app.interactionHandler.handle(nonHostSelect);
      assert.equal(nonHostSelect.getResponses()[0].payload.flags, MessageFlags.Ephemeral);
      assert.equal(lobbyMsg.payload.components[1].toJSON().components[0].disabled, true);

      const nonHostStart = createComponentInteraction({
        customId: startId,
        user: other,
        message: lobbyMsg,
        membersMap,
        client,
      });
      await app.interactionHandler.handle(nonHostStart);
      assert.equal(nonHostStart.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

      // Reject selecting self
      const selfSelect = createComponentInteraction({
        customId: selectId,
        user: host,
        message: lobbyMsg,
        values: [host.id],
        isSelectMenu: true,
        membersMap,
        client,
      });
      await app.interactionHandler.handle(selfSelect);
      assert.match(selfSelect.getResponses()[0].payload.embeds[0].data.description, /dirimu sendiri/i);
      assert.equal(lobbyMsg.payload.components[1].toJSON().components[0].disabled, true);

      // Reject selecting a bot
      const botSelect = createComponentInteraction({
        customId: selectId,
        user: host,
        message: lobbyMsg,
        values: [botUser.id],
        isSelectMenu: true,
        membersMap,
        client,
      });
      await app.interactionHandler.handle(botSelect);
      assert.match(botSelect.getResponses()[0].payload.embeds[0].data.description, /bot/i);
      assert.equal(lobbyMsg.payload.components[1].toJSON().components[0].disabled, true);

      // Reject selecting a user who already left server
      const leftSelect = createComponentInteraction({
        customId: selectId,
        user: host,
        message: lobbyMsg,
        values: [DEPARTED_ID],
        isSelectMenu: true,
        membersMap,
        client,
      });
      await app.interactionHandler.handle(leftSelect);
      assert.match(leftSelect.getResponses()[0].payload.embeds[0].data.description, /keluar dari server/i);

      // Valid opponent selection -> updates SAME lobby message & enables Start
      await app.interactionHandler.handle(
        createComponentInteraction({
          customId: selectId,
          user: host,
          message: lobbyMsg,
          values: [opp.id],
          isSelectMenu: true,
          membersMap,
          client,
        }),
      );
      assert.match(lobbyMsg.payload.embeds[0].toJSON().description, new RegExp(`<@${opp.id}>`));
      assert.equal(lobbyMsg.payload.components[1].toJSON().components[0].disabled, false);

      // If opponent leaves BEFORE host clicks Start -> clears opponent & asks to pick again
      membersMap.delete(opp.id);
      const startLeftInt = createComponentInteraction({
        customId: startId,
        user: host,
        message: lobbyMsg,
        membersMap,
        client,
      });
      await app.interactionHandler.handle(startLeftInt);
      assert.equal(lobbyMsg.payload.components[1].toJSON().components[0].disabled, true);
      assert.ok(startLeftInt.getResponses().some((r) => r.type === 'followUp'));

      // Re-add opponent -> select -> Start -> SAME message transforms into active Tic Tac Toe board!
      membersMap.set(opp.id, opp);
      await app.interactionHandler.handle(
        createComponentInteraction({
          customId: selectId,
          user: host,
          message: lobbyMsg,
          values: [opp.id],
          isSelectMenu: true,
          membersMap,
          client,
        }),
      );

      // Double-click Start concurrently -> only 1 session created, no duplicate message sent!
      const startInt1 = createComponentInteraction({
        customId: startId,
        user: host,
        message: lobbyMsg,
        membersMap,
        client,
      });
      const startInt2 = createComponentInteraction({
        customId: startId,
        user: host,
        message: lobbyMsg,
        membersMap,
        client,
      });
      await Promise.all([
        app.interactionHandler.handle(startInt1),
        app.interactionHandler.handle(startInt2),
      ]);

      // Verify board rendered in-place (3 board rows + Forfeit row) and zero duplicate session/messages
      assert.equal(lobbyMsg.payload.embeds[0].toJSON().title, '⭕ Tic Tac Toe — Game Center');
      assert.equal(lobbyMsg.payload.components.length, 4);
      assert.equal(ch1._messages.size, messagesCountBefore + 1); // only dupLobbyMsg reply was extra
      assert.equal(startInt2.getResponses()[0].payload.flags, MessageFlags.Ephemeral);
      const activeCount = await prisma.gameSession.count({
        where: { guildId: GUILD_ID, gameType: 'ttt', status: 'active' },
      });
      assert.equal(activeCount, 1);
    } finally {
      app.shutdown();
    }
  });

  it('supports !rps Solo Mode & Multiplayer via Lobby, !coinflip Multiplayer via Lobby, expiration, and legacy mentions', async () => {
    await cleanupUnifiedLobbyGuild();
    const { app, ch1, membersMap, client } = await createLobbyHarness({ lobbyTtlMs: 5000 });
    const host = membersMap.get(HOST_ID);
    const opp = membersMap.get(OPP_ID);

    try {
      // 1. !rps -> Solo Mode -> Start -> pick Rock -> instant result in-place
      const rpsTrigger = createPrefixMsg({ content: '!rps', author: host, channel: ch1, membersMap, client });
      await app.prefixCommandHandler.handle(rpsTrigger);
      const rpsMsg = rpsTrigger.getReplies()[0];
      const rpsActionRow = rpsMsg.payload.components[1].toJSON().components;
      const rpsSoloBtn = rpsActionRow.find((c) => c.label === 'Solo Mode');
      const rpsStartBtn = rpsActionRow.find((c) => c.label === 'Start');

      await app.interactionHandler.handle(
        createComponentInteraction({
          customId: rpsSoloBtn.custom_id,
          user: host,
          message: rpsMsg,
          membersMap,
          client,
        }),
      );
      assert.equal(rpsMsg.payload.components[1].toJSON().components[1].disabled, false);

      await app.interactionHandler.handle(
        createComponentInteraction({
          customId: rpsStartBtn.custom_id,
          user: host,
          message: rpsMsg,
          membersMap,
          client,
        }),
      );
      assert.equal(rpsMsg.payload.embeds[0].toJSON().title, 'Rock Paper Scissors — Solo');
      const rockBtnId = rpsMsg.payload.components[0].toJSON().components[0].custom_id;

      await app.interactionHandler.handle(
        createComponentInteraction({
          customId: rockBtnId,
          user: host,
          message: rpsMsg,
          membersMap,
          client,
        }),
      );
      assert.equal(rpsMsg.payload.embeds[0].toJSON().title, 'Rock Paper Scissors — Hasil');
      assert.deepEqual(rpsMsg.payload.components, []);

      // 2. !coinflip -> Select Opponent -> Start -> Multiplayer Heads/Tails board in same message
      const cfTrigger = createPrefixMsg({ content: '!cf', author: host, channel: ch1, membersMap, client });
      await app.prefixCommandHandler.handle(cfTrigger);
      const cfMsg = cfTrigger.getReplies()[0];
      const cfSelectId = cfMsg.payload.components[0].toJSON().components[0].custom_id;
      const cfStartId = cfMsg.payload.components[1].toJSON().components.find((c) => c.label === 'Start').custom_id;

      await app.interactionHandler.handle(
        createComponentInteraction({
          customId: cfSelectId,
          user: host,
          message: cfMsg,
          values: [opp.id],
          isSelectMenu: true,
          membersMap,
          client,
        }),
      );
      await app.interactionHandler.handle(
        createComponentInteraction({
          customId: cfStartId,
          user: host,
          message: cfMsg,
          membersMap,
          client,
        }),
      );

      assert.equal(cfMsg.payload.embeds[0].toJSON().title, '🪙 Coin Flip');
      assert.equal(cfMsg.payload.components[0].toJSON().components[0].label, 'Heads');
      assert.equal(app.sessionManager.activeGames.size, 1);
      app.sessionManager.clearAll();

      // 3. Unused lobby expires automatically after TTL and frees host
      app.context.lobbyTtlMs = 25;
      const expTrigger = createPrefixMsg({ content: '!ttt', author: host, channel: ch1, membersMap, client });
      await app.prefixCommandHandler.handle(expTrigger);
      const expMsg = expTrigger.getReplies()[0];

      for (let i = 0; i < 20; i += 1) {
        if (/kedaluwarsa/i.test(expMsg.payload.embeds[0].toJSON().description)) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.match(expMsg.payload.embeds[0].toJSON().description, /kedaluwarsa/i);
      assert.equal(expMsg.payload.components[0].toJSON().components[0].disabled, true);
      assert.equal(app.gameLobbyManager.getHostLobby(GUILD_ID, host.id), null);

      // 4. Legacy mention & instant solo formats stay compatible
      app.context.lobbyTtlMs = 5000;
      const legacyTtt = createPrefixMsg({
        content: `!ttt <@${opp.id}>`,
        author: host,
        channel: ch1,
        mentions: [opp],
        membersMap,
        client,
      });
      await app.prefixCommandHandler.handle(legacyTtt);
      assert.match(legacyTtt.getReplies()[0].payload.embeds[0].toJSON().title, /Tantangan Tic Tac Toe/);
    } finally {
      app.shutdown();
    }
  });

  it('enforces Special Rules for !quiz: Quiz Lobby UI, per-channel isolation, creator-only Start Quiz, and global channel gameplay', async () => {
    await cleanupUnifiedLobbyGuild();
    const { app, ch1, ch2, membersMap, client } = await createLobbyHarness({
      quizRoundDurationMs: 2500,
      quizIntermissionMs: 25,
    });
    const host = membersMap.get(HOST_ID);
    const opp = membersMap.get(OPP_ID);
    const other = membersMap.get(OTHER_ID);

    try {
      // Launch !quiz in channel 1 and channel 2 independently
      const qTrig1 = createPrefixMsg({ content: '!quiz', author: host, channel: ch1, membersMap, client });
      const qTrig2 = createPrefixMsg({ content: '!quiz', author: opp, channel: ch2, membersMap, client });
      await app.prefixCommandHandler.handle(qTrig1);
      await app.prefixCommandHandler.handle(qTrig2);

      const lobbyMsg1 = qTrig1.getReplies()[0];
      const lobbyMsg2 = qTrig2.getReplies()[0];
      const embed1 = lobbyMsg1.payload.embeds[0].toJSON();

      // Exact Quiz Lobby UI checks (Section 10.B)
      assert.equal(embed1.title, 'Quiz');
      assert.equal(embed1.thumbnail?.url, 'attachment://quiz.png');
      assert.equal(
        embed1.description,
        'Test your knowledge with exciting questions! Answer correctly and compete with others in this channel.',
      );
      assert.equal(/Choose Opponent|Selected Players|Sudah menjawab/i.test(JSON.stringify(lobbyMsg1.payload)), false);
      assert.equal(lobbyMsg1.payload.components.length, 1);
      assert.equal(lobbyMsg1.payload.components[0].components.length, 1);
      assert.equal(lobbyMsg1.payload.components[0].toJSON().components[0].label, 'Start Quiz');
      assert.equal(lobbyMsg1.payload.components[0].toJSON().components[0].disabled, false);

      // Channel 1 blocks duplicate !quiz while Channel 2 started its own independent Quiz Lobby cleanly!
      assert.equal(lobbyMsg2.payload.embeds[0].toJSON().title, 'Quiz');
      const dupCh1 = createPrefixMsg({ content: '!quiz', author: other, channel: ch1, membersMap, client });
      await app.prefixCommandHandler.handle(dupCh1);
      assert.match(dupCh1.getReplies()[0].payload.embeds[0].data.description, /Quiz Lobby/i);

      // Answers before Start Quiz are ignored (still in lobby phase)
      const earlyAns = createPrefixMsg({ content: 'a', author: other, channel: ch1, membersMap, client });
      await app.prefixCommandHandler.handle(earlyAns);
      assert.deepEqual(earlyAns.getReactions(), []);

      // Only host can click Start Quiz
      const startQuizId1 = lobbyMsg1.payload.components[0].toJSON().components[0].custom_id;
      const sessionId1 = startQuizId1.split(':')[2];
      const otherStart = createComponentInteraction({
        customId: startQuizId1,
        user: other,
        message: lobbyMsg1,
        membersMap,
        client,
      });
      await app.interactionHandler.handle(otherStart);
      assert.equal(otherStart.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

      // Host clicks Start Quiz -> updates SAME message to Question 1 without participant count/progress
      await app.interactionHandler.handle(
        createComponentInteraction({
          customId: startQuizId1,
          user: host,
          message: lobbyMsg1,
          membersMap,
          client,
        }),
      );
      const q1Json = lobbyMsg1.payload.embeds[0].toJSON();
      assert.match(q1Json.title, /Pertanyaan 1\/10/);
      assert.equal(/Sudah menjawab/i.test(q1Json.description), false);

      // Global Channel Gameplay: ANY user in channel 1 (e.g. `other`) can answer a/b/c/d!
      let session = await getPersistedSession(sessionId1, prisma);
      const letters = ['a', 'b', 'c', 'd'];
      const correctIdx = session.state.questions[0].correctIndex;
      const wrongIdx = (correctIdx + 1) % 4;

      const wrongAnswer = createPrefixMsg({
        content: letters[wrongIdx],
        author: other,
        channel: ch1,
        membersMap,
        client,
      });
      await app.prefixCommandHandler.handle(wrongAnswer);
      assert.deepEqual(wrongAnswer.getReactions(), ['❌']);

      // User can retry and get ✅ + score +1 -> advances to Round 2
      const rightAnswer = createPrefixMsg({
        content: letters[correctIdx],
        author: other,
        channel: ch1,
        membersMap,
        client,
      });
      await app.prefixCommandHandler.handle(rightAnswer);
      assert.deepEqual(rightAnswer.getReactions(), ['✅']);

      session = await getPersistedSession(sessionId1, prisma);
      assert.equal(session.state.scores[other.id], 1);

      for (let wait = 0; wait < 25; wait += 1) {
        session = await getPersistedSession(sessionId1, prisma);
        if (session.state.round === 2 && session.state.phase === 'question') break;
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(session.state.round, 2);
      assert.equal(/Sudah menjawab/i.test(lobbyMsg1.payload.embeds[0].toJSON().description), false);
    } finally {
      app.shutdown();
    }
  });
});
