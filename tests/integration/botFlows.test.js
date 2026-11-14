import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createBotApp } from '../../src/index.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { GameManager } from '../../src/managers/GameManager.js';
import { SessionManager } from '../../src/managers/SessionManager.js';
import { InviteManager } from '../../src/managers/InviteManager.js';
import { registerDefaultGames } from '../../src/index.js';
import { createSeededRng } from '../../src/utils/random.js';
import { EMBED_FOOTER } from '../../src/utils/constants.js';

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
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
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
  it('registers all 29 valid Discord commands within API limits', async () => {
    const app = await createBotApp();
    const payloads = app.commandHandler.toJSON();
    const names = payloads.map((c) => c.name).sort();
    assert.deepEqual(names, [
      'Generate QC',
      'ai',
      'bonk',
      'brat',
      'coinflip',
      'connect4',
      'cry',
      'dice',
      'download',
      'game',
      'games',
      'guess',
      'help',
      'highfive',
      'hug',
      'invite',
      'knowledge',
      'laugh',
      'lyrics',
      'math',
      'pat',
      'poke',
      'qc',
      'rps',
      'slap',
      'tictactoe',
      'trivia',
      'wave',
      'yeet',
    ]);

    for (const cmd of payloads) {
      if (cmd.type === 3) {
        assert.ok(cmd.name.length >= 1 && cmd.name.length <= 32);
        assert.equal(cmd.description, undefined);
      } else {
        assert.ok(/^[a-z0-9_-]{1,32}$/.test(cmd.name), `Invalid command name ${cmd.name}`);
        assert.ok(cmd.description && cmd.description.length <= 100);
        assert.ok((cmd.options?.length ?? 0) <= 25);
      }
    }
    app.shutdown();
  });

  it('executes full multiplayer RPS flow with ephemeral secret choices and clean session teardown', async () => {
    const channel = createFakeChannel('ch-1');
    const client = createFakeClient(channel);
    const sessionManager = new SessionManager({ defaultIdleTimeoutMs: 0 });
    const inviteManager = new InviteManager({ sessionManager, defaultTtlMs: 0 });
    const gameManager = new GameManager({
      sessionManager,
      inviteManager,
      rng: createSeededRng(1),
    });
    registerDefaultGames(gameManager);

    const app = await createBotApp({
      client,
      cooldowns: new CooldownManager(0),
      sessionManager,
      inviteManager,
      gameManager,
    });

    // 1. P1 challenges P2
    const chInt = createMockCommandInteraction({
      commandName: 'rps',
      subcommand: 'challenge',
      userId: 'p1',
      channel,
      options: { opponent: { id: 'p2', bot: false } },
    });
    await app.interactionHandler.handle(chInt);
    assert.equal(inviteManager.count, 1);

    // 2. P2 accepts invite
    const accInt = createMockCommandInteraction({
      commandName: 'invite',
      subcommand: 'accept',
      userId: 'p2',
      channel,
    });
    await app.interactionHandler.handle(accInt);
    assert.equal(inviteManager.count, 0);
    assert.deepEqual(sessionManager.getStats(), { activeGamesCount: 1, playerSessionsCount: 2 });

    // 3. P1 submits secret choice (ephemeral!)
    const p1Choose = createMockCommandInteraction({
      commandName: 'rps',
      subcommand: 'choose',
      userId: 'p1',
      channel,
      options: { choice: 'rock' },
    });
    await app.interactionHandler.handle(p1Choose);
    assert.equal(p1Choose.getReplies()[0].payload.flags, MessageFlags.Ephemeral);

    // Check public board field did NOT leak 'Rock (Batu)'
    const boardMsg = Array.from(channel._messages.values()).at(-1);
    const embedJson = boardMsg.edits.at(-1).embeds[0].toJSON();
    const boardField = embedJson.fields.find((f) => f.name === 'Papan / Informasi');
    assert.ok(boardField);
    assert.equal(boardField.value.includes('Rock (Batu)'), false);
    assert.ok(boardField.value.includes('Sudah memilih (rahasia)'));
    assert.equal(embedJson.footer.text, EMBED_FOOTER);

    // 4. P2 submits secret choice -> finishes match and cleans up RAM
    const p2Choose = createMockCommandInteraction({
      commandName: 'rps',
      subcommand: 'choose',
      userId: 'p2',
      channel,
      options: { choice: 'scissors' },
    });
    await app.interactionHandler.handle(p2Choose);
    assert.deepEqual(sessionManager.getStats(), { activeGamesCount: 0, playerSessionsCount: 0 });
    const finalJson = JSON.stringify(boardMsg.edits.at(-1).embeds[0].toJSON());
    assert.ok(finalJson.includes('Rock'));
    assert.ok(finalJson.includes('Scissors'));

    app.shutdown();
  });

  it('executes solo TicTacToe & Connect4 and gracefully recovers if board message was deleted', async () => {
    const deletedIds = new Set();
    const channel = createFakeChannel('ch-2', deletedIds);
    const client = createFakeClient(channel);
    const sessionManager = new SessionManager({ defaultIdleTimeoutMs: 0 });
    const inviteManager = new InviteManager({ sessionManager, defaultTtlMs: 0 });
    const gameManager = new GameManager({
      sessionManager,
      inviteManager,
      rng: createSeededRng(42),
    });
    registerDefaultGames(gameManager);

    const app = await createBotApp({
      client,
      cooldowns: new CooldownManager(0),
      sessionManager,
      inviteManager,
      gameManager,
    });

    // Start solo TicTacToe
    const startInt = createMockCommandInteraction({
      commandName: 'tictactoe',
      subcommand: 'solo',
      userId: 'solo-1',
      channel,
      options: { difficulty: 'easy' },
    });
    await app.interactionHandler.handle(startInt);
    const session = sessionManager.getPlayerSession('solo-1');
    assert.ok(session.boardMessageRef);

    // Simulate someone deleting the board message in Discord
    deletedIds.add(session.boardMessageRef.messageId);

    const moveInt = createMockCommandInteraction({
      commandName: 'tictactoe',
      subcommand: 'move',
      userId: 'solo-1',
      channel,
      options: { position: 'B2' },
    });
    await app.interactionHandler.handle(moveInt);

    // Fallback sent a fresh message and updated boardMessageRef
    assert.notEqual(session.boardMessageRef.messageId, deletedIds.values().next().value);
    assert.equal(moveInt.getReplies()[0].payload.flags, MessageFlags.Ephemeral);

    // Cancel via /game cancel
    const cancelInt = createMockCommandInteraction({
      commandName: 'game',
      subcommand: 'cancel',
      userId: 'solo-1',
      channel,
    });
    await app.interactionHandler.handle(cancelInt);
    assert.deepEqual(sessionManager.getStats(), { activeGamesCount: 0, playerSessionsCount: 0 });

    // Instant solo Dice & CoinFlip
    const diceInt = createMockCommandInteraction({
      commandName: 'dice',
      subcommand: 'solo',
      userId: 'solo-1',
      channel,
      options: { count: 3, sides: 10 },
    });
    await app.interactionHandler.handle(diceInt);
    assert.equal(diceInt.getReplies().length, 1);

    const coinInt = createMockCommandInteraction({
      commandName: 'coinflip',
      subcommand: 'solo',
      userId: 'solo-1',
      channel,
      options: { choice: 'heads' },
    });
    await app.interactionHandler.handle(coinInt);
    assert.equal(coinInt.getReplies().length, 1);

    app.shutdown();
  });

  it('executes /help, /game status, /invite decline, and multiplayer Trivia round timer flow', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const channel = createFakeChannel('ch-3');
    const client = createFakeClient(channel);
    const sessionManager = new SessionManager({ defaultIdleTimeoutMs: 120_000 });
    const inviteManager = new InviteManager({ sessionManager, defaultTtlMs: 60_000 });
    const gameManager = new GameManager({
      sessionManager,
      inviteManager,
      rng: createSeededRng(7),
    });
    registerDefaultGames(gameManager);

    const app = await createBotApp({
      client,
      cooldowns: new CooldownManager(0),
      sessionManager,
      inviteManager,
      gameManager,
    });

    // /help
    const helpInt = createMockCommandInteraction({ commandName: 'help', userId: 'p1', channel });
    await app.interactionHandler.handle(helpInt);
    assert.equal(helpInt.getReplies().length, 1);

    // /trivia challenge -> /invite decline
    await app.interactionHandler.handle(
      createMockCommandInteraction({
        commandName: 'trivia',
        subcommand: 'challenge',
        userId: 'p1',
        channel,
        options: { opponent: { id: 'p2', bot: false }, category: 'science', difficulty: 'easy' },
      }),
    );
    await app.interactionHandler.handle(
      createMockCommandInteraction({
        commandName: 'invite',
        subcommand: 'decline',
        userId: 'p2',
        channel,
      }),
    );
    assert.equal(inviteManager.count, 0);

    // /trivia challenge -> /invite accept -> /game status
    await app.interactionHandler.handle(
      createMockCommandInteraction({
        commandName: 'trivia',
        subcommand: 'challenge',
        userId: 'p1',
        channel,
        options: { opponent: { id: 'p2', bot: false }, category: 'science', difficulty: 'easy' },
      }),
    );
    await app.interactionHandler.handle(
      createMockCommandInteraction({
        commandName: 'invite',
        subcommand: 'accept',
        userId: 'p2',
        channel,
      }),
    );

    const statusInt = createMockCommandInteraction({
      commandName: 'game',
      subcommand: 'status',
      userId: 'p1',
      channel,
    });
    await app.interactionHandler.handle(statusInt);
    assert.equal(statusInt.getReplies()[0].payload.flags, MessageFlags.Ephemeral);

    // Let all 5 Trivia rounds time out (5 * 20_000 ms)
    for (let r = 0; r < 5; r += 1) {
      t.mock.timers.tick(20_000);
      for (let m = 0; m < 10; m += 1) {
        await Promise.resolve();
      }
    }

    assert.deepEqual(sessionManager.getStats(), { activeGamesCount: 0, playerSessionsCount: 0 });
    app.shutdown();
  });
});
