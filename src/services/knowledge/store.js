import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_KNOWLEDGE_FILE_PATH = path.resolve(__dirname, '../../data/botKnowledge.json');

export const KNOWLEDGE_CATEGORIES = Object.freeze({
  bot_identity: 'Bot Identity',
  creator_developer: 'Creator & Developer',
  official_links: 'Website & Official Links',
  features_commands: 'Features & Commands',
  technical_knowledge: 'Technical Knowledge',
  policies_faq: 'Policies & FAQ',
});

export const VALID_VERIFICATION_STATUSES = new Set([
  'verified',
  'pending_verification',
  'unknown',
]);

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{10,}/,
  /tvly-[A-Za-z0-9_-]{8,}/i,
  /Bearer\s+[A-Za-z0-9._-]{12,}/i,
  /\b(DISCORD_TOKEN|GEMINI_API_KEY|TAVILY_API_KEY|RAPIDAPI_KEY|GENIUS_API_KEY)\s*=\s*[^\s]+/i,
  /\bsk-[A-Za-z0-9]{16,}\b/,
];

/**
 * Domain error for Global Bot Knowledge storage and authorization.
 */
export class KnowledgeServiceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'KnowledgeServiceError';
    this.code = code;
  }
}

/**
 * Parses configured Discord User IDs allowed to manage Global Bot Knowledge.
 * Authorization relies strictly on numeric Discord User IDs, never usernames.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Set<string>}
 */
export function getAuthorizedAdminIds(env = process.env) {
  const raw = [env?.BOT_OWNER_IDS, env?.MIDWAVE_KNOWLEDGE_ADMIN_IDS]
    .filter(Boolean)
    .join(',');

  const ids = new Set();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (/^\d{15,25}$/.test(trimmed)) {
      ids.add(trimmed);
    }
  }
  return ids;
}

/**
 * Checks whether a Discord User ID is authorized to modify Global Bot Knowledge.
 * @param {unknown} userId
 * @param {{ authorizedUserIds?: Set<string> | string[], env?: Record<string, string | undefined> }} [options]
 * @returns {boolean}
 */
export function isAuthorizedKnowledgeAdmin(userId, options = {}) {
  if (typeof userId !== 'string' || !/^\d{15,25}$/.test(userId.trim())) {
    return false;
  }
  const normalizedId = userId.trim();
  const allowed = options.authorizedUserIds
    ? new Set(Array.from(options.authorizedUserIds).map((id) => String(id).trim()))
    : getAuthorizedAdminIds(options.env ?? process.env);

  return allowed.has(normalizedId);
}

/**
 * Ensures knowledge text never stores API keys, tokens, or credentials.
 * @param {string} text
 */
export function assertNoSecretsInKnowledge(text) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new KnowledgeServiceError(
        'SECRET_DETECTED',
        'Konten knowledge ditolak karena terdeteksi menyerupai API key, token, atau secret.',
      );
    }
  }
}

/**
 * Normalizes and validates an entry category against global bot categories only.
 * @param {unknown} category
 * @returns {string}
 */
function validateCategory(category) {
  const key = typeof category === 'string' ? category.trim() : '';
  if (!key || !Object.hasOwn(KNOWLEDGE_CATEGORIES, key)) {
    throw new KnowledgeServiceError(
      'INVALID_CATEGORY',
      `Kategori tidak valid. Pilih salah satu: ${Object.keys(KNOWLEDGE_CATEGORIES).join(', ')}.`,
    );
  }
  return key;
}

/**
 * Normalizes tags array from string or array input.
 * @param {unknown} rawTags
 * @returns {string[]}
 */
function normalizeTags(rawTags) {
  const list = Array.isArray(rawTags)
    ? rawTags
    : typeof rawTags === 'string'
      ? rawTags.split(',')
      : [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const clean = String(item || '').trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean.slice(0, 40));
    if (result.length >= 15) break;
  }
  return result;
}

/**
 * Persistent JSON-backed Global Bot Knowledge Store.
 * Stores strictly bot identity, creator, official links, features, technical docs,
 * and policies/FAQ. Never stores user memory, personal profiles, or chat history.
 */
export class KnowledgeStore {
  /**
   * @param {{ filePath?: string }} [options]
   */
  constructor(options = {}) {
    this.filePath = options.filePath ?? DEFAULT_KNOWLEDGE_FILE_PATH;
    this.data = null;
  }

  /**
   * Loads knowledge from disk (cached in memory after first load).
   */
  load() {
    if (this.data) {
      return this.data;
    }
    return this.reload();
  }

  /**
   * Reloads knowledge directly from the persistent JSON file on disk.
   */
  reload() {
    if (!fs.existsSync(this.filePath)) {
      throw new KnowledgeServiceError(
        'STORAGE_NOT_FOUND',
        'File Global Bot Knowledge tidak ditemukan.',
      );
    }

    let parsed;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      throw new KnowledgeServiceError(
        'STORAGE_CORRUPT',
        'Gagal membaca atau mem-parsing file Global Bot Knowledge.',
      );
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw new KnowledgeServiceError(
        'STORAGE_INVALID',
        'Struktur file Global Bot Knowledge tidak valid.',
      );
    }

    this.data = parsed;
    return this.data;
  }

  /**
   * Atomically persists the current knowledge state to disk.
   */
  save() {
    if (!this.data) {
      throw new KnowledgeServiceError('STORAGE_EMPTY', 'Belum ada data knowledge untuk disimpan.');
    }

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.data.updatedAt = new Date().toISOString();
    const serialized = `${JSON.stringify(this.data, null, 2)}\n`;
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, serialized, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  /**
   * Lists all global knowledge categories along with their entry counts.
   */
  listCategories() {
    const store = this.load();
    const counts = new Map();
    for (const entry of store.entries) {
      counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
    }

    return Object.entries(KNOWLEDGE_CATEGORIES).map(([key, label]) => ({
      id: key,
      label,
      description: store.categories?.[key]?.description ?? label,
      entryCount: counts.get(key) || 0,
    }));
  }

  /**
   * Searches global knowledge entries by keyword and/or category.
   * @param {string} [query]
   * @param {{ category?: string, limit?: number }} [options]
   */
  search(query = '', options = {}) {
    const store = this.load();
    const cleanQuery = String(query || '').trim().toLowerCase();
    const categoryFilter = options.category ? validateCategory(options.category) : null;
    const limit = Math.min(25, Math.max(1, options.limit ?? 10));
    const tokens = cleanQuery.split(/\s+/).filter((t) => t.length >= 2);

    const scored = [];
    for (const entry of store.entries) {
      if (categoryFilter && entry.category !== categoryFilter) continue;

      if (!cleanQuery) {
        scored.push({ entry, score: 1 });
        continue;
      }

      const titleLower = String(entry.title || '').toLowerCase();
      const contentLower = String(entry.content || '').toLowerCase();
      const idLower = String(entry.id || '').toLowerCase();
      const tagsLower = Array.isArray(entry.tags) ? entry.tags.map((t) => String(t).toLowerCase()) : [];

      let score = 0;
      if (idLower === cleanQuery) score += 10;
      if (titleLower.includes(cleanQuery)) score += 6;
      if (tagsLower.some((t) => t === cleanQuery || t.includes(cleanQuery))) score += 5;

      for (const token of tokens) {
        if (titleLower.includes(token)) score += 3;
        if (tagsLower.some((t) => t.includes(token))) score += 3;
        if (contentLower.includes(token)) score += 1;
      }

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((item) => item.entry);
  }

  /**
   * Ensures only authorized creator/admin Discord User IDs can mutate global knowledge.
   * @param {{ actorUserId?: string, authorizedUserIds?: Set<string> | string[], env?: Record<string, string | undefined> }} auth
   */
  _assertAdmin(auth = {}) {
    if (!isAuthorizedKnowledgeAdmin(auth.actorUserId, auth)) {
      throw new KnowledgeServiceError(
        'UNAUTHORIZED',
        'Akses ditolak. Hanya creator/admin terotorisasi (Discord User ID terdaftar) yang dapat mengubah Global Bot Knowledge.',
      );
    }
  }

  /**
   * Adds a new global bot knowledge entry and persists it to disk.
   * @param {{
   *   id: string,
   *   category: string,
   *   title: string,
   *   content: string,
   *   tags?: string[] | string,
   *   verificationStatus?: string,
   * }} input
   * @param {{ actorUserId?: string, authorizedUserIds?: Set<string> | string[], env?: Record<string, string | undefined> }} auth
   */
  addEntry(input, auth = {}) {
    this._assertAdmin(auth);
    const store = this.load();

    const id = String(input?.id || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64);

    if (!id) {
      throw new KnowledgeServiceError('INVALID_ID', 'ID knowledge wajib diisi (huruf, angka, strip).');
    }

    if (store.entries.some((e) => e.id === id)) {
      throw new KnowledgeServiceError('DUPLICATE_ID', `Knowledge dengan ID \`${id}\` sudah ada.`);
    }

    const category = validateCategory(input?.category);
    const title = String(input?.title || '').trim();
    const content = String(input?.content || '').trim();
    if (!title || !content) {
      throw new KnowledgeServiceError('INVALID_CONTENT', 'Judul dan isi knowledge tidak boleh kosong.');
    }

    assertNoSecretsInKnowledge(`${title}\n${content}`);

    const status = VALID_VERIFICATION_STATUSES.has(input?.verificationStatus)
      ? input.verificationStatus
      : 'verified';

    const entry = {
      id,
      category,
      title: title.slice(0, 140),
      content: content.slice(0, 2000),
      tags: normalizeTags(input?.tags),
      verificationStatus: status,
      updatedAt: new Date().toISOString(),
      updatedBy: `admin:${String(auth.actorUserId).trim()}`,
    };

    store.entries.push(entry);
    this.save();
    return entry;
  }

  /**
   * Updates an existing global bot knowledge entry and persists it to disk.
   * @param {string} rawId
   * @param {{
   *   category?: string,
   *   title?: string,
   *   content?: string,
   *   tags?: string[] | string,
   *   verificationStatus?: string,
   * }} patch
   * @param {{ actorUserId?: string, authorizedUserIds?: Set<string> | string[], env?: Record<string, string | undefined> }} auth
   */
  updateEntry(rawId, patch, auth = {}) {
    this._assertAdmin(auth);
    const store = this.load();
    const id = String(rawId || '').trim().toLowerCase();
    const existing = store.entries.find((e) => e.id === id);

    if (!existing) {
      throw new KnowledgeServiceError('NOT_FOUND', `Knowledge dengan ID \`${id}\` tidak ditemukan.`);
    }

    const nextTitle = patch?.title !== undefined ? String(patch.title).trim() : existing.title;
    const nextContent = patch?.content !== undefined ? String(patch.content).trim() : existing.content;
    if (!nextTitle || !nextContent) {
      throw new KnowledgeServiceError('INVALID_CONTENT', 'Judul dan isi knowledge tidak boleh kosong.');
    }

    assertNoSecretsInKnowledge(`${nextTitle}\n${nextContent}`);

    if (patch?.category !== undefined) {
      existing.category = validateCategory(patch.category);
    }
    existing.title = nextTitle.slice(0, 140);
    existing.content = nextContent.slice(0, 2000);
    if (patch?.tags !== undefined) {
      existing.tags = normalizeTags(patch.tags);
    }
    if (patch?.verificationStatus !== undefined) {
      if (!VALID_VERIFICATION_STATUSES.has(patch.verificationStatus)) {
        throw new KnowledgeServiceError('INVALID_STATUS', 'Status verifikasi tidak valid.');
      }
      existing.verificationStatus = patch.verificationStatus;
    }

    existing.updatedAt = new Date().toISOString();
    existing.updatedBy = `admin:${String(auth.actorUserId).trim()}`;
    this.save();
    return existing;
  }

  /**
   * Deletes an existing global bot knowledge entry and persists it to disk.
   * @param {string} rawId
   * @param {{ actorUserId?: string, authorizedUserIds?: Set<string> | string[], env?: Record<string, string | undefined> }} auth
   */
  deleteEntry(rawId, auth = {}) {
    this._assertAdmin(auth);
    const store = this.load();
    const id = String(rawId || '').trim().toLowerCase();
    const idx = store.entries.findIndex((e) => e.id === id);

    if (idx === -1) {
      throw new KnowledgeServiceError('NOT_FOUND', `Knowledge dengan ID \`${id}\` tidak ditemukan.`);
    }

    const [removed] = store.entries.splice(idx, 1);
    this.save();
    return removed;
  }
}

export const defaultKnowledgeStore = new KnowledgeStore();
