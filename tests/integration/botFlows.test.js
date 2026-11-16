import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { COLORS } from '../../src/config/colors.js';
import { commandStructure } from '../../src/config/commandStructure.js';
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
    assert.equal(new Set(payloads.map((c) => c.name)).size, expectedNames.length);

    for (const cmd of payloads) {
      if (cmd.type === 3) {
        assert.ok(cmd.name.length >= 1 && cmd.name.length <= 32);
        assert.equal(cmd.description, undefined);
      } else {
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

    // 1. P1 challenges P2 via /game
    const chInt = createMockCommandInteraction({
      commandName: 'game',
      subcommand: 'challenge',
        userId: 'p1',
      channel,
      options: { action: 'challenge', game: 'rps', opponent: { id: 'p2', bot: false } },
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
      commandName: 'game',
      subcommand: 'choose',
        userId: 'p1',
      channel,
      options: { action: 'choose', game: 'rps', choice: 'rock' },
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
    assert.equal(embedJson.footer, undefined);

    // 4. P2 submits secret choice -> finishes match and cleans up RAM
    const p2Choose = createMockCommandInteraction({
      commandName: 'game',
      subcommand: 'choose',
        userId: 'p2',
      channel,
      options: { action: 'choose', game: 'rps', choice: 'scissors' },
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
      commandName: 'game',
      subcommand: 'solo',
        userId: 'solo-1',
      channel,
      options: { action: 'solo', game: 'tictactoe', difficulty: 'easy' },
    });
    await app.interactionHandler.handle(startInt);
    const session = sessionManager.getPlayerSession('solo-1');
    assert.ok(session.boardMessageRef);

    // Simulate someone deleting the board message in Discord
    deletedIds.add(session.boardMessageRef.messageId);

    const moveInt = createMockCommandInteraction({
      commandName: 'game',
      subcommand: 'move',
        userId: 'solo-1',
      channel,
      options: { action: 'move', game: 'tictactoe', position: 'B2' },
    });
    await app.interactionHandler.handle(moveInt);

    // Fallback sent a fresh message and updated boardMessageRef
    assert.notEqual(session.boardMessageRef.messageId, deletedIds.values().next().value);
    assert.equal(moveInt.getReplies()[0].payload.flags, MessageFlags.Ephemeral);

    // Cancel via /game action:cancel
    const cancelInt = createMockCommandInteraction({
      commandName: 'game',
      subcommand: 'cancel',
        userId: 'solo-1',
      channel,
      options: { action: 'cancel' },
    });
    await app.interactionHandler.handle(cancelInt);
    assert.deepEqual(sessionManager.getStats(), { activeGamesCount: 0, playerSessionsCount: 0 });

    // Instant solo Dice & CoinFlip
    const diceInt = createMockCommandInteraction({
      commandName: 'game',
      subcommand: 'solo',
        userId: 'solo-1',
      channel,
      options: { action: 'solo', game: 'dice', count: 3, sides: 10 },
    });
    await app.interactionHandler.handle(diceInt);
    assert.equal(diceInt.getReplies().length, 1);

    const coinInt = createMockCommandInteraction({
      commandName: 'game',
      subcommand: 'solo',
        userId: 'solo-1',
      channel,
      options: { action: 'solo', game: 'coinflip', choice: 'heads' },
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

    // /game action:challenge game:trivia -> /invite decline
    await app.interactionHandler.handle(
      createMockCommandInteraction({
        commandName: 'game',
        subcommand: 'challenge',
        userId: 'p1',
        channel,
        options: {
          action: 'challenge',
          game: 'trivia',
          opponent: { id: 'p2', bot: false },
          category: 'science',
          difficulty: 'easy',
        },
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

    // /game action:challenge game:trivia -> /invite accept -> /game action:status
    await app.interactionHandler.handle(
      createMockCommandInteraction({
        commandName: 'game',
        subcommand: 'challenge',
        userId: 'p1',
        channel,
        options: {
          action: 'challenge',
          game: 'trivia',
          opponent: { id: 'p2', bot: false },
          category: 'science',
          difficulty: 'easy',
        },
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
      options: { action: 'status' },
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

  it('validates /game valid combinations across all 7 games and rejects invalid game/action combinations & missing params', async () => {
    const channel = createFakeChannel('ch-4');
    const client = createFakeClient(channel);
    const sessionManager = new SessionManager({ defaultIdleTimeoutMs: 0 });
    const inviteManager = new InviteManager({ sessionManager, defaultTtlMs: 0 });
    const gameManager = new GameManager({
      sessionManager,
      inviteManager,
      rng: createSeededRng(11),
    });
    registerDefaultGames(gameManager);

    const app = await createBotApp({
      client,
      cooldowns: new CooldownManager(0),
      sessionManager,
      inviteManager,
      gameManager,
    });

    const runGame = async ({ action, ...options }, userId = 'u-test-1') => {
      const interaction = createMockCommandInteraction({
        commandName: 'game',
        subcommand: action,
        userId,
        channel,
        options,
      });
      await app.interactionHandler.handle(interaction);
      return interaction.getReplies();
    };

    // 1. Missing required game on solo/challenge & unknown action
    const noGameSolo = await runGame({ action: 'solo' });
    assert.equal(noGameSolo[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(noGameSolo[0].payload.embeds[0].toJSON().description, /parameter `game`/i);

    const badAction = await runGame({ action: 'fly', game: 'dice' });
    assert.equal(badAction[0].payload.flags, MessageFlags.Ephemeral);

    // 2. Invalid (game, action) combinations
    const invalidPairs = [
      { action: 'drop', game: 'dice', column: 1 },
      { action: 'move', game: 'coinflip', position: 'A1' },
      { action: 'drop', game: 'guess', column: 2 },
      { action: 'answer', game: 'connect4', answer: '5' },
      { action: 'choose', game: 'trivia', choice: 'rock' },
      { action: 'choose', game: 'tictactoe', choice: 'rock' },
    ];
    for (const pair of invalidPairs) {
      const replies = await runGame(pair);
      assert.equal(replies[0].payload.flags, MessageFlags.Ephemeral);
      assert.match(replies[0].payload.embeds[0].toJSON().description, /tidak tersedia untuk/i);
    }

    // 3. Challenge without opponent
    const missingOpponent = await runGame({ action: 'challenge', game: 'connect4' });
    assert.equal(missingOpponent[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(missingOpponent[0].payload.embeds[0].toJSON().description, /opponent/i);

    // 4. Guess solo -> answer without specifying game (auto-detects active session) -> cancel with game_id
    await runGame({ action: 'solo', game: 'guess' });
    const guessSession = sessionManager.getPlayerSession('u-test-1');
    assert.equal(guessSession.gameType, 'guess');

    const badGuessAnswer = await runGame({ action: 'answer', answer: 'not-a-number' });
    assert.equal(badGuessAnswer[0].payload.flags, MessageFlags.Ephemeral);

    const validGuessAnswer = await runGame({ action: 'answer', answer: '50' });
    assert.equal(validGuessAnswer[0].payload.flags, MessageFlags.Ephemeral);

    // Mismatched game vs active session
    const mismatchAnswer = await runGame({ action: 'answer', game: 'trivia', answer: 'A' });
    assert.equal(mismatchAnswer[0].payload.flags, MessageFlags.Ephemeral);

    if (sessionManager.getPlayerSession('u-test-1')) {
      const wrongGameIdCancel = await runGame({ action: 'cancel', game_id: 'nonexistent-id' });
      assert.match(wrongGameIdCancel[0].payload.embeds[0].toJSON().description, /tidak cocok/i);

      await runGame({ action: 'cancel', game_id: guessSession.sessionId });
    }
    assert.equal(sessionManager.getPlayerSession('u-test-1'), undefined);

    // 5. Connect4 solo -> missing column -> valid drop -> cancel
    await runGame({ action: 'solo', game: 'connect4', difficulty: 'easy' });
    const missingCol = await runGame({ action: 'drop', game: 'connect4' });
    assert.equal(missingCol[0].payload.flags, MessageFlags.Ephemeral);
    const validDrop = await runGame({ action: 'drop', game: 'connect4', column: 4 });
    assert.equal(validDrop[0].payload.flags, MessageFlags.Ephemeral);
    await runGame({ action: 'cancel' });

    // 6. RPS solo + Trivia solo + CoinFlip/Dice solo + in-game choose/answer validation
    const rpsSolo = await runGame({ action: 'solo', game: 'rps', choice: 'rock' });
    assert.equal(rpsSolo.length, 1);

    await runGame({ action: 'solo', game: 'trivia', category: 'science', difficulty: 'easy' });
    const invalidTriviaAns = await runGame({ action: 'answer', game: 'trivia', answer: 'Z' });
    assert.equal(invalidTriviaAns[0].payload.flags, MessageFlags.Ephemeral);
    await runGame({ action: 'cancel' });

    // Status when idle
    const idleStatus = await runGame({ action: 'status' });
    assert.equal(idleStatus[0].payload.flags, MessageFlags.Ephemeral);

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
    app.interactionHandler.context.config = { rapidApiConfigured: true };
    app.interactionHandler.context.downloadMedia = mockDownload;
    app.prefixCommandHandler.context.config = { rapidApiConfigured: true };
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
