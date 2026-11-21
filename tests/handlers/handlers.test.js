import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { createBotApp } from '../../src/index.js';
import { deployCommands } from '../../deploy-commands.js';
import { commandStructure } from '../../src/config/commandStructure.js';

function createMockInteraction(commandName, userId = '111', subcommand = null) {
  const replies = [];
  return {
    commandName,
    user: { id: userId },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => null,
      getSubcommandGroup: () => null,
      getString: (name) => (name === 'action' ? subcommand : null),
    },
    async reply(payload) {
      this.replied = true;
      replies.push({ type: 'reply', payload });
    },
    async editReply(payload) {
      replies.push({ type: 'editReply', payload });
    },
    async followUp(payload) {
      replies.push({ type: 'followUp', payload });
    },
    getReplies() {
      return replies;
    },
  };
}

describe('CommandHandler & InteractionHandler', () => {
  it('loads commands and creates bot app cleanly', async () => {
    assert.equal(typeof deployCommands, 'function');
    const app = await createBotApp();
    assert.ok(app.commandHandler.get('donate'));
    assert.ok(app.commandHandler.get('help'));
    assert.ok(app.commandHandler.get('ping'));
    assert.ok(app.commandHandler.toJSON().length >= 2);
    app.shutdown();
  });

  it('logs sanitized Discord REST rateLimited and shard lifecycle events cleanly', async () => {
    const logs = { log: [], warn: [], error: [] };
    const fakeLogger = {
      log: (...args) => logs.log.push(args.join(' ')),
      warn: (...args) => logs.warn.push(args.join(' ')),
      error: (...args) => logs.error.push(args.join(' ')),
    };

    const app = await createBotApp({ logger: fakeLogger });
    app.client.rest.emit('rateLimited', {
      route: '/gateway/bot',
      scope: 'shared',
      global: false,
      retryAfter: 2760_000,
    });
    app.client.emit('shardReconnecting', 0);
    app.client.emit('shardDisconnect', { code: 1006 }, 0);
    app.client.emit('warn', 'Authorization: Bot secret_12345');

    assert.ok(logs.warn.some((msg) => msg.includes('Discord REST rate-limited') && msg.includes('2760.0s')));
    assert.ok(logs.log.some((msg) => msg.includes('Shard 0 reconnecting')));
    assert.ok(logs.warn.some((msg) => msg.includes('Shard 0 disconnected (code=1006)')));
    assert.ok(logs.warn.some((msg) => msg.includes('[REDACTED]') && !msg.includes('secret_12345')));

    app.shutdown();
  });

  it('executes loaded /donate command and enforces cooldown', async () => {
    let now = 10_000;
    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();
    const cooldowns = new CooldownManager(2000, () => now);
    const handler = new InteractionHandler({ commandHandler, cooldowns });

    const i1 = createMockInteraction('donate', 'user-1');
    await handler.handle(i1);
    assert.equal(i1.getReplies().length, 1);
    assert.equal(i1.getReplies()[0].payload.embeds.length, 1);

    // Immediate second call hits cooldown with ephemeral error
    const i2 = createMockInteraction('donate', 'user-1');
    await handler.handle(i2);
    assert.equal(i2.getReplies().length, 1);
    assert.equal(i2.getReplies()[0].payload.flags, MessageFlags.Ephemeral);

    now += 2500;
    const i3 = createMockInteraction('donate', 'user-1');
    await handler.handle(i3);
    assert.equal(i3.getReplies()[0].payload.flags, undefined);
  });

  it('catches command errors without crashing and replies ephemerally', async () => {
    const fakeCommandHandler = {
      get: () => ({
        execute: async () => {
          throw new Error('Boom');
        },
      }),
    };
    const silentLogger = { error() {}, warn() {} };
    const handler = new InteractionHandler({
      commandHandler: fakeCommandHandler,
      cooldowns: new CooldownManager(0),
      logger: silentLogger,
    });

    const interaction = createMockInteraction('broken', 'user-2');
    await handler.handle(interaction);
    const replies = interaction.getReplies();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].payload.flags, MessageFlags.Ephemeral);
  });

  it('deploys all enabled application commands including /autorole, /donate, /media, /social for guild and global routes', async () => {
    const expectedEnabledCount = commandStructure.commands.filter((c) => c.enabled !== false).length;
    const calls = [];
    const mockRest = {
      async put(route, opts) {
        calls.push({ route, body: opts.body });
        return opts.body.map((cmd, idx) => ({ id: String(idx + 1), ...cmd }));
      },
    };
    const silentLogger = { log() {} };

    const guildResult = await deployCommands({
      global: false,
      restClient: mockRest,
      env: { DISCORD_TOKEN: 'tok', CLIENT_ID: '123', GUILD_ID: '456' },
      logger: silentLogger,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, '/applications/123/guilds/456/commands');
    assert.equal(guildResult.length, expectedEnabledCount);
    const autoroleCmd = guildResult.find((c) => c.name === 'autorole');
    assert.ok(autoroleCmd);
    assert.deepEqual(
      autoroleCmd.options.map((o) => o.name),
      ['action', 'role'],
    );
    assert.deepEqual(
      autoroleCmd.options[0].choices.map((c) => c.value),
      ['add', 'delete', 'list'],
    );
    assert.ok(guildResult.find((c) => c.name === 'donate'));
    assert.equal(guildResult.find((c) => c.name === 'download'), undefined);
    const mediaCmd = guildResult.find((c) => c.name === 'media');
    assert.ok(mediaCmd);
    assert.deepEqual(
      mediaCmd.options.map((o) => o.name),
      ['action', 'text', 'query', 'artist', 'url'],
    );
    assert.deepEqual(
      mediaCmd.options[0].choices.map((c) => c.value),
      ['qc', 'brat', 'lyrics', 'download'],
    );
    const socialCmd = guildResult.find((c) => c.name === 'social');
    assert.ok(socialCmd);
    assert.equal(socialCmd.options[0].name, 'action');
    assert.equal(socialCmd.options[0].required, true);
    assert.equal(guildResult.find((c) => c.name === 'game'), undefined);
    assert.equal(guildResult.find((c) => c.name === 'invite'), undefined);
    assert.equal(guildResult.find((c) => c.name === 'Generate QC'), undefined);

    await deployCommands({
      global: true,
      restClient: mockRest,
      env: { DISCORD_TOKEN: 'tok', CLIENT_ID: '123' },
      logger: silentLogger,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].route, '/applications/123/commands');
    assert.equal(calls[1].body.length, expectedEnabledCount);
  });
});
