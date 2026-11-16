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
import { recoverGameCenterSessions } from '../../src/events/gameInteraction.js';
import { createRpsMatchState } from '../../src/games/engines/rockPaperScissors.js';
import {
  buildTwoPlayerResults,
  recordMatchStatsOnce,
} from '../../src/games/services/scoreService.js';
import {
  getGuildLeaderboard,
  getUserProfileStats,
} from '../../src/games/services/leaderboardService.js';
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
    assert.equal(finished.statsRecorded, true);

    // Verify duplicate recordMatchStatsOnce is rejected
    const dup = await recordMatchStatsOnce({
      prisma,
      sessionId,
      results: buildTwoPlayerResults([p1.id, p2.id], { winnerId: p1.id }),
    });
    assert.equal(dup.recorded, false);

    // Verify Profile stats
    const p1Profile = await getUserProfileStats({ prisma, guildId: TEST_GUILD_1, userId: p1.id });
    assert.equal(p1Profile.summary.matches, 1);
    assert.equal(p1Profile.summary.wins, 1);
    assert.equal(p1Profile.summary.points, 25);
    assert.equal(p1Profile.summary.winRate, 100);
    assert.equal(p1Profile.perGame.ttt.wins, 1);
  });

  it('plays Connect Four via !connect4 @user -> Accept -> Column Buttons -> Win', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness();
    const [p1, p2] = [...h.users.values()];

    const msg = createFakeMessage({
      content: `!connect4 <@${p2.id}>`,
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

    // Vertical win in col 0 for p1
    const drops = [
      [p1, 0],
      [p2, 1],
      [p1, 0],
      [p2, 1],
      [p1, 0],
      [p2, 1],
      [p1, 0],
    ];
    for (const [player, col] of drops) {
      await h.interactionHandler.handle(
        createFakeButtonInteraction({
          customId: buildGameCustomId('c4', sessionId, 'drop', col),
          user: player,
          message: challengeMsg,
          client: h.client,
        }),
      );
    }

    const finished = await getPersistedSession(sessionId, prisma);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.winnerId, p1.id);

    const p2Profile = await getUserProfileStats({ prisma, guildId: TEST_GUILD_1, userId: p2.id });
    assert.equal(p2Profile.perGame.connect4.losses, 1);
    assert.equal(p2Profile.summary.winRate, 0);
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
    assert.equal(finished.statsRecorded, true);
  });

  it('runs a full 10-round Quiz Battle via !quiz with lobby, answer hiding, double-answer rejection, timeout, and +5 bonus', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness({ quizRoundDurationMs: 400, quizIntermissionMs: 30 });
    const [host, p2, outsider] = [...h.users.values()];

    const msg = createFakeMessage({
      content: '!quiz',
      author: host,
      channel: h.channel,
      client: h.client,
    });
    await h.prefixHandler.handle(msg);
    const quizMsg = msg.getReplies()[0];
    const joinId = quizMsg.payload.components[0].components[0].data.custom_id;
    const sessionId = joinId.split(':')[2];

    // Cannot start with only 1 player
    const badStart = createFakeButtonInteraction({
      customId: buildGameCustomId('quiz', sessionId, 'start'),
      user: host,
      message: quizMsg,
      client: h.client,
    });
    await h.interactionHandler.handle(badStart);
    assert.equal(badStart.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

    // p2 joins
    await h.interactionHandler.handle(
      createFakeButtonInteraction({ customId: joinId, user: p2, message: quizMsg, client: h.client }),
    );

    // Host starts
    await h.interactionHandler.handle(
      createFakeButtonInteraction({
        customId: buildGameCustomId('quiz', sessionId, 'start'),
        user: host,
        message: quizMsg,
        client: h.client,
      }),
    );

    let session = await getPersistedSession(sessionId, prisma);
    assert.equal(session.status, 'active');
    assert.equal(session.state.questions.length, 10);

    // Verify answer is NOT exposed in question embed
    assert.equal(quizMsg.payload.embeds[0].data.description.includes('Jawaban Benar'), false);

    // Outsider rejected
    const outAns = createFakeButtonInteraction({
      customId: buildGameCustomId('quiz', sessionId, 'ans', 1, 0),
      user: outsider,
      message: quizMsg,
      client: h.client,
    });
    await h.interactionHandler.handle(outAns);
    assert.equal(outAns.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

    // Play rounds 1..9 with both players answering (host always picks correctIndex, p2 picks wrong)
    for (let round = 1; round <= 9; round += 1) {
      // Wait for round to become active
      for (let wait = 0; wait < 30; wait += 1) {
        session = await getPersistedSession(sessionId, prisma);
        if (session.state.phase === 'question' && session.state.round === round) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(session.state.round, round);
      const correctIdx = session.state.questions[round - 1].correctIndex;
      const wrongIdx = (correctIdx + 1) % 4;

      const hostAns = createFakeButtonInteraction({
        customId: buildGameCustomId('quiz', sessionId, 'ans', round, correctIdx),
        user: host,
        message: quizMsg,
        client: h.client,
      });
      await h.interactionHandler.handle(hostAns);
      assert.equal(hostAns.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

      // Duplicate answer rejected in round 1
      if (round === 1) {
        const dupAns = createFakeButtonInteraction({
          customId: buildGameCustomId('quiz', sessionId, 'ans', round, wrongIdx),
          user: host,
          message: quizMsg,
          client: h.client,
        });
        await h.interactionHandler.handle(dupAns);
        assert.equal(dupAns.getResponses()[0].payload.flags, MessageFlags.Ephemeral);
      }

      await h.interactionHandler.handle(
        createFakeButtonInteraction({
          customId: buildGameCustomId('quiz', sessionId, 'ans', round, wrongIdx),
          user: p2,
          message: quizMsg,
          client: h.client,
        }),
      );
    }

    // Round 10: let timeout resolve automatically (both get 0 on round 10 -> host finishes with 90 + 5 bonus = 95)
    for (let wait = 0; wait < 60; wait += 1) {
      session = await getPersistedSession(sessionId, prisma);
      if (session.status === 'finished') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.equal(session.status, 'finished');
    assert.equal(session.winnerId, host.id);
    assert.equal(session.statsRecorded, true);
    assert.equal(session.state.scores[host.id], 95);
    assert.equal(session.state.scores[p2.id], 0);

    const hostStats = await getUserProfileStats({ prisma, guildId: TEST_GUILD_1, userId: host.id });
    assert.equal(hostStats.perGame.quiz.points, 95);
    assert.equal(hostStats.perGame.quiz.wins, 1);
  });

  it('supports leaderboard pagination, guild isolation, !lb/!profile commands, and unfinished match exclusion', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness();
    const allUsers = [...h.users.values()];

    // Seed 12 finished matches in guild 1 (to require 2 pages) and 1 match in guild 2
    for (let i = 0; i < 12; i += 1) {
      const winner = allUsers[i];
      const loser = allUsers[(i + 1) % 12];
      const sid = `seed-g1-${i}`;
      await createPersistedSession({
        prisma,
        id: sid,
        guildId: TEST_GUILD_1,
        channelId: h.channel.id,
        gameType: 'ttt',
        status: 'finished',
        hostId: winner.id,
        state: createTicTacToeState({ hostId: winner.id, opponentId: loser.id }),
        participants: [
          { userId: winner.id, username: winner.username, role: 'X' },
          { userId: loser.id, username: loser.username, role: 'O' },
        ],
      });
      await recordMatchStatsOnce({
        prisma,
        sessionId: sid,
        results: buildTwoPlayerResults([winner.id, loser.id], {
          winnerId: winner.id,
          usernames: { [winner.id]: winner.username, [loser.id]: loser.username },
        }),
      });
    }

    // Unfinished session must NOT be counted
    const pendingSid = 'seed-unfinished';
    await createPersistedSession({
      prisma,
      id: pendingSid,
      guildId: TEST_GUILD_1,
      channelId: h.channel.id,
      gameType: 'ttt',
      status: 'active',
      hostId: allUsers[14].id,
      state: createTicTacToeState({ hostId: allUsers[14].id, opponentId: allUsers[13].id }),
      participants: [
        { userId: allUsers[14].id, username: allUsers[14].username, role: 'X' },
        { userId: allUsers[13].id, username: allUsers[13].username, role: 'O' },
      ],
    });
    const unfinishedAttempt = await recordMatchStatsOnce({
      prisma,
      sessionId: pendingSid,
      results: buildTwoPlayerResults([allUsers[14].id, allUsers[13].id], { winnerId: allUsers[14].id }),
    });
    assert.equal(unfinishedAttempt.recorded, false);

    // Guild 2 isolation check
    const g2Sid = 'seed-g2-0';
    await createPersistedSession({
      prisma,
      id: g2Sid,
      guildId: TEST_GUILD_2,
      channelId: h.channel.id,
      gameType: 'rps',
      status: 'finished',
      hostId: allUsers[14].id,
      state: {},
      participants: [
        { userId: allUsers[14].id, username: allUsers[14].username, role: 'P1' },
        { userId: allUsers[13].id, username: allUsers[13].username, role: 'P2' },
      ],
    });
    await recordMatchStatsOnce({
      prisma,
      sessionId: g2Sid,
      results: buildTwoPlayerResults([allUsers[14].id, allUsers[13].id], { winnerId: allUsers[14].id }),
    });

    const g1Lb = await getGuildLeaderboard({ prisma, guildId: TEST_GUILD_1, gameType: 'all', page: 1 });
    assert.equal(g1Lb.totalPages, 2);
    assert.equal(g1Lb.entries.length, 10);
    assert.equal(g1Lb.entries.some((e) => e.userId === allUsers[14].id), false);

    // !lb ttt + Next page button
    const lbMsg = createFakeMessage({
      content: '!lb ttt',
      author: allUsers[0],
      channel: h.channel,
      client: h.client,
    });
    await h.prefixHandler.handle(lbMsg);
    const lbSent = lbMsg.getReplies()[0];
    assert.ok(lbSent.payload.embeds[0].data.title.includes('Tic Tac Toe'));
    const nextBtnId = lbSent.payload.components[0].components[2].data.custom_id;

    await h.interactionHandler.handle(
      createFakeButtonInteraction({
        customId: nextBtnId,
        user: allUsers[0],
        message: lbSent,
        client: h.client,
      }),
    );
    assert.ok(lbSent.payload.embeds[0].data.fields[0].value.includes('Halaman **2/2**'));

    // !profile @user
    const profMsg = createFakeMessage({
      content: `!profile <@${allUsers[0].id}>`,
      author: allUsers[1],
      channel: h.channel,
      mentions: [allUsers[0]],
      client: h.client,
    });
    await h.prefixHandler.handle(profMsg);
    const profSent = profMsg.getReplies()[0];
    assert.ok(profSent.payload.embeds[0].data.title.includes('Profil Game Center'));
    assert.ok(profSent.payload.embeds[0].data.description.includes('**Total Poin:** **25**'));
  });

  it('handles concurrent quiz seeding, concurrent RPS button clicks, and deleted message gracefully', async () => {
    await cleanupTestGuilds();
    const h = await createGameCenterHarness();
    const [p1, p2] = [...h.users.values()];

    // Concurrent seed calls must remain idempotent and leave 90 active questions
    const seedCounts = await Promise.all(
      Array.from({ length: 5 }, () => ensureQuizQuestionsSeeded(prisma)),
    );
    assert.ok(seedCounts.every((c) => c === 90));

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
      scores: { [p1.id]: 30, [p2.id]: 10 },
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
    assert.equal(recoveredQuiz.statsRecorded, true);
    assert.equal(recoveredQuiz.winnerId, p1.id);
    assert.equal(recoveredQuiz.state.scores[p1.id], 45);
  });
});
