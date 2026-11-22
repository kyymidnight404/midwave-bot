import { KNOWLEDGE_CATEGORIES, defaultKnowledgeStore } from './store.js';

const CATEGORY_INTENT_PATTERNS = {
  bot_identity: [
    /\b(midwave|siapa\s+kamu|kamu\s+siapa|tentang\s+(kamu|bot|midwave)|bot\s+apa|identitas|kepribadian|kemampuan\s+bot|apa\s+itu\s+midwave|who\s+are\s+you|what\s+are\s+you|what\s+is\s+midwave|tell\s+me\s+about\s+(yourself|midwave)|namamu)\b/i,
  ],
  creator_developer: [
    /\b(creator|developer|pembuat(mu)?|pencipta(mu|nya)?|pemilik|owner|siapa\s+yang\s+(buat|bikin|membuat|kembangkan|ciptakan)|who\s+(created|made|built|developed)\s+(you|midwave)|dibuat\s+oleh|hengky|kyymidnight|kyymidnight404)\b/i,
  ],
  official_links: [
    /\b(website|situs|tautan\s+resmi|link\s+resmi|github|repo(sitory)?|dokumentasi|midwave\.ai\.id)\b/i,
  ],
  features_commands: [
    /\b(fitur(\s+(lengkap|apa\s+saja|semua|midwave))?|daftar\s+(fitur|command)|semua\s+(fitur|command)|command\s+(midwave|apa\s+saja|lengkap)|apa\s+(saja\s+)?yang\s+bisa\s+(kamu|midwave)\s+(lakukan|kerjakan|bantu)|what\s+can\s+(you|midwave)\s+do|all\s+(features|commands))\b/i,
    /\b(apakah|bisakah|apa)\s+(kamu|midwave|bot(\s+ini)?)\s+(bisa|dapat|mampu|punya|ada|menyediakan|mendukung|support)\b.*\b(fitur|command|download|mendownload|unduh|mengunduh|musik|music|lagu|voice\s+channel|pinterest|tiktok|instagram|youtube|connect\s*(4|four)|tic\s*tac\s*toe|tictactoe|profile|leaderboard|quiz|rps|coinflip|autorole|cuaca|weather|anime|lirik|lyrics|gambar|image|qc|brat|igf|moderasi|ban|kick|mute|level|xp|ekonomi)\b/i,
    /\b(can|do|does)\s+(you|midwave)\b.*\b(feature|command|music|voice\s+channel|pinterest|tiktok|instagram|youtube|downloader|download|tic\s*tac\s*toe|tictactoe|connect\s*(4|four)|profile|leaderboard|weather|anime|lyrics|autorole|quiz|rps|coinflip)\b/i,
    /\b(apakah|apa)\s+ada\s+fitur\b/i,
    /\b(pinterest|yt-dlp|auto[-\s]?downloader|auto[-\s]?role|game\s*center|tic\s*tac\s*toe|tictactoe|connect\s*(four|4)|rock\s*paper\s*scissors|coin\s*flip|quiz\s*battle|otakugifs|bmkg|anilist)\b/i,
    /\b(cara\s+(pakai|main|memainkan|menggunakan|mengaktifkan)\s+(\/)?(ai|download|dl|pin|pinterest|lyrics|lirik|brat|qc|igf|rps|ttt|tictactoe|tic\s*tac\s*toe|coinflip|cf|quiz|help|menu|autorole|math|weather|anime|donate|social|connect\s*4|connect\s*four|profile|musik|music))\b/i,
    /\/(ai|download|lyrics|brat|help|autorole|media|math|weather|anime|pin|social|donate|ping)\b/i,
    /!(ai|donate|download|dl|pin|lyrics|lyric|lirik|brat|qc|igf|rps|ttt|tictactoe|coinflip|cf|quiz|menu|knowledge|feedback|say|weather|anime|math|ping|servers|guilds)\b/i,
  ],
  technical_knowledge: [
    /\b(wispbyte|arsitektur(\s+midwave)|tech\s*stack(\s+midwave)?|deploy[-\s]?commands|troubleshooting\s+midwave|((node\.?js|discord\.?js|prisma|tavily|gemini).*(midwave|bot\s+ini))|((midwave|bot\s+ini).*(node\.?js|discord\.?js|prisma|tavily|gemini|tech\s*stack|stack|environment\s*variable)))\b/i,
  ],
  policies_faq: [
    /\b(privacy(\s+policy)?|kebijakan\s+privasi|terms(\s+of\s+service)?|tos|syarat\s+ketentuan|user\s+memory|faq\s+midwave|aturan\s+midwave|fakta\s+global|knowledge\s+global)\b/i,
    /\b(menyimpan|simpan|record|log|store|save|keep|ingat|mengingat)\s+(semua\s+|seluruh\s+)?(chat|percakapan|pesan|riwayat|obrolan|memori|data(\s+(pribadi|pengguna|saya|aku|user))?)\b/i,
    /\b(riwayat\s+chat|chat\s+history|permanen(t)?\s+memory|memori\s+permanen)\b/i,
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
 * Checks whether a user question pertains to Midwave's internal identity, commands,
 * developer, links, or technical architecture.
 *
 * @param {string} question
 * @returns {boolean}
 */
export function isMidwaveKnowledgeQuery(question) {
  const q = String(question || '').trim();
  if (!q) return false;
  return /\bmidwave\b/i.test(q) || detectRelevantKnowledgeCategories(q).length > 0;
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
const OVERVIEW_QUERY_RE =
  /\b(fitur(\s+(lengkap|apa\s+saja|semua|midwave))?|daftar\s+(fitur|command)|semua\s+(fitur|command)|command\s+(apa\s+saja|lengkap)|apa\s+(saja\s+)?yang\s+bisa\s+(kamu|midwave)|what\s+can\s+(you|midwave)\s+do|all\s+(features|commands)|menu)\b/i;

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
  const isOverviewQuery = OVERVIEW_QUERY_RE.test(cleanQuestion);

  const scored = [];
  for (const entry of entries) {
    let score = 0;
    if (categorySet.has(entry.category)) {
      score += 5;
    }

    if (isOverviewQuery && (entry.id === 'feature-menu-and-scope' || entry.id === 'identity-overview')) {
      score += 6;
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
export function formatKnowledgeContext(entries, maxChars = 3400) {
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
