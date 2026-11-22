import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { prisma } from '../../src/services/prisma.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { PrefixCommandHandler } from '../../src/handlers/PrefixCommandHandler.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import {
  clearAllGameCenterTimers,
  createPersistedSession,
  getPersistedSession,
  updatePersistedSession,
} from '../../src/games/services/sessionService.js';
import { ensureQuizQuestionsSeeded } from '../../src/games/services/questionService.js';
import {
  handleQuizChatAnswer,
  recoverGameCenterSessions,
} from '../../src/events/gameInteraction.js';
import {
  createDirectQuizState,
  createQuizLobbyState,
  startQuizBattle,
} from '../../src/games/engines/quizBattle.js';
import { buildQuizQuestionMessage } from '../../src/games/utils/gameUi.js';
import quizCommand from '../../src/commands/quiz.js';
import { createRpsMatchState } from '../../src/games/engines/rockPaperScissors.js';
import { buildGameCustomId } from '../../src/games/utils/customId.js';
import { createTicTacToeState } from '../../src/games/engines/ticTacToe.js';

const TEST_GUILD_1 = 'gc_test_guild_1';
const TEST_GUILD_2 = 'gc_test_guild_2';

function createFakeGuildChannel(channelId = 'ch-gc-1') {
  const messages = new Map();
  let seq = 100;

  const makeMessageObj = (id, payload, author = null) => {
    const obj = {
      id,
      channelId,
      author,
      payload,
      edits: [],
      async edit(nextPayload) {
        this.payload = nextPayload;
        this.edits.push(nextPayload);
        return this;
      },
      async reply(replyPayload) {
        return sendFn(replyPayload);
      },
    };
    messages.set(id, obj);
    return obj;
  };

  const sendFn = async (payload) => makeMessageObj(String(++seq), payload);

  return {
    id: channelId,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: sendFn,
    messages: {
      async fetch(id) {
        if (!messages.has(id)) {
          const err = new Error('Unknown Message');
          err.code = 10008;
          throw err;
        }
        return messages.get(id);
      },
    },
    _messages: messages,
    _store: makeMessageObj,
  };
}

function createFakeMessage({ content, author, channel, guildId = TEST_GUILD_1, mentions = [], client }) {
  const mentionMap = new Map(mentions.map((u) => [u.id, u]));
  const replies = [];
  const reactions = [];
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content,
    author,
    member: { permissions: { has: () => true } },
    guildId,
    guild: {
      id: guildId,
      members: {
        me: { permissions: { has: () => true } },
        async fetch(id) {
          const u = mentionMap.get(id);
          return u ? { user: u } : null;
        },
      },
    },
    channelId: channel.id,
    channel,
    client,
    mentions: { users: mentionMap },
    deletable: true,
    async react(emoji) {
      reactions.push(emoji);
    },
    getReactions: () => reactions,
    async delete() {},
    async reply(payload) {
      const sent = await channel.send(payload);
      replies.push(sent);
      return sent;
    },
    getReplies: () => replies,
  };
}

function createFakeButtonInteraction({ customId, user, message, guildId = TEST_GUILD_1, client }) {
  const responses = [];
  return {
    customId,
    user,
    guildId,
    channelId: message.channelId,
    message,
    client,
    deferred: false,
    replied: false,
    isButton: () => true,
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
    },
    async followUp(payload) {
      responses.push({ type: 'followUp', payload });
    },
    getResponses: () => responses,
  };
}

async function createGameCenterHarness({ quizRoundDurationMs = 20000, quizIntermissionMs = 3500 } = {}) {
  const channel = createFakeGuildChannel();
  const users = new Map();
  for (let i = 1; i <= 15; i += 1) {
    const id = `9000000000000000${String(i).padStart(2, '0')}`;
    users.set(id, { id, username: `Player${i}`, bot: false });
  }

  const client = {
    user: { id: 'bot-midwave' },
    users: {
      cache: users,
      async fetch(id) {
        return users.get(id) ?? null;
      },
    },
    channels: {
      async fetch(id) {
        return id === channel.id ? channel : null;
      },
    },
  };

  const commandHandler = new CommandHandler();
  await commandHandler.loadCommands();
  const cooldowns = new CooldownManager(0);
  const context = {
    prisma,
    client,
    quizRoundDurationMs,
    quizIntermissionMs,
  };
  const interactionHandler = new InteractionHandler({ commandHandler, cooldowns, context });
  const prefixHandler = new PrefixCommandHandler({
    commandHandler,
    cooldowns,
    prefix: '!',
    context,
  });

  return { channel, users, client, interactionHandler, prefixHandler };
}

async function cleanupTestGuilds() {
  await prisma.gameSession.deleteMany({
    where: { guildId: { in: [TEST_GUILD_1, TEST_GUILD_2] } },
  });
  await prisma.gameStats.deleteMany({
    where: { guildId: { in: [TEST_GUILD_1, TEST_GUILD_2] } },
  });
}

describe('Game Center Integration Flows (Prisma + SQLite + Buttons)', () => {
  before(cleanupTestGuilds);
  after(async () => {
    clearAllGameCenterTimers();
    await cleanupTestGuilds();
  });

  it('plays full Tic Tac Toe via !ttt @user -> Accept -> Button Moves -> Win & single stats recording', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness();
    const [p1, p2, outsider] = [...h.users.values()];

    // 1. !ttt @p2
    const msg = createFakeMessage({
      content: `!ttt <@${p2.id}>`,
      author: p1,
      channel: h.channel,
      mentions: [p2],
      client: h.client,
    });
    await h.prefixHandler.handle(msg);
    const challengeMsg = msg.getReplies()[0];
    assert.ok(challengeMsg);
    const acceptId = challengeMsg.payload.components[0].components[0].data.custom_id;
    const sessionId = acceptId.split(':')[2];

    // Outsider cannot accept
    const badAccept = createFakeButtonInteraction({
      customId: acceptId,
      user: outsider,
      message: challengeMsg,
      client: h.client,
    });
    await h.interactionHandler.handle(badAccept);
    assert.equal(badAccept.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

    // Opponent accepts
    await h.interactionHandler.handle(
      createFakeButtonInteraction({
        customId: acceptId,
        user: p2,
        message: challengeMsg,
        client: h.client,
      }),
    );

    const active = await getPersistedSession(sessionId, prisma);
    assert.equal(active.status, 'active');

    // Wrong turn (p2 clicks before p1)
    const wrongTurn = createFakeButtonInteraction({
      customId: buildGameCustomId('ttt', sessionId, 'move', 0),
      user: p2,
      message: challengeMsg,
      client: h.client,
    });
    await h.interactionHandler.handle(wrongTurn);
    assert.equal(wrongTurn.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

    // Play X win on top row: p1:0, p2:3, p1:1, p2:4, p1:2
    const steps = [
      [p1, 0],
      [p2, 3],
      [p1, 1],
      [p2, 4],
      [p1, 2],
    ];
    for (const [player, cell] of steps) {
      await h.interactionHandler.handle(
        createFakeButtonInteraction({
          customId: buildGameCustomId('ttt', sessionId, 'move', cell),
          user: player,
          message: challengeMsg,
          client: h.client,
        }),
      );
    }

    const finished = await getPersistedSession(sessionId, prisma);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.winnerId, p1.id);
    assert.equal(finished.statsRecorded, false);
    assert.equal(await prisma.gameStats.count({ where: { guildId: TEST_GUILD_1 } }), 0);

    const tttEmbed = challengeMsg.payload.embeds[0].toJSON();
    assert.equal(tttEmbed.footer, undefined);
    assert.equal(tttEmbed.timestamp, undefined);
    assert.equal(tttEmbed.thumbnail?.url, 'attachment://tic-tac-toe.png');
    assert.doesNotMatch(tttEmbed.description, /poin/i);
  });

  it('plays Rock Paper Scissors Best of 3 via !rps @user with hidden choices', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness();
    const [p1, p2] = [...h.users.values()];

    const msg = createFakeMessage({
      content: `!rps <@${p2.id}>`,
      author: p1,
      channel: h.channel,
      mentions: [p2],
      client: h.client,
    });
    await h.prefixHandler.handle(msg);
    const challengeMsg = msg.getReplies()[0];
    const acceptId = challengeMsg.payload.components[0].components[0].data.custom_id;
    const sessionId = acceptId.split(':')[2];

    await h.interactionHandler.handle(
      createFakeButtonInteraction({ customId: acceptId, user: p2, message: challengeMsg, client: h.client }),
    );

    // Round 1: p1 chooses rock -> must NOT reveal "Rock" on public embed
    const p1PickInt = createFakeButtonInteraction({
      customId: buildGameCustomId('rps', sessionId, 'pick', 'rock'),
      user: p1,
      message: challengeMsg,
      client: h.client,
    });
    await h.interactionHandler.handle(p1PickInt);
    assert.equal(p1PickInt.getResponses()[0].payload.flags, MessageFlags.Ephemeral);
    const publicDesc = challengeMsg.payload.embeds[0].data.description;
    assert.equal(publicDesc.includes('🪨 Rock'), false);

    // Duplicate pick by p1 in round 1 rejected
    const dupPick = createFakeButtonInteraction({
      customId: buildGameCustomId('rps', sessionId, 'pick', 'paper'),
      user: p1,
      message: challengeMsg,
      client: h.client,
    });
    await h.interactionHandler.handle(dupPick);
    assert.equal(dupPick.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

    // p2 chooses scissors -> p1 wins round 1 (1-0)
    await h.interactionHandler.handle(
      createFakeButtonInteraction({
        customId: buildGameCustomId('rps', sessionId, 'pick', 'scissors'),
        user: p2,
        message: challengeMsg,
        client: h.client,
      }),
    );

    // Round 2: p1 chooses paper, p2 chooses rock -> p1 wins match 2-0
    await h.interactionHandler.handle(
      createFakeButtonInteraction({
        customId: buildGameCustomId('rps', sessionId, 'pick', 'paper'),
        user: p1,
        message: challengeMsg,
        client: h.client,
      }),
    );
    await h.interactionHandler.handle(
      createFakeButtonInteraction({
        customId: buildGameCustomId('rps', sessionId, 'pick', 'rock'),
        user: p2,
        message: challengeMsg,
        client: h.client,
      }),
    );

    const finished = await getPersistedSession(sessionId, prisma);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.winnerId, p1.id);
    assert.equal(finished.statsRecorded, false);
    assert.equal(await prisma.gameStats.count({ where: { guildId: TEST_GUILD_1 } }), 0);

    const rpsEmbed = challengeMsg.payload.embeds[0].toJSON();
    assert.equal(rpsEmbed.footer, undefined);
    assert.equal(rpsEmbed.timestamp, undefined);
    assert.doesNotMatch(rpsEmbed.description, /poin/i);
  });

  it('opens Quiz Lobby on !quiz -> host clicks Start Quiz -> Global Channel Gameplay with direct chat answers (a/b/c/d)', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness({ quizRoundDurationMs: 2500, quizIntermissionMs: 30 });
    const [host, p2, p3] = [...h.users.values()];

    const msg = createFakeMessage({
      content: '!quiz',
      author: host,
      channel: h.channel,
      client: h.client,
    });
    await h.prefixHandler.handle(msg);
    const quizMsg = msg.getReplies()[0];

    // Step 1: Quiz Lobby UI matches specification (no opponent select, no player counts)
    const lobbyEmbed = quizMsg.payload.embeds[0].toJSON();
    assert.equal(lobbyEmbed.title, 'Quiz');
    assert.equal(
      lobbyEmbed.description,
      'Test your knowledge with exciting questions! Answer correctly and compete with others in this channel.',
    );
    assert.equal(lobbyEmbed.thumbnail?.url, 'attachment://quiz.png');
    assert.equal(quizMsg.payload.components.length, 1);
    assert.equal(quizMsg.payload.components[0].components.length, 1);
    const startQuizBtn = quizMsg.payload.components[0].components[0];
    assert.equal(startQuizBtn.data.label, 'Start Quiz');
    const startQuizId = startQuizBtn.data.custom_id;
    const sessionId = startQuizId.split(':')[2];
    assert.ok(startQuizId.endsWith(':start_global'));

    // Non-creator cannot click Start Quiz
    const nonHostStart = createFakeButtonInteraction({
      customId: startQuizId,
      user: p2,
      message: quizMsg,
      client: h.client,
    });
    await h.interactionHandler.handle(nonHostStart);
    assert.equal(nonHostStart.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

    // Duplicate !quiz lobby in the same channel is blocked while pending
    const dupPendingMsg = createFakeMessage({
      content: '!quiz',
      author: p2,
      channel: h.channel,
      client: h.client,
    });
    await h.prefixHandler.handle(dupPendingMsg);
    assert.match(dupPendingMsg.getReplies()[0].payload.embeds[0].data.description, /Quiz Lobby/i);

    // Host clicks Start Quiz -> updates SAME message to Question 1/10!
    await h.interactionHandler.handle(
      createFakeButtonInteraction({
        customId: startQuizId,
        user: host,
        message: quizMsg,
        client: h.client,
      }),
    );

    const stopId = quizMsg.payload.components[0].components[0].data.custom_id;
    assert.equal(quizMsg.payload.components[0].components.length, 1);
    assert.ok(stopId.endsWith(':cancel'));

    let session = await getPersistedSession(sessionId, prisma);
    assert.equal(session.status, 'active');
    assert.equal(session.state.phase, 'question');
    assert.equal(session.state.round, 1);
    assert.equal(session.state.questions.length, 10);

    // Verify answer is NOT exposed, no participant answered count/progress, A/B/C/D options clean, no footer
    const q1Embed = quizMsg.payload.embeds[0].toJSON();
    const q1Desc = q1Embed.description;
    assert.equal(q1Embed.footer, undefined);
    assert.equal(q1Embed.timestamp, undefined);
    assert.equal(q1Desc.includes('Jawaban Benar'), false);
    assert.equal(q1Desc.includes('Sudah menjawab'), false);
    assert.doesNotMatch(q1Desc, /[🇦🇧🇨🇩]/u);
    assert.match(q1Desc, /\*\*A\.\*\* /);
    assert.match(q1Desc, /Ketik \*\*a\*\*, \*\*b\*\*, \*\*c\*\*, atau \*\*d\*\* langsung di chat/i);

    // Starting a second !quiz in the same channel while active is rejected
    const dupQuizMsg = createFakeMessage({
      content: '!quiz',
      author: p2,
      channel: h.channel,
      client: h.client,
    });
    await h.prefixHandler.handle(dupQuizMsg);
    assert.match(dupQuizMsg.getReplies()[0].payload.embeds[0].data.description, /sedang berlangsung/i);

    // Normal chat text is ignored by quiz answer handler
    await h.prefixHandler.handle(
      createFakeMessage({ content: 'aku mau ikut dong', author: p2, channel: h.channel, client: h.client }),
    );
    session = await getPersistedSession(sessionId, prisma);
    assert.deepEqual(session.state.roundAnswers, {});

    // Play rounds 1..9 using direct chat letters a/b/c/d (p2 auto-joins on round 1!)
    const letters = ['a', 'b', 'c', 'd'];
    for (let round = 1; round <= 9; round += 1) {
      for (let wait = 0; wait < 30; wait += 1) {
        session = await getPersistedSession(sessionId, prisma);
        if (session.state.phase === 'question' && session.state.round === round) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(session.state.round, round);
      const correctIdx = session.state.questions[round - 1].correctIndex;
      const wrongIdx = (correctIdx + 1) % 4;

      // p2 answers first via uppercase chat letter (wrong) -> gets ❌ reaction, question stays active & p2 can retry
      const p2Chat = createFakeMessage({
        content: letters[wrongIdx].toUpperCase(),
        author: p2,
        channel: h.channel,
        client: h.client,
      });
      await h.prefixHandler.handle(p2Chat);
      assert.deepEqual(p2Chat.getReactions(), ['❌']);

      // Retry with another wrong option on round 1 -> still ❌ and round does NOT advance
      if (round === 1) {
        const wrongIdx2 = (correctIdx + 2) % 4;
        const p2RetryWrong = createFakeMessage({
          content: letters[wrongIdx2],
          author: p2,
          channel: h.channel,
          client: h.client,
        });
        await h.prefixHandler.handle(p2RetryWrong);
        assert.deepEqual(p2RetryWrong.getReactions(), ['❌']);
        const stillRound1 = await getPersistedSession(sessionId, prisma);
        assert.equal(stillRound1.state.round, 1);
        assert.equal(stillRound1.state.phase, 'question');
        assert.equal(stillRound1.state.roundResolved, false);
        assert.equal(stillRound1.state.scores[p2.id], 0);
      }

      // Host answers via lowercase chat letter (a/b/c/d) -> gets ✅, scores +1, resolves round
      const hostChat = createFakeMessage({
        content: letters[correctIdx],
        author: host,
        channel: h.channel,
        client: h.client,
      });
      await h.prefixHandler.handle(hostChat);
      assert.deepEqual(hostChat.getReactions(), ['✅']);
    }

    // Round 10: let timeout resolve automatically (host finishes with 9 correct answers, zero bonus)
    for (let wait = 0; wait < 90; wait += 1) {
      session = await getPersistedSession(sessionId, prisma);
      if (session.status === 'finished') break;
      await new Promise((r) => setTimeout(r, 40));
    }

    assert.equal(session.status, 'finished');
    assert.equal(session.winnerId, host.id);
    assert.equal(session.statsRecorded, false);
    assert.equal(session.state.scores[host.id], 9);
    assert.equal(session.state.scores[p2.id], 0);
    assert.equal(await prisma.gameStats.count({ where: { guildId: TEST_GUILD_1 } }), 0);
    const quizFinalEmbed = quizMsg.payload.embeds[0].toJSON();
    assert.equal(quizFinalEmbed.footer, undefined);
    assert.equal(quizFinalEmbed.timestamp, undefined);
    assert.equal(quizFinalEmbed.thumbnail?.url, 'attachment://quiz.png');
    assert.doesNotMatch(quizFinalEmbed.description, /poin|bonus/i);

    // Quick test: non-host cannot click Stop Quiz, host CAN stop active quiz early (after starting Quiz Lobby)
    const msg2 = createFakeMessage({
      content: '!quiz science easy',
      author: p3,
      channel: h.channel,
      client: h.client,
    });
    await h.prefixHandler.handle(msg2);
    const quizMsg2 = msg2.getReplies()[0];
    const startId2 = quizMsg2.payload.components[0].components[0].data.custom_id;
    const sessionId2 = startId2.split(':')[2];

    await h.interactionHandler.handle(
      createFakeButtonInteraction({
        customId: startId2,
        user: p3,
        message: quizMsg2,
        client: h.client,
      }),
    );
    const stopId2 = quizMsg2.payload.components[0].components[0].data.custom_id;

    const nonHostStop = createFakeButtonInteraction({
      customId: stopId2,
      user: host,
      message: quizMsg2,
      client: h.client,
    });
    await h.interactionHandler.handle(nonHostStop);
    assert.equal(nonHostStop.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

    await h.interactionHandler.handle(
      createFakeButtonInteraction({
        customId: stopId2,
        user: p3,
        message: quizMsg2,
        client: h.client,
      }),
    );
    const cancelledSession = await getPersistedSession(sessionId2, prisma);
    assert.equal(cancelledSession.status, 'cancelled');
    assert.equal(quizMsg2.payload.embeds[0].toJSON().thumbnail?.url, 'attachment://quiz.png');
  });

  it('ignores !lb and !profile commands and never writes GameStats rows', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness();
    const allUsers = [...h.users.values()];

    const lbMsg = createFakeMessage({
      content: '!lb',
      author: allUsers[0],
      channel: h.channel,
      client: h.client,
    });
    await h.prefixHandler.handle(lbMsg);
    assert.equal(lbMsg.getReplies().length, 0);

    const profMsg = createFakeMessage({
      content: `!profile <@${allUsers[0].id}>`,
      author: allUsers[1],
      channel: h.channel,
      mentions: [allUsers[0]],
      client: h.client,
    });
    await h.prefixHandler.handle(profMsg);
    assert.equal(profMsg.getReplies().length, 0);
    assert.equal(await prisma.gameStats.count({ where: { guildId: TEST_GUILD_1 } }), 0);
  });

  it('handles concurrent quiz seeding, concurrent RPS button clicks, and deleted message gracefully', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness();
    const [p1, p2] = [...h.users.values()];

    // Concurrent seed calls must remain idempotent, keep 90 active questions, and reflect Indonesian bank
    const seedCounts = await Promise.all(
      Array.from({ length: 5 }, () => ensureQuizQuestionsSeeded(prisma)),
    );
    assert.ok(seedCounts.every((c) => c === 90));
    const sampleQuestion = await prisma.quizQuestion.findUnique({ where: { externalKey: 'spo-n-5' } });
    assert.match(sampleQuestion.question, /Berapa menit/i);

    // Concurrent RPS button clicks in the same millisecond
    const rpsSid = 'concurrent-rps';
    const rpsMsg = await h.channel.send({ embeds: [] });
    await createPersistedSession({
      prisma,
      id: rpsSid,
      guildId: TEST_GUILD_1,
      channelId: h.channel.id,
      gameType: 'rps',
      status: 'active',
      hostId: p1.id,
      state: createRpsMatchState({ hostId: p1.id, opponentId: p2.id }),
      participants: [
        { userId: p1.id, username: p1.username, role: 'P1' },
        { userId: p2.id, username: p2.username, role: 'P2' },
      ],
    });
    await updatePersistedSession(rpsSid, { messageId: rpsMsg.id }, prisma);

    await Promise.all([
      h.interactionHandler.handle(
        createFakeButtonInteraction({
          customId: buildGameCustomId('rps', rpsSid, 'pick', 'rock'),
          user: p1,
          message: rpsMsg,
          client: h.client,
        }),
      ),
      h.interactionHandler.handle(
        createFakeButtonInteraction({
          customId: buildGameCustomId('rps', rpsSid, 'pick', 'scissors'),
          user: p2,
          message: rpsMsg,
          client: h.client,
        }),
      ),
    ]);

    const afterConcurrent = await getPersistedSession(rpsSid, prisma);
    assert.equal(afterConcurrent.state.scores[p1.id], 1);
    assert.equal(afterConcurrent.state.round, 2);

    // Deleted message during active Tic Tac Toe move cancels safely without crashing
    const deletedMsg = {
      id: 'deleted-msg-id',
      channelId: h.channel.id,
      async edit() {
        const err = new Error('Unknown Message');
        err.code = 10008;
        throw err;
      },
    };
    const tttSid = 'deleted-ttt';
    await createPersistedSession({
      prisma,
      id: tttSid,
      guildId: TEST_GUILD_1,
      channelId: h.channel.id,
      gameType: 'ttt',
      status: 'active',
      hostId: p1.id,
      currentTurnId: p1.id,
      state: createTicTacToeState({ hostId: p1.id, opponentId: p2.id }),
      participants: [
        { userId: p1.id, username: p1.username, role: 'X' },
        { userId: p2.id, username: p2.username, role: 'O' },
      ],
    });
    const delInteraction = createFakeButtonInteraction({
      customId: buildGameCustomId('ttt', tttSid, 'move', 0),
      user: p1,
      message: deletedMsg,
      client: h.client,
    });
    delInteraction.update = async () => {
      const err = new Error('Unknown Message');
      err.code = 10008;
      throw err;
    };
    await h.interactionHandler.handle(delInteraction);
    const cancelledTtt = await getPersistedSession(tttSid, prisma);
    assert.equal(cancelledTtt.status, 'cancelled');
  });

  it('recovers active Quiz Battle timers and expires stale sessions on restart', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness({ quizRoundDurationMs: 50, quizIntermissionMs: 20 });
    const [p1, p2] = [...h.users.values()];

    // 1. Stale pending challenge expired while bot was offline
    const staleSid = 'stale-challenge';
    const staleMsg = await h.channel.send({ embeds: [] });
    await createPersistedSession({
      prisma,
      id: staleSid,
      guildId: TEST_GUILD_1,
      channelId: h.channel.id,
      gameType: 'ttt',
      status: 'pending',
      hostId: p1.id,
      state: createTicTacToeState({ hostId: p1.id, opponentId: p2.id }),
      participants: [
        { userId: p1.id, username: p1.username, role: 'X' },
        { userId: p2.id, username: p2.username, role: 'O' },
      ],
      ttlMs: 1,
    });
    await prisma.gameSession.update({
      where: { id: staleSid },
      data: { messageId: staleMsg.id, expiresAt: new Date(Date.now() - 5000) },
    });

    // 2. Active Quiz Battle interrupted mid-final-round before bot restart
    const quizSid = 'recover-quiz';
    const quizMsg = await h.channel.send({ embeds: [] });
    const qState = {
      phase: 'question',
      hostId: p1.id,
      category: 'general',
      difficulty: 'easy',
      players: [p1.id, p2.id],
      scores: { [p1.id]: 3, [p2.id]: 1 },
      round: 1,
      totalQuestions: 1,
      questions: [
        { id: 1, category: 'general', difficulty: 'easy', question: 'Q', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
      ],
      roundAnswers: { [p1.id]: 0 },
      roundResolved: false,
      roundEndsAt: Date.now() + 30,
      lastRoundSummary: null,
      winnerId: null,
      winnerIds: [],
      isDraw: false,
    };
    await createPersistedSession({
      prisma,
      id: quizSid,
      guildId: TEST_GUILD_1,
      channelId: h.channel.id,
      gameType: 'quiz',
      status: 'active',
      hostId: p1.id,
      state: qState,
      participants: [
        { userId: p1.id, username: p1.username, role: 'host' },
        { userId: p2.id, username: p2.username, role: 'player' },
      ],
      ttlMs: 60_000,
    });
    await updatePersistedSession(quizSid, { messageId: quizMsg.id }, prisma);

    // Simulate restart recovery
    clearAllGameCenterTimers();
    await recoverGameCenterSessions({
      prisma,
      client: h.client,
      quizRoundDurationMs: 50,
      quizIntermissionMs: 20,
    });

    const recoveredStale = await getPersistedSession(staleSid, prisma);
    assert.equal(recoveredStale.status, 'expired');

    // Wait for recovered quiz round timer + intermission to finish match and record stats
    let recoveredQuiz = null;
    for (let wait = 0; wait < 40; wait += 1) {
      recoveredQuiz = await getPersistedSession(quizSid, prisma);
      if (recoveredQuiz.status === 'finished') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(recoveredQuiz.status, 'finished');
    assert.equal(recoveredQuiz.statsRecorded, false);
    assert.equal(recoveredQuiz.winnerId, p1.id);
    assert.equal(recoveredQuiz.state.scores[p1.id], 4);
    assert.equal(await prisma.gameStats.count({ where: { guildId: TEST_GUILD_1 } }), 0);
  });

  it('validates Quiz System Bug Fix & UI: wrong retry ❌, single-score race safety ✅, embed image, and outsider protection', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness({ quizRoundDurationMs: 5000, quizIntermissionMs: 25 });
    const [p1, p2, outsider] = [...h.users.values()];

    // Scenario 1-7: Wrong answers react ❌ without advancing, retries allowed, correct answer reacts ✅ once with race protection
    const questions = [
      {
        id: 901,
        category: 'general',
        difficulty: 'easy',
        question: 'What is the capital of Japan?',
        options: ['Seoul', 'Tokyo', 'Beijing', 'Bangkok'],
        correctIndex: 1,
        imageUrl: 'https://cdn.example.com/quiz/japan.png',
      },
      {
        id: 902,
        category: 'science',
        difficulty: 'easy',
        question: 'Simbol kimia air adalah?',
        options: ['CO2', 'H2O', 'O2', 'NaCl'],
        correctIndex: 1,
        imageUrl: 'javascript:alert(1)',
      },
    ];

    const sid1 = 'quiz-bugfix-1';
    const initialState = createDirectQuizState({
      hostId: p1.id,
      preparedQuestions: questions,
      roundDurationMs: 5000,
    });
    const initialPayload = buildQuizQuestionMessage({ sessionId: sid1, state: initialState });
    const quizMsg1 = await h.channel.send({
      ...initialPayload,
      attachments: new Map([['quiz.png', { name: 'quiz.png' }]]),
    });
    quizMsg1.attachments = new Map([['quiz.png', { name: 'quiz.png' }]]);

    // Scenario 8 & 9: Valid image appears on Embed, invalid URL omitted safely without breaking quiz
    const q1Json = quizMsg1.payload.embeds[0].toJSON();
    assert.equal(q1Json.image?.url, 'https://cdn.example.com/quiz/japan.png');
    assert.equal(q1Json.thumbnail?.url, 'attachment://quiz.png');

    const invalidImgPayload = buildQuizQuestionMessage({
      sessionId: sid1,
      state: { ...initialState, round: 2 },
    });
    assert.equal(invalidImgPayload.embeds[0].toJSON().image, undefined);

    await createPersistedSession({
      prisma,
      id: sid1,
      guildId: TEST_GUILD_1,
      channelId: h.channel.id,
      gameType: 'quiz',
      status: 'active',
      hostId: p1.id,
      state: initialState,
      participants: [{ userId: p1.id, username: p1.username, role: 'host' }],
      ttlMs: 60_000,
    });
    await updatePersistedSession(sid1, { messageId: quizMsg1.id }, prisma);

    // Wrong answer #1: A (0) -> ❌, stays on Question 1/2, edits NOT triggered, no score change
    const editsBeforeWrong = quizMsg1.edits.length;
    const wrong1 = createFakeMessage({ content: 'a', author: p1, channel: h.channel, client: h.client });
    await h.prefixHandler.handle(wrong1);
    assert.deepEqual(wrong1.getReactions(), ['❌']);
    assert.equal(quizMsg1.edits.length, editsBeforeWrong);

    let s1 = await getPersistedSession(sid1, prisma);
    assert.equal(s1.state.round, 1);
    assert.equal(s1.state.phase, 'question');
    assert.equal(s1.state.roundResolved, false);
    assert.equal(s1.state.scores[p1.id], 0);

    // Wrong answer #2 (retry still works): C (2) -> ❌, stays on Question 1/2
    const wrong2 = createFakeMessage({ content: 'C', author: p1, channel: h.channel, client: h.client });
    await h.prefixHandler.handle(wrong2);
    assert.deepEqual(wrong2.getReactions(), ['❌']);
    s1 = await getPersistedSession(sid1, prisma);
    assert.equal(s1.state.round, 1);

    // Same message ID dispatched twice does not react twice
    const dupMsg = createFakeMessage({ content: 'd', author: p1, channel: h.channel, client: h.client });
    await h.prefixHandler.handle(dupMsg);
    await h.prefixHandler.handle(dupMsg);
    assert.deepEqual(dupMsg.getReactions(), ['❌']);

    // Race condition check: 3 concurrent correct answers ('b') -> ONLY 1 ✅, score increments strictly +1!
    const correctRace1 = createFakeMessage({ content: 'b', author: p1, channel: h.channel, client: h.client });
    const correctRace2 = createFakeMessage({ content: 'B', author: p1, channel: h.channel, client: h.client });
    const correctRace3 = createFakeMessage({ content: 'b', author: p2, channel: h.channel, client: h.client });
    await Promise.all([
      handleQuizChatAnswer(correctRace1, { prisma, client: h.client, quizIntermissionMs: 25 }),
      handleQuizChatAnswer(correctRace2, { prisma, client: h.client, quizIntermissionMs: 25 }),
      handleQuizChatAnswer(correctRace3, { prisma, client: h.client, quizIntermissionMs: 25 }),
    ]);

    const winnerReactions = [correctRace1, correctRace2, correctRace3]
      .map((m) => m.getReactions())
      .filter((r) => r.length > 0);
    assert.deepEqual(winnerReactions, [['✅']]);

    // No redundant file re-uploads on intermission / round update
    assert.equal(quizMsg1.edits.every((e) => !e.files), true);

    s1 = await getPersistedSession(sid1, prisma);
    assert.equal((s1.state.scores[p1.id] ?? 0) + (s1.state.scores[p2.id] ?? 0), 1);
    assert.equal(s1.state.roundResolved, true);
    assert.equal(s1.state.phase, 'intermission');

    // Wait briefly for intermission -> advances to Question 2/2 without Q1's image leaking or breaking
    for (let wait = 0; wait < 30; wait += 1) {
      s1 = await getPersistedSession(sid1, prisma);
      if (s1.state.round === 2 && s1.state.phase === 'question') break;
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(s1.state.round, 2);
    assert.equal(s1.state.phase, 'question');
    const q2Embed = quizMsg1.payload.embeds[0].toJSON();
    assert.match(q2Embed.title, /Pertanyaan 2\/2/);
    assert.equal(q2Embed.image, undefined);
    assert.equal(q2Embed.thumbnail?.url, 'attachment://quiz.png');

    // Scenario 9: safeUpdateMessage strips missing attachment:// when message has 0 attachments; reply failure falls back safely
    const emptyAttMsg = await h.channel.send({ embeds: [] });
    emptyAttMsg.attachments = new Map();
    const sidFallback = 'quiz-no-attach-fallback';
    const noAttachInteraction = {
      guildId: TEST_GUILD_1,
      channelId: h.channel.id,
      user: p2,
      client: h.client,
      canAttachFiles: true,
      options: { getString: () => 'all' },
      replyCalls: 0,
      async reply(payload) {
        this.replyCalls += 1;
        if (payload.files?.length > 0) {
          throw new Error('Attachment blocked');
        }
        return h.channel.send(payload);
      },
    };
    await cleanupTestGuilds();
    const fallbackSession = await quizCommand.execute(noAttachInteraction, { prisma });
    assert.ok(fallbackSession);
    assert.equal(noAttachInteraction.replyCalls, 2);
    clearAllGameCenterTimers();

    // Scenario 10: Outsider cannot disrupt non-autoJoin / lobby quiz session & finished session ignores late answers
    await cleanupTestGuilds();
    let lobbyState = createQuizLobbyState({ hostId: p1.id });
    lobbyState = {
      ...lobbyState,
      players: [p1.id, p2.id],
      scores: { [p1.id]: 0, [p2.id]: 0 },
    };
    const started = startQuizBattle(lobbyState, p1.id, questions);
    const sidLocked = 'quiz-locked-participants';
    const lockedMsg = await h.channel.send(buildQuizQuestionMessage({ sessionId: sidLocked, state: started.state }));
    await createPersistedSession({
      prisma,
      id: sidLocked,
      guildId: TEST_GUILD_1,
      channelId: h.channel.id,
      gameType: 'quiz',
      status: 'active',
      hostId: p1.id,
      state: started.state,
      participants: [
        { userId: p1.id, username: p1.username, role: 'host' },
        { userId: p2.id, username: p2.username, role: 'player' },
      ],
      ttlMs: 60_000,
    });
    await updatePersistedSession(sidLocked, { messageId: lockedMsg.id }, prisma);

    const outsiderMsg = createFakeMessage({ content: 'b', author: outsider, channel: h.channel, client: h.client });
    const wasHandled = await handleQuizChatAnswer(outsiderMsg, { prisma, client: h.client });
    assert.equal(wasHandled, false);
    assert.deepEqual(outsiderMsg.getReactions(), []);
    const unchanged = await getPersistedSession(sidLocked, prisma);
    assert.equal(unchanged.state.round, 1);
    assert.equal(unchanged.state.roundResolved, false);
    assert.equal(unchanged.state.players.includes(outsider.id), false);

    // After session finished, late answers are ignored cleanly
    await updatePersistedSession(sidLocked, { status: 'finished' }, prisma);
    const lateMsg = createFakeMessage({ content: 'b', author: p1, channel: h.channel, client: h.client });
    const lateHandled = await handleQuizChatAnswer(lateMsg, { prisma, client: h.client });
    assert.equal(lateHandled, false);
    assert.deepEqual(lateMsg.getReactions(), []);
    assert.ok(sidFallback);
  });
});
