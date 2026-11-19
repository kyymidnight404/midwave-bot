import { AttachmentBuilder, MessageFlags } from 'discord.js';
import {
  DownloaderError,
  cleanupTempDir,
  downloadMediaFromUrl,
  getDownloaderConfig,
  sanitizeLogText,
  validateMediaUrl,
} from '../services/downloader.js';
import {
  buildDownloadProcessingEmbed,
  buildDownloadSuccessEmbed,
  buildErrorEmbed,
} from '../utils/embeds.js';

/**
 * Formats upload failures from Discord REST API into safe user-facing messages.
 *
 * @param {unknown} error
 * @returns {string}
 */
function resolveUploadErrorMessage(error) {
  if (error instanceof DownloaderError) {
    return error.userMessage;
  }

  const discordCode = error?.code ?? error?.rawError?.code;
  if (discordCode === 40005 || String(error?.message || '').includes('Request entity too large')) {
    return 'Ukuran media melebihi batas unggahan file Discord pada server ini.';
  }
  if (discordCode === 50013) {
    return 'Bot tidak memiliki izin `Attach Files` atau `Send Messages` di channel ini.';
  }

  return 'Gagal mengunggah file media ke Discord. Silakan coba lagi beberapa saat lagi.';
}

function formatProgressStatusText(progress) {
  if (!progress) return null;
  if (progress.stage === 'queued') {
    return `Dalam antrean unduhan (posisi #${progress.position || 1})...`;
  }
  if (progress.stage === 'downloading') {
    if (typeof progress.percent === 'number' && progress.percent > 0) {
      return `Mengunduh media (${progress.percent.toFixed(0)}%)...`;
    }
    return 'Mengunduh media melalui yt-dlp...';
  }
  if (progress.stage === 'processing') {
    return 'Memproses & memvalidasi file media (FFmpeg)...';
  }
  return null;
}

/**
 * Executes media download for `/media action:download` and `!download` using the yt-dlp pipeline.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
 * @param {{
 *   downloadMedia?: typeof downloadMediaFromUrl,
 *   cleanupDir?: typeof cleanupTempDir,
 *   config?: ReturnType<typeof getDownloaderConfig>,
 *   deps?: object,
 * }} [context]
 */
export async function execute(interaction, context = {}) {
  const rawUrl = interaction.options?.getString?.('url', false);
  const rawMode = interaction.options?.getString?.('mode', false);
  const mode = rawMode === 'audio' ? 'audio' : 'video';

  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Tautan `url` wajib diisi untuk mengunduh media. Contoh: `/media action:download url:https://www.youtube.com/watch?v=...` atau `!download https://vt.tiktok.com/...`.',
          'Tautan Tidak Valid',
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let validated;
  try {
    validated = validateMediaUrl(rawUrl);
  } catch (error) {
    const message =
      error instanceof DownloaderError
        ? error.userMessage
        : 'Tautan tidak valid. Gunakan URL publik HTTP/HTTPS yang valid.';
    await interaction.reply({
      embeds: [buildErrorEmbed(message, 'Tautan Tidak Valid')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const runtimeConfig = context.config || getDownloaderConfig();
  const platformLabel = validated.platformLabel || validated.platform;
  await interaction.deferReply();

  let result = null;
  const downloader = context.downloadMedia || downloadMediaFromUrl;
  const cleanup = context.cleanupDir || cleanupTempDir;

  let lastProgressUpdateAt = Date.now();
  const handleProgress = async (progress) => {
    const now = Date.now();
    const isQueued = progress?.stage === 'queued';
    if (!isQueued && now - lastProgressUpdateAt < 2_500) {
      return;
    }
    const statusText = formatProgressStatusText(progress);
    if (!statusText) return;
    lastProgressUpdateAt = now;
    await interaction
      .editReply({
        embeds: [buildDownloadProcessingEmbed({ platformLabel, statusText })],
      })
      .catch(() => {});
  };

  try {
    await interaction.editReply({
      embeds: [buildDownloadProcessingEmbed({ platformLabel })],
    });

    result = await downloader({
      url: validated.normalizedUrl,
      mode,
      guild: interaction.guild,
      config: runtimeConfig,
      onProgress: handleProgress,
      deps: context.deps,
    });

    const attachments = result.items.map(
      (item) => new AttachmentBuilder(item.filePath, { name: item.fileName }),
    );

    const successEmbed = buildDownloadSuccessEmbed({
      platformLabel: result.platformLabel,
      mediaType: result.mediaType,
      fileFormat: result.fileFormat,
      formattedSize: result.formattedSize,
      requesterId: interaction.user.id,
      title: result.title,
      author: result.author,
      truncatedCount: result.truncatedCount,
    });

    await interaction.editReply({
      embeds: [successEmbed],
      files: attachments,
    });
  } catch (error) {
    const safeErrorCode = error instanceof DownloaderError ? error.code : 'UPLOAD_OR_INTERNAL_ERROR';
    console.error(
      `[Download] Command failed (${safeErrorCode}):`,
      sanitizeLogText(error instanceof Error ? error.message : error),
    );

    const userMessage = resolveUploadErrorMessage(error);
    await interaction
      .editReply({
        embeds: [buildErrorEmbed(userMessage, 'Gagal Mengunduh Media')],
        files: [],
      })
      .catch(() => {});
  } finally {
    if (result?.jobDir) {
      await cleanup(result.jobDir);
    }
  }
}

export default { name: 'download', execute };
