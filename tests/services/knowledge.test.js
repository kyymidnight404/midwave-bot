import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  DEFAULT_KNOWLEDGE_FILE_PATH,
  KNOWLEDGE_CATEGORIES,
  KnowledgeServiceError,
  KnowledgeStore,
  defaultKnowledgeStore,
  formatKnowledgeContext,
  isAuthorizedKnowledgeAdmin,
  retrieveRelevantKnowledge,
} from '../../src/services/knowledge/index.js';
import { MIDWAVE_AI_SYSTEM_INSTRUCTION, askGemini } from '../../src/services/gemini.js';
import { execute as executeKnowledge } from '../../src/commands/knowledge.js';

function createTempKnowledgeFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midwave-kb-'));
  const filePath = path.join(dir, 'botKnowledge.json');
  fs.copyFileSync(DEFAULT_KNOWLEDGE_FILE_PATH, filePath);
  return {
    dir,
    filePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function createMockKnowledgeInteraction({
  subcommand,
  userId = '999999999999999999',
  username = 'KyyMidnight',
  options = {},
} = {}) {
  const replies = [];
  return {
    commandName: 'knowledge',
    user: { id: userId, username, bot: false },
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => (Object.hasOwn(options, name) ? options[name] : null),
    },
    async reply(payload) {
      replies.push(payload);
      return payload;
    },
    getReplies: () => replies,
  };
}

describe('Midwave Global Bot Knowledge Memory System', () => {
  it('1 & 2. Knowledge tersimpan secara persisten dan tetap ada setelah restart', () => {
    const tmp = createTempKnowledgeFile();
    try {
      const store1 = new KnowledgeStore({ filePath: tmp.filePath });
      const adminId = '111222333444555666';

      store1.addEntry(
        {
          id: 'test-release-note',
          category: 'technical_knowledge',
          title: 'Catatan Rilis Uji',
          content: 'Midwave mendukung Global Bot Knowledge persisten.',
          tags: ['rilis', 'persisten'],
        },
        { actorUserId: adminId, authorizedUserIds: [adminId] },
      );

      // Simulate full bot restart with a brand new KnowledgeStore instance
      const store2 = new KnowledgeStore({ filePath: tmp.filePath });
      const found = store2.search('persisten');
      assert.ok(found.some((e) => e.id === 'test-release-note'));
    } finally {
      tmp.cleanup();
    }
  });

  it('3. Retrieval kategori berjalan akurat dan tidak membebani pertanyaan non-Midwave', () => {
    const creatorEntries = retrieveRelevantKnowledge('Siapa pembuat Midwave dan apa GitHub-nya?');
    assert.ok(creatorEntries.length > 0);
    assert.ok(creatorEntries.some((e) => e.category === 'creator_developer'));

    const linkEntries = retrieveRelevantKnowledge('Apa website resmi Midwave?');
    assert.ok(linkEntries.some((e) => e.content.includes('https://midwave.ai.id/')));

    const unrelated = retrieveRelevantKnowledge('Jelaskan cara kerja async await di JavaScript');
    assert.deepEqual(unrelated, []);
  });

  it('4 & 5. Gemini menerima knowledge relevan dan diarahkan untuk tidak mengarang info yang tidak tersedia', async () => {
    const captured = [];
    const mockCreateClient = () => ({
      models: {
        generateContent: async (params) => {
          captured.push(params);
          return { text: 'Midwave dibuat oleh KyyMidnight (GitHub: kyymidnight404).' };
        },
      },
    });

    const res = await askGemini('Siapa creator Midwave dan apa website resminya?', {
      apiKey: 'fake-key',
      createClient: mockCreateClient,
    });

    assert.match(res.text, /KyyMidnight/);
    assert.equal(captured.length, 1);
    assert.match(captured[0].contents, /<global_bot_knowledge>/);
    assert.match(captured[0].contents, /KyyMidnight/);
    assert.match(captured[0].contents, /https:\/\/midwave\.ai\.id\//);
    assert.match(MIDWAVE_AI_SYSTEM_INSTRUCTION, /pending_verification\/unknown/);

    // Verify non-existent query in knowledge store returns empty without fabricating
    const missing = defaultKnowledgeStore.search('fitur_fiktif_yang_tidak_pernah_ada_xyz');
    assert.deepEqual(missing, []);

    const formatted = formatKnowledgeContext(defaultKnowledgeStore.search('privacy policy'));
    assert.match(formatted, /pending_verification|Privacy/i);
  });

  it('6. Update dan delete bekerja secara persisten', () => {
    const tmp = createTempKnowledgeFile();
    try {
      const adminId = '111222333444555666';
      const auth = { actorUserId: adminId, authorizedUserIds: [adminId] };
      const store1 = new KnowledgeStore({ filePath: tmp.filePath });

      store1.addEntry(
        {
          id: 'temp-feature',
          category: 'features_commands',
          title: 'Fitur Sementara',
          content: 'Versi awal.',
          tags: ['sementara'],
        },
        auth,
      );

      store1.updateEntry(
        'temp-feature',
        { content: 'Versi diperbarui.', verificationStatus: 'pending_verification' },
        auth,
      );

      const storeAfterUpdate = new KnowledgeStore({ filePath: tmp.filePath });
      const updated = storeAfterUpdate.search('temp-feature')[0];
      assert.equal(updated.content, 'Versi diperbarui.');
      assert.equal(updated.verificationStatus, 'pending_verification');

      storeAfterUpdate.deleteEntry('temp-feature', auth);
      const storeAfterDelete = new KnowledgeStore({ filePath: tmp.filePath });
      assert.equal(storeAfterDelete.search('temp-feature').length, 0);
    } finally {
      tmp.cleanup();
    }
  });

  it('7 & 8. Hanya creator/admin terotorisasi berdasarkan Discord User ID yang dapat mengubah knowledge', async () => {
    const tmp = createTempKnowledgeFile();
    try {
      const adminId = '111222333444555666';
      const regularUserId = '777888999000111222';
      const store = new KnowledgeStore({ filePath: tmp.filePath });

      // Username spoofing must NOT grant access
      assert.equal(
        isAuthorizedKnowledgeAdmin(regularUserId, { authorizedUserIds: [adminId] }),
        false,
      );
      assert.equal(
        isAuthorizedKnowledgeAdmin('KyyMidnight', { authorizedUserIds: [adminId] }),
        false,
      );
      assert.equal(
        isAuthorizedKnowledgeAdmin(adminId, { authorizedUserIds: [adminId] }),
        true,
      );

      // Regular user attempting /knowledge add must be rejected ephemerally
      const unauthInteraction = createMockKnowledgeInteraction({
        subcommand: 'add',
        userId: regularUserId,
        username: 'KyyMidnight',
        options: {
          id: 'hack-entry',
          category: 'bot_identity',
          title: 'Hack',
          content: 'Unauthorized',
        },
      });
      await executeKnowledge(unauthInteraction, {
        knowledgeStore: store,
        authorizedUserIds: [adminId],
      });
      const unauthReply = unauthInteraction.getReplies()[0];
      assert.equal(unauthReply.flags, MessageFlags.Ephemeral);
      assert.match(unauthReply.embeds[0].toJSON().description, /Akses ditolak/i);
      assert.equal(store.search('hack-entry').length, 0);

      // Authorized creator/admin succeeds
      const authInteraction = createMockKnowledgeInteraction({
        subcommand: 'add',
        userId: adminId,
        options: {
          id: 'official-faq-new',
          category: 'policies_faq',
          title: 'FAQ Baru',
          content: 'Informasi resmi baru untuk Midwave.',
        },
      });
      await executeKnowledge(authInteraction, {
        knowledgeStore: store,
        authorizedUserIds: [adminId],
      });
      assert.ok(store.search('official-faq-new').length === 1);
    } finally {
      tmp.cleanup();
    }
  });

  it('9. Tidak ada user memory, profil pengguna, atau penyimpanan secret', () => {
    const tmp = createTempKnowledgeFile();
    try {
      const adminId = '111222333444555666';
      const auth = { actorUserId: adminId, authorizedUserIds: [adminId] };
      const store = new KnowledgeStore({ filePath: tmp.filePath });
      const data = store.load();

      assert.equal(data.scope, 'global_bot_knowledge_only');
      assert.equal(Object.hasOwn(KNOWLEDGE_CATEGORIES, 'user_memory'), false);
      assert.equal(Object.hasOwn(KNOWLEDGE_CATEGORIES, 'user_profile'), false);

      // Reject invalid personal/user category
      assert.throws(
        () =>
          store.addEntry(
            {
              id: 'user-pref-1',
              category: 'user_memory',
              title: 'User Pref',
              content: 'User likes coffee',
            },
            auth,
          ),
        (err) => err instanceof KnowledgeServiceError && err.code === 'INVALID_CATEGORY',
      );

      // Reject API keys / secrets in knowledge content
      assert.throws(
        () =>
          store.addEntry(
            {
              id: 'leak-test',
              category: 'technical_knowledge',
              title: 'Secret Test',
              content: 'Key: AIzaSy_DO_NOT_STORE_THIS_SECRET',
            },
            auth,
          ),
        (err) => err instanceof KnowledgeServiceError && err.code === 'SECRET_DETECTED',
      );
    } finally {
      tmp.cleanup();
    }
  });
});
