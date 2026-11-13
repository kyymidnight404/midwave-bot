import { GoogleGenAI } from '@google/genai';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const AI_MAX_QUESTION_LENGTH = 1500;
export const AI_REQUEST_TIMEOUT_MS = 25_000;
export const AI_COOLDOWN_MS = 8_000;

export const MIDWAVE_AI_SYSTEM_INSTRUCTION = [
  'Kamu adalah Midwave AI, asisten chatbot cerdas di bot Discord Midwave.',
  'Sifat & gaya bicara:',
  '- Ramah, komunikatif, jelas, dan informatif.',
  '- Gunakan Bahasa Indonesia sebagai bahasa utama secara default, tetapi jawab dalam bahasa lain apabila pengguna memintanya.',
  '- Bisa membantu topik pemrograman, teknologi, pendidikan, pengetahuan umum, maupun percakapan sehari-hari.',
  '- Jangan pernah mengaku sebagai manusia; akui dirimu sebagai AI (Midwave AI) jika ditanya.',
  '- Untuk pertanyaan sederhana, berikan jawaban ringkas dan langsung ke inti; gunakan Markdown Discord yang rapi jika membantu keterbacaan.',
  '- Setiap permintaan bersifat independen tanpa riwayat percakapan sebelumnya, jadi jangan berasumsi ada konteks chat terdahulu.',
].join('\n');

/**
 * Safe domain error raised by the Gemini AI service with user-facing messaging.
 */
export class GeminiServiceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'GeminiServiceError';
    this.code = code;
  }
}

/**
 * Validates and normalizes an AI question before sending it to Gemini.
 * @param {unknown} rawQuestion
 * @returns {string}
 */
export function validateAiQuestion(rawQuestion) {
  if (typeof rawQuestion !== 'string') {
    throw new GeminiServiceError(
      'EMPTY_QUESTION',
      'Pertanyaan wajib diisi. Contoh: `/ai question: Apa itu JavaScript?` atau `!ai Apa itu JavaScript?`.',
    );
  }

  const trimmed = rawQuestion.trim();
  if (!trimmed) {
    throw new GeminiServiceError(
      'EMPTY_QUESTION',
      'Pertanyaan tidak boleh kosong. Contoh: `/ai question: Apa itu JavaScript?` atau `!ai Apa itu JavaScript?`.',
    );
  }

  if (trimmed.length > AI_MAX_QUESTION_LENGTH) {
    throw new GeminiServiceError(
      'QUESTION_TOO_LONG',
      `Pertanyaan terlalu panjang (maksimal ${AI_MAX_QUESTION_LENGTH} karakter). Persingkat pertanyaanmu agar tetap cepat diproses.`,
    );
  }

  return trimmed;
}

/**
 * Maps raw Gemini SDK / network errors to safe, informative Indonesian messages.
 * Never includes credentials, headers, or stack traces.
 * @param {unknown} error
 * @returns {GeminiServiceError}
 */
export function mapGeminiErrorToUserMessage(error) {
  if (error instanceof GeminiServiceError) {
    return error;
  }

  const status = typeof error?.status === 'number' ? error.status : Number(error?.code ?? 0);
  const name = typeof error?.name === 'string' ? error.name : '';
  const rawMessage = typeof error?.message === 'string' ? error.message : '';
  const lower = rawMessage.toLowerCase();

  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    /timeout|timed out|aborted|etimedout/i.test(lower)
  ) {
    return new GeminiServiceError(
      'TIMEOUT',
      'Permintaan ke Gemini AI melebihi batas waktu. Silakan coba lagi sebentar.',
    );
  }

  if (
    status === 401 ||
    status === 403 ||
    /api[_ ]?key.*(invalid|not valid|expired|missing)|unauthenticated|permission_denied/i.test(lower)
  ) {
    return new GeminiServiceError(
      'INVALID_API_KEY',
      'Autentikasi Gemini AI gagal. Periksa kembali konfigurasi `GEMINI_API_KEY` pada bot.',
    );
  }

  if (
    status === 404 ||
    /model.*(not found|not supported|deprecated|unavailable)|is not found for api version/i.test(lower)
  ) {
    return new GeminiServiceError(
      'MODEL_UNAVAILABLE',
      'Model Gemini yang dikonfigurasi tidak tersedia atau tidak didukung untuk akun ini. Periksa `GEMINI_MODEL`.',
    );
  }

  if (
    status === 429 ||
    /resource_exhausted|quota|rate.?limit|too many requests/i.test(lower)
  ) {
    if (/quota|billing|free_tier|exceeded your current quota|daily/i.test(lower)) {
      return new GeminiServiceError(
        'QUOTA_EXCEEDED',
        'Kuota free tier Gemini AI saat ini sudah habis. Silakan coba lagi nanti setelah kuota tereset.',
      );
    }
    return new GeminiServiceError(
      'RATE_LIMITED',
      'Layanan Gemini AI sedang mencapai batas rate limit. Tunggu beberapa saat lalu coba lagi.',
    );
  }

  return new GeminiServiceError(
    'API_ERROR',
    'Terjadi gangguan saat menghubungi layanan Gemini AI. Silakan coba lagi beberapa saat.',
  );
}

/**
 * Extracts and validates plain text from a Gemini generateContent response.
 * @param {any} response
 * @returns {string}
 */
function extractResponseText(response) {
  let rawText = '';
  if (typeof response?.text === 'function') {
    rawText = response.text();
  } else if (typeof response?.text === 'string') {
    rawText = response.text;
  } else if (Array.isArray(response?.candidates)) {
    const parts = response.candidates[0]?.content?.parts;
    if (Array.isArray(parts)) {
      rawText = parts
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('');
    }
  }

  const trimmed = typeof rawText === 'string' ? rawText.trim() : '';
  if (!trimmed) {
    throw new GeminiServiceError(
      'EMPTY_RESPONSE',
      'Gemini AI tidak mengembalikan jawaban yang dapat ditampilkan. Coba ajukan ulang pertanyaanmu.',
    );
  }
  return trimmed;
}

/**
 * Sends a single stateless prompt to Google Gemini and returns the generated answer text.
 * Does not persist or reference any conversation history.
 *
 * @param {string} rawQuestion
 * @param {{
 *   apiKey?: string,
 *   model?: string,
 *   timeoutMs?: number,
 *   systemInstruction?: string,
 *   createClient?: (apiKey: string) => { models: { generateContent: Function } },
 * }} [options]
 * @returns {Promise<{ text: string, model: string }>}
 */
export async function askGemini(rawQuestion, options = {}) {
  const question = validateAiQuestion(rawQuestion);
  const apiKey = (options.apiKey ?? process.env.GEMINI_API_KEY ?? '').trim();

  if (!apiKey) {
    throw new GeminiServiceError(
      'MISSING_API_KEY',
      'Fitur AI belum siap karena `GEMINI_API_KEY` belum dikonfigurasi pada server bot.',
    );
  }

  const model = (options.model ?? process.env.GEMINI_MODEL ?? '').trim() || DEFAULT_GEMINI_MODEL;
  const timeoutMs = options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS;
  const systemInstruction = options.systemInstruction ?? MIDWAVE_AI_SYSTEM_INSTRUCTION;

  const client = options.createClient
    ? options.createClient(apiKey)
    : new GoogleGenAI({ apiKey });

  try {
    const response = await client.models.generateContent({
      model,
      contents: question,
      config: {
        systemInstruction,
        abortSignal: AbortSignal.timeout(timeoutMs),
      },
    });

    const text = extractResponseText(response);
    return { text, model };
  } catch (error) {
    throw mapGeminiErrorToUserMessage(error);
  }
}
