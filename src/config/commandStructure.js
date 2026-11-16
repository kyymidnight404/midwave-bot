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
import { BRAT_MAX_LENGTH } from '../utils/bratGenerator.js';
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

const GAME_CHOICES = [
  { name: 'Coin Flip', value: GAME_TYPES.COINFLIP },
  { name: 'Connect Four', value: GAME_TYPES.CONNECT4 },
  { name: 'Dice Rolling', value: GAME_TYPES.DICE },
  { name: 'Number Guessing', value: GAME_TYPES.GUESS },
  { name: 'Rock Paper Scissors', value: GAME_TYPES.RPS },
  { name: 'Tic Tac Toe', value: GAME_TYPES.TICTACTOE },
  { name: 'Trivia Quiz', value: GAME_TYPES.TRIVIA },
];

const DIFFICULTY_CHOICES = [
  { name: 'Easy', value: 'easy' },
  { name: 'Normal', value: 'normal' },
  { name: 'Hard', value: 'hard' },
];

const TRIVIA_CATEGORY_CHOICES = TRIVIA_CATEGORIES.map((cat) => ({
  name: TRIVIA_CATEGORY_LABELS[cat],
  value: cat,
}));

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
      name: 'autorole',
      description: 'Kelola role otomatis untuk member baru MIDWAVE BOT',
      enabled: true,
      type: 'choice',
      handler: 'autorole',
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      help: {
        category: 'general',
        visibility: 'admin',
        usage: 'autorole action:<add|delete|list> [role]',
        description: 'Kelola Auto Role untuk member baru (Admin)',
      },
      options: [
        {
          name: 'action',
          description: 'Pilih aksi Auto Role',
          type: 'string',
          required: true,
          choices: [
            { name: 'add — Tambahkan role Auto Role', value: 'add' },
            { name: 'delete — Hapus role dari Auto Role', value: 'delete' },
            { name: 'list — Tampilkan seluruh role Auto Role', value: 'list' },
          ],
        },
        {
          name: 'role',
          description: 'Role yang ditambahkan atau dihapus (untuk add/delete)',
          type: 'role',
          required: false,
        },
      ],
    },
    {
      name: 'ai',
      description: 'Tanya apa saja ke Midwave AI — cerdas, ringkas, dan kontekstual',
      enabled: true,
      type: 'standalone',
      handler: 'ai',
      help: {
        category: 'ai_knowledge',
        usage: 'ai <pertanyaan>',
        prefixUsage: '{prefix}ai <pertanyaan>',
        description: 'Tanya apa saja ke Midwave AI',
      },
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
      name: 'knowledge',
      description: 'Kelola Global Bot Knowledge Midwave (khusus creator/admin terotorisasi)',
      enabled: true,
      type: 'choice',
      handler: 'knowledge',
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      help: {
        category: 'ai_knowledge',
        visibility: 'admin',
        usage: 'knowledge action:<categories|search|add|update|list|remove>',
        description: 'Kelola knowledge base Midwave (Admin)',
      },
      options: [
        {
          name: 'action',
          description: 'Pilih aksi Global Bot Knowledge',
          type: 'string',
          required: true,
          choices: [
            { name: 'categories — Lihat daftar kategori', value: 'categories' },
            { name: 'search — Cari entri knowledge', value: 'search' },
            { name: 'add — Tambah entri knowledge baru', value: 'add' },
            { name: 'update — Perbarui entri knowledge', value: 'update' },
            { name: 'list — Lihat ringkasan entri', value: 'list' },
            { name: 'remove — Hapus entri knowledge', value: 'remove' },
          ],
        },
        {
          name: 'id',
          description: 'ID unik entri (wajib untuk add/update/remove)',
          type: 'string',
          required: false,
          maxLength: 64,
        },
        {
          name: 'category',
          description: 'Kategori Global Knowledge (wajib untuk add, opsional untuk search/list/update)',
          type: 'string',
          required: false,
          choices: KNOWLEDGE_CATEGORY_CHOICES,
        },
        {
          name: 'title',
          description: 'Judul entri (wajib untuk add, opsional untuk update)',
          type: 'string',
          required: false,
          maxLength: 140,
        },
        {
          name: 'content',
          description: 'Isi pengetahuan bot (wajib untuk add, opsional untuk update)',
          type: 'string',
          required: false,
          maxLength: 1500,
        },
        {
          name: 'query',
          description: 'Kata kunci pencarian (untuk search)',
          type: 'string',
          required: false,
          maxLength: 150,
        },
        {
          name: 'tags',
          description: 'Tag dipisah koma (opsional untuk add/update)',
          type: 'string',
          required: false,
          maxLength: 200,
        },
        {
          name: 'status',
          description: 'Status verifikasi (opsional untuk add/update)',
          type: 'string',
          required: false,
          choices: KNOWLEDGE_STATUS_CHOICES,
        },
      ],
    },
    {
      name: 'help',
      description: 'Tampilkan panduan penggunaan command dan aturan permainan Midwave',
      enabled: true,
      type: 'standalone',
      handler: 'help',
      help: {
        category: 'general',
        usage: 'help',
        prefixUsage: '{prefix}help',
        description: 'Tampilkan panduan command Midwave',
      },
    },
    {
      name: 'donate',
      description: 'Dukung pengembangan Midwave melalui Saweria atau Ko-fi',
      enabled: true,
      type: 'standalone',
      handler: 'donate',
      help: {
        category: 'general',
        usage: 'donate',
        description: 'Dukung pengembangan Midwave',
      },
    },
    {
      name: 'game',
      description: 'Mainkan mini-game Midwave dan kelola sesi pertandingan',
      enabled: true,
      type: 'choice',
      handler: 'game',
      actionHandlers: {
        solo: 'game.solo',
        challenge: 'game.challenge',
        choose: 'game.choose',
        drop: 'game.drop',
        move: 'game.move',
        answer: 'game.answer',
        status: 'game.status',
        cancel: 'game.cancel',
        list: 'games',
      },
      help: {
        category: 'mini_games',
        usage: 'game action:<solo|challenge|choose|drop|move|answer|status|cancel|list>',
        prefixUsage: '{prefix}<game> [aksi]',
        description: 'Mainkan 7 mini-game (coinflip, connect4, dice, guess, rps, tictactoe, trivia)',
      },
      options: [
        {
          name: 'action',
          description: 'Pilih aksi game',
          type: 'string',
          required: true,
          choices: [
            { name: 'solo — Mainkan mini-game solo melawan Bot/AI', value: 'solo' },
            { name: 'challenge — Tantang pemain lain untuk bermain multiplayer', value: 'challenge' },
            { name: 'choose — Pilih gerakan RPS atau sisi Coin Flip', value: 'choose' },
            { name: 'drop — Jatuhkan keping Connect Four (1–7)', value: 'drop' },
            { name: 'move — Letakkan simbol Tic Tac Toe (A1–C3)', value: 'move' },
            { name: 'answer — Kirim tebakan Guess atau jawaban Trivia (A/B/C/D)', value: 'answer' },
            { name: 'status — Lihat status sesi game atau undangan aktif', value: 'status' },
            { name: 'cancel — Batalkan sesi game atau undangan aktif', value: 'cancel' },
            { name: 'list — Tampilkan daftar mini-game dan aturan mainnya', value: 'list' },
          ],
        },
        {
          name: 'game',
          description: 'Pilih jenis mini-game (untuk solo/challenge/choose)',
          type: 'string',
          required: false,
          choices: GAME_CHOICES,
        },
        {
          name: 'opponent',
          description: 'Pemain lawan yang ingin ditantang (untuk challenge)',
          type: 'user',
          required: false,
        },
        {
          name: 'choice',
          description: 'Pilihan RPS (rock/paper/scissors) atau Coin Flip (heads/tails)',
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
          description: 'Nomor kolom 1–7 (untuk drop di Connect Four)',
          type: 'integer',
          required: false,
          minValue: 1,
          maxValue: 7,
        },
        {
          name: 'position',
          description: 'Koordinat papan A1–C3 (untuk move di Tic Tac Toe)',
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
          name: 'difficulty',
          description: 'Tingkat kesulitan AI/game (default Normal)',
          type: 'string',
          required: false,
          choices: DIFFICULTY_CHOICES,
        },
        {
          name: 'category',
          description: 'Kategori soal Trivia (default General Knowledge)',
          type: 'string',
          required: false,
          choices: TRIVIA_CATEGORY_CHOICES,
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
        {
          name: 'game_id',
          description: 'Opsional ID sesi atau undangan (untuk status/cancel)',
          type: 'string',
          required: false,
        },
      ],
    },
    {
      name: 'invite',
      description: 'Terima atau tolak undangan pertandingan multiplayer',
      enabled: true,
      type: 'choice',
      handler: 'invite',
      actionHandlers: {
        accept: 'invite.accept',
        decline: 'invite.decline',
      },
      help: {
        category: 'mini_games',
        usage: 'invite action:<accept|decline>',
        prefixUsage: '{prefix}invite <accept|decline>',
        description: 'Terima atau tolak undangan permainan',
      },
      options: [
        {
          name: 'action',
          description: 'Terima atau tolak undangan pertandingan',
          type: 'string',
          required: true,
          choices: [
            { name: 'accept — Menerima undangan pertandingan terbaru untukmu', value: 'accept' },
            { name: 'decline — Menolak undangan pertandingan yang masuk', value: 'decline' },
          ],
        },
      ],
    },
    {
      name: 'media',
      description: 'Utilitas media Midwave: QC, Brat, Lyrics Finder, dan Downloader',
      enabled: true,
      type: 'choice',
      handler: 'media',
      actionHandlers: {
        qc: 'media.qc',
        brat: 'media.brat',
        lyrics: 'media.lyrics',
        download: 'media.download',
      },
      help: {
        category: 'media_utilities',
        actionHelp: {
          qc: {
            usage: 'media action:qc text:<teks>',
            prefixUsage: '{prefix}qc <teks>',
            description: 'Buat gambar chat screenshot WhatsApp',
          },
          brat: {
            usage: 'media action:brat text:<teks>',
            prefixUsage: '{prefix}brat <teks>',
            description: 'Buat gambar teks gaya Brat',
          },
          lyrics: {
            usage: 'media action:lyrics query:<judul>',
            prefixUsage: '{prefix}lyrics <judul>',
            description: 'Cari lirik lagu lengkap dengan cover',
          },
          download: {
            usage: 'media action:download url:<link>',
            prefixUsage: '{prefix}download <link>',
            description: 'Unduh media Instagram atau TikTok',
          },
        },
      },
      options: [
        {
          name: 'action',
          description: 'Pilih fitur media yang ingin dijalankan',
          type: 'string',
          required: true,
          choices: [
            { name: 'qc — Buat gambar chat screenshot WhatsApp dari teks', value: 'qc' },
            { name: 'brat — Buat gambar teks gaya Brat (1024x1024 PNG)', value: 'brat' },
            { name: 'lyrics — Cari lirik lagu lengkap dengan cover dan metadata', value: 'lyrics' },
            { name: 'download — Unduh media (foto/video) Instagram atau TikTok', value: 'download' },
          ],
        },
        {
          name: 'text',
          description: `Teks untuk qc (maks ${QC_MAX_LENGTH}) atau brat (maks ${BRAT_MAX_LENGTH})`,
          type: 'string',
          required: false,
          maxLength: Math.max(QC_MAX_LENGTH, BRAT_MAX_LENGTH),
        },
        {
          name: 'query',
          description: 'Judul lagu atau kata kunci lirik (untuk lyrics)',
          type: 'string',
          required: false,
          maxLength: LYRICS_MAX_QUERY_LENGTH,
        },
        {
          name: 'artist',
          description: 'Opsional nama penyanyi/artis (untuk lyrics)',
          type: 'string',
          required: false,
          maxLength: LYRICS_MAX_ARTIST_LENGTH,
        },
        {
          name: 'url',
          description: 'Tautan publik Instagram atau TikTok (untuk download)',
          type: 'string',
          required: false,
        },
      ],
    },
    {
      name: 'math',
      description: 'Hitung ekspresi matematika secara aman dan cepat',
      enabled: true,
      type: 'standalone',
      handler: 'math',
      help: {
        category: 'media_utilities',
        usage: 'math <ekspresi>',
        prefixUsage: '{prefix}math <ekspresi>',
        description: 'Hitung ekspresi matematika',
      },
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
      name: 'social',
      description: 'Lakukan interaksi sosial dan ekspresi dengan GIF anime',
      enabled: true,
      type: 'choice',
      handler: 'social',
      help: {
        category: 'social',
        usage: 'social <action> [@user]',
        prefixUsage: '{prefix}<aksi> [@user]',
        description: 'Interaksi sosial & ekspresi GIF anime',
      },
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
          description: 'Pengguna target (wajib untuk hug, pat, slap, bonk, kick, poke, yeet, highfive, wave)',
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
      help: {
        category: 'media_utilities',
        usage: 'Apps → Generate QC',
        description: 'Buat QC dari pesan Discord (Context Menu)',
      },
    },
  ],
};

export default commandStructure;
