import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createBotApp, registerDefaultGames } from '../../src/index.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { PrefixCommandHandler } from '../../src/handlers/PrefixCommandHandler.js';
import { SessionManager } from '../../src/managers/SessionManager.js';
import { InviteManager } from '../../src/managers/InviteManager.js';
import { GameManager } from '../../src/managers/GameManager.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { createSeededRng } from '../../src/utils/random.js';
import { parsePrefixInvocation, resolvePrefix } from '../../src/utils/prefixParser.js';
import { BRAT_ATTACHMENT_NAME, BRAT_SIZE } from '../../src/utils/bratGenerator.js';

function createFakeChannel(channelId, permissionsMask = null) {
  const messages = new Map();
  let nextId = 2000;

  return {
    id: channelId,
    isTextBased: () => true,
    typingCalls: 0,
    async sendTyping() {
      this.typingCalls++;
    },
    permissionsFor() {
      if (permissionsMask === null) {
        return { has: () => true };
      }
      return {
        has: (bit) => permissionsMask.has(bit),
      };
    },
    messages: {
      async fetch(id) {
        const msg = messages.get(id);
        if (!msg) {
          const err = new Error('Unknown Message');
          err.code = 10008;
          throw err;
        }
        return msg;
      },
    },
    async send(payload) {
      const id = String(++nextId);
      const msg = {
        id,
        channelId,
        payload,
        edits: [],
        async edit(newPayload) {
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

function createFakeUser(id, { bot = false, allowDm = true } = {}) {
  const dms = [];
  return {
    id,
    bot,
    username: `user-${id}`,
    dms,
    async send(payload) {
      if (!allowDm) {
        const err = new Error('Cannot send messages to this user');
        err.code = 50007;
        throw err;
      }
      dms.push(payload);
      return payload;
    },
  };
}

function createFakeMessage({
  content,
  author,
  channel,
  guildId = 'guild-1',
  mentions = [],
  userDirectory = new Map(),
}) {
  const replies = [];
  let deleted = false;
  const mentionMap = new Map(mentions.map((u) => [u.id, u]));

  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content,
    author,
    channel,
    channelId: channel.id,
    guildId,
    guild: guildId
      ? {
          id: guildId,
          members: {
            me: { id: 'bot-1' },
            async fetch(id) {
              const u = userDirectory.get(id) ?? mentionMap.get(id);
              if (!u) throw new Error('Unknown Member');
              return { id, user: u };
            },
          },
        }
      : null,
    client: {
      user: { id: 'bot-1' },
      users: {
        cache: userDirectory,
        async fetch(id) {
          const u = userDirectory.get(id) ?? mentionMap.get(id);
          if (!u) throw new Error('Unknown User');
          return u;
        },
      },
    },
    mentions: {
      users: mentionMap,
    },
    deletable: true,
    async delete() {
      deleted = true;
    },
    isDeleted: () => deleted,
    async reply(payload) {
      const sent = await channel.send(payload);
      replies.push(sent);
      return sent;
    },
    getReplies: () => replies,
  };
}

function createMockSlashInteraction({ commandName, subcommand = null, userId, channel, options = {} }) {
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
        replyMsg = await channel.send(payload);
      }
      return replyMsg;
    },
    async editReply(payload) {
      replies.push({ type: 'editReply', payload });
      if (!this.deferred || !replies.find((r) => r.type === 'deferReply')?.payload?.flags) {
        replyMsg = await channel.send(payload);
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

const U1_ID = '100000000000000001';
const U2_ID = '200000000000000002';

async function createTestHarness({ prefix = '!', cooldownMs = 0 } = {}) {
  const channel = createFakeChannel('ch-prefix-1');
  const users = new Map([
    [U1_ID, createFakeUser(U1_ID)],
    [U2_ID, createFakeUser(U2_ID)],
    ['bot2', createFakeUser('bot2', { bot: true })],
  ]);

  const client = {
    user: { id: 'bot-1' },
    users: {
      cache: users,
      async fetch(id) {
        const u = users.get(id);
        if (!u) throw new Error('Unknown user');
        return u;
      },
    },
    channels: {
      async fetch(id) {
        if (id === channel.id) return channel;
        throw new Error(`Unknown channel ${id}`);
      },
    },
  };

  const sessionManager = new SessionManager({ defaultIdleTimeoutMs: 0 });
  const inviteManager = new InviteManager({ sessionManager, defaultTtlMs: 0 });
  const gameManager = new GameManager({
    sessionManager,
    inviteManager,
    rng: createSeededRng(42),
  });
  registerDefaultGames(gameManager);

  const commandHandler = new CommandHandler();
  await commandHandler.loadCommands();
  const cooldowns = new CooldownManager(cooldownMs);

  const context = {
    client,
    prefix,
    commandHandler,
    cooldowns,
    sessionManager,
    inviteManager,
    gameManager,
  };

  const interactionHandler = new InteractionHandler({
    commandHandler,
    cooldowns,
    context,
  });
  const prefixCommandHandler = new PrefixCommandHandler({
    commandHandler,
    cooldowns,
    prefix,
    context,
  });

  return {
    channel,
    users,
    client,
    sessionManager,
    inviteManager,
    gameManager,
    cooldowns,
    interactionHandler,
    prefixCommandHandler,
  };
}

describe('Prefix Command System', () => {
  it('resolves prefix from config and ignores invalid triggers or unknown commands', () => {
    assert.equal(resolvePrefix(undefined), '!');
    assert.equal(resolvePrefix('   '), '!');
    assert.equal(resolvePrefix(' ? '), '?');

    assert.equal(parsePrefixInvocation('hello world'), null);
    assert.equal(parsePrefixInvocation('!'), null);
    assert.equal(parsePrefixInvocation('! games'), null);
    assert.equal(parsePrefixInvocation('!!games'), null);
    assert.equal(parsePrefixInvocation('!unknowncmd arg'), null);
  });

  it('parses all supported commands, shorthands, aliases, and ignores removed commands', () => {
    assert.equal(parsePrefixInvocation('!games'), null);
    assert.equal(parsePrefixInvocation('!game status'), null);
    assert.equal(parsePrefixInvocation('!invite accept'), null);
    assert.equal(parsePrefixInvocation('!dice 2d20'), null);
    assert.equal(parsePrefixInvocation('!guess'), null);
    assert.equal(parsePrefixInvocation('!c4 5'), null);
    assert.equal(parsePrefixInvocation('!connect4'), null);
    assert.equal(parsePrefixInvocation('!help'), null);
    assert.equal(parsePrefixInvocation('!trivia science hard'), null);
    assert.equal(parsePrefixInvocation('!trivia b'), null);

    assert.deepEqual(parsePrefixInvocation('!menu'), {
      commandName: 'menu',
      subcommand: null,
      options: {},
    });
    assert.deepEqual(parsePrefixInvocation('!brat midnight ocean & <test>'), {
      commandName: 'brat',
      subcommand: null,
      options: { text: 'midnight ocean & <test>' },
    });
    assert.ok(parsePrefixInvocation('!brat')?.error);

    assert.deepEqual(parsePrefixInvocation('!download https://vt.tiktok.com/ZSp4TETHK/'), {
      commandName: 'download',
      subcommand: null,
      options: { url: 'https://vt.tiktok.com/ZSp4TETHK/' },
    });
    assert.deepEqual(parsePrefixInvocation('!dl https://www.instagram.com/reel/abc/'), {
      commandName: 'download',
      subcommand: null,
      options: { url: 'https://www.instagram.com/reel/abc/' },
    });
    assert.ok(parsePrefixInvocation('!download')?.error);

    assert.deepEqual(parsePrefixInvocation('!rps batu'), {
      commandName: 'rps',
      subcommand: 'solo',
      options: { choice: 'rock' },
    });
    assert.deepEqual(parsePrefixInvocation('!rps'), {
      commandName: 'rps',
      subcommand: 'lobby',
      options: {},
    });

    assert.deepEqual(parsePrefixInvocation('!coinflip tails'), {
      commandName: 'coinflip',
      subcommand: 'solo',
      options: { choice: 'tails' },
    });
    assert.deepEqual(parsePrefixInvocation('!cf <@!123456789012345678>'), {
      commandName: 'coinflip',
      subcommand: 'challenge',
      options: { opponentId: '123456789012345678' },
    });

    assert.deepEqual(parsePrefixInvocation('!ttt'), {
      commandName: 'tictactoe',
      subcommand: 'lobby',
      options: {},
    });
    assert.ok(parsePrefixInvocation('!ttt easy')?.error);
    assert.ok(parsePrefixInvocation('!ttt b2')?.error);
    assert.deepEqual(parsePrefixInvocation('!ttt <@123456789012345678>'), {
      commandName: 'tictactoe',
      subcommand: 'challenge',
      options: { opponentId: '123456789012345678' },
    });
    assert.deepEqual(parsePrefixInvocation('!weather Kemayoran, Jakarta'), {
      commandName: 'weather',
      subcommand: null,
      options: { location: 'Kemayoran, Jakarta' },
    });
    assert.ok(parsePrefixInvocation('!weather')?.error);
  });

  it('ignores bot messages, enforces guild channel permissions, and shares cooldown with slash commands', async () => {
    const harness = await createTestHarness({ prefix: '!', cooldownMs: 5000 });
    const botMsg = createFakeMessage({
      content: '!menu',
      author: harness.users.get('bot2'),
      channel: harness.channel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(botMsg);
    assert.equal(botMsg.getReplies().length, 0);

    // Channel missing EmbedLinks must send a plain warning instead of throwing
    const noEmbedChannel = createFakeChannel(
      'ch-no-embed',
      new Set([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]),
    );
    const noEmbedMsg = createFakeMessage({
      content: '!menu',
      author: harness.users.get(U1_ID),
      channel: noEmbedChannel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(noEmbedMsg);
    assert.equal(noEmbedMsg.getReplies().length, 1);
    assert.match(noEmbedMsg.getReplies()[0].payload.content, /Embed Links/i);

    // Channel missing AttachFiles on !brat must send a clear error embed
    const noAttachChannel = createFakeChannel(
      'ch-no-attach',
      new Set([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ]),
    );
    const noAttachMsg = createFakeMessage({
      content: '!brat midnight',
      author: harness.users.get(U1_ID),
      channel: noAttachChannel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(noAttachMsg);
    assert.equal(noAttachMsg.getReplies().length, 1);
    assert.match(noAttachMsg.getReplies()[0].payload.embeds[0].toJSON().description, /Attach Files/i);

    // Shared cooldown between prefix (!math) and slash (/math)
    const firstPrefix = createFakeMessage({
      content: '!math 2 + 2',
      author: harness.users.get(U1_ID),
      channel: harness.channel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(firstPrefix);
    assert.equal(firstPrefix.getReplies().length, 1);
    assert.equal(firstPrefix.getReplies()[0].payload.embeds.length, 1);

    const secondSlash = createMockSlashInteraction({
      commandName: 'math',
      userId: U1_ID,
      channel: harness.channel,
    });
    await harness.interactionHandler.handle(secondSlash);
    assert.equal(secondSlash.getReplies()[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(secondSlash.getReplies()[0].payload.embeds[0].toJSON().description, /Tunggu/i);
  });

  it('executes !brat, !menu, solo games, and respects custom PREFIX configuration', async () => {
    const app = await createBotApp({ prefix: '?' });
    assert.equal(app.prefix, '?');
    const intents = app.client.options.intents;
    assert.ok(intents.has(GatewayIntentBits.Guilds));
    assert.ok(intents.has(GatewayIntentBits.GuildMessages));
    assert.ok(intents.has(GatewayIntentBits.MessageContent));
    app.shutdown();

    const harness = await createTestHarness({ prefix: '?' });
    const u1 = harness.users.get(U1_ID);

    const helpMsg = createFakeMessage({
      content: '?menu',
      author: u1,
      channel: harness.channel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(helpMsg);
    const helpJson = JSON.stringify(helpMsg.getReplies()[0].payload.embeds[0].toJSON());
    assert.ok(helpJson.includes('MIDWAVE — COMMAND GUIDE'));
    assert.ok(helpJson.includes('`brat`'));
    assert.ok(helpJson.includes('`donate`'));

    assert.deepEqual(parsePrefixInvocation('!donate'), {
      commandName: 'donate',
      subcommand: null,
      options: {},
    });

    const donateMsg = createFakeMessage({
      content: '?donate',
      author: u1,
      channel: harness.channel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(donateMsg);
    assert.equal(donateMsg.getReplies().length, 1);
    const donatePayload = donateMsg.getReplies()[0].payload;
    assert.equal(donatePayload.embeds[0].toJSON().title, '☕ Buy Me a Coffee?');
    assert.equal(donatePayload.components[0].toJSON().components.length, 2);

    const bratMsg = createFakeMessage({
      content: '?brat midnight ocean',
      author: u1,
      channel: harness.channel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(bratMsg);
    const attachment = bratMsg.getReplies()[0].payload.files[0];
    assert.equal(attachment.name, BRAT_ATTACHMENT_NAME);
    assert.equal(attachment.attachment.readUInt32BE(16), BRAT_SIZE);
    assert.equal(attachment.attachment.readUInt32BE(20), BRAT_SIZE);

    // ?brat with exact 1000 chars and multiline succeeds
    const brat1000Msg = createFakeMessage({
      content: `?brat ${'a'.repeat(499)}\n${'b'.repeat(500)}`,
      author: u1,
      channel: harness.channel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(brat1000Msg);
    const attachment1000 = brat1000Msg.getReplies()[0].payload.files[0];
    assert.equal(attachment1000.name, BRAT_ATTACHMENT_NAME);

    // ?brat exceeding 1000 chars (1001) returns informative error embed before rendering
    const bratOverMsg = createFakeMessage({
      content: `?brat ${'a'.repeat(1001)}`,
      author: u1,
      channel: harness.channel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(bratOverMsg);
    const overEmbed = JSON.stringify(bratOverMsg.getReplies()[0].payload.embeds[0].toJSON());
    assert.match(overEmbed, /maksimal 1000 karakter/i);

    // ?math integration through PrefixCommandHandler (minimalist embed)
    const mathMsg = createFakeMessage({
      content: '?math 9 + 11',
      author: u1,
      channel: harness.channel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(mathMsg);
    const mathEmbed = mathMsg.getReplies()[0].payload.embeds[0].toJSON();
    assert.equal(mathEmbed.title, undefined);
    assert.equal(mathEmbed.description, undefined);
    assert.equal(mathEmbed.fields.length, 2);
    assert.equal(mathEmbed.fields[0].name, 'Input');
    assert.equal(mathEmbed.fields[0].value, '`9 + 11`');
    assert.equal(mathEmbed.fields[1].name, 'Output');
    assert.equal(mathEmbed.fields[1].value, '`20`');
    assert.equal(mathEmbed.footer, undefined);

    const mathSqrtMsg = createFakeMessage({
      content: '?math sqrt(144)',
      author: u1,
      channel: harness.channel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(mathSqrtMsg);
    const sqrtEmbed = mathSqrtMsg.getReplies()[0].payload.embeds[0].toJSON();
    assert.equal(sqrtEmbed.fields[1].value, '`12`');

    // ?tictactoe without mention opens Tic Tac Toe Lobby under custom prefix cleanly (no error!)
    const tttLobbyCustom = createFakeMessage({
      content: '?tictactoe',
      author: u1,
      channel: harness.channel,
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(tttLobbyCustom);
    const tttLobbyPayload = tttLobbyCustom.getReplies()[0].payload;
    assert.equal(tttLobbyPayload.embeds[0].data.title, 'Tic Tac Toe');
    assert.equal(tttLobbyPayload.components[1].components[0].data.disabled, true);
    assert.equal(harness.sessionManager.activeGames.size, 0);
  });

  it('runs real solo CoinFlip/RPS flows and rejects solo or bot TicTacToe via prefix commands', async () => {
    const harness = await createTestHarness({ prefix: '!' });
    const u1 = harness.users.get(U1_ID);

    const cfMsg = createFakeMessage({ content: '!coinflip heads', author: u1, channel: harness.channel, userDirectory: harness.users });
    await harness.prefixCommandHandler.handle(cfMsg);
    assert.equal(cfMsg.getReplies().length, 1);
    assert.equal(harness.sessionManager.activeGames.size, 0);

    const rpsMsg = createFakeMessage({ content: '!rps rock', author: u1, channel: harness.channel, userDirectory: harness.users });
    await harness.prefixCommandHandler.handle(rpsMsg);
    assert.equal(rpsMsg.getReplies().length, 1);
    assert.equal(harness.sessionManager.activeGames.size, 0);

    const tttEasyMsg = createFakeMessage({ content: '!ttt easy', author: u1, channel: harness.channel, userDirectory: harness.users });
    await harness.prefixCommandHandler.handle(tttEasyMsg);
    assert.match(tttEasyMsg.getReplies()[0].payload.embeds[0].data.description, /bersama teman/i);

    const bot2 = harness.users.get('bot2');
    const tttBotMsg = createFakeMessage({
      content: `!ttt <@${bot2.id}>`,
      author: u1,
      channel: harness.channel,
      mentions: [bot2],
      userDirectory: harness.users,
    });
    await harness.prefixCommandHandler.handle(tttBotMsg);
    assert.match(tttBotMsg.getReplies()[0].payload.embeds[0].data.description, /bot/i);
    assert.equal(harness.sessionManager.activeGames.size, 0);
  });

  it('ignores removed !trivia prefix command cleanly', () => {
    assert.equal(parsePrefixInvocation('!trivia science normal'), null);
  });
});
