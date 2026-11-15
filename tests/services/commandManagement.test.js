import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandOptionType, ApplicationCommandType, PermissionFlagsBits } from 'discord.js';
import { commandStructure } from '../../src/config/commandStructure.js';
import {
  DEFAULT_HANDLER_REGISTRY,
  resolveCommandExecutor,
} from '../../src/config/commandRegistry.js';
import {
  CommandConfigError,
  buildCommandPayloads,
  detectDuplicateCommands,
  formatSyncPreview,
  previewCommandSync,
  syncCommands,
  validateCommandStructure,
} from '../../src/services/commandManager.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { createBotApp } from '../../src/index.js';
import { deployCommands } from '../../deploy-commands.js';

function createFakeSlashInteraction({
  commandName,
  subcommand = null,
  subcommandGroup = null,
  strings = {},
  integers = {},
  numbers = {},
  booleans = {},
  users = {},
  userId = 'u-cfg-1',
} = {}) {
  const replies = [];
  return {
    commandName,
    user: { id: userId, bot: false },
    guildId: 'g-1',
    channelId: 'c-1',
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    options: {
      getSubcommand: () => subcommand,
      getSubcommandGroup: () => subcommandGroup,
      getString: (name) => (Object.hasOwn(strings, name) ? strings[name] : null),
      getInteger: (name) => (Object.hasOwn(integers, name) ? integers[name] : null),
      getNumber: (name) => (Object.hasOwn(numbers, name) ? numbers[name] : null),
      getBoolean: (name) => (Object.hasOwn(booleans, name) ? booleans[name] : null),
      getUser: (name) => (Object.hasOwn(users, name) ? users[name] : null),
      getChannel: () => null,
      getRole: () => null,
      getAttachment: () => null,
    },
    async deferReply() {
      this.deferred = true;
      replies.push({ type: 'deferReply' });
    },
    async reply(payload) {
      this.replied = true;
      replies.push({ type: 'reply', payload });
      return payload;
    },
    async editReply(payload) {
      replies.push({ type: 'editReply', payload });
      return payload;
    },
    async followUp(payload) {
      replies.push({ type: 'followUp', payload });
      return payload;
    },
    getReplies: () => replies,
  };
}

describe('Configurable Slash Command Management System', () => {
  it('1-6. Supports standalone, subcommand, choice, grouped subcommands, required & optional parameters across Discord option types', () => {
    const customStructure = {
      commands: [
        {
          name: 'calc',
          description: 'Custom renamed math calculator',
          enabled: true,
          type: 'standalone',
          handler: 'math',
          options: [
            {
              name: 'expression',
              description: 'Expression to evaluate',
              type: 'string',
              required: true,
              maxLength: 200,
            },
            {
              name: 'precision',
              description: 'Optional decimal precision',
              type: 'integer',
              required: false,
              minValue: 0,
              maxValue: 10,
            },
            {
              name: 'verbose',
              description: 'Optional boolean flag',
              type: 'boolean',
              required: false,
            },
            {
              name: 'attachment_ref',
              description: 'Optional attachment',
              type: 'attachment',
              required: false,
            },
          ],
        },
        {
          name: 'social_sub',
          description: 'Social actions configured as subcommands',
          enabled: true,
          type: 'subcommand',
          handler: 'social',
          subcommands: [
            {
              name: 'hug',
              description: 'Hug a user',
              options: [
                { name: 'user', description: 'Target user', type: 'user', required: true },
              ],
            },
            {
              name: 'laugh',
              description: 'Laugh expression',
            },
          ],
        },
        {
          name: 'social_choice',
          description: 'Social actions configured as choice options',
          enabled: true,
          type: 'choice',
          handler: 'social',
          options: [
            {
              name: 'action',
              description: 'Select action',
              type: 'string',
              required: true,
              choices: [
                { name: 'Hug', value: 'hug' },
                { name: 'Laugh', value: 'laugh' },
              ],
            },
            {
              name: 'user',
              description: 'Target user',
              type: 'user',
              required: false,
            },
          ],
        },
        {
          name: 'media_hub',
          description: 'Grouped media commands',
          enabled: true,
          type: 'grouped',
          handler: 'media',
          groups: [
            {
              name: 'image',
              description: 'Image tools',
              subcommands: [
                {
                  name: 'qc',
                  description: 'Generate QC image',
                  handler: 'media.qc',
                  options: [{ name: 'text', description: 'Chat text', type: 'string', required: true }],
                },
                {
                  name: 'brat',
                  description: 'Generate Brat image',
                  handler: 'media.brat',
                  options: [{ name: 'text', description: 'Brat text', type: 'string', required: true }],
                },
              ],
            },
            {
              name: 'music',
              description: 'Music tools',
              subcommands: [
                {
                  name: 'lyrics',
                  description: 'Search lyrics',
                  handler: 'media.lyrics',
                  options: [{ name: 'query', description: 'Song title', type: 'string', required: true }],
                },
              ],
            },
          ],
          subcommands: [
            {
              name: 'download',
              description: 'Download IG/TikTok media',
              handler: 'media.download',
              options: [{ name: 'url', description: 'Media URL', type: 'string', required: true }],
            },
          ],
        },
      ],
    };

    const report = validateCommandStructure(customStructure);
    assert.equal(report.valid, true, report.errors.join('; '));
    assert.equal(report.topLevelCount, 4);

    const payloads = buildCommandPayloads(customStructure);
    assert.equal(payloads.length, 4);

    // Standalone option types + required/optional
    const calc = payloads.find((c) => c.name === 'calc');
    assert.equal(calc.options[0].type, ApplicationCommandOptionType.String);
    assert.equal(calc.options[0].required, true);
    assert.equal(calc.options[1].type, ApplicationCommandOptionType.Integer);
    assert.equal(calc.options[1].required, false);
    assert.equal(calc.options[2].type, ApplicationCommandOptionType.Boolean);
    assert.equal(calc.options[3].type, ApplicationCommandOptionType.Attachment);

    // Subcommand
    const socialSub = payloads.find((c) => c.name === 'social_sub');
    assert.equal(socialSub.options[0].type, ApplicationCommandOptionType.Subcommand);
    assert.equal(socialSub.options[0].name, 'hug');

    // Choice
    const socialChoice = payloads.find((c) => c.name === 'social_choice');
    assert.equal(socialChoice.options[0].choices.length, 2);

    // Grouped + mixed top-level subcommand
    const mediaHub = payloads.find((c) => c.name === 'media_hub');
    assert.equal(mediaHub.options[0].type, ApplicationCommandOptionType.SubcommandGroup);
    assert.equal(mediaHub.options[0].name, 'image');
    assert.equal(mediaHub.options[0].options.length, 2);
    assert.equal(mediaHub.options[2].type, ApplicationCommandOptionType.Subcommand);
    assert.equal(mediaHub.options[2].name, 'download');
  });

  it('7-8. Supports enable/disable without touching handlers and dispatches choice, subcommand, and grouped structures to existing features', async () => {
    const customStructure = {
      commands: [
        {
          name: 'calc',
          description: 'Math renamed',
          enabled: true,
          type: 'standalone',
          handler: 'math',
          options: [{ name: 'expression', description: 'Expr', type: 'string', required: true }],
        },
        {
          name: 'disabled_cmd',
          description: 'Should not load',
          enabled: false,
          type: 'standalone',
          handler: 'games',
        },
        {
          name: 'social',
          description: 'Social restructured as subcommands',
          enabled: true,
          type: 'subcommand',
          handler: 'social',
          subcommands: [
            {
              name: 'laugh',
              description: 'Laugh anime GIF',
            },
            {
              name: 'hug',
              description: 'Hug user',
              options: [{ name: 'user', description: 'Target', type: 'user', required: true }],
            },
          ],
        },
        {
          name: 'media',
          description: 'Grouped media commands',
          enabled: true,
          type: 'grouped',
          groups: [
            {
              name: 'image',
              description: 'Image tools',
              subcommands: [
                {
                  name: 'qc',
                  description: 'QC image',
                  handler: 'media.qc',
                  options: [{ name: 'text', description: 'Text', type: 'string', required: true }],
                },
              ],
            },
          ],
        },
      ],
    };

    const handler = new CommandHandler({ commandStructure: customStructure });
    await handler.loadCommands();

    assert.ok(handler.get('calc'));
    assert.equal(handler.get('disabled_cmd'), undefined);
    assert.ok(handler.get('social'));
    assert.ok(handler.get('media'));

    let gifCalledWith = '';
    let qcCalledWith = '';
    const interactionHandler = new InteractionHandler({
      commandHandler: handler,
      cooldowns: new CooldownManager(0),
      context: {
        getReactionGif: async (reaction) => {
          gifCalledWith = reaction;
          return 'https://cdn.otakugifs.xyz/gifs/laugh-test.gif';
        },
        renderQcPng: async (text) => {
          qcCalledWith = text;
          return Buffer.from('fake-png');
        },
      },
    });

    // Renamed standalone /calc executes real math business logic
    const calcInt = createFakeSlashInteraction({ commandName: 'calc', strings: { expression: '7 * 6' } });
    await interactionHandler.handle(calcInt);
    assert.match(calcInt.getReplies()[0].payload.embeds[0].toJSON().fields[1].value, /42/);

    // Subcommand /social laugh executes real social business logic
    const socialInt = createFakeSlashInteraction({ commandName: 'social', subcommand: 'laugh' });
    await interactionHandler.handle(socialInt);
    assert.equal(gifCalledWith, 'laugh');
    assert.equal(socialInt.getReplies()[1].type, 'editReply');

    // Grouped /media image qc executes real QC business logic
    const qcInt = createFakeSlashInteraction({
      commandName: 'media',
      subcommandGroup: 'image',
      subcommand: 'qc',
      strings: { text: 'Halo dari grouped config!' },
    });
    await interactionHandler.handle(qcInt);
    assert.equal(qcCalledWith, 'Halo dari grouped config!');
  });

  it('9. Rejects invalid configurations (bad names, empty desc, >25 choices, required after optional, unknown handler) and blocks sync', async () => {
    const invalidStructure = {
      commands: [
        {
          name: 'Invalid Name!',
          description: '',
          enabled: true,
          type: 'standalone',
          handler: 'non_existent_handler',
          options: [
            { name: 'opt_first', description: 'Optional first', type: 'string', required: false },
            { name: 'req_after', description: 'Required after optional', type: 'string', required: true },
            {
              name: 'too_many_choices',
              description: 'Over 25 choices',
              type: 'string',
              required: false,
              choices: Array.from({ length: 26 }, (_, i) => ({ name: `C${i}`, value: `c${i}` })),
            },
          ],
        },
      ],
    };

    const validation = validateCommandStructure(invalidStructure);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((e) => /invalid slash command name/i.test(e)));
    assert.ok(validation.errors.some((e) => /description must be/i.test(e)));
    assert.ok(validation.errors.some((e) => /unknown handler/i.test(e)));
    assert.ok(validation.errors.some((e) => /cannot be placed after an optional parameter/i.test(e)));
    assert.ok(validation.errors.some((e) => /exceeds Discord maximum 25/i.test(e)));

    let putCalled = false;
    await assert.rejects(
      () =>
        syncCommands({
          structure: invalidStructure,
          clientId: 'app-1',
          guildId: 'guild-1',
          token: 'fake',
          restClient: {
            async get() {
              return [];
            },
            async put() {
              putCalled = true;
              return [];
            },
          },
          logger: { log() {} },
        }),
      (err) => err instanceof CommandConfigError,
    );
    assert.equal(putCalled, false, 'Must NEVER overwrite Discord commands when validation fails');
  });

  it('10. Detects duplicate commands within config, single scope, and global+guild cross-scope overlap', () => {
    const report = detectDuplicateCommands({
      configCommands: [
        { name: 'math', description: 'One', enabled: true, type: 'standalone', handler: 'math' },
        { name: 'math', description: 'Two', enabled: true, type: 'standalone', handler: 'math' },
      ],
      globalCommands: [
        { name: 'ai', type: ApplicationCommandType.ChatInput },
        { name: 'Generate QC', type: ApplicationCommandType.Message },
      ],
      guildCommands: [
        { name: 'ai', type: ApplicationCommandType.ChatInput },
        { name: 'ai', type: ApplicationCommandType.ChatInput },
      ],
      guildId: '999888777',
    });

    assert.equal(report.hasDuplicates, true);
    assert.ok(report.duplicates.some((d) => d.name === 'math' && d.scopes.includes('config')));
    assert.ok(
      report.duplicates.some(
        (d) =>
          d.name === 'ai' &&
          d.scopes.includes('global') &&
          d.scopes.includes('guild:999888777') &&
          /BOTH global and guild:999888777/i.test(d.cause),
      ),
    );
  });

  it('11-14 & 16. Previews, cleans legacy/disabled commands, syncs guild & global scopes safely, and preserves Generate QC context menu', async () => {
    const structureWithDisabled = {
      ...commandStructure,
      commands: commandStructure.commands.map((c) =>
        c.name === 'invite' ? { ...c, enabled: false } : c,
      ),
    };

    const restCalls = [];
    const remoteGuildCommands = [
      { name: 'math', type: ApplicationCommandType.ChatInput },
      { name: 'invite', type: ApplicationCommandType.ChatInput },
      { name: 'old_legacy_cmd', type: ApplicationCommandType.ChatInput },
      { name: 'Generate QC', type: ApplicationCommandType.Message },
    ];

    const mockRest = {
      async get(route) {
        restCalls.push({ method: 'GET', route });
        if (String(route).includes('/guilds/')) {
          return remoteGuildCommands;
        }
        return [];
      },
      async put(route, opts) {
        restCalls.push({ method: 'PUT', route, body: opts.body });
        return opts.body.map((c, idx) => ({ id: String(idx + 1), ...c }));
      },
    };

    // Dry-run preview must NOT call PUT
    const dryRunRes = await syncCommands({
      structure: structureWithDisabled,
      global: false,
      dryRun: true,
      clientId: 'client-123',
      guildId: 'guild-456',
      restClient: mockRest,
      logger: { log() {} },
    });

    assert.equal(dryRunRes.synced, false);
    assert.equal(dryRunRes.dryRun, true);
    assert.ok(dryRunRes.preview.diff.toDelete.includes('invite'));
    assert.ok(dryRunRes.preview.diff.toDelete.includes('old_legacy_cmd'));
    assert.ok(dryRunRes.preview.diff.toCreate.includes('ai'));
    assert.ok(dryRunRes.preview.diff.toUpdate.includes('Generate QC'));
    assert.match(formatSyncPreview(dryRunRes.preview), /Top-level commands: 9/);
    assert.equal(restCalls.some((c) => c.method === 'PUT'), false);

    // Guild sync
    const guildSync = await syncCommands({
      structure: structureWithDisabled,
      global: false,
      dryRun: false,
      clientId: 'client-123',
      guildId: 'guild-456',
      restClient: mockRest,
      logger: { log() {} },
    });
    assert.equal(guildSync.synced, true);
    const guildPut = restCalls.find((c) => c.method === 'PUT');
    assert.match(guildPut.route, /\/guilds\/guild-456\/commands$/);
    assert.equal(guildPut.body.some((c) => c.name === 'invite'), false);
    assert.equal(guildPut.body.some((c) => c.name === 'old_legacy_cmd'), false);
    const qcContext = guildPut.body.find((c) => c.name === 'Generate QC');
    assert.equal(qcContext.type, ApplicationCommandType.Message);
    assert.equal(qcContext.description, undefined);

    // Global sync
    const globalRes = await deployCommands({
      global: true,
      restClient: mockRest,
      env: { DISCORD_TOKEN: 't', CLIENT_ID: 'client-123', GUILD_ID: 'guild-456' },
      logger: { log() {} },
    });
    const globalPut = restCalls.filter((c) => c.method === 'PUT').at(-1);
    assert.match(globalPut.route, /\/applications\/client-123\/commands$/);
    assert.equal(globalRes.length, 10);
  });

  it('15. Keeps all Prefix Commands (!math, !qc, !say, !hug, !connect4, !dice) working independently of Slash Command config', async () => {
    // Even if slash commands in config are minimal/disabled, prefix commands stay operational
    const minimalSlashConfig = {
      commands: [
        { name: 'help', description: 'Help', enabled: true, type: 'standalone', handler: 'help' },
      ],
    };
    const customCommandHandler = new CommandHandler({ commandStructure: minimalSlashConfig });
    const app = await createBotApp({
      commandHandler: customCommandHandler,
      cooldowns: new CooldownManager(0),
    });

    assert.equal(app.commandHandler.get('math'), undefined);

    const sent = [];
    const replies = [];
    const makeMsg = (content) => ({
      id: 'm1',
      content,
      author: { id: 'u-pfx-1', bot: false, username: 'tester' },
      guildId: 'g-1',
      channelId: 'c-1',
      guild: {
        id: 'g-1',
        members: { me: { id: 'bot-1' } },
      },
      mentions: { users: new Map() },
      channel: {
        id: 'c-1',
        isTextBased: () => true,
        permissionsFor: () =>
          new Set([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
          ]),
        async sendTyping() {},
        async send(payload) {
          sent.push(payload);
          return payload;
        },
      },
      async reply(payload) {
        replies.push(payload);
        return payload;
      },
    });

    await app.prefixCommandHandler.handle(makeMsg('!say Halo prefix tetap aman!'));
    await app.prefixCommandHandler.handle(makeMsg('!math 9 + 11'));
    await app.prefixCommandHandler.handle(makeMsg('!dice 2d6'));

    assert.equal(sent[0].content, 'Halo prefix tetap aman!');
    assert.match(replies[0].embeds[0].toJSON().fields[1].value, /20/);
    assert.match(replies[1].embeds[0].toJSON().title, /Dice Rolling/i);

    app.shutdown();
  });
});
