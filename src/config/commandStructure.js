import { PermissionFlagsBits } from 'discord.js';
import {
  DICE_CONFIG,
  GAME_TYPES,
  TRIVIA_CATEGORIES,
  TRIVIA_CATEGORY_LABELS,
  TTT_POSITIONS,
} from '../utils/constants.js';
import { AI_MAX_QUESTION_LENGTH } from '../services/gemini.js';
import { KNOWLEDGE_CATEGORIES } from '../services/knowledge/index.js';
import {
  LYRICS_MAX_ARTIST_LENGTH,
  LYRICS_MAX_QUERY_LENGTH,
} from '../services/lyricsService.js';
import { SOCIAL_INTERACTIONS } from '../services/otakuGifsService.js';
import { MATH_MAX_LENGTH } from '../utils/mathEvaluator.js';
import { QC_MAX_LENGTH } from '../utils/qcGenerator.js';

const KNOWLEDGE_CATEGORY_CHOICES = Object.entries(KNOWLEDGE_CATEGORIES).map(([value, name]) => ({
  name,
  value,
}));

const KNOWLEDGE_STATUS_CHOICES = [
  { name: 'Verified', value: 'verified' },
  { name: 'Pending Verification', value: 'pending_verification' },
  { name: 'Unknown', value: 'unknown' },
];

/**
 * Centralized Discord Application Command configuration for Midwave.
 *
 * Edit this file to:
 * - Enable or disable commands (`enabled: true | false`)
 * - Rename commands, change descriptions, or adjust permissions
 * - Switch structure between `standalone`, `choice`, `subcommand`, `grouped`, or `context_message` / `context_user`
 * - Add, remove, reorder, or toggle required/optional parameters
 *
 * After editing, preview and sync changes safely via:
 * - `npm run deploy:preview`
 * - `npm run deploy` (guild / development)
 * - `npm run deploy:global` (global / production)
 */
export const commandStructure = {
  environment: {
    developmentScope: 'guild',
    productionScope: 'global',
    cleanupLegacy: true,
  },
  commands: [
    {
      name: 'ai',
      description: 'Tanya apa saja ke Midwave AI — cerdas, ringkas, dan kontekstual',
      enabled: true,
      type: 'standalone',
      handler: 'ai',
      options: [
        {
          name: 'question',
          description: `Pertanyaan untuk Midwave AI (maksimal ${AI_MAX_QUESTION_LENGTH} karakter)`,
          type: 'string',
          required: true,
          maxLength: AI_MAX_QUESTION_LENGTH,
        },
      ],
    },
    {
      name: 'game',
      description: 'Mainkan seluruh mini-game Midwave dan kelola sesi pertandingan',
      enabled: true,
      type: 'choice',
      handler: 'game',
      options: [
        {
          name: 'action',
          description: 'Aksi yang ingin dijalankan',
          type: 'string',
          required: true,
          choices: [
            { name: 'Solo (Main vs Bot/AI)', value: 'solo' },
            { name: 'Challenge (Tantang Pemain)', value: 'challenge' },
            { name: 'Choose (Pilih RPS / Coin Flip)', value: 'choose' },
            { name: 'Drop (Jatuhkan Keping Connect4)', value: 'drop' },
            { name: 'Move (Langkah Tic Tac Toe)', value: 'move' },
            { name: 'Answer (Tebak Guess / Jawab Trivia)', value: 'answer' },
            { name: 'Status (Lihat Sesi/Undangan Aktif)', value: 'status' },
            { name: 'Cancel (Batalkan Sesi/Undangan)', value: 'cancel' },
          ],
        },
        {
          name: 'game',
          description: 'Pilih jenis mini-game',
          type: 'string',
          required: false,
          choices: [
            { name: 'Coin Flip', value: GAME_TYPES.COINFLIP },
            { name: 'Connect Four', value: GAME_TYPES.CONNECT4 },
            { name: 'Dice Rolling', value: GAME_TYPES.DICE },
            { name: 'Number Guessing', value: GAME_TYPES.GUESS },
            { name: 'Rock Paper Scissors', value: GAME_TYPES.RPS },
            { name: 'Tic Tac Toe', value: GAME_TYPES.TICTACTOE },
            { name: 'Trivia Quiz', value: GAME_TYPES.TRIVIA },
          ],
        },
        {
          name: 'opponent',
          description: 'Pemain lawan (untuk aksi challenge)',
          type: 'user',
          required: false,
        },
        {
          name: 'choice',
          description: 'Pilihan untuk RPS (rock/paper/scissors) atau Coin Flip (heads/tails)',
          type: 'string',
          required: false,
          choices: [
            { name: 'Rock (Batu — RPS)', value: 'rock' },
            { name: 'Paper (Kertas — RPS)', value: 'paper' },
            { name: 'Scissors (Gunting — RPS)', value: 'scissors' },
            { name: 'Heads (Coin Flip)', value: 'heads' },
            { name: 'Tails (Coin Flip)', value: 'tails' },
          ],
        },
        {
          name: 'column',
          description: 'Nomor kolom 1–7 (untuk Connect Four drop)',
          type: 'integer',
          required: false,
          minValue: 1,
          maxValue: 7,
        },
        {
          name: 'position',
          description: 'Koordinat papan A1–C3 (untuk Tic Tac Toe move)',
          type: 'string',
          required: false,
          choices: TTT_POSITIONS.map((pos) => ({ name: pos, value: pos })),
        },
        {
          name: 'answer',
          description: 'Tebakan angka 1–200 (Guess) atau jawaban A/B/C/D (Trivia)',
          type: 'string',
          required: false,
        },
        {
          name: 'game_id',
          description: 'Opsional ID sesi atau undangan (untuk status / cancel)',
          type: 'string',
          required: false,
        },
        {
          name: 'difficulty',
          description: 'Tingkat kesulitan AI/game (default Normal)',
          type: 'string',
          required: false,
          choices: [
            { name: 'Easy', value: 'easy' },
            { name: 'Normal', value: 'normal' },
            { name: 'Hard', value: 'hard' },
          ],
        },
        {
          name: 'category',
          description: 'Kategori soal Trivia (default General Knowledge)',
          type: 'string',
          required: false,
          choices: TRIVIA_CATEGORIES.map((cat) => ({
            name: TRIVIA_CATEGORY_LABELS[cat],
            value: cat,
          })),
        },
        {
          name: 'count',
          description: `Jumlah dadu ${DICE_CONFIG.MIN_COUNT}–${DICE_CONFIG.MAX_COUNT} (default 1, untuk Dice)`,
          type: 'integer',
          required: false,
          minValue: DICE_CONFIG.MIN_COUNT,
          maxValue: DICE_CONFIG.MAX_COUNT,
        },
        {
          name: 'sides',
          description: `Jumlah sisi dadu ${DICE_CONFIG.MIN_SIDES}–${DICE_CONFIG.MAX_SIDES} (default 6, untuk Dice)`,
          type: 'integer',
          required: false,
          minValue: DICE_CONFIG.MIN_SIDES,
          maxValue: DICE_CONFIG.MAX_SIDES,
        },
      ],
    },
    {
      name: 'games',
      description: 'Tampilkan daftar seluruh permainan Midwave beserta cara memainkannya',
      enabled: true,
      type: 'standalone',
      handler: 'games',
    },
    {
      name: 'help',
      description: 'Tampilkan panduan penggunaan command dan aturan permainan Midwave',
      enabled: true,
      type: 'standalone',
      handler: 'help',
    },
    {
      name: 'invite',
      description: 'Terima atau tolak undangan pertandingan multiplayer',
      enabled: true,
      type: 'subcommand',
      handler: 'invite',
      subcommands: [
        {
          name: 'accept',
          description: 'Menerima undangan pertandingan terbaru untukmu',
          handler: 'invite',
        },
        {
          name: 'decline',
          description: 'Menolak undangan pertandingan yang masuk',
          handler: 'invite',
        },
      ],
    },
    {
      name: 'knowledge',
      description: 'Kelola Global Bot Knowledge Midwave (khusus creator/admin terotorisasi)',
      enabled: true,
      type: 'subcommand',
      handler: 'knowledge',
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      subcommands: [
        {
          name: 'categories',
          description: 'Lihat daftar kategori Global Bot Knowledge',
          handler: 'knowledge',
        },
        {
          name: 'search',
          description: 'Cari entri pada Global Bot Knowledge',
          handler: 'knowledge',
          options: [
            {
              name: 'query',
              description: 'Kata kunci pencarian',
              type: 'string',
              required: false,
              maxLength: 150,
            },
            {
              name: 'category',
              description: 'Filter kategori',
              type: 'string',
              required: false,
              choices: KNOWLEDGE_CATEGORY_CHOICES,
            },
          ],
        },
        {
          name: 'add',
          description: 'Tambah entri Global Bot Knowledge baru (creator/admin only)',
          handler: 'knowledge',
          options: [
            {
              name: 'id',
              description: 'ID unik entri (contoh: links-docs-v2)',
              type: 'string',
              required: true,
              maxLength: 64,
            },
            {
              name: 'category',
              description: 'Kategori Global Knowledge',
              type: 'string',
              required: true,
              choices: KNOWLEDGE_CATEGORY_CHOICES,
            },
            {
              name: 'title',
              description: 'Judul entri',
              type: 'string',
              required: true,
              maxLength: 140,
            },
            {
              name: 'content',
              description: 'Isi pengetahuan bot',
              type: 'string',
              required: true,
              maxLength: 1500,
            },
            {
              name: 'tags',
              description: 'Tag dipisah koma (opsional)',
              type: 'string',
              required: false,
              maxLength: 200,
            },
            {
              name: 'status',
              description: 'Status verifikasi',
              type: 'string',
              required: false,
              choices: KNOWLEDGE_STATUS_CHOICES,
            },
          ],
        },
        {
          name: 'update',
          description: 'Perbarui entri Global Bot Knowledge (creator/admin only)',
          handler: 'knowledge',
          options: [
            {
              name: 'id',
              description: 'ID entri yang akan diperbarui',
              type: 'string',
              required: true,
              maxLength: 64,
            },
            {
              name: 'title',
              description: 'Judul baru (opsional)',
              type: 'string',
              required: false,
              maxLength: 140,
            },
            {
              name: 'content',
              description: 'Isi baru (opsional)',
              type: 'string',
              required: false,
              maxLength: 1500,
            },
            {
              name: 'category',
              description: 'Kategori baru (opsional)',
              type: 'string',
              required: false,
              choices: KNOWLEDGE_CATEGORY_CHOICES,
            },
            {
              name: 'tags',
              description: 'Tag baru dipisah koma (opsional)',
              type: 'string',
              required: false,
              maxLength: 200,
            },
            {
              name: 'status',
              description: 'Status verifikasi baru (opsional)',
              type: 'string',
              required: false,
              choices: KNOWLEDGE_STATUS_CHOICES,
            },
          ],
        },
        {
          name: 'list',
          description: 'Lihat ringkasan entri Global Bot Knowledge',
          handler: 'knowledge',
          options: [
            {
              name: 'category',
              description: 'Filter berdasarkan kategori',
              type: 'string',
              required: false,
              choices: KNOWLEDGE_CATEGORY_CHOICES,
            },
          ],
        },
        {
          name: 'remove',
          description: 'Hapus entri Global Bot Knowledge (creator/admin only)',
          handler: 'knowledge',
          options: [
            {
              name: 'id',
              description: 'ID entri yang ingin dihapus',
              type: 'string',
              required: true,
              maxLength: 64,
            },
          ],
        },
      ],
    },
    {
      name: 'math',
      description: 'Hitung ekspresi matematika secara aman dan cepat',
      enabled: true,
      type: 'standalone',
      handler: 'math',
      options: [
        {
          name: 'expression',
          description: `Ekspresi matematika (maksimal ${MATH_MAX_LENGTH} karakter)`,
          type: 'string',
          required: true,
          maxLength: MATH_MAX_LENGTH,
        },
      ],
    },
    {
      name: 'media',
      description: 'Fitur media Midwave: QC chat screenshot, Brat image, Lyrics Finder, dan Downloader',
      enabled: true,
      type: 'choice',
      handler: 'media',
      actionHandlers: {
        qc: 'media.qc',
        brat: 'media.brat',
        lyrics: 'media.lyrics',
        download: 'media.download',
      },
      options: [
        {
          name: 'action',
          description: 'Fitur media yang ingin dijalankan',
          type: 'string',
          required: true,
          choices: [
            { name: 'qc — Buat gambar chat screenshot WhatsApp', value: 'qc' },
            { name: 'brat — Buat gambar teks gaya Brat (1024x1024 PNG)', value: 'brat' },
            { name: 'lyrics — Cari lirik lagu lengkap dengan cover', value: 'lyrics' },
            { name: 'download — Unduh media Instagram atau TikTok', value: 'download' },
          ],
        },
        {
          name: 'text',
          description: 'Teks untuk action qc (maks 2000) atau brat (maks 1000)',
          type: 'string',
          required: false,
          maxLength: QC_MAX_LENGTH,
        },
        {
          name: 'query',
          description: 'Judul lagu atau kata kunci untuk action lyrics',
          type: 'string',
          required: false,
          maxLength: LYRICS_MAX_QUERY_LENGTH,
        },
        {
          name: 'url',
          description: 'Tautan publik Instagram atau TikTok untuk action download',
          type: 'string',
          required: false,
        },
        {
          name: 'artist',
          description: 'Opsional nama penyanyi/artis untuk mempersempit pencarian lyrics',
          type: 'string',
          required: false,
          maxLength: LYRICS_MAX_ARTIST_LENGTH,
        },
      ],
    },
    {
      name: 'social',
      description: 'Lakukan interaksi sosial dan ekspresi dengan GIF anime',
      enabled: true,
      type: 'choice',
      handler: 'social',
      options: [
        {
          name: 'action',
          description: 'Jenis interaksi sosial atau ekspresi',
          type: 'string',
          required: true,
          choices: Object.values(SOCIAL_INTERACTIONS).map((item) => ({
            name: `${item.command} — ${item.description}`,
            value: item.command,
          })),
        },
        {
          name: 'user',
          description: 'Pengguna target (wajib untuk hug, pat, slap, bonk, poke, yeet, highfive, wave)',
          type: 'user',
          required: false,
        },
      ],
    },
    {
      name: 'Generate QC',
      enabled: true,
      type: 'context_message',
      handler: 'context.generate_qc',
    },
  ],
};

export default commandStructure;
