import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { COLORS } from '../../src/config/colors.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { PrefixCommandHandler } from '../../src/handlers/PrefixCommandHandler.js';
import aboutCommand, {
  ABOUT_AUTHOR_NAME,
  ABOUT_DESCRIPTION,
  ABOUT_FOOTER_TEXT,
  buildAboutEmbed,
  resolveBotAvatarUrl,
} from '../../src/prefixCommands/about.js';
import { discoverHelpEntries, buildDynamicHelpEmbed } from '../../src/services/helpService.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

function createFakeMessage({
  content = '!about',
  userId = 'user-1',
  bot = false,
  avatarUrl = 'https://cdn.discordapp.com/avatars/bot-1/avatar.png',
} = {}) {
  const replies = [];
  return {
    id: 'msg-about-1',
    content,
    author: { id: userId, bot, username: 'tester' },
    client: {
      user: {
        id: 'bot-1',
        displayAvatarURL: () => avatarUrl,
      },
    },
    guild: {
      id: 'guild-1',
      members: { me: { id: 'bot-1' } },
    },
    channel: {
      id: 'ch-1',
      isTextBased: () => true,
      permissionsFor: () =>
        new Set([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
        ]),
      async send(payload) {
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

describe('Prefix Command !about & Menu Visibility', () => {
  it('parses !about cleanly and does not register !help', () => {
    assert.deepEqual(parsePrefixInvocation('!about'), {
      commandName: 'about',
      subcommand: null,
      options: {},
    });
    assert.deepEqual(parsePrefixInvocation('?about', { prefix: '?' }), {
      commandName: 'about',
      subcommand: null,
      options: {},
    });
    assert.equal(parsePrefixInvocation('!help'), null);
  });

  it('builds minimalist Midwave embed matching exact author, description, footer, color, and no extra clutter', () => {
    const mockClient = {
      user: {
        id: 'bot-123',
        displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot-123/abc.png',
      },
    };
    const json = buildAboutEmbed({ client: mockClient }).toJSON();

    assert.equal(json.color, COLORS.PRIMARY);
    assert.equal(json.author?.name, ABOUT_AUTHOR_NAME);
    assert.equal(json.author?.icon_url, 'https://cdn.discordapp.com/avatars/bot-123/abc.png');
    assert.equal(json.description, ABOUT_DESCRIPTION);
    assert.equal(
      json.description,
      'A multifunctional Discord companion.\n\n' +
        'Midwave is a friendly and versatile Discord bot designed to bring convenience and entertainment to your server. ' +
        'From AI assistance and media downloads to social interactions, mini-games, and useful utilities, ' +
        'Midwave makes your Discord experience more enjoyable.',
    );
    assert.equal(json.footer?.text, ABOUT_FOOTER_TEXT);

    // Visual cleanliness checks
    assert.equal(json.title, undefined);
    assert.equal(json.thumbnail, undefined);
    assert.equal(json.image, undefined);
    assert.equal(json.fields, undefined);
    assert.equal(json.timestamp, undefined);
    assert.equal(/\b(uptime|latency|ram|cpu|shards?|guild\s*count|total\s*servers?|!menu|!ai|!pin)\b/i.test(JSON.stringify(json)), false);

    // Graceful fallback when client/avatar is unavailable
    assert.equal(resolveBotAvatarUrl(null), undefined);
    const noAvatarJson = buildAboutEmbed({ client: null }).toJSON();
    assert.equal(noAvatarJson.author?.name, 'Midwave');
    assert.equal(noAvatarJson.author?.icon_url, undefined);
  });

  it('executes !about via PrefixCommandHandler and shows !about under Information category in !menu', async () => {
    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();

    const handler = new PrefixCommandHandler({
      commandHandler,
      cooldowns: new CooldownManager(0),
      prefix: '!',
    });

    const msg = createFakeMessage({ content: '!about' });
    await handler.handle(msg);

    const replies = msg.getReplies();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].embeds.length, 1);
    assert.equal(replies[0].files, undefined);
    assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });

    const embedJson = replies[0].embeds[0].toJSON();
    assert.equal(embedJson.author.name, 'Midwave');
    assert.equal(embedJson.author.icon_url, 'https://cdn.discordapp.com/avatars/bot-1/avatar.png');
    assert.equal(embedJson.footer.text, 'Developed by kyymidnight');
    assert.equal(embedJson.color, COLORS.PRIMARY);

    // Bots are ignored
    const botMsg = createFakeMessage({ content: '!about', bot: true });
    await handler.handle(botMsg);
    assert.equal(botMsg.getReplies().length, 0);

    // !menu includes Information category with `about` and no `!help`
    const menuMsg = createFakeMessage({ content: '!menu' });
    await handler.handle(menuMsg);
    const menuJson = menuMsg.getReplies()[0].embeds[0].toJSON();
    const infoField = menuJson.fields.find((f) => f.name.includes('Information'));
    assert.ok(infoField, 'Expected Information category in !menu');
    assert.ok(infoField.value.includes('`about`'));

    const entries = discoverHelpEntries({ prefix: '!' });
    const builtMenu = buildDynamicHelpEmbed({ entries, prefix: '!' }).toJSON();
    assert.ok(builtMenu.fields.some((f) => f.name.includes('Information') && f.value.includes('`about`')));
    assert.equal(JSON.stringify(builtMenu).includes('`help`'), false);
    assert.equal(aboutCommand.name, 'about');
  });
});
