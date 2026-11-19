import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { execute as executeBrat } from '../prefixCommands/brat.js';
import { execute as executeDownload } from '../prefixCommands/download.js';
import { execute as executeLyrics } from '../prefixCommands/lyrics.js';
import { execute as executeQc } from '../prefixCommands/qc.js';
import {
  LYRICS_MAX_ARTIST_LENGTH,
  LYRICS_MAX_QUERY_LENGTH,
} from '../services/lyricsService.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { QC_MAX_LENGTH } from '../utils/qcGenerator.js';

const MEDIA_ACTION_CHOICES = [
  { name: 'qc — Buat gambar chat screenshot WhatsApp', value: 'qc' },
  { name: 'brat — Buat gambar teks gaya Brat (1024x1024 PNG)', value: 'brat' },
  { name: 'lyrics — Cari lirik lagu lengkap dengan cover', value: 'lyrics' },
  { name: 'download — Unduh media (YouTube, TikTok, IG, X, dll.) via yt-dlp', value: 'download' },
];

const MEDIA_DISPATCHERS = Object.freeze({
  qc: executeQc,
  brat: executeBrat,
  lyrics: executeLyrics,
  download: executeDownload,
});

export const data = new SlashCommandBuilder()
  .setName('media')
  .setDescription('Fitur media Midwave: QC chat screenshot, Brat image, Lyrics Finder, dan Downloader')
  .addStringOption((option) =>
    option
      .setName('action')
      .setDescription('Fitur media yang ingin dijalankan')
      .setRequired(true)
      .addChoices(...MEDIA_ACTION_CHOICES),
  )
  .addStringOption((option) =>
    option
      .setName('text')
      .setDescription('Teks untuk action qc (maks 2000) atau brat (maks 1000)')
      .setRequired(false)
      .setMaxLength(QC_MAX_LENGTH),
  )
  .addStringOption((option) =>
    option
      .setName('query')
      .setDescription('Judul lagu atau kata kunci untuk action lyrics')
      .setRequired(false)
      .setMaxLength(LYRICS_MAX_QUERY_LENGTH),
  )
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('Tautan publik media (YouTube, TikTok, IG, X, dll.) untuk action download')
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName('artist')
      .setDescription('Opsional nama penyanyi/artis untuk mempersempit pencarian lyrics')
      .setRequired(false)
      .setMaxLength(LYRICS_MAX_ARTIST_LENGTH),
  );

/**
 * Executes the consolidated `/media` slash command by dispatching to the shared feature executor.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} [context]
 */
export async function execute(interaction, context = {}) {
  const rawAction = interaction.options?.getString?.('action', false) ?? '';
  const action = typeof rawAction === 'string' ? rawAction.trim().toLowerCase() : '';
  const handler = Object.hasOwn(MEDIA_DISPATCHERS, action) ? MEDIA_DISPATCHERS[action] : null;

  if (!handler) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Action media tidak valid. Pilih salah satu dari: `qc`, `brat`, `lyrics`, atau `download`.',
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  return handler(interaction, context);
}

export default { data, execute };
