import { AttachmentBuilder, MessageFlags } from 'discord.js';
import {
  DownloaderError,
  PLATFORM_LABELS,
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

/**
 * Executes media download for `/media action:download` using the unified RapidAPI downloader service.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{
 *   downloadMedia?: typeof downloadMediaFromUrl,
 *   cleanupDir?: typeof cleanupTempDir,
 *   config?: ReturnType<typeof getDownloaderConfig>,
 *   deps?: object,
 * }} [context]
 */
export async function execute(interaction, context = {}) {
  const rawUrl = interaction.options?.getString?.('url', false);

  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Tautan `url` wajib diisi untuk mengunduh media. Contoh: `/media action:download url:https://www.instagram.com/reel/...`.',
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
        : 'Tautan tidak valid. Gunakan URL publik Instagram atau TikTok.';
    await interaction.reply({
      embeds: [buildErrorEmbed(message, 'Tautan Tidak Valid')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const runtimeConfig = context.config || getDownloaderConfig();
  if (!context.downloadMedia && !runtimeConfig.rapidApiConfigured) {
    await interaction.reply({
      embeds: [
        buildErrorEmbed(
          'Fitur download media belum aktif karena `RAPIDAPI_KEY` belum dikonfigurasi oleh administrator.',
          'Downloader Belum Dikonfigurasi',
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const platformLabel = PLATFORM_LABELS[validated.platform] || validated.platform;
  await interaction.deferReply();

  let result = null;
  const downloader = context.downloadMedia || downloadMediaFromUrl;
  const cleanup = context.cleanupDir || cleanupTempDir;

  try {
    await interaction.editReply({
      embeds: [buildDownloadProcessingEmbed({ platformLabel })],
    });

    result = await downloader({
      url: validated.normalizedUrl,
      guild: interaction.guild,
      config: runtimeConfig,
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
