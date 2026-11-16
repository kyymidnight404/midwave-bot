import { PermissionFlagsBits } from 'discord.js';
import { AI_MAX_QUESTION_LENGTH } from '../services/gemini.js';
import {
  LYRICS_MAX_ARTIST_LENGTH,
  LYRICS_MAX_QUERY_LENGTH,
} from '../services/lyricsService.js';
import { SOCIAL_INTERACTIONS } from '../services/otakuGifsService.js';
import { BRAT_MAX_LENGTH } from '../utils/bratGenerator.js';
import { MATH_MAX_LENGTH } from '../utils/mathEvaluator.js';
import { QC_MAX_LENGTH } from '../utils/qcGenerator.js';

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
      name: 'help',
      description: 'Tampilkan panduan penggunaan command dan aturan permainan Midwave',
      enabled: true,
      type: 'standalone',
      handler: 'help',
      help: {
        category: 'general',
        usage: 'help',
        prefixName: 'menu',
        prefixUsage: '{prefix}menu',
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
  ],
};

export default commandStructure;
