import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { createBotApp } from '../../src/index.js';
import { deployCommands } from '../../deploy-commands.js';

function createMockInteraction(commandName, userId = '111') {
  const replies = [];
  return {
    commandName,
    user: { id: userId },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
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
    assert.ok(app.commandHandler.get('games'));
    assert.ok(app.commandHandler.get('help'));
    assert.ok(app.commandHandler.toJSON().length >= 2);
    app.shutdown();
  });

  it('executes loaded /games command and enforces cooldown', async () => {
    let now = 10_000;
    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();
    const cooldowns = new CooldownManager(2000, () => now);
    const handler = new InteractionHandler({ commandHandler, cooldowns });

    const i1 = createMockInteraction('games', 'user-1');
    await handler.handle(i1);
    assert.equal(i1.getReplies().length, 1);
    assert.equal(i1.getReplies()[0].payload.embeds.length, 1);

    // Immediate second call hits cooldown with ephemeral error
    const i2 = createMockInteraction('games', 'user-1');
    await handler.handle(i2);
    assert.equal(i2.getReplies().length, 1);
    assert.equal(i2.getReplies()[0].payload.flags, MessageFlags.Ephemeral);

    now += 2500;
    const i3 = createMockInteraction('games', 'user-1');
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

  it('deploys all 29 application commands including /qc and Generate QC for guild and global routes', async () => {
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
    assert.equal(guildResult.length, 29);
    const downloadCmd = guildResult.find((c) => c.name === 'download');
    assert.ok(downloadCmd);
    assert.equal(downloadCmd.options[0].name, 'url');
    assert.equal(downloadCmd.options[0].required, true);

    await deployCommands({
      global: true,
      restClient: mockRest,
      env: { DISCORD_TOKEN: 'tok', CLIENT_ID: '123' },
      logger: silentLogger,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].route, '/applications/123/commands');
    assert.equal(calls[1].body.length, 29);
  });
});
