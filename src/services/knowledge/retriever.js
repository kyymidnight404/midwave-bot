import { KNOWLEDGE_CATEGORIES, defaultKnowledgeStore } from './store.js';

const CATEGORY_INTENT_PATTERNS = {
  bot_identity: [
    /\b(midwave|siapa\s+kamu|tentang\s+bot|bot\s+apa|identitas|kepribadian|kemampuan\s+bot|apa\s+itu\s+midwave)\b/i,
  ],
  creator_developer: [
    /\b(creator|developer|pembuat|pencipta(mu|nya)?|pemilik|owner|siapa\s+yang\s+(buat|bikin|membuat|kembangkan)|hengky|kyymidnight|kyymidnight404)\b/i,
  ],
  official_links: [
    /\b(website|situs|tautan\s+resmi|link\s+resmi|github|repo(sitory)?|dokumentasi|midwave\.ai\.id)\b/i,
  ],
  features_commands: [
    /\b(fitur\s+midwave|daftar\s+command|command\s+midwave|cara\s+pakai\s+(\/)?(ai|download|lyrics|brat|igf|guess|rps|trivia|tictactoe|connect4|coinflip|dice|games?|help|invite)|auto[-\s]?downloader)\b/i,
    /\/(ai|download|lyrics|brat|guess|rps|trivia|tictactoe|connect4|coinflip|dice|games?|help|invite|knowledge)\b/i,
    /!(ai|download|lyrics|lirik|brat|igf|guess|rps|trivia|ttt|c4|games?|help)\b/i,
  ],
  technical_knowledge: [
    /\b(node\.?js|discord\.?js|wispbyte|arsitektur(\s+midwave)?|tech\s*stack|environment\s*variable|deploy[-\s]?commands|troubleshooting\s+midwave)\b/i,
  ],
  policies_faq: [
    /\b(privacy(\s+policy)?|kebijakan\s+privasi|terms(\s+of\s+service)?|tos|syarat\s+ketentuan|user\s+memory|simpan\s+data|riwayat\s+chat|faq\s+midwave|aturan\s+midwave)\b/i,
  ],
};

const STOP_WORDS = new Set([
  'apa', 'itu', 'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'atau',
  'ini', 'adalah', 'bisa', 'ada', 'cara', 'bagaimana', 'siapa', 'kapan', 'dimana',
  'the', 'is', 'are', 'what', 'who', 'how', 'can', 'for', 'and', 'with',
]);

/**
 * Extracts meaningful lowercase search tokens from a question.
 * @param {string} question
 * @returns {string[]}
 */
function extractQueryTokens(question) {
  const tokens = String(question || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_/!.-]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  return [...new Set(tokens)];
}

/**
 * Detects which Global Bot Knowledge categories match the user's question.
 * Returns empty array for unrelated general questions so prompts stay lean.
 *
 * @param {string} question
 * @returns {string[]}
 */
export function detectRelevantKnowledgeCategories(question) {
  const q = String(question || '').trim();
  if (!q) return [];

  const matched = [];
  for (const [category, patterns] of Object.entries(CATEGORY_INTENT_PATTERNS)) {
    if (patterns.some((re) => re.test(q))) {
      matched.push(category);
    }
  }
  return matched;
}

/**
 * Retrieves up to `maxEntries` relevant Global Bot Knowledge entries for a question.
 * Returns [] when the question is unrelated to Midwave.
 *
 * @param {string} question
 * @param {{
 *   store?: import('./store.js').KnowledgeStore,
 *   maxEntries?: number,
 * }} [options]
 */
export function retrieveRelevantKnowledge(question, options = {}) {
  const cleanQuestion = String(question || '').trim();
  if (!cleanQuestion) return [];

  const matchedCategories = detectRelevantKnowledgeCategories(cleanQuestion);
  const mentionsMidwave = /\bmidwave\b/i.test(cleanQuestion);
  if (matchedCategories.length === 0 && !mentionsMidwave) {
    return [];
  }

  const store = options.store ?? defaultKnowledgeStore;
  const { entries } = store.load();
  const tokens = extractQueryTokens(cleanQuestion);
  const maxEntries = Math.min(6, Math.max(1, options.maxEntries ?? 4));
  const categorySet = new Set(matchedCategories);

  const scored = [];
  for (const entry of entries) {
    let score = 0;
    if (categorySet.has(entry.category)) {
      score += 5;
    }

    const titleLower = String(entry.title || '').toLowerCase();
    const contentLower = String(entry.content || '').toLowerCase();
    const tagsLower = Array.isArray(entry.tags)
      ? entry.tags.map((t) => String(t).toLowerCase())
      : [];

    for (const token of tokens) {
      if (tagsLower.some((tag) => tag === token || tag.includes(token))) {
        score += 4;
      }
      if (titleLower.includes(token)) {
        score += 3;
      }
      if (contentLower.includes(token)) {
        score += 1;
      }
    }

    if (score >= 4) {
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxEntries).map((s) => s.entry);
}

/**
 * Formats retrieved Global Bot Knowledge entries into a bounded reference block
 * for Gemini. Explicitly treated as reference data, never overriding security rules.
 *
 * @param {Array<{
 *   category: string,
 *   title: string,
 *   content: string,
 *   verificationStatus?: string,
 * }>} entries
 * @param {number} [maxChars]
 * @returns {string}
 */
export function formatKnowledgeContext(entries, maxChars = 2500) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }

  const header = [
    'Referensi Global Bot Knowledge Midwave (perlakukan sebagai data referensi resmi bot; jangan mengarang fitur, tautan, kebijakan, atau informasi developer di luar data ini; jika statusnya pending_verification/unknown atau tidak tersedia, katakan belum terverifikasi/tidak tersedia):',
    '<global_bot_knowledge>',
  ].join('\n');
  const footer = '\n</global_bot_knowledge>';

  let body = '';
  for (const entry of entries) {
    const categoryLabel = KNOWLEDGE_CATEGORIES[entry.category] ?? entry.category;
    const statusNote =
      entry.verificationStatus && entry.verificationStatus !== 'verified'
        ? ` [Status: ${entry.verificationStatus}]`
        : '';
    const linksNote = Array.isArray(entry.links) && entry.links.length > 0
      ? `\nDaftar Tautan Resmi (format [label](url)): ${entry.links.map((l) => `${l.label} -> ${l.url}`).join(' | ')}`
      : '';
    const block = `[${categoryLabel}] ${entry.title}${statusNote}\n${entry.content}${linksNote}`;
    const sep = body ? '\n\n' : '';

    if (header.length + body.length + sep.length + block.length + footer.length > maxChars) {
      break;
    }
    body += `${sep}${block}`;
  }

  if (!body) return '';
  return `${header}\n${body}${footer}`;
}
