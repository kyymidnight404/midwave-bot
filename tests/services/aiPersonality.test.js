import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  DEFAULT_GEMINI_TEMPERATURE,
  MIDWAVE_AI_SYSTEM_INSTRUCTION,
  MIDWAVE_WEB_SEARCH_SYSTEM_INSTRUCTION,
  askGemini,
  resolveGeminiTemperature,
} from '../../src/services/gemini.js';
import { askAiWithWebSearch } from '../../src/services/webSearch/index.js';
import { KnowledgeStore } from '../../src/services/knowledge/index.js';
import {
  AiConversationManager,
  DEFAULT_AI_CONVERSATION_TTL_MS,
} from '../../src/managers/AiConversationManager.js';
import { execute as executeAi, data as aiSlashData } from '../../src/commands/ai.js';
import { createBotApp } from '../../src/index.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import {
  buildWebSearchEmbed,
  collapseExcessiveNewlines,
  formatDiscordAiChunks,
} from '../../src/utils/aiFormatter.js';

const ROBOTIC_OPENERS = [
  /^\s*(halo|hai|hi there|hello)[\s!,.:]/i,
  /^\s*(tentu,?\s*dengan senang hati|baik,?\s*saya akan membantu)/i,
  /^\s*wah,?\s*pertanyaan yang (sangat )?menarik/i,
];

const ROBOTIC_CLOSERS = [
  /apakah ada hal lain yang ingin (anda |kamu )?(?:di)?tanyakan\??/i,
  /ada lagi yang (ingin|bisa) (ditanyakan|saya bantu)\??/i,
  /jangan ragu untuk bertanya kembali/i,
  /semoga informasi ini membantu[.!]?$/i,
  /jika butuh bantuan lebih lanjut,?\s*silakan hubungi/i,
];

const ROBOTIC_SECTION_LABELS = [
  /(^|\n)\s*(\*\*|__)?(catatan|kesimpulan|insight|saran tambahan|penutup)\s*:(\*\*|__)?/i,
];

/**
 * Validates behavioral style constraints on an AI response for non-greeting scenarios.
 */
function assertNaturalResponseStyle(text, { allowGreeting = false, expectEnglish = false } = {}) {
  const trimmed = String(text || '').trim();
  assert.ok(trimmed.length > 0, 'Response must not be empty');

  if (!allowGreeting) {
    for (const pattern of ROBOTIC_OPENERS) {
      assert.equal(pattern.test(trimmed), false, `Unexpected robotic opener matched ${pattern}: "${trimmed}"`);
    }
  }

  for (const pattern of ROBOTIC_CLOSERS) {
    assert.equal(pattern.test(trimmed), false, `Unexpected robotic closer matched ${pattern}: "${trimmed}"`);
  }

  for (const pattern of ROBOTIC_SECTION_LABELS) {
    assert.equal(pattern.test(trimmed), false, `Unexpected rigid label matched ${pattern}: "${trimmed}"`);
  }

  if (expectEnglish) {
    assert.equal(/\b(berikut adalah|semoga membantu|dengan senang hati)\b/i.test(trimmed), false);
  }
}

function createMockSlashInteraction({
  question = '',
  userId = 'u-pers-1',
  guildId = 'g-1',
  channelId = 'c-1',
} = {}) {
  const events = [];
  return {
    commandName: 'ai',
    user: { id: userId, bot: false },
    guildId,
    channelId,
    isChatInputCommand: () => true,
    options: {
      getString: (name) => (name === 'question' ? question : null),
    },
    async deferReply() {
      events.push({ type: 'deferReply' });
    },
    async editReply(payload) {
      events.push({ type: 'editReply', payload });
      return payload;
    },
    async followUp(payload) {
      events.push({ type: 'followUp', payload });
      return payload;
    },
    async reply(payload) {
      events.push({ type: 'reply', payload });
      return payload;
    },
    getEvents: () => events,
  };
}

function createFakePrefixMessage({
  content = '!ai tes',
  userId = 'u-pers-1',
  guildId = 'g-1',
  channelId = 'c-1',
  reference = null,
  referencedMessage = null,
  failFetchReference = false,
} = {}) {
  const replies = [];
  return {
    id: `msg-${Math.random().toString(16).slice(2)}`,
    content,
    guildId,
    channelId,
    reference,
    author: {
      id: userId,
      bot: false,
      username: 'tester',
      globalName: 'Tester',
    },
    guild: {
      id: guildId,
      members: { me: { id: 'bot-1' } },
    },
    channel: {
      id: channelId,
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
        replies.push({ type: 'send', payload });
        return payload;
      },
    },
    async fetchReference() {
      if (failFetchReference) {
        throw new Error('Unknown Message');
      }
      return referencedMessage;
    },
    async reply(payload) {
      replies.push({ type: 'reply', payload });
      return payload;
    },
    getReplies: () => replies,
  };
}

describe('Midwave AI Personality, Prompt Audit, Context Handling & Response Behavior', () => {
  it('audits system prompts: removes chatbot/stateless contradictions and preserves accuracy/knowledge guards', () => {
    assert.equal(/asisten chatbot/i.test(MIDWAVE_AI_SYSTEM_INSTRUCTION), false);
    assert.equal(/Setiap permintaan bersifat independen tanpa riwayat/i.test(MIDWAVE_AI_SYSTEM_INSTRUCTION), false);
    assert.equal(/jangan berasumsi ada konteks chat terdahulu/i.test(MIDWAVE_AI_SYSTEM_INSTRUCTION), false);

    // Core personality, greeting, conciseness, anti-template, adaptive & honesty rules
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /maximum useful information, minimum unnecessary words/i);
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /JANGAN mengawali jawaban dengan sapaan generik/i);
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /DILARANG mengakhiri jawaban dengan pertanyaan otomatis/i);
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /Catatan:|Insight:|Kesimpulan:/i);
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /Bahasa Indonesia.*Bahasa Inggris/i);
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /riwayat percakapan terakhir atau konteks pesan yang direply/i);

    // Preserved critical knowledge & link rules
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /<global_bot_knowledge>/);
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /pending_verification\/unknown/);
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /\[label\]\(URL\)/);
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /\[website\]\(https:\/\/midwave\.ai\.id\/\)/);

    // Web search prompt aligns with natural style + retains untrusted data guard
    assert.match(MIDWAVE_WEB_SEARCH_SYSTEM_INSTRUCTION, /DATA EKSTERNAL TIDAK TEPERCAYA/);
    assert.match(MIDWAVE_WEB_SEARCH_SYSTEM_INSTRUCTION, /Buat jawaban natural, ringkas, akurat/i);
    assert.match(MIDWAVE_WEB_SEARCH_SYSTEM_INSTRUCTION, /<web_search_results>/);

    // Slash command metadata reflects new natural behavior
    assert.doesNotMatch(aiSlashData.description, /chatbot|stateless/i);
    assert.match(aiSlashData.description, /ringkas|kontekstual/i);
  });

  it('configures balanced Gemini temperature cleanly via options and env with clamping', async () => {
    assert.equal(DEFAULT_GEMINI_TEMPERATURE, 0.65);

    const prevEnv = process.env.GEMINI_TEMPERATURE;
    try {
      delete process.env.GEMINI_TEMPERATURE;
      assert.equal(resolveGeminiTemperature(), 0.65);
      assert.equal(resolveGeminiTemperature(0.35), 0.35);
      assert.equal(resolveGeminiTemperature(-2), 0);
      assert.equal(resolveGeminiTemperature(5), 2);
      assert.equal(resolveGeminiTemperature('not-a-number'), 0.65);

      process.env.GEMINI_TEMPERATURE = '0.5';
      assert.equal(resolveGeminiTemperature(), 0.5);
      assert.equal(resolveGeminiTemperature(0.8), 0.8);

      process.env.GEMINI_TEMPERATURE = 'invalid';
      assert.equal(resolveGeminiTemperature(), 0.65);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.GEMINI_TEMPERATURE;
      } else {
        process.env.GEMINI_TEMPERATURE = prevEnv;
      }
    }

    const captured = [];
    await askGemini('Jelaskan rate limiting singkat.', {
      apiKey: 'fake-key',
      temperature: 0.45,
      createClient: () => ({
        models: {
          generateContent: async (params) => {
            captured.push(params);
            return { text: 'Rate limiting membatasi jumlah request per interval waktu tertentu.' };
          },
        },
      }),
    });

    assert.equal(captured[0].config.temperature, 0.45);
  });

  it('manages ephemeral RAM conversation history with scope isolation, TTL expiration, trimming, and LRU cap', () => {
    let now = 1_000_000;
    const manager = new AiConversationManager({
      ttlMs: DEFAULT_AI_CONVERSATION_TTL_MS,
      maxMessages: 6,
      maxChars: 500,
      maxConversations: 10,
      nowFn: () => now,
    });

    const scopeA = { guildId: 'g1', channelId: 'c1', userId: 'u1' };
    const scopeB = { guildId: 'g1', channelId: 'c1', userId: 'u2' };
    const scopeOtherChannel = { guildId: 'g1', channelId: 'c2', userId: 'u1' };

    manager.appendTurn(scopeA, 'Perbedaan SQLite dan MySQL?', 'SQLite berbasis file lokal, MySQL berbasis client-server.');
    manager.appendTurn(scopeA, 'Kalau untuk bot kecil?', 'SQLite sudah cukup cepat dan minim setup.');

    assert.equal(manager.getHistory(scopeA).length, 4);
    assert.deepEqual(manager.getHistory(scopeB), []);
    assert.deepEqual(manager.getHistory(scopeOtherChannel), []);

    // Trims oldest turns cleanly when exceeding maxMessages (6)
    manager.appendTurn(scopeA, 'Turn 3', 'Resp 3');
    manager.appendTurn(scopeA, 'Turn 4', 'Resp 4');
    const historyA = manager.getHistory(scopeA);
    assert.equal(historyA.length, 6);
    assert.equal(historyA[0].content, 'Kalau untuk bot kecil?');
    assert.equal(historyA.at(-1).content, 'Resp 4');

    // Idle TTL expires after 15 minutes
    now += DEFAULT_AI_CONVERSATION_TTL_MS + 1;
    assert.deepEqual(manager.getHistory(scopeA), []);

    // LRU cap evicts oldest inactive scopes beyond maxConversations (min 10)
    for (let i = 1; i <= 12; i++) {
      now += 100;
      manager.appendTurn({ guildId: 'g1', channelId: 'c1', userId: `lru-${i}` }, `Q${i}`, `A${i}`);
    }
    assert.equal(manager.getStats().activeConversationsCount, 10);
    assert.deepEqual(manager.getHistory({ guildId: 'g1', channelId: 'c1', userId: 'lru-1' }), []);
    assert.deepEqual(manager.getHistory({ guildId: 'g1', channelId: 'c1', userId: 'lru-2' }), []);
    assert.equal(manager.getHistory({ guildId: 'g1', channelId: 'c1', userId: 'lru-12' }).length, 2);

    manager.clear();
    assert.equal(manager.getStats().activeConversationsCount, 0);
  });

  it('maintains multi-turn context across /ai & !ai via createBotApp and cleans up on shutdown', async () => {
    let now = 50_000;
    const cooldowns = new CooldownManager(2_000, () => now);
    const capturedPrompts = [];

    const app = await createBotApp({ cooldowns });
    const context = {
      ...app.context,
      geminiOptions: {
        apiKey: 'fake-key',
        createClient: () => ({
          models: {
            generateContent: async (params) => {
              capturedPrompts.push(params.contents);
              if (capturedPrompts.length === 1) {
                return { text: 'MySQL cocok untuk skala server bersama, sedangkan SQLite ringan berbasis file.' };
              }
              if (capturedPrompts.length === 2) {
                return { text: 'Ekspor skema dan data SQLite ke SQL, sesuaikan tipe datanya, lalu impor ke MySQL.' };
              }
              return { text: '1. Dump skema\n2. Konversi tipe data\n3. Import ke MySQL\n4. Verifikasi row count' };
            },
          },
        }),
      },
    };
    app.prefixCommandHandler.setContext(context);
    app.interactionHandler.setContext(context);

    // Turn 1 via /ai
    const turn1 = createMockSlashInteraction({ question: 'Apa beda MySQL dan SQLite?' });
    await app.interactionHandler.handle(turn1);
    assert.match(turn1.getEvents()[1].payload.content, /MySQL cocok/);

    // Turn 2 via !ai after cooldown passes
    now += 10_000;
    const turn2 = createFakePrefixMessage({ content: '!ai Kalau begitu bagaimana cara migrasinya?' });
    await app.prefixCommandHandler.handle(turn2);
    assert.match(turn2.getReplies()[0].payload.content, /Ekspor skema/);
    assert.match(capturedPrompts[1], /Riwayat percakapan terakhir:/);
    assert.match(capturedPrompts[1], /User: Apa beda MySQL dan SQLite\?/);
    assert.match(capturedPrompts[1], /Midwave: MySQL cocok untuk skala server bersama/);
    assert.match(capturedPrompts[1], /Kalau begitu bagaimana cara migrasinya\?/);

    // Turn 3 follow-up refinement
    now += 10_000;
    const turn3 = createMockSlashInteraction({ question: 'Ringkas langkah tadi jadi checklist singkat.' });
    await app.interactionHandler.handle(turn3);
    assert.match(capturedPrompts[2], /User: Kalau begitu bagaimana cara migrasinya\?/);
    assert.match(capturedPrompts[2], /Midwave: Ekspor skema/);

    assert.equal(app.aiConversationManager.getStats().activeConversationsCount, 1);
    app.shutdown();
    assert.equal(app.aiConversationManager.getStats().activeConversationsCount, 0);
  });

  it('extracts Discord reply reference context safely for !ai and preserves history alongside web search context', async () => {
    const captured = [];
    const manager = new AiConversationManager();

    // 1. Reply-based !ai picks up referenced Discord message content safely
    const msgWithReply = createFakePrefixMessage({
      content: '!ai Kenapa ini bisa error?',
      reference: { messageId: 'ref-msg-1' },
      referencedMessage: {
        id: 'ref-msg-1',
        author: { bot: false, globalName: 'Budi', username: 'budi' },
        content: 'Error: connect ECONNREFUSED 127.0.0.1:5432 saat menjalankan migrasi.',
      },
    });
    await executeAi(
      {
        commandName: 'ai',
        user: msgWithReply.author,
        guildId: msgWithReply.guild.id,
        channelId: msgWithReply.channel.id,
        message: msgWithReply,
        isChatInputCommand: () => false,
        options: { getString: (n) => (n === 'question' ? 'Kenapa ini bisa error?' : null) },
        async deferReply() {},
        async editReply(payload) {
          return msgWithReply.reply(payload);
        },
        async reply(payload) {
          return msgWithReply.reply(payload);
        },
        async followUp(payload) {
          return msgWithReply.reply(payload);
        },
      },
      {
        aiConversationManager: manager,
        geminiOptions: {
          apiKey: 'fake-key',
          createClient: () => ({
            models: {
              generateContent: async (params) => {
                captured.push(params.contents);
                return { text: 'Port 5432 menolak koneksi karena service PostgreSQL belum berjalan.' };
              },
            },
          }),
        },
      },
    );

    assert.match(captured[0], /Pesan yang direply pengguna/);
    assert.match(captured[0], /Budi/);
    assert.match(captured[0], /ECONNREFUSED 127\.0\.0\.1:5432/);
    assert.match(captured[0], /Kenapa ini bisa error\?/);

    // 2. Web search + active conversation history must NOT discard <web_search_results>
    const webResult = await askAiWithWebSearch('Berapa harga emas Antam terbaru hari ini?', {
      userId: 'u-pers-1',
      apiKey: 'tvly-fake',
      searchTavilyFn: async () => ({
        results: [
          {
            title: 'Harga Emas Hari Ini',
            url: 'https://finance.example.com/emas',
            content: 'Harga emas Antam tercatat Rp 1.520.000 per gram.',
            publishedDate: '2026-11-14',
          },
        ],
        searchedAt: '2026-11-14T10:00:00.000Z',
      }),
      geminiOptions: {
        apiKey: 'fake-key',
        history: [{ role: 'user', content: 'Sebelumnya bahas investasi aman.' }],
        createClient: () => ({
          models: {
            generateContent: async (params) => {
              captured.push(params.contents);
              return { text: 'Berdasarkan data terkini, harga emas Antam berada di Rp 1.520.000 per gram.' };
            },
          },
        }),
      },
    });

    assert.equal(webResult.mode, 'web_search');
    assert.match(captured[1], /Sebelumnya bahas investasi aman/);
    assert.match(captured[1], /<web_search_results>/);
    assert.match(captured[1], /1\.520\.000/);

    // 3. Failed fetchReference degrades gracefully without failing !ai
    const brokenRefMsg = createFakePrefixMessage({
      content: '!ai Jelaskan REST API singkat',
      reference: { messageId: 'deleted-msg' },
      failFetchReference: true,
    });
    const fakeAdapter = {
      commandName: 'ai',
      user: brokenRefMsg.author,
      guildId: 'g-1',
      channelId: 'c-1',
      message: brokenRefMsg,
      isChatInputCommand: () => false,
      options: { getString: (n) => (n === 'question' ? 'Jelaskan REST API singkat' : null) },
      async deferReply() {},
      async editReply(payload) {
        return brokenRefMsg.reply(payload);
      },
      async reply(payload) {
        return brokenRefMsg.reply(payload);
      },
      async followUp(payload) {
        return brokenRefMsg.reply(payload);
      },
    };
    await executeAi(fakeAdapter, {
      geminiOptions: {
        apiKey: 'fake-key',
        createClient: () => ({
          models: { generateContent: async () => ({ text: 'REST API memakai method HTTP standar untuk bertukar resource.' }) },
        }),
      },
    });
    assert.match(brokenRefMsg.getReplies()[0].payload.content, /REST API memakai method HTTP standar/);
  });

  it('normalizes excessive blank lines in Discord output without altering fenced code blocks', () => {
    const raw = [
      'Penjelasan awal.',
      '',
      '',
      '   ',
      '```js',
      'function demo() {',
      '',
      '',
      '  return 1;',
      '}',
      '```',
      '',
      '',
      '',
      'Bagian penutup ringkas.',
    ].join('\n');

    const collapsed = collapseExcessiveNewlines(raw);
    assert.equal(collapsed.includes('Penjelasan awal.\n\n```js'), true);
    assert.equal(collapsed.includes('function demo() {\n\n\n  return 1;\n}'), true);
    assert.equal(collapsed.includes('```\n\nBagian penutup ringkas.'), true);

    const chunks = formatDiscordAiChunks(raw);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].includes('\n\n\nBagian'), false);

    const embed = buildWebSearchEmbed({ description: 'Ringkasan 1.\n\n\n\nRingkasan 2.' });
    assert.equal(embed.toJSON().description, 'Ringkasan 1.\n\nRingkasan 2.');
  });

  it('validates behavioral quality matrix across all 16 Section 14 scenarios and catches robotic regressions', async () => {
    // Negative regression checks: confirm validator catches typical old chatbot failures
    assert.throws(() => assertNaturalResponseStyle('Halo! Tentu, dengan senang hati saya bantu menjelaskan HTTP.'));
    assert.throws(() => assertNaturalResponseStyle('HTTP adalah protokol web. Apakah ada hal lain yang ingin ditanyakan?'));
    assert.throws(() => assertNaturalResponseStyle('HTTP adalah protokol web.\n\nCatatan: Pastikan pakai HTTPS.'));

    const kbStore = new KnowledgeStore();

    const scenarios = [
      {
        id: '1. Sapaan awal',
        question: 'Halo Midwave',
        mockReply: 'Hai, lagi ngerjain atau mau bahas apa hari ini?',
        allowGreeting: true,
        check: (text) => assert.ok(text.length <= 140),
      },
      {
        id: '2. Pertanyaan faktual sederhana',
        question: 'Apa kepanjangan HTTP?',
        mockReply: 'Hypertext Transfer Protocol — protokol komunikasi utama yang dipakai browser dan server untuk bertukar data di web.',
        check: (text) => assert.equal(text.includes('\n- '), false),
      },
      {
        id: '3. Pertanyaan lanjutan kontekstual',
        question: 'Bagaimana dengan HTTPS-nya?',
        history: [
          { role: 'user', content: 'Apa kepanjangan HTTP?' },
          { role: 'model', content: 'Hypertext Transfer Protocol.' },
        ],
        mockReply: 'HTTPS menambahkan enkripsi TLS di atas HTTP supaya traffic antara browser dan server tidak bisa disadap atau diubah di tengah jalan.',
      },
      {
        id: '4. Pertanyaan teknis (masalah, penyebab, solusi)',
        question: 'Error CORS muncul saat fetch API di frontend, kenapa?',
        mockReply: [
          'Browser memblokir response karena origin frontend dan API berbeda, sementara server belum mengirim header `Access-Control-Allow-Origin` yang mengizinkannya.',
          '',
          'Tambahkan origin frontend ke konfigurasi CORS di backend (atau gunakan dev proxy), pastikan preflight `OPTIONS` dibalas HTTP 204/200.',
        ].join('\n'),
      },
      {
        id: '5. Permintaan opini / tradeoff',
        question: 'Lebih baik pakai REST API atau GraphQL?',
        mockReply:
          'Untuk kebanyakan project baru, REST lebih praktis karena caching HTTP standar dan debugging-nya sederhana. GraphQL baru terasa sepadan saat banyak client butuh bentuk data berbeda dari satu endpoint kompleks.',
      },
      {
        id: '6. Pertanyaan ambigu',
        question: 'Bantu perbaiki kode ini dong',
        mockReply: 'Bagian kode dan pesan error-nya belum ikut terkirim—paste cuplikannya biar bisa langsung dicek.',
        check: (text) => assert.ok(text.length <= 160),
      },
      {
        id: '7. Percakapan santai',
        question: 'Capek banget ngoding bug-nya gak ketemu-ketemu',
        mockReply: 'Wajar kok, kadang setelah beberapa jam fokus malah susah lihat bug sepele. Istirahat sebentar dulu, nanti balik baca ulang stack trace-nya dengan kepala segar.',
      },
      {
        id: '8. Permintaan bahasa Inggris',
        question: 'Explain the difference between JWT and session auth concisely.',
        expectEnglish: true,
        mockReply:
          'Session auth stores state on the server and sends a session ID cookie, making instant revocation trivial. JWT embeds signed claims in the client token itself, scaling statelessly at the cost of harder immediate invalidation.',
      },
      {
        id: '9. Pertanyaan sangat spesifik membutuhkan ketepatan',
        question: 'Berapa maksimal karakter pertanyaan /ai di Midwave dan apakah ada dokumen ToS resminya?',
        mockReply:
          'Input pertanyaan `/ai` dan `!ai` dibatasi maksimal 1.500 karakter dengan cooldown 8 detik per pengguna. Untuk dokumen Terms of Service resmi lengkap, saat ini statusnya belum dipublikasikan atau diverifikasi di knowledge base Midwave.',
        verifyPayload: (contents) => {
          assert.match(contents, /<global_bot_knowledge>/);
          assert.match(contents, /1\.500 karakter/);
        },
      },
      {
        id: '10. Permintaan tutorial',
        question: 'Cara singkat cek port 3000 yang kepake di Windows PowerShell',
        mockReply: [
          '1. Cari PID proses yang memakai port 3000:',
          '```powershell',
          'Get-NetTCPConnection -LocalPort 3000 | Select-Object OwningProcess',
          '```',
          '2. Hentikan proses tersebut jika diperlukan dengan `Stop-Process -Id <PID> -Force`.',
        ].join('\n'),
      },
      {
        id: '11. Permintaan debugging',
        question: "Kenapa muncul `TypeError: Cannot read properties of undefined (reading 'map')` di React?",
        mockReply:
          "Variabel array yang di-`.map()` masih bernilai `undefined` saat render awal, biasanya sebelum data async selesai dimuat. Inisialisasi state awal dengan `[]` atau gunakan guard seperti `(items ?? []).map(...)`.",
      },
      {
        id: '12. Permintaan penulisan / revisi',
        question: 'Revisi kalimat ini agar lebih ringkas dan profesional: "Mohon maaf ya kak sistem kami lagi ada kendala teknis nih jadi harap tunggu sebentar"',
        mockReply: 'Opsi revisi: "Saat ini sistem sedang mengalami kendala teknis dan sedang kami tangani. Mohon tunggu beberapa saat."',
      },
      {
        id: '13. Pertanyaan informasi terbaru (Web Search integration)',
        question: 'Berapa harga Bitcoin hari ini?',
        useWebSearch: true,
        mockReply: 'Berdasarkan hasil pencarian terbaru, Bitcoin diperdagangkan di kisaran $91.200 per koin.',
      },
      {
        id: '14. Pertanyaan identitas Midwave (Knowledge Base integration)',
        question: 'Siapa pencipta Midwave dan mana website resminya?',
        mockReply: 'Midwave dibuat oleh Hengky T (dikenal juga sebagai KyyMidnight). Informasi lengkapnya tersedia di [website](https://midwave.ai.id/).',
        verifyPayload: (contents) => {
          assert.match(contents, /Hengky T/);
          assert.match(contents, /https:\/\/midwave\.ai\.id\//);
        },
      },
      {
        id: '15. Pertanyaan panjang beruntun (12 turns)',
        question: 'Lanjutkan poin terakhir tadi dalam 1 kalimat.',
        history: Array.from({ length: 12 }, (_, idx) => ({
          role: idx % 2 === 0 ? 'user' : 'model',
          content: `Pesan ke-${idx + 1} dalam diskusi arsitektur cache Redis.`,
        })),
        mockReply: 'Set TTL berbeda sesuai volatilitas data dan pantau hit ratio supaya eviction tidak menggerus performa.',
        verifyPayload: (contents) => {
          assert.match(contents, /Pesan ke-12/);
        },
      },
      {
        id: '16. Permintaan penjelasan ulang lebih sederhana',
        question: 'Jelaskan ulang pakai bahasa awam yang lebih singkat dong',
        history: [
          {
            role: 'user',
            content: 'Apa itu idempotency key?',
          },
          {
            role: 'model',
            content: 'Idempotency key memastikan request retry tidak mengeksekusi mutasi resource dua kali pada server.',
          },
        ],
        mockReply: 'Anggap saja seperti nomor resi unik saat transfer: kalau tombol kirim kepencet dua kali karena sinyal lemot, saldomu tetap cuma kepotong sekali.',
      },
    ];

    assert.equal(scenarios.length, 16);

    for (const s of scenarios) {
      let capturedContents = '';

      if (s.useWebSearch) {
        const res = await askAiWithWebSearch(s.question, {
          userId: 'u-scenario-13',
          apiKey: 'tvly-fake',
          knowledgeStore: kbStore,
          searchTavilyFn: async () => ({
            results: [
              {
                title: 'BTC Market Snapshot',
                url: 'https://markets.example.com/btc',
                content: 'Bitcoin trades near $91,200 today.',
                publishedDate: '2026-11-14',
              },
            ],
            searchedAt: '2026-11-14T10:00:00.000Z',
          }),
          geminiOptions: {
            apiKey: 'fake-key',
            createClient: () => ({
              models: {
                generateContent: async (params) => {
                  capturedContents = params.contents;
                  return { text: s.mockReply };
                },
              },
            }),
          },
        });
        assert.equal(res.mode, 'web_search', s.id);
        assert.match(capturedContents, /<web_search_results>/, s.id);
        assertNaturalResponseStyle(res.text);
      } else {
        const res = await askGemini(s.question, {
          apiKey: 'fake-key',
          knowledgeStore: kbStore,
          history: s.history,
          createClient: () => ({
            models: {
              generateContent: async (params) => {
                capturedContents = params.contents;
                return { text: s.mockReply };
              },
            },
          }),
        });
        if (s.verifyPayload) {
          s.verifyPayload(capturedContents);
        }
        assertNaturalResponseStyle(res.text, {
          allowGreeting: Boolean(s.allowGreeting),
          expectEnglish: Boolean(s.expectEnglish),
        });
        const chunks = formatDiscordAiChunks(res.text);
        assert.ok(chunks.length >= 1, s.id);
        if (s.check) {
          s.check(res.text);
        }
      }
    }
  });
});
