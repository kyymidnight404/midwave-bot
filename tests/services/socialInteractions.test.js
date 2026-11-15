import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  getReactionGif,
  OtakuGifsError,
  resolveApiReaction,
  SOCIAL_INTERACTIONS,
  SOLO_SOCIAL_COMMANDS,
  TARGETED_SOCIAL_COMMANDS,
  validateGifUrl,
} from '../../src/services/otakuGifsService.js';
import socialCommand, { data as socialData } from '../../src/commands/social.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { buildSocialEmbed, createSocialCommand } from '../../src/utils/socialCommand.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { PrefixCommandHandler } from '../../src/handlers/PrefixCommandHandler.js';
import { CooldownManager } from '../../src/utils/cooldown.js';

function createMockSlashInteraction(commandName, { author, target = null } = {}) {
  const events = [];
  return {
    commandName,
    user: author ?? { id: '100000000000000001', username: 'Author', bot: false },
    options: {
      getUser: (name) => (name === 'user' ? target : null),
    },
    async deferReply(opts = {}) {
      events.push({ type: 'deferReply', payload: opts });
    },
    async reply(payload) {
      events.push({ type: 'reply', payload });
      return payload;
    },
    async editReply(payload) {
      events.push({ type: 'editReply', payload });
      return payload;
    },
    getEvents: () => events,
  };
}

function createFakeMessage({ content, author, mentionedUser = null, guild = null }) {
  const replies = [];
  const usersMap = new Map();
  if (mentionedUser) {
    usersMap.set(mentionedUser.id, mentionedUser);
  }
  return {
    id: 'msg-1',
    content,
    author,
    guild,
    guildId: guild ? 'guild-1' : null,
    channelId: 'ch-1',
    mentions: { users: usersMap },
    channel: {
      sendTyping: async () => {},
      send: async (payload) => {
        replies.push(payload);
        return payload;
      },
    },
    async reply(payload) {
      replies.push(payload);
      return payload;
    },
    getReplies: () => replies,
  };
}

describe('Social Interactions System (OtakuGIFs)', () => {
  it('maps all 11 commands to validated OtakuGIFs API reactions', () => {
    assert.equal(TARGETED_SOCIAL_COMMANDS.length, 9);
    assert.equal(SOLO_SOCIAL_COMMANDS.length, 2);

    assert.equal(resolveApiReaction('hug'), 'hug');
    assert.equal(resolveApiReaction('pat'), 'pat');
    assert.equal(resolveApiReaction('slap'), 'slap');
    assert.equal(resolveApiReaction('bonk'), 'smack');
    assert.equal(resolveApiReaction('kick'), 'punch');
    assert.equal(resolveApiReaction('poke'), 'poke');
    assert.equal(resolveApiReaction('yeet'), 'punch');
    assert.equal(resolveApiReaction('highfive'), 'brofist');
    assert.equal(resolveApiReaction('wave'), 'wave');
    assert.equal(resolveApiReaction('laugh'), 'laugh');
    assert.equal(resolveApiReaction('cry'), 'cry');

    assert.throws(() => resolveApiReaction('nonexistent'), OtakuGifsError);
    assert.throws(() => resolveApiReaction(''), OtakuGifsError);
  });

  it('fetches and validates GIF URLs from OtakuGIFs API with format=gif', async () => {
    const requestedUrls = [];
    const mockFetch = async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://cdn.otakugifs.xyz/gifs/smack/sample.gif' }),
      };
    };

    const gifUrl = await getReactionGif('bonk', { fetchFn: mockFetch });
    assert.equal(gifUrl, 'https://cdn.otakugifs.xyz/gifs/smack/sample.gif');
    assert.equal(requestedUrls[0], 'https://api.otakugifs.xyz/gif?reaction=smack&format=gif');
  });

  it('validates GIF URLs and handles API timeouts, HTTP errors, and invalid responses cleanly', async () => {
    assert.throws(() => validateGifUrl(''), /tidak mengembalikan URL/i);
    assert.throws(() => validateGifUrl(null), /tidak mengembalikan URL/i);
    assert.throws(() => validateGifUrl('javascript:alert(1)'), /tidak valid/i);
    assert.throws(() => validateGifUrl('not-a-url'), /tidak valid/i);

    await assert.rejects(
      () =>
        getReactionGif('hug', {
          fetchFn: async () => {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            throw err;
          },
        }),
      (err) => err instanceof OtakuGifsError && err.code === 'TIMEOUT',
    );

    await assert.rejects(
      () =>
        getReactionGif('hug', {
          fetchFn: async () => {
            throw new Error('ECONNREFUSED');
          },
        }),
      (err) => err instanceof OtakuGifsError && err.code === 'API_UNAVAILABLE',
    );

    await assert.rejects(
      () =>
        getReactionGif('hug', {
          fetchFn: async () => ({ ok: false, status: 404 }),
        }),
      (err) => err instanceof OtakuGifsError && err.code === 'UNKNOWN_REACTION',
    );

    await assert.rejects(
      () =>
        getReactionGif('hug', {
          fetchFn: async () => ({ ok: false, status: 503 }),
        }),
      (err) => err instanceof OtakuGifsError && err.code === 'API_HTTP_ERROR',
    );

    await assert.rejects(
      () =>
        getReactionGif('hug', {
          fetchFn: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ url: '' }),
          }),
        }),
      (err) => err instanceof OtakuGifsError && err.code === 'EMPTY_GIF_URL',
    );
  });

  it('executes all 10 slash commands with exact interaction message templates and embeds', async () => {
    const author = { id: '111111111111111111', bot: false };
    const target = { id: '222222222222222222', bot: false };

    const expectedSnippets = {
      hug: `**<@${author.id}>** gives **<@${target.id}>** a warm hug!`,
      pat: `Headpats for **<@${target.id}>** from **<@${author.id}>**~`,
      slap: `**<@${author.id}>** slaps **<@${target.id}>** across the face!`,
      bonk: `**<@${author.id}>** bonks **<@${target.id}>**! Go to jail!`,
      kick: `**<@${author.id}>** kicks **<@${target.id}>**!`,
      poke: `**<@${author.id}>** pokes **<@${target.id}>** to get their attention.`,
      yeet: `**<@${author.id}>** yeets **<@${target.id}>** into orbit!`,
      highfive: `**<@${author.id}>** gives **<@${target.id}>** an epic high-five!`,
      wave: `**<@${author.id}>** waves at **<@${target.id}>**! Hello~`,
      laugh: `**<@${author.id}>** is laughing out loud!`,
      cry: `**<@${author.id}>** is crying... someone send tissues!`,
    };

    for (const cmdName of Object.keys(SOCIAL_INTERACTIONS)) {
      const cmd = createSocialCommand(cmdName);
      const isTargeted = SOCIAL_INTERACTIONS[cmdName].requiresTarget;
      assert.equal(cmd.data.name, cmdName);
      assert.equal(cmd.data.options.length, isTargeted ? 1 : 0);

      const interaction = createMockSlashInteraction(cmdName, {
        author,
        target: isTargeted ? target : null,
      });
      const fakeGif = `https://cdn.otakugifs.xyz/gifs/${cmdName}/test.gif`;

      await cmd.execute(interaction, {
        getReactionGif: async () => fakeGif,
      });

      const events = interaction.getEvents();
      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'deferReply');
      assert.equal(events[1].type, 'editReply');

      const embedJson = events[1].payload.embeds[0].toJSON();
      assert.equal(embedJson.description, expectedSnippets[cmdName]);
      assert.equal(embedJson.image.url, fakeGif);
      assert.equal(embedJson.footer, undefined);
      assert.ok(!embedJson.description.includes(fakeGif));
    }

    // Direct buildSocialEmbed check
    const direct = buildSocialEmbed({
      message: '**<@1>** gives **<@2>** a warm hug!',
      gifUrl: 'https://cdn.otakugifs.xyz/gifs/hug/1.gif',
    }).toJSON();
    assert.equal(direct.footer, undefined);
    assert.equal(direct.image.url, 'https://cdn.otakugifs.xyz/gifs/hug/1.gif');
  });

  it('rejects missing target, bot target, self target, and API failure gracefully on slash commands', async () => {
    const author = { id: '111111111111111111', bot: false };
    const botTarget = { id: '999999999999999999', bot: true };
    const hugCmd = createSocialCommand('hug');

    // Missing target
    const missing = createMockSlashInteraction('hug', { author, target: null });
    await hugCmd.execute(missing);
    assert.equal(missing.getEvents()[0].type, 'reply');
    assert.equal(missing.getEvents()[0].payload.flags, MessageFlags.Ephemeral);

    // Bot target
    const botCase = createMockSlashInteraction('hug', { author, target: botTarget });
    await hugCmd.execute(botCase);
    assert.equal(botCase.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(botCase.getEvents()[0].payload.embeds[0].toJSON().description, /bot/i);

    // Self target
    const selfCase = createMockSlashInteraction('hug', { author, target: author });
    await hugCmd.execute(selfCase);
    assert.equal(selfCase.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(selfCase.getEvents()[0].payload.embeds[0].toJSON().description, /diri sendiri/i);

    // API failure does not send an empty GIF embed
    const target = { id: '222222222222222222', bot: false };
    const failCase = createMockSlashInteraction('hug', { author, target });
    await hugCmd.execute(failCase, {
      getReactionGif: async () => {
        throw new OtakuGifsError('API_UNAVAILABLE', 'Layanan GIF sedang tidak dapat diakses.');
      },
    });
    const failEmbed = failCase.getEvents()[1].payload.embeds[0].toJSON();
    assert.equal(failEmbed.image, undefined);
    assert.match(failEmbed.description, /tidak dapat diakses/i);
  });

  it('parses and executes all 10 prefix commands including mentions and DMs via PrefixCommandHandler', async () => {
    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();

    const cooldowns = new CooldownManager(0);
    const prefixHandler = new PrefixCommandHandler({
      commandHandler,
      cooldowns,
      prefix: '!',
      context: {
        getReactionGif: async (reaction) => `https://cdn.otakugifs.xyz/gifs/${reaction}/mock.gif`,
      },
    });

    const author = { id: '111111111111111111', bot: false };
    const target = { id: '222222222222222222', bot: false };

    // Targeted prefix commands (including DM: guild = null)
    for (const cmdName of TARGETED_SOCIAL_COMMANDS) {
      assert.deepEqual(parsePrefixInvocation(`!${cmdName} <@${target.id}>`), {
        commandName: cmdName,
        subcommand: null,
        options: { userId: target.id },
      });
      assert.deepEqual(parsePrefixInvocation(`!${cmdName} <@!${target.id}>`), {
        commandName: cmdName,
        subcommand: null,
        options: { userId: target.id },
      });

      const msg = createFakeMessage({
        content: `!${cmdName} <@${target.id}>`,
        author,
        mentionedUser: target,
        guild: null,
      });
      await prefixHandler.handle(msg);
      const embed = msg.getReplies()[0].embeds[0].toJSON();
      assert.equal(embed.image.url, `https://cdn.otakugifs.xyz/gifs/${cmdName}/mock.gif`);
      assert.equal(embed.footer, undefined);
    }

    // Solo prefix commands
    for (const cmdName of SOLO_SOCIAL_COMMANDS) {
      assert.deepEqual(parsePrefixInvocation(`!${cmdName}`), {
        commandName: cmdName,
        subcommand: null,
        options: {},
      });

      const msg = createFakeMessage({
        content: `!${cmdName}`,
        author,
        guild: null,
      });
      await prefixHandler.handle(msg);
      const embed = msg.getReplies()[0].embeds[0].toJSON();
      assert.equal(embed.image.url, `https://cdn.otakugifs.xyz/gifs/${cmdName}/mock.gif`);
    }

    // Missing target and invalid target in prefix
    const missingTargetMsg = createFakeMessage({ content: '!hug', author });
    await prefixHandler.handle(missingTargetMsg);
    assert.match(missingTargetMsg.getReplies()[0].embeds[0].toJSON().description, /mention pengguna target/i);

    const invalidTargetMsg = createFakeMessage({ content: '!slap @notvalid', author });
    await prefixHandler.handle(invalidTargetMsg);
    assert.match(invalidTargetMsg.getReplies()[0].embeds[0].toJSON().description, /mention atau ID/i);
  });

  it('executes consolidated /social slash command across all 11 actions with target validation & cooldown', async () => {
    const json = socialData.toJSON();
    assert.equal(json.name, 'social');
    assert.equal(json.options[0].name, 'action');
    assert.equal(json.options[0].required, true);
    assert.equal(json.options[0].choices.length, 11);
    assert.equal(json.options[1].name, 'user');
    assert.equal(json.options[1].required, false);

    let now = 10_000;
    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();
    assert.equal(commandHandler.get('hug'), undefined);
    assert.ok(commandHandler.get('social'));

    const handler = new InteractionHandler({
      commandHandler,
      cooldowns: new CooldownManager(3_000, () => now),
      context: {
        getReactionGif: async (reaction) => `https://cdn.otakugifs.xyz/gifs/${reaction}/consolidated.gif`,
      },
    });

    const author = { id: '111111111111111111', bot: false };
    const target = { id: '222222222222222222', bot: false };

    for (const action of TARGETED_SOCIAL_COMMANDS) {
      const events = [];
      await handler.handle({
        commandName: 'social',
        user: author,
        isChatInputCommand: () => true,
        options: {
          getSubcommand: () => null,
          getString: (name) => (name === 'action' ? action : null),
          getUser: (name) => (name === 'user' ? target : null),
        },
        async deferReply(opts = {}) {
          events.push({ type: 'deferReply', payload: opts });
        },
        async reply(payload) {
          events.push({ type: 'reply', payload });
          return payload;
        },
        async editReply(payload) {
          events.push({ type: 'editReply', payload });
          return payload;
        },
      });
      assert.equal(events[0].type, 'deferReply');
      const embed = events[1].payload.embeds[0].toJSON();
      assert.ok(embed.image.url.endsWith('/consolidated.gif'));
      assert.ok(embed.description.includes(`<@${author.id}>`));
      assert.ok(embed.description.includes(`<@${target.id}>`));
    }

    for (const action of SOLO_SOCIAL_COMMANDS) {
      const events = [];
      await handler.handle({
        commandName: 'social',
        user: author,
        isChatInputCommand: () => true,
        options: {
          getSubcommand: () => null,
          getString: (name) => (name === 'action' ? action : null),
          getUser: () => null,
        },
        async deferReply(opts = {}) {
          events.push({ type: 'deferReply', payload: opts });
        },
        async reply(payload) {
          events.push({ type: 'reply', payload });
          return payload;
        },
        async editReply(payload) {
          events.push({ type: 'editReply', payload });
          return payload;
        },
      });
      assert.equal(events[0].type, 'deferReply');
      const embed = events[1].payload.embeds[0].toJSON();
      assert.ok(embed.image.url.endsWith('/consolidated.gif'));
      assert.ok(embed.description.includes(`<@${author.id}>`));
    }

    // Immediate repeat of same action triggers SOCIAL_COOLDOWN_MS (3000 ms)
    const cooldownEvents = [];
    await handler.handle({
      commandName: 'social',
      user: author,
      isChatInputCommand: () => true,
      options: {
        getSubcommand: () => null,
        getString: (name) => (name === 'action' ? 'hug' : null),
        getUser: (name) => (name === 'user' ? target : null),
      },
      async reply(payload) {
        cooldownEvents.push({ type: 'reply', payload });
        return payload;
      },
    });
    assert.equal(cooldownEvents[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(cooldownEvents[0].payload.embeds[0].toJSON().description, /Terlalu cepat/i);

    // Targeted action without user replies ephemerally without deferring
    now += 5_000;
    const missingUserEvents = [];
    await socialCommand.execute({
      commandName: 'social',
      user: author,
      options: {
        getString: (name) => (name === 'action' ? 'bonk' : null),
        getUser: () => null,
      },
      async reply(payload) {
        missingUserEvents.push({ type: 'reply', payload });
        return payload;
      },
    });
    assert.equal(missingUserEvents[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(missingUserEvents[0].payload.embeds[0].toJSON().description, /target/i);

    // Invalid action rejects ephemerally
    const badActionEvents = [];
    await socialCommand.execute({
      commandName: 'social',
      user: author,
      options: {
        getString: (name) => (name === 'action' ? 'dance' : null),
        getUser: () => null,
      },
      async reply(payload) {
        badActionEvents.push({ type: 'reply', payload });
        return payload;
      },
    });
    assert.equal(badActionEvents[0].payload.flags, MessageFlags.Ephemeral);
  });
});
