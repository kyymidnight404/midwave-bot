import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  SAY_COOLDOWN_MS,
  SAY_MAX_LENGTH,
  SayValidationError,
  execute as executeSay,
  validateSayMessage,
} from '../../src/prefixCommands/say.js';
import { createBotApp } from '../../src/index.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

function createMockDiscordEnv({
  channelId = 'ch-say-1',
  permissions = null,
  sendError = null,
  failReply = false,
} = {}) {
  const sentMessages = [];
  const replies = [];
  const users = new Map([
    ['u-1', { id: 'u-1', bot: false, username: 'alice', globalName: 'Alice' }],
    ['u-2', { id: 'u-2', bot: false, username: 'bob', globalName: 'Bob' }],
  ]);

  const channel = {
    id: channelId,
    isTextBased: () => true,
    permissionsFor: () =>
      permissions ??
      new Set([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ]),
    async sendTyping() {},
    async send(payload) {
      if (sendError) {
        throw sendError;
      }
      sentMessages.push(payload);
      return { id: `bot-msg-${sentMessages.length}`, ...payload };
    },
  };

  function makeMessage(content, { authorId = 'u-1', bot = false, mentions = [] } = {}) {
    const author = bot
      ? { id: 'other-bot', bot: true, username: 'otherbot' }
      : users.get(authorId) ?? { id: authorId, bot: false, username: `user-${authorId}` };
    const mentionMap = new Map(mentions.map((u) => [u.id, u]));

    return {
      id: `user-msg-${Math.random().toString(36).slice(2, 8)}`,
      content,
      author,
      guildId: 'guild-1',
      channelId,
      guild: {
        id: 'guild-1',
        members: {
          me: { id: 'bot-1' },
          async fetch(id) {
            const u = users.get(id) ?? mentionMap.get(id);
            if (!u) throw new Error('Unknown Member');
            return { id, user: u };
          },
        },
      },
      mentions: { users: mentionMap },
      channel,
      async reply(payload) {
        if (failReply) {
          throw new Error('Reply delivery failed');
        }
        replies.push(payload);
        return { id: `reply-msg-${replies.length}`, ...payload };
      },
    };
  }

  return { channel, sentMessages, replies, users, makeMessage };
}

describe('Say Prefix Command (!say) — Message Repeater', () => {
  it('1-5. Repeats plain text, emojis, Markdown, preserved internal spaces, and multiline without embeds or headers', async () => {
    const app = await createBotApp({ cooldowns: new CooldownManager(0) });
    assert.equal(app.commandHandler.get('say'), undefined, 'Must not register unnecessary /say slash command');

    const env = createMockDiscordEnv();

    // 1. Plain text + case-insensitive command parsing
    await app.prefixCommandHandler.handle(env.makeMessage('!say Hello World!'));
    await app.prefixCommandHandler.handle(env.makeMessage('!SAY Uppercase Trigger'));
    assert.equal(env.sentMessages[0].content, 'Hello World!');
    assert.equal(env.sentMessages[0].embeds, undefined);
    assert.equal(env.sentMessages[0].files, undefined);
    assert.equal(env.sentMessages[0].content.includes('Midwave says:'), false);
    assert.equal(env.sentMessages[0].content.includes('alice'), false);
    assert.equal(env.sentMessages[1].content, 'Uppercase Trigger');

    // 2. Emoji & Unicode characters
    const emojiInput = '🎉 Selamat datang di Midwave! 🌍 ❤️‍🔥 🇮🇩';
    await app.prefixCommandHandler.handle(env.makeMessage(`!say ${emojiInput}`));
    assert.equal(env.sentMessages[2].content, emojiInput);

    // 3. Discord Markdown formatting preserved cleanly
    const markdownInput = '**Important Announcement**\n*italic* __underline__ ~~strike~~ `inline` > quote';
    await app.prefixCommandHandler.handle(env.makeMessage(`!say ${markdownInput}`));
    assert.equal(env.sentMessages[3].content, markdownInput);

    // 4. Outer whitespace trimmed while spaces between words remain intact
    await app.prefixCommandHandler.handle(env.makeMessage('!say     Spasi   di   antara   kata    '));
    assert.equal(env.sentMessages[4].content, 'Spasi   di   antara   kata');

    // 5. Multiline directly after command trigger
    await app.prefixCommandHandler.handle(env.makeMessage('!say\nBaris satu\n\nBaris tiga'));
    assert.equal(env.sentMessages[5].content, 'Baris satu\n\nBaris tiga');

    // Unrelated prefix word like !saysomething must not match !say
    assert.equal(parsePrefixInvocation('!saysomething hello'), null);
    assert.equal(env.sentMessages.length, 6);

    app.shutdown();
  });

  it('6-8. Rejects empty, whitespace-only, invisible unsendable input, and >2000-char messages without truncating', async () => {
    const app = await createBotApp({ cooldowns: new CooldownManager(0) });
    const env = createMockDiscordEnv();

    // 6. Empty input (!say)
    await app.prefixCommandHandler.handle(env.makeMessage('!say'));
    assert.equal(env.sentMessages.length, 0);
    assert.equal(env.replies.length, 1);
    assert.match(env.replies[0].embeds[0].toJSON().description, /Masukkan pesan yang ingin diulang/i);

    // 7a. Whitespace-only (!say   \n\t )
    await app.prefixCommandHandler.handle(env.makeMessage('!say    \n\t   '));
    assert.equal(env.sentMessages.length, 0);
    assert.equal(env.replies.length, 2);

    // 7b. Invisible / control-only input rejected cleanly before Discord API
    await app.prefixCommandHandler.handle(env.makeMessage('!say \u200B\u200C\uFEFF'));
    assert.equal(env.sentMessages.length, 0);
    assert.equal(env.replies.length, 3);
    assert.match(env.replies[2].embeds[0].toJSON().description, /tidak dapat dikirim ke Discord/i);

    assert.throws(
      () => validateSayMessage('halo\0dunia'),
      (err) => err instanceof SayValidationError && err.code === 'INVALID_MESSAGE',
    );

    // 8a. Exact 2000-character limit succeeds intact
    const exact2000 = 'a'.repeat(SAY_MAX_LENGTH);
    await app.prefixCommandHandler.handle(env.makeMessage(`!say ${exact2000}`));
    assert.equal(env.sentMessages.length, 1);
    assert.equal(env.sentMessages[0].content, exact2000);

    // 8b. 2001 characters rejected cleanly with error and ZERO silent truncation
    const over2000 = 'b'.repeat(SAY_MAX_LENGTH + 1);
    await app.prefixCommandHandler.handle(env.makeMessage(`!say ${over2000}`));
    assert.equal(env.sentMessages.length, 1);
    assert.equal(env.replies.length, 4);
    assert.match(env.replies[3].embeds[0].toJSON().description, /2000 karakter/i);

    app.shutdown();
  });

  it('9-11. Prevents all mention pings via allowedMentions while preserving @everyone, @here, and user mentions intact', async () => {
    const app = await createBotApp({ cooldowns: new CooldownManager(0) });
    const env = createMockDiscordEnv();

    const cases = [
      '@everyone Server event dimulai!',
      '@here Ada pengumuman penting di channel ini',
      '<@123456789012345678> dan <@&987654321098765432> cek pesan ini',
    ];

    for (let i = 0; i < cases.length; i++) {
      await app.prefixCommandHandler.handle(env.makeMessage(`!say ${cases[i]}`));
      const sent = env.sentMessages[i];
      assert.equal(sent.content, cases[i], 'Must NOT alter or strip user characters');
      assert.deepEqual(sent.allowedMentions, {
        parse: [],
        users: [],
        roles: [],
        repliedUser: false,
      });
    }

    app.shutdown();
  });

  it('12. Handles Discord API send errors safely without crashing, even when reply fallback also fails', async () => {
    const logged = [];
    const silentLogger = {
      error(...args) {
        logged.push(args.map(String).join(' '));
      },
    };

    // Primary channel.send throws 50013 -> sends clean user error embed via reply
    const envPermErr = createMockDiscordEnv({
      sendError: Object.assign(new Error('Missing Permissions'), { code: 50013 }),
    });
    const msg = envPermErr.makeMessage('!say halo test error');
    await executeSay(
      {
        user: msg.author,
        message: msg,
        canEmbedLinks: true,
        options: { getString: () => 'halo test error' },
        reply: (payload) => msg.reply(payload),
      },
      { logger: silentLogger },
    );
    assert.equal(envPermErr.replies.length, 1);
    assert.match(envPermErr.replies[0].embeds[0].toJSON().description, /izin yang cukup/i);
    assert.ok(logged[0].includes('50013'));

    // Secondary reply also throws -> must swallow gracefully without unhandled rejection
    const envDoubleFail = createMockDiscordEnv({
      sendError: Object.assign(new Error('Unknown Error'), { code: 50001 }),
      failReply: true,
    });
    const msg2 = envDoubleFail.makeMessage('!say test');
    await assert.doesNotReject(() =>
      executeSay(
        {
          user: msg2.author,
          message: msg2,
          canEmbedLinks: true,
          options: { getString: () => 'test' },
          reply: (payload) => msg2.reply(payload),
        },
        { logger: silentLogger },
      ),
    );
  });

  it('13. Enforces per-user cooldown cleanly and works even in channels without EmbedLinks permission', async () => {
    let now = 100_000;
    const cooldowns = new CooldownManager(2_000, () => now);
    const app = await createBotApp({ cooldowns });
    const env = createMockDiscordEnv();

    // First !say succeeds
    await app.prefixCommandHandler.handle(env.makeMessage('!say pesan pertama', { authorId: 'u-1' }));
    assert.equal(env.sentMessages.length, 1);

    // Immediate second !say by same user within SAY_COOLDOWN_MS (3000ms) is blocked
    now += 1_500;
    await app.prefixCommandHandler.handle(env.makeMessage('!say spam cepat', { authorId: 'u-1' }));
    assert.equal(env.sentMessages.length, 1);
    assert.equal(env.replies.length, 1);
    assert.match(env.replies[0].embeds[0].toJSON().description, /Tunggu/i);

    // Different user is not blocked by u-1's cooldown
    await app.prefixCommandHandler.handle(env.makeMessage('!say pesan user lain', { authorId: 'u-2' }));
    assert.equal(env.sentMessages.length, 2);

    // After SAY_COOLDOWN_MS elapses, u-1 can send again
    now += SAY_COOLDOWN_MS;
    await app.prefixCommandHandler.handle(env.makeMessage('!say sesudah cooldown', { authorId: 'u-1' }));
    assert.equal(env.sentMessages.length, 3);
    assert.equal(env.sentMessages[2].content, 'sesudah cooldown');

    // Channel with ViewChannel + SendMessages (no EmbedLinks) still allows plain !say
    const noEmbedEnv = createMockDiscordEnv({
      channelId: 'ch-plain-only',
      permissions: new Set([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]),
    });
    now += SAY_COOLDOWN_MS + 100;
    await app.prefixCommandHandler.handle(noEmbedEnv.makeMessage('!say tanpa embed permission', { authorId: 'u-1' }));
    assert.equal(noEmbedEnv.sentMessages.length, 1);
    assert.equal(noEmbedEnv.sentMessages[0].content, 'tanpa embed permission');

    app.shutdown();
  });

  it('14. Remains fully compatible with !math, !hug, !qc, !brat, !menu, and custom prefixes', async () => {
    const app = await createBotApp({ prefix: '!', cooldowns: new CooldownManager(0) });
    const env = createMockDiscordEnv();

    // !say works alongside !math and !menu without interference
    await app.prefixCommandHandler.handle(env.makeMessage('!say Cek fitur lain:'));
    await app.prefixCommandHandler.handle(env.makeMessage('!math 9 + 11'));
    await app.prefixCommandHandler.handle(env.makeMessage('!menu'));

    assert.equal(env.sentMessages[0].content, 'Cek fitur lain:');
    assert.equal(env.replies.length, 2);
    assert.match(env.replies[0].embeds[0].toJSON().fields[1].value, /20/);
    assert.equal(env.replies[1].embeds[0].toJSON().title, 'MIDWAVE — COMMAND GUIDE');

    // Verify existing prefix parsers are unaffected
    assert.deepEqual(parsePrefixInvocation('!math 9 + 11'), {
      commandName: 'math',
      subcommand: null,
      options: { expression: '9 + 11' },
    });
    assert.deepEqual(parsePrefixInvocation('!hug <@123456789012345678>'), {
      commandName: 'hug',
      subcommand: null,
      options: { userId: '123456789012345678' },
    });
    assert.deepEqual(parsePrefixInvocation('!qc halo'), {
      commandName: 'qc',
      subcommand: null,
      options: { text: 'halo' },
    });

    // Custom prefix ?say works too
    assert.deepEqual(parsePrefixInvocation('?say custom prefix', { prefix: '?' }), {
      commandName: 'say',
      subcommand: null,
      options: { text: 'custom prefix' },
    });

    app.shutdown();
  });
});
