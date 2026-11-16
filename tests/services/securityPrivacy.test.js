import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { execute as executeAi, isAiConversationResetCommand } from '../../src/commands/ai.js';
import { AutoDownloaderHandler } from '../../src/handlers/AutoDownloaderHandler.js';
import { CommandHandler } from '../../src/handlers/CommandHandler.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { PrefixCommandHandler } from '../../src/handlers/PrefixCommandHandler.js';
import { createBotApp } from '../../src/index.js';
import {
  AiConversationManager,
  DEFAULT_AI_CONVERSATION_TTL_MS,
} from '../../src/managers/AiConversationManager.js';
import { execute as executeDownload } from '../../src/prefixCommands/download.js';
import {
  DOWNLOADER_ERROR_CODES,
  downloadMediaFromUrl,
  getDownloaderConfig,
  sanitizeLogText,
  validateMediaUrl,
} from '../../src/services/downloader.js';
import { resolveAndValidateRedirects } from '../../src/services/downloader/urlValidator.js';
import {
  clearFeedbackStateForTests,
  handleFeedbackInteraction,
  registerFeedbackPrompt,
  resolveFeedbackChannel,
  validateScreenshotUrl,
} from '../../src/services/feedbackService.js';
import { askGemini } from '../../src/services/gemini.js';
import { redactTavilySecrets } from '../../src/services/webSearch/tavilyService.js';
import { CooldownManager } from '../../src/utils/cooldown.js';

const FAKE_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
]);

function createMockChannel({
  id = '999000111222333444',
  everyoneCanView = false,
  hasEveryoneRole = true,
  hasPermissionsFor = true,
} = {}) {
  const sentMessages = [];
  const everyoneRole = hasEveryoneRole ? { id: 'guild-1' } : null;

  const channel = {
    id,
    guild: {
      id: 'guild-1',
      name: 'Midwave Test Guild',
      members: { me: { id: 'bot-1' } },
      roles: {
        everyone: everyoneRole,
        cache: new Map(everyoneRole ? [['guild-1', everyoneRole]] : []),
      },
    },
    isTextBased: () => true,
    permissionOverwrites: { cache: new Map() },
    async send(payload) {
      sentMessages.push(payload);
      return { id: `msg-${sentMessages.length}`, ...payload };
    },
    sentMessages,
  };

  if (hasPermissionsFor) {
    channel.permissionsFor = (target) => {
      if (target === channel.guild.members.me) {
        return {
          has: (perm) =>
            perm === PermissionFlagsBits.ViewChannel ||
            perm === PermissionFlagsBits.SendMessages ||
            perm === PermissionFlagsBits.EmbedLinks,
        };
      }
      if (everyoneRole && target === everyoneRole) {
        return {
          has: (perm) => (perm === PermissionFlagsBits.ViewChannel ? everyoneCanView : false),
        };
      }
      return { has: () => false };
    };
  }

  return channel;
}

function createMockFeedbackClient(channel) {
  return {
    user: { id: 'bot-1' },
    channels: {
      cache: new Map(channel ? [[channel.id, channel]] : []),
      async fetch(id) {
        if (channel && channel.id === id) return channel;
        throw new Error('Unknown Channel');
      },
    },
  };
}

describe('Security & Privacy Remediation', () => {
  afterEach(() => {
    clearFeedbackStateForTests();
  });

  it('rejects public (@everyone viewable) and unverified feedback channels strictly instead of warning', async () => {
    const publicChannel = createMockChannel({ everyoneCanView: true });
    const logs = [];
    const logger = {
      error: (...args) => logs.push(['error', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    };

    const publicRes = await resolveFeedbackChannel(createMockFeedbackClient(publicChannel), {
      env: { FEEDBACK_CHANNEL_ID: publicChannel.id },
      logger,
    });
    assert.equal(publicRes.ok, false);
    assert.equal(publicRes.reason, 'CHANNEL_NOT_PRIVATE');
    assert.match(publicRes.userMessage, /@everyone/i);
    assert.equal(logs.some(([level]) => level === 'error'), true);

    // Unverified channel (missing permissionsFor / missing @everyone role) also fails closed
    const unverifiedChannel = createMockChannel({ hasEveryoneRole: false, hasPermissionsFor: false });
    const unverifiedRes = await resolveFeedbackChannel(createMockFeedbackClient(unverifiedChannel), {
      env: { FEEDBACK_CHANNEL_ID: unverifiedChannel.id },
      logger,
    });
    assert.equal(unverifiedRes.ok, false);
    assert.equal(unverifiedRes.reason, 'CHANNEL_PRIVACY_UNVERIFIED');

    // End-to-end modal submission is blocked before writing anything to the public channel
    registerFeedbackPrompt('pub12345', { userId: 'u-rep-1', selectedCategory: 'bug' });
    const modalReplies = [];
    await handleFeedbackInteraction(
      {
        customId: 'feedback:submit:pub12345:bug',
        user: { id: 'u-rep-1', username: 'reporter', tag: 'reporter#0001' },
        guild: publicChannel.guild,
        client: createMockFeedbackClient(publicChannel),
        fields: {
          getTextInputValue(fieldId) {
            if (fieldId === 'subject') return 'Bug sensitif';
            if (fieldId === 'description') return 'Laporan rahasia yang tidak boleh masuk channel publik.';
            return '';
          },
        },
        isStringSelectMenu: () => false,
        isButton: () => false,
        isModalSubmit: () => true,
        async reply(payload) {
          modalReplies.push(payload);
        },
      },
      {
        cooldowns: new CooldownManager(60_000),
        env: { FEEDBACK_CHANNEL_ID: publicChannel.id },
        logger,
      },
    );

    assert.equal(publicChannel.sentMessages.length, 0);
    assert.equal(modalReplies.length, 1);
    assert.equal(modalReplies[0].flags, MessageFlags.Ephemeral);
    assert.match(modalReplies[0].embeds[0].data.description, /@everyone/i);
  });

  it('allows private feedback channels and rejects credential-bearing screenshot URLs', async () => {
    const credUrlCheck = validateScreenshotUrl('https://user:secretpass@example.com/proof.png');
    assert.equal(credUrlCheck.valid, false);
    assert.match(credUrlCheck.error, /username|password/i);

    const privateChannel = createMockChannel({ everyoneCanView: false });
    const resolved = await resolveFeedbackChannel(createMockFeedbackClient(privateChannel), {
      env: { FEEDBACK_CHANNEL_ID: privateChannel.id },
      logger: { error() {}, warn() {} },
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.channel, privateChannel);

    const client = createMockFeedbackClient(privateChannel);
    const commandHandler = new CommandHandler();
    await commandHandler.loadCommands();
    const cooldowns = new CooldownManager();
    const context = {
      client,
      cooldowns,
      env: { FEEDBACK_CHANNEL_ID: privateChannel.id },
      logger: { error() {}, warn() {}, log() {} },
    };
    const prefixHandler = new PrefixCommandHandler({ commandHandler, cooldowns, prefix: '!', context });

    const replies = [];
    await prefixHandler.handle({
      id: 'msg-fb-1',
      content: '!feedback',
      author: { id: 'u-priv-1', bot: false, username: 'alice' },
      guild: privateChannel.guild,
      channel: {
        id: 'ch-public-input',
        permissionsFor: () => ({ has: () => true }),
        async sendTyping() {},
      },
      client,
      async reply(payload) {
        replies.push(payload);
        return payload;
      },
    });

    assert.equal(replies.length, 1);
    assert.ok(replies[0].components?.length >= 2);
  });

  it('enforces 15-minute AI conversation TTL and proactive RAM cleanup sweeps', async () => {
    assert.equal(DEFAULT_AI_CONVERSATION_TTL_MS, 15 * 60 * 1000);

    let fakeNow = 10_000;
    const manager = new AiConversationManager({
      ttlMs: DEFAULT_AI_CONVERSATION_TTL_MS,
      cleanupIntervalMs: 15,
      nowFn: () => fakeNow,
    });

    const scope = { guildId: 'g-sec', channelId: 'c-sec', userId: 'u-sec' };
    manager.appendTurn(scope, 'Simpan konteks sebentar', 'Baik, konteks sementara aktif.');
    assert.equal(manager.getHistory(scope).length, 2);
    assert.ok(manager.cleanupTimer !== null);

    // Not yet expired at 14m59s
    fakeNow += DEFAULT_AI_CONVERSATION_TTL_MS - 1_000;
    assert.equal(manager.getHistory(scope).length, 2);

    // Crosses 15m TTL -> periodic cleanup sweep removes entry & stops timer cleanly
    fakeNow += 2_000;
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(manager.conversations.size, 0);
    assert.equal(manager.cleanupTimer, null);
    assert.deepEqual(manager.getHistory(scope), []);

    manager.clear();
  });

  it('deletes AI conversation context cleanly via manager and user reset commands without calling Gemini', async () => {
    assert.equal(isAiConversationResetCommand('reset'), true);
    assert.equal(isAiConversationResetCommand('hapus riwayat'), true);
    assert.equal(isAiConversationResetCommand('clear chat'), true);
    assert.equal(isAiConversationResetCommand('Bagaimana cara reset router?'), false);

    const app = await createBotApp({ cooldowns: new CooldownManager(0) });
    let geminiCalls = 0;
    const capturedPrompts = [];
    const context = {
      ...app.context,
      geminiOptions: {
        apiKey: 'fake-gemini-key',
        createClient: () => ({
          models: {
            generateContent: async (params) => {
              geminiCalls += 1;
              capturedPrompts.push(params.contents);
              return { text: `Jawaban #${geminiCalls}` };
            },
          },
        }),
      },
    };
    app.prefixCommandHandler.setContext(context);
    app.interactionHandler.setContext(context);

    try {
      // Turn 1 populates history
      const replyEvents = [];
      await executeAi(
        {
          commandName: 'ai',
          guildId: 'g-reset',
          channelId: 'c-reset',
          user: { id: 'u-reset', bot: false, username: 'rina' },
          isChatInputCommand: () => true,
          options: { getString: (n) => (n === 'question' ? 'Namaku Rina.' : null) },
          async deferReply() {},
          async editReply(p) {
            replyEvents.push({ type: 'editReply', payload: p });
            return p;
          },
          async reply(p) {
            replyEvents.push({ type: 'reply', payload: p });
            return p;
          },
          async followUp(p) {
            replyEvents.push({ type: 'followUp', payload: p });
            return p;
          },
        },
        context,
      );
      assert.equal(app.aiConversationManager.getStats().activeConversationsCount, 1);
      assert.equal(geminiCalls, 1);

      // User deletes conversation history via !ai hapus riwayat
      const resetEvents = [];
      await app.prefixCommandHandler.handle({
        content: '!ai hapus riwayat',
        author: { id: 'u-reset', bot: false, username: 'rina' },
        guild: { id: 'g-reset' },
        guildId: 'g-reset',
        channelId: 'c-reset',
        channel: {
          id: 'c-reset',
          permissionsFor: () => ({ has: () => true }),
          async sendTyping() {},
        },
        async reply(payload) {
          resetEvents.push(payload);
          return payload;
        },
      });

      assert.equal(geminiCalls, 1); // Reset must NOT call Gemini
      assert.equal(resetEvents.length, 1);
      assert.match(resetEvents[0].embeds[0].data.title, /Riwayat Percakapan Dihapus/i);
      assert.equal(app.aiConversationManager.getStats().activeConversationsCount, 0);

      // Next turn starts fresh with zero prior history
      await app.prefixCommandHandler.handle({
        content: '!ai Siapa namaku?',
        author: { id: 'u-reset', bot: false, username: 'rina' },
        guild: { id: 'g-reset' },
        guildId: 'g-reset',
        channelId: 'c-reset',
        channel: {
          id: 'c-reset',
          permissionsFor: () => ({ has: () => true }),
          async sendTyping() {},
        },
        async reply() {},
      });

      assert.equal(geminiCalls, 2);
      assert.doesNotMatch(capturedPrompts[1], /Riwayat percakapan terakhir/);
      assert.doesNotMatch(capturedPrompts[1], /Namaku Rina/);
    } finally {
      app.shutdown();
    }
  });

  it('rejects non-TikTok/Instagram, private IP, login-wall, and unsafe redirect URLs before calling RapidAPI', async () => {
    let rapidApiCalls = 0;
    const axiosMock = {
      async get() {
        rapidApiCalls += 1;
        return { status: 200, headers: { 'content-type': 'video/mp4' }, data: Readable.from(FAKE_MP4) };
      },
    };
    const config = getDownloaderConfig({ RAPIDAPI_KEY: 'rapid-test-secret' });

    const disallowedUrls = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://x.com/user/status/123456',
      'https://127.0.0.1/video/1',
      'http://www.tiktok.com/@user/video/1',
      'https://user:pass@www.instagram.com/reel/abc/',
      'https://www.instagram.com/accounts/login/',
    ];

    for (const url of disallowedUrls) {
      await assert.rejects(
        downloadMediaFromUrl({
          url,
          config,
          deps: { axiosClient: axiosMock, lookupFn: async () => [{ address: '93.184.216.34', family: 4 }] },
        }),
      );
    }
    assert.equal(rapidApiCalls, 0);

    // Even if a redirect chain starts on vm.tiktok.com and tries redirecting off-platform, block it before RapidAPI
    const validatedShort = validateMediaUrl('https://vm.tiktok.com/ZM6redirect/');
    await assert.rejects(
      resolveAndValidateRedirects(validatedShort, {
        lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchFn: async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://evil.example.com/payload.mp4' },
          }),
      }),
      (err) => err.code === DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM,
    );

    // AutoDownloaderHandler also skips unsupported/malicious URLs cleanly without calling downloadFn
    let autoDownloadCalls = 0;
    const autoHandler = new AutoDownloaderHandler({
      cooldowns: new CooldownManager(0),
      getConfig: () => ({ configured: true, apiKey: 'rapid-test-secret' }),
      downloadFn: async () => {
        autoDownloadCalls += 1;
        return null;
      },
    });

    const msgHandled = await autoHandler.handle({
      content: 'Cek https://youtube.com/watch?v=123 dan https://tiktok.com/login',
      author: { id: 'u-ad-1', bot: false },
      guild: { members: { me: { id: 'bot-1' } } },
      channel: { permissionsFor: () => ({ has: () => true }) },
    });
    assert.equal(msgHandled, false);
    assert.equal(autoDownloadCalls, 0);
  });

  it('prevents secret and unnecessary user URL leaks in Gemini, Tavily, and Downloader logs', async () => {
    const geminiSecret = 'AIzaSyFakeSecretValue1234567890';
    const rapidSecret = 'rapidapi_super_secret_987654';
    const tavilySecret = 'tvly-secret-token-abcdef';
    const privateShareUrl = 'https://www.instagram.com/reel/Private123/?igsh=secret_tracking_token';

    await assert.rejects(
      askGemini('Tes keamanan log', {
        apiKey: geminiSecret,
        createClient: () => ({
          models: {
            generateContent: async () => {
              const err = new Error(`Request failed with api_key=${geminiSecret} Bearer ${geminiSecret}`);
              err.status = 401;
              throw err;
            },
          },
        }),
      }),
      (err) => {
        assert.equal(String(err.debugDetail || '').includes(geminiSecret), false);
        assert.equal(err.message.includes(geminiSecret), false);
        return true;
      },
    );

    const sanitizedTavily = redactTavilySecrets(
      `Authorization: Bearer ${tavilySecret} x-key api_key=${tavilySecret}`,
    );
    assert.equal(sanitizedTavily.includes(tavilySecret), false);

    const sanitizedDl = sanitizeLogText(
      `Failed fetching ${privateShareUrl} with x-rapidapi-key=${rapidSecret} token=${geminiSecret}`,
    );
    assert.equal(sanitizedDl.includes(rapidSecret), false);
    assert.equal(sanitizedDl.includes(geminiSecret), false);
    assert.equal(sanitizedDl.includes('Private123'), false);
    assert.equal(sanitizedDl.includes('secret_tracking_token'), false);
    assert.match(sanitizedDl, /\[REDACTED_URL\]/);

    // Verify AutoDownloaderHandler error logger uses redacted log text (no secret, no user URL)
    const loggedErrors = [];
    const autoHandler = new AutoDownloaderHandler({
      cooldowns: new CooldownManager(0),
      getConfig: () => ({ configured: true, apiKey: rapidSecret }),
      logger: {
        error: (...args) => loggedErrors.push(args.join(' ')),
      },
      downloadFn: async () => {
        throw new Error(`Fetch ${privateShareUrl} failed with x-rapidapi-key=${rapidSecret}`);
      },
    });

    await autoHandler.handle({
      content: privateShareUrl,
      author: { id: 'u-log-1', bot: false },
      guild: { members: { me: { id: 'bot-1' } } },
      channel: {
        permissionsFor: () => ({ has: () => true }),
        async sendTyping() {},
      },
      async reply() {},
      async suppressEmbeds() {},
    });

    assert.equal(loggedErrors.length, 1);
    assert.equal(loggedErrors[0].includes(rapidSecret), false);
    assert.equal(loggedErrors[0].includes('Private123'), false);
    assert.equal(loggedErrors[0].includes('secret_tracking_token'), false);

    // Verify /media download command logs also sanitize secrets & URLs
    const capturedConsoleErrors = [];
    const origConsoleError = console.error;
    console.error = (...args) => capturedConsoleErrors.push(args.join(' '));
    try {
      await executeDownload(
        {
          guild: { id: 'g-1', premiumTier: 0 },
          user: { id: 'u-dl-log', bot: false },
          options: {
            getString(name) {
              if (name === 'url') return privateShareUrl;
              return null;
            },
          },
          async deferReply() {},
          async editReply() {},
          async reply() {},
        },
        {
          config: getDownloaderConfig({ RAPIDAPI_KEY: rapidSecret }),
          downloadMedia: async () => {
            throw new Error(`Upstream failed at ${privateShareUrl} token=${rapidSecret}`);
          },
        },
      );
    } finally {
      console.error = origConsoleError;
    }

    assert.equal(capturedConsoleErrors.length, 1);
    assert.equal(capturedConsoleErrors[0].includes(rapidSecret), false);
    assert.equal(capturedConsoleErrors[0].includes('Private123'), false);
    assert.equal(capturedConsoleErrors[0].includes('secret_tracking_token'), false);
  });
});
