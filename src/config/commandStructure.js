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
      type: 'subcommand',
      handler: 'knowledge',
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      help: {
        category: 'ai_knowledge',
        visibility: 'admin',
        usage: 'knowledge <categories|search|add|update|list|remove>',
        description: 'Kelola knowledge base Midwave (Admin)',
      },
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
      name: 'game',
      description: 'Mainkan mini-game Midwave dan kelola sesi pertandingan',
      enabled: true,
      type: 'subcommand',
      handler: 'game',
      help: {
        category: 'mini_games',
        usage: 'game <solo|challenge|choose|drop|move|answer|status|cancel|list>',
        prefixUsage: '{prefix}<game> [aksi]',
        description: 'Mainkan 7 mini-game (coinflip, connect4, dice, guess, rps, tictactoe, trivia)',
      },
      subcommands: [
        {
          name: 'solo',
          description: 'Mainkan mini-game solo melawan Bot/AI',
          handler: 'game.solo',
          options: [
            {
              name: 'game',
              description: 'Pilih jenis mini-game',
              type: 'string',
              required: true,
              choices: GAME_CHOICES,
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
          ],
        },
        {
          name: 'challenge',
          description: 'Tantang pemain lain untuk bermain multiplayer',
          handler: 'game.challenge',
          options: [
            {
              name: 'game',
              description: 'Pilih jenis mini-game',
              type: 'string',
              required: true,
              choices: GAME_CHOICES,
            },
            {
              name: 'opponent',
              description: 'Pemain lawan yang ingin ditantang',
              type: 'user',
              required: true,
            },
            {
              name: 'difficulty',
              description: 'Tingkat kesulitan (untuk Guess/Trivia)',
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
          ],
        },
        {
          name: 'choose',
          description: 'Pilih gerakan RPS atau sisi Coin Flip pada sesi aktif',
          handler: 'game.choose',
          options: [
            {
              name: 'choice',
              description: 'Pilihan untuk RPS (rock/paper/scissors) atau Coin Flip (heads/tails)',
              type: 'string',
              required: true,
              choices: [
                { name: 'Rock (Batu — RPS)', value: 'rock' },
                { name: 'Paper (Kertas — RPS)', value: 'paper' },
                { name: 'Scissors (Gunting — RPS)', value: 'scissors' },
                { name: 'Heads (Coin Flip)', value: 'heads' },
                { name: 'Tails (Coin Flip)', value: 'tails' },
              ],
            },
            {
              name: 'game',
              description: 'Opsional jenis game (rps atau coinflip)',
              type: 'string',
              required: false,
              choices: [
                { name: 'Rock Paper Scissors', value: GAME_TYPES.RPS },
                { name: 'Coin Flip', value: GAME_TYPES.COINFLIP },
              ],
            },
          ],
        },
        {
          name: 'drop',
          description: 'Jatuhkan keping pada kolom Connect Four (1–7)',
          handler: 'game.drop',
          options: [
            {
              name: 'column',
              description: 'Nomor kolom 1–7',
              type: 'integer',
              required: true,
              minValue: 1,
              maxValue: 7,
            },
          ],
        },
        {
          name: 'move',
          description: 'Letakkan simbol pada papan Tic Tac Toe (A1–C3)',
          handler: 'game.move',
          options: [
            {
              name: 'position',
              description: 'Koordinat papan A1–C3',
              type: 'string',
              required: true,
              choices: TTT_POSITIONS.map((pos) => ({ name: pos, value: pos })),
            },
          ],
        },
        {
          name: 'answer',
          description: 'Kirim tebakan angka (Guess) atau jawaban A/B/C/D (Trivia)',
          handler: 'game.answer',
          options: [
            {
              name: 'answer',
              description: 'Tebakan angka 1–200 (Guess) atau jawaban A/B/C/D (Trivia)',
              type: 'string',
              required: true,
            },
          ],
        },
        {
          name: 'status',
          description: 'Lihat status sesi game atau undangan aktif',
          handler: 'game.status',
          options: [
            {
              name: 'game_id',
              description: 'Opsional ID sesi atau undangan',
              type: 'string',
              required: false,
            },
          ],
        },
        {
          name: 'cancel',
          description: 'Batalkan sesi game atau undangan aktif',
          handler: 'game.cancel',
          options: [
            {
              name: 'game_id',
              description: 'Opsional ID sesi atau undangan',
              type: 'string',
              required: false,
            },
          ],
        },
        {
          name: 'list',
          description: 'Tampilkan daftar seluruh mini-game Midwave dan aturan mainnya',
          handler: 'games',
        },
      ],
    },
    {
      name: 'invite',
      description: 'Terima atau tolak undangan pertandingan multiplayer',
      enabled: true,
      type: 'subcommand',
      handler: 'invite',
      help: {
        category: 'mini_games',
        usage: 'invite <accept|decline>',
        prefixUsage: '{prefix}invite <accept|decline>',
        description: 'Terima atau tolak undangan permainan',
      },
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
      name: 'media',
      description: 'Utilitas media Midwave: QC, Brat, Lyrics Finder, dan Downloader',
      enabled: true,
      type: 'subcommand',
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
            usage: 'media qc text:<teks>',
            prefixUsage: '{prefix}qc <teks>',
            description: 'Buat gambar chat screenshot WhatsApp',
          },
          brat: {
            usage: 'media brat text:<teks>',
            prefixUsage: '{prefix}brat <teks>',
            description: 'Buat gambar teks gaya Brat',
          },
          lyrics: {
            usage: 'media lyrics query:<judul>',
            prefixUsage: '{prefix}lyrics <judul>',
            description: 'Cari lirik lagu lengkap dengan cover',
          },
          download: {
            usage: 'media download url:<link>',
            prefixUsage: '{prefix}download <link>',
            description: 'Unduh media Instagram atau TikTok',
          },
        },
      },
      subcommands: [
        {
          name: 'qc',
          description: 'Buat gambar chat screenshot WhatsApp dari teks',
          handler: 'media.qc',
          options: [
            {
              name: 'text',
              description: `Teks pesan QC (maksimal ${QC_MAX_LENGTH} karakter)`,
              type: 'string',
              required: true,
              maxLength: QC_MAX_LENGTH,
            },
          ],
        },
        {
          name: 'brat',
          description: 'Buat gambar teks gaya Brat (1024x1024 PNG)',
          handler: 'media.brat',
          options: [
            {
              name: 'text',
              description: `Teks Brat (maksimal ${BRAT_MAX_LENGTH} karakter)`,
              type: 'string',
              required: true,
              maxLength: BRAT_MAX_LENGTH,
            },
          ],
        },
        {
          name: 'lyrics',
          description: 'Cari lirik lagu lengkap dengan cover dan metadata',
          handler: 'media.lyrics',
          options: [
            {
              name: 'query',
              description: 'Judul lagu atau kata kunci lirik',
              type: 'string',
              required: true,
              maxLength: LYRICS_MAX_QUERY_LENGTH,
            },
            {
              name: 'artist',
              description: 'Opsional nama penyanyi/artis untuk mempersempit pencarian',
              type: 'string',
              required: false,
              maxLength: LYRICS_MAX_ARTIST_LENGTH,
            },
          ],
        },
        {
          name: 'download',
          description: 'Unduh media (foto/video) dari tautan publik Instagram atau TikTok',
          handler: 'media.download',
          options: [
            {
              name: 'url',
              description: 'Tautan publik Instagram atau TikTok',
              type: 'string',
              required: true,
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
