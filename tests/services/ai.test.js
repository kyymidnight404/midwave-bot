import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  AI_COOLDOWN_MS,
  AI_MAX_QUESTION_LENGTH,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TEMPERATURE,
  MIDWAVE_AI_SYSTEM_INSTRUCTION,
  askGemini,
  countUnicodeChars,
  trimConversationHistory,
  validateAiQuestion,
} from '../../src/services/gemini.js';
import { askAiWithWebSearch } from '../../src/services/webSearch/index.js';
import {
  DISCORD_MAX_MESSAGE_LENGTH,
  formatDiscordAiChunks,
  sanitizeAiMentions,
} from '../../src/utils/aiFormatter.js';
import aiCommand, { data as aiData, execute as executeAi } from '../../src/commands/ai.js';
import { createBotApp } from '../../src/index.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

function createMockSlashInteraction({ question = '', userId = 'u-ai-1', bot = false, failEdit = false } = {}) {
  const events = [];
  return {
    commandName: 'ai',
    user: { id: userId, bot },
    guildId: 'guild-1',
    channelId: 'ch-1',
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => null,
      getString: (name) => (name === 'question' ? question : null),
    },
    async deferReply(opts = {}) {
      this.deferred = true;
      events.push({ type: 'deferReply', payload: opts });
    },
    async reply(payload) {
      this.replied = true;
      events.push({ type: 'reply', payload });
      return payload;
    },
    async editReply(payload) {
      if (failEdit && payload.content) {
        throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      }
      events.push({ type: 'editReply', payload });
      return payload;
    },
    async followUp(payload) {
      events.push({ type: 'followUp', payload });
      return payload;
    },
    getEvents: () => events,
  };
}

function createFakePrefixMessage({
  content = '!ai Apa itu JavaScript?',
  userId = 'u-ai-1',
  bot = false,
} = {}) {
  const replies = [];
  let typingCalls = 0;

  return {
    id: 'msg-ai-1',
    content,
    author: {
      id: userId,
      bot,
      username: 'tester',
      globalName: 'Tester',
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
      async sendTyping() {
        typingCalls++;
      },
      async send(payload) {
        replies.push({ type: 'send', payload });
        return payload;
      },
    },
    async reply(payload) {
      replies.push({ type: 'reply', payload });
      return {
        async edit(editPayload) {
          replies.push({ type: 'edit', payload: editPayload });
          return editPayload;
        },
      };
    },
    getReplies: () => replies,
    getTypingCalls: () => typingCalls,
  };
}

describe('Midwave AI (Gemini) service, formatter, /ai, and !ai', () => {
  it('validates question length and rejects empty or oversized input', () => {
    assert.throws(() => validateAiQuestion(''), /tidak boleh kosong/i);
    assert.throws(() => validateAiQuestion('   \n\t  '), /tidak boleh kosong/i);
    assert.throws(() => validateAiQuestion(null), /wajib diisi/i);

    const exact = 'a'.repeat(AI_MAX_QUESTION_LENGTH);
    assert.equal(validateAiQuestion(`  ${exact}  `), exact);

    const tooLong = 'a'.repeat(AI_MAX_QUESTION_LENGTH + 1);
    assert.throws(() => validateAiQuestion(tooLong), /terlalu panjang/i);
  });

  it('calls mocked Gemini SDK statelessly without storing conversation history', async () => {
    const capturedCalls = [];
    const mockCreateClient = (apiKey) => ({
      models: {
        generateContent: async (params) => {
          capturedCalls.push({ apiKey, params });
          return { text: `Jawaban untuk: ${params.contents}` };
        },
      },
    });

    const first = await askGemini('Apa itu JavaScript?', {
      apiKey: 'fake-key-123',
      model: 'gemini-2.5-flash',
      createClient: mockCreateClient,
    });
    const second = await askGemini('Apa itu Python?', {
      apiKey: 'fake-key-123',
      createClient: mockCreateClient,
    });

    assert.equal(first.text, 'Jawaban untuk: Apa itu JavaScript?');
    assert.equal(second.text, 'Jawaban untuk: Apa itu Python?');
    assert.equal(capturedCalls.length, 2);

    // Every request must be completely independent (single string prompt, no history array).
    assert.equal(capturedCalls[0].params.model, 'gemini-2.5-flash');
    assert.equal(capturedCalls[0].params.contents, 'Apa itu JavaScript?');
    assert.equal(capturedCalls[1].params.contents, 'Apa itu Python?');
    assert.equal(capturedCalls[0].params.config.systemInstruction, MIDWAVE_AI_SYSTEM_INSTRUCTION);
    assert.equal(capturedCalls[0].params.config.temperature, DEFAULT_GEMINI_TEMPERATURE);
    assert.ok(capturedCalls[0].params.config.abortSignal instanceof AbortSignal);
    assert.equal(second.model, process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL);
  });

  it('handles missing API key, invalid key, rate limit, quota, timeout, unavailable model, and empty response without leaking secrets', async () => {
    const prevKey = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      await assert.rejects(
        () => askGemini('halo', { apiKey: '' }),
        (err) => err.code === 'MISSING_API_KEY' && /GEMINI_API_KEY/i.test(err.message),
      );
    } finally {
      if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
    }

    const secretToken = 'AIzaSy_SUPER_SECRET_SHOULD_NOT_LEAK';

    await assert.rejects(
      () =>
        askGemini('tes', {
          apiKey: secretToken,
          createClient: () => ({
            models: {
              generateContent: async () => {
                throw Object.assign(new Error(`API key not valid: ${secretToken}`), { status: 403 });
              },
            },
          }),
        }),
      (err) =>
        err.code === 'INVALID_API_KEY' &&
        !err.message.includes(secretToken) &&
        !String(err.debugDetail || '').includes(secretToken) &&
        /Autentikasi Gemini AI gagal/i.test(err.message),
    );

    await assert.rejects(
      () =>
        askGemini('tes', {
          apiKey: secretToken,
          createClient: () => ({
            models: {
              generateContent: async () => {
                throw Object.assign(new Error('This model is currently unavailable'), { status: 503 });
              },
            },
          }),
        }),
      (err) => err.code === 'SERVICE_UNAVAILABLE' && /status=503/.test(err.debugDetail || ''),
    );

    await assert.rejects(
      () =>
        askGemini('tes', {
          apiKey: secretToken,
          createClient: () => ({
            models: {
              generateContent: async () => {
                throw Object.assign(new Error('Too many requests rate limit'), { status: 429 });
              },
            },
          }),
        }),
      (err) => err.code === 'RATE_LIMITED',
    );

    await assert.rejects(
      () =>
        askGemini('tes', {
          apiKey: secretToken,
          createClient: () => ({
            models: {
              generateContent: async () => {
                throw Object.assign(new Error('You exceeded your current quota for free_tier'), { status: 429 });
              },
            },
          }),
        }),
      (err) => err.code === 'QUOTA_EXCEEDED',
    );

    await assert.rejects(
      () =>
        askGemini('tes', {
          apiKey: secretToken,
          createClient: () => ({
            models: {
              generateContent: async () => {
                const abortErr = new Error('The operation was aborted due to timeout');
                abortErr.name = 'TimeoutError';
                throw abortErr;
              },
            },
          }),
        }),
      (err) => err.code === 'TIMEOUT',
    );

    await assert.rejects(
      () =>
        askGemini('tes', {
          apiKey: secretToken,
          createClient: () => ({
            models: {
              generateContent: async () => {
                throw Object.assign(new Error('models/old-model is not found'), { status: 404 });
              },
            },
          }),
        }),
      (err) => err.code === 'MODEL_UNAVAILABLE',
    );

    await assert.rejects(
      () =>
        askGemini('tes', {
          apiKey: secretToken,
          createClient: () => ({
            models: {
              generateContent: async () => ({ text: '   \n  ' }),
            },
          }),
        }),
      (err) => err.code === 'EMPTY_RESPONSE',
    );
  });

  it('sanitizes @everyone/@here and splits >2000-char responses without breaking fenced code blocks', () => {
    const clean = sanitizeAiMentions('Halo @everyone dan @HERE!');
    assert.equal(clean.includes('@everyone'), false);
    assert.equal(clean.includes('@HERE'), false);

    const codeBody = 'const x = 123;\n'.repeat(160);
    const longMarkdown = `Berikut contoh kodenya:\n\`\`\`js\n${codeBody}\`\`\`\nSelesai @everyone.`;
    const chunks = formatDiscordAiChunks(longMarkdown);

    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0 && chunk.length <= DISCORD_MAX_MESSAGE_LENGTH);
      assert.equal(chunk.includes('@everyone'), false);
      // Every chunk must have an even number of ``` fences so Markdown stays balanced.
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      assert.equal(fenceCount % 2, 0, 'Code fence must be balanced within each chunk');
    }
    assert.deepEqual(formatDiscordAiChunks('   '), []);
  });

  it('parses !ai preserving multi-space questions and rejects empty !ai', () => {
    assert.deepEqual(parsePrefixInvocation('!ai Jelaskan   perbedaan   HTML, CSS, dan JavaScript'), {
      commandName: 'ai',
      subcommand: null,
      options: { question: 'Jelaskan   perbedaan   HTML, CSS, dan JavaScript' },
    });

    const emptyParsed = parsePrefixInvocation('!ai   ');
    assert.equal(emptyParsed.commandName, 'ai');
    assert.match(emptyParsed.error, /Pertanyaan wajib diisi/i);
  });

  it('registers /ai command and executes slash /ai with chunking and error handling', async () => {
    const app = await createBotApp();
    const aiCmd = app.commandHandler.toJSON().find((c) => c.name === 'ai');
    assert.ok(aiCmd, '/ai must be registered');
    assert.equal(aiData.name, 'ai');
    assert.equal(aiCmd.options[0].name, 'question');
    assert.equal(aiCmd.options[0].required, true);
    assert.equal(aiCmd.options[0].max_length, AI_MAX_QUESTION_LENGTH);
    app.shutdown();

    // Multi-chunk slash response (>2000 chars)
    const longAnswer = `${'Paragraf panjang. '.repeat(130)}@everyone`;
    const slashInt = createMockSlashInteraction({ question: 'Jelaskan JS panjang' });
    await executeAi(slashInt, {
      askGemini: async () => ({ text: longAnswer, model: 'gemini-2.5-flash' }),
    });

    const events = slashInt.getEvents();
    assert.equal(events[0].type, 'deferReply');
    assert.equal(events[1].type, 'editReply');
    assert.ok(events.some((e) => e.type === 'followUp'));
    assert.deepEqual(events[1].payload.allowedMentions, { parse: [], repliedUser: false });
    for (const ev of events.slice(1)) {
      assert.ok(ev.payload.content.length <= DISCORD_MAX_MESSAGE_LENGTH);
      assert.equal(ev.payload.content.includes('@everyone'), false);
    }

    // Empty whitespace question replies ephemerally
    const emptySlash = createMockSlashInteraction({ question: '   ' });
    await executeAi(emptySlash);
    assert.equal(emptySlash.getEvents()[0].type, 'reply');
    assert.equal(emptySlash.getEvents()[0].payload.flags, MessageFlags.Ephemeral);

    // Discord send failure does not crash
    const failDeliverySlash = createMockSlashInteraction({ question: 'tes', failEdit: true });
    await executeAi(failDeliverySlash, {
      askGemini: async () => ({ text: 'Jawaban oke', model: 'gemini-2.5-flash' }),
    });
    assert.equal(failDeliverySlash.getEvents()[0].type, 'deferReply');
  });

  it('executes !ai via PrefixCommandHandler, enforces dedicated AI cooldown across /ai and !ai, and leaves other commands unaffected', async () => {
    let now = 10_000;
    const cooldowns = new CooldownManager(2_000, () => now);
    const app = await createBotApp({ cooldowns });
    const intents = app.client.options.intents;
    assert.ok(intents.has(GatewayIntentBits.MessageContent));

    let callCount = 0;
    const contextWithMockAi = {
      ...app.context,
      askGemini: async (q) => {
        callCount++;
        return { text: `AI: ${q}`, model: 'gemini-2.5-flash' };
      },
    };
    app.prefixCommandHandler.setContext(contextWithMockAi);
    app.interactionHandler.setContext(contextWithMockAi);

    // Bot message must be ignored
    const botMsg = createFakePrefixMessage({ content: '!ai halo', bot: true });
    await app.prefixCommandHandler.handle(botMsg);
    assert.equal(callCount, 0);
    assert.equal(botMsg.getReplies().length, 0);

    // Valid !ai message triggers typing indicator and replies
    const msg1 = createFakePrefixMessage({
      content: '!ai Jelaskan   perbedaan   HTML, CSS, dan JS',
      userId: 'u-cool-ai',
    });
    await app.prefixCommandHandler.handle(msg1);
    assert.equal(msg1.getTypingCalls(), 1);
    assert.equal(callCount, 1);
    assert.equal(msg1.getReplies()[0].payload.content, 'AI: Jelaskan   perbedaan   HTML, CSS, dan JS');

    // Within AI_COOLDOWN_MS (e.g. +3s > default 2s, but < 8s AI cooldown), /ai must be blocked
    now += 3_000;
    const slashBlocked = createMockSlashInteraction({ question: 'tes lagi', userId: 'u-cool-ai' });
    await app.interactionHandler.handle(slashBlocked);
    assert.equal(callCount, 1);
    assert.equal(slashBlocked.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(slashBlocked.getEvents()[0].payload.embeds[0].toJSON().description, /Tunggu/i);

    // Other commands like !menu are NOT blocked by AI cooldown
    const menuMsg = createFakePrefixMessage({ content: '!menu', userId: 'u-cool-ai' });
    await app.prefixCommandHandler.handle(menuMsg);
    assert.equal(menuMsg.getReplies()[0].payload.embeds[0].toJSON().title, 'MIDWAVE — COMMAND GUIDE');

    // After AI_COOLDOWN_MS elapses, /ai succeeds again
    now += AI_COOLDOWN_MS;
    const slashAllowed = createMockSlashInteraction({ question: 'sesudah cooldown', userId: 'u-cool-ai' });
    await app.interactionHandler.handle(slashAllowed);
    assert.equal(callCount, 2);
    assert.equal(slashAllowed.getEvents()[1].payload.content, 'AI: sesudah cooldown');

    app.shutdown();
  });

  it('validates 100, 1499, 1500, 1501 chars and counts surrogate-pair emojis consistently', () => {
    assert.equal(validateAiQuestion('a'.repeat(100)).length, 100);
    assert.equal(validateAiQuestion('a'.repeat(1499)).length, 1499);
    assert.equal(validateAiQuestion('a'.repeat(1500)).length, 1500);
    assert.throws(
      () => validateAiQuestion('a'.repeat(1501)),
      (err) => err.code === 'QUESTION_TOO_LONG' && /maksimal 1500 karakter/i.test(err.message),
    );

    const emojis1500 = '😀'.repeat(1500);
    assert.equal(countUnicodeChars(emojis1500), 1500);
    assert.equal(validateAiQuestion(emojis1500), emojis1500);

    const emojis1501 = '😀'.repeat(1501);
    assert.throws(
      () => validateAiQuestion(emojis1501),
      (err) => err.code === 'QUESTION_TOO_LONG',
    );
  });

  it('does not reject short user messages when system prompt, history, or search context are long', async () => {
    const captured = [];
    const mockCreateClient = () => ({
      models: {
        generateContent: async (params) => {
          captured.push(params);
          return { text: 'Ringkasan peristiwa 12/11/2026 di Indonesia.' };
        },
      },
    });

    const shortQuestion = 'apakah bisa mengetahui apa saja yang terjadi di indonesia pada tanggal 12/11/2026';
    const longSystemPrompt = 'Instruksi sistem panjang. '.repeat(250);
    const longHistory = Array.from({ length: 20 }, (_, idx) => ({
      role: idx % 2 === 0 ? 'user' : 'model',
      content: `Pesan history ke-${idx + 1}: ${'konteks '.repeat(120)}`,
    }));

    const trimmed = trimConversationHistory(longHistory, { maxMessages: 10, maxChars: 2000 });
    assert.ok(trimmed.length <= 10);
    assert.ok(trimmed.some((m) => m.content.includes('Pesan history ke-20')));

    // Long system prompt + long conversation history + short latest user question
    const historyRes = await askGemini(shortQuestion, {
      apiKey: 'fake-key-123',
      systemInstruction: longSystemPrompt,
      history: longHistory,
      createClient: mockCreateClient,
    });
    assert.equal(historyRes.text, 'Ringkasan peristiwa 12/11/2026 di Indonesia.');
    assert.equal(captured[0].config.systemInstruction, longSystemPrompt);
    assert.ok(captured[0].contents.includes(shortQuestion));
    assert.ok(captured[0].contents.includes('Pesan history ke-20'));

    // Long web search context passed through askAiWithWebSearch -> real askGemini
    const searchRes = await askAiWithWebSearch(shortQuestion, {
      userId: 'u-limit-fix',
      apiKey: 'tvly-test-key',
      searchTavilyFn: async () => ({
        results: [
          {
            title: 'Berita Indonesia 12 November 2026',
            url: 'https://news.example.com/id-12-11-2026',
            content: 'Ringkasan berita panjang. '.repeat(90),
            publishedDate: '2026-11-12',
          },
          {
            title: 'Laporan Ekonomi 12 November 2026',
            url: 'https://finance.example.com/id-12-11-2026',
            content: 'Laporan ekonomi harian. '.repeat(90),
            publishedDate: '2026-11-12',
          },
        ],
        searchedAt: '2026-11-14T03:00:00.000Z',
      }),
      geminiOptions: {
        apiKey: 'fake-key-123',
        createClient: mockCreateClient,
      },
    });

    assert.equal(searchRes.mode, 'web_search');
    assert.equal(searchRes.text, 'Ringkasan peristiwa 12/11/2026 di Indonesia.');
    assert.ok(captured[1].contents.length > 1500);
    assert.ok(captured[1].contents.includes(shortQuestion));
  });

  it('distinguishes PAYLOAD_TOO_LARGE from QUESTION_TOO_LONG and other Gemini errors', async () => {
    await assert.rejects(
      () =>
        askGemini('pertanyaan pendek', {
          apiKey: 'fake-key-123',
          contextText: 'x'.repeat(2000),
          maxPayloadChars: 1000,
          createClient: () => ({
            models: { generateContent: async () => ({ text: 'ok' }) },
          }),
        }),
      (err) => err.code === 'PAYLOAD_TOO_LARGE' && !/Pertanyaan terlalu panjang/i.test(err.message),
    );

    await assert.rejects(
      () =>
        askGemini('pertanyaan pendek', {
          apiKey: 'fake-key-123',
          createClient: () => ({
            models: {
              generateContent: async () => {
                throw Object.assign(new Error('Request payload size exceeds limit'), { status: 413 });
              },
            },
          }),
        }),
      (err) => err.code === 'PAYLOAD_TOO_LARGE' && !/Pertanyaan terlalu panjang/i.test(err.message),
    );
  });
});
