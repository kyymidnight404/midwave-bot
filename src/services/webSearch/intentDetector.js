const EXPLICIT_SEARCH_PATTERNS = [
  /\b(cari(kan)?\s+(di\s+)?(web|internet|google|berita)|cek\s+(di\s+)?(web|internet|berita))\b/i,
  /\b(sumber|referensi)\s+(terbaru|terkini|resmi|valid|berita)\b/i,
  /\b(beri(kan)?|kasih|sertakan)\s+(sumber|link|referensi)\b/i,
  /\b(menurut\s+berita|headline\s+hari\s+ini|berita\s+terbaru|berita\s+terkini)\b/i,
  /\b(search\s+the\s+web|latest\s+sources?|cite\s+sources?)\b/i,
];

const TEMPORAL_ANCHOR_PATTERNS = [
  /\b(hari\s+ini|sekarang|saat\s+ini|terbaru|terkini|barusan|tadi|minggu\s+ini|bulan\s+ini|tahun\s+ini)\b/i,
  /\b(today|right\s+now|currently|latest|recent(ly)?|breaking|this\s+(week|month|year))\b/i,
  /\b(202[5-9]|203\d)\b/,
];

const NEWS_TOPIC_PATTERNS = [
  /\b(berita|kabar|kejadian|insiden|tragedi|gempa|cuaca|prakiraan|banjir|erupsi|pemilu|kebijakan\s+baru|undang-undang\s+baru|viral|trending)\b/i,
  /\b(news|headline|weather|forecast|earthquake|election|announcement)\b/i,
];

const SPORTS_TOPIC_PATTERNS = [
  /\b(jadwal\s+pertandingan|hasil\s+pertandingan|skor(\s+akhir)?|klasemen|timnas|liga\s+\w+|champions\s+league|premier\s+league|ucl|epl|mpl|vct|piala\s+dunia|match\s+schedule|live\s+score)\b/i,
];

const FINANCE_PRICE_PATTERNS = [
  /\b(harga\s+(terkini|sekarang|hari\s+ini|emas|bbm|bitcoin|btc|eth|crypto|saham|beras|iphone|rtx)|kurs(\s+rupiah)?|nilai\s+tukar|ihsg|usd\s+to\s+idr|idr\s+to\s+usd|bitcoin\s+price|gold\s+price|stock\s+price)\b/i,
  /\b(harga|kurs|bitcoin|btc|ethereum|eth|ihsg|saham)\b/i,
];

const TECH_GAME_UPDATE_PATTERNS = [
  /\b(versi\s+terbaru|latest\s+version|patch\s*notes?|changelog|release\s*(notes?|date)|tanggal\s+rilis|update\s+(terbaru|game|windows|ios|android|node\.?js|python|next\.?js|react|discord\.?js|valorant|genshin|mlbb|mobile\s+legends|minecraft|pubg)|nerf|buff|banner\s+terbaru|status\s+server)\b/i,
];

const CURRENT_ROLE_PATTERNS = [
  /\b(siapa\s+(presiden|menteri|ceo|pelatih|juara|pemenang)|who\s+is\s+the\s+(current|new)\s+(president|ceo|champion|winner))\b/i,
];

const NON_SEARCH_CONCEPT_PATTERNS = [
  /```[\s\S]*```/,
  /^\s*(apa\s+itu|jelaskan(\s+konsep)?|definisi|pengertian|bedanya|perbedaan|bagaimana\s+cara\s+kerja|kenapa\s+bisa|contoh\s+kode|buatkan\s+(fungsi|kode|script|query|regex|cerita|puisi|pantun|esai|artikel|email|caption|ide)|tolong\s+(jelaskan|perbaiki|debug|refactor|ringkas|terjemahkan|translate)|terjemahkan|translate|artinya\s+dalam\s+bahasa|hitung(kan)?|siapa\s+kamu|halo+|hai+|hi+|hello+|terima\s+kasih|makasih)\b/i,
];

const CONVERSATIONAL_PREFIX_RE = /^(tolong\s+|coba\s+|bisa\s+|mohon\s+)?(carikan|cek(kan)?|cari|kasih\s+tau(\s+dong)?|beri\s+tau|jelaskan|apa(\s+sih)?)\s+/i;

/**
 * Normalizes a user question into a clean search query & cache key.
 * @param {string} question
 * @returns {string}
 */
export function normalizeSearchQuery(question) {
  const cleaned = String(question || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(CONVERSATIONAL_PREFIX_RE, '')
    .replace(/[?!.]+$/g, '')
    .trim();

  const base = cleaned || String(question || '').trim().replace(/\s+/g, ' ');
  return base.slice(0, 300);
}

/**
 * Classifies whether a question requires real-time web search via Tavily.
 * Uses multi-signal scoring (explicit request, domain topic, temporal context,
 * and negative concept/chat signals). Defaults to normal Gemini when uncertain.
 *
 * @param {string} rawQuestion
 * @returns {{
 *   shouldSearch: boolean,
 *   reason: string,
 *   confidence: 'high' | 'medium' | 'low',
 *   topic: 'news' | 'general',
 *   cacheCategory: 'dynamic' | 'semi_stable',
 *   normalizedQuery: string,
 * }}
 */
export function detectSearchIntent(rawQuestion) {
  const question = String(rawQuestion || '').trim();
  const normalizedQuery = normalizeSearchQuery(question);

  if (!question || question.length < 4) {
    return {
      shouldSearch: false,
      reason: 'short_or_empty',
      confidence: 'low',
      topic: 'general',
      cacheCategory: 'dynamic',
      normalizedQuery,
    };
  }

  let score = 0;
  let topic = 'general';
  let cacheCategory = 'dynamic';
  const matchedSignals = [];

  const hasExplicit = EXPLICIT_SEARCH_PATTERNS.some((re) => re.test(question));
  const hasTemporal = TEMPORAL_ANCHOR_PATTERNS.some((re) => re.test(question));
  const hasNews = NEWS_TOPIC_PATTERNS.some((re) => re.test(question));
  const hasSports = SPORTS_TOPIC_PATTERNS.some((re) => re.test(question));
  const hasFinance = FINANCE_PRICE_PATTERNS.some((re) => re.test(question));
  const hasTechUpdate = TECH_GAME_UPDATE_PATTERNS.some((re) => re.test(question));
  const hasCurrentRole = CURRENT_ROLE_PATTERNS.some((re) => re.test(question));
  const hasNonSearchConcept = NON_SEARCH_CONCEPT_PATTERNS.some((re) => re.test(question));

  if (hasExplicit) {
    score += 3;
    matchedSignals.push('explicit_search');
  }
  if (hasTemporal) {
    score += 2;
    matchedSignals.push('temporal');
  }
  if (hasNews) {
    score += 2;
    topic = 'news';
    matchedSignals.push('news');
  }
  if (hasSports) {
    score += 2;
    topic = 'news';
    matchedSignals.push('sports');
  }
  if (hasFinance) {
    // Broad price keyword alone needs temporal/asset context; specific phrase scores higher.
    score += FINANCE_PRICE_PATTERNS[0].test(question) ? 3 : 1;
    matchedSignals.push('finance_price');
  }
  if (hasTechUpdate) {
    score += 2;
    if (!hasNews && !hasSports) {
      cacheCategory = 'semi_stable';
    }
    matchedSignals.push('tech_or_game_update');
  }
  if (hasCurrentRole) {
    score += hasTemporal ? 2 : 1;
    matchedSignals.push('current_role');
  }

  if (hasNonSearchConcept) {
    score -= 2;
    matchedSignals.push('concept_or_static');
  }

  // Require clear signal threshold (>= 2) so uncertain queries stay on normal Gemini.
  const shouldSearch = score >= 2;
  const confidence = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';

  return {
    shouldSearch,
    reason: matchedSignals.join(',') || 'general_knowledge',
    confidence,
    topic,
    cacheCategory,
    normalizedQuery,
  };
}
