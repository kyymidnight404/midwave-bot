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
  DOWNLOAD_SAFE_MENTION_OPTIONS,
  formatDownloadErrorMessage,
  formatDownloadProcessingMessage,
  formatDownloadSuccessMessage,
} from '../utils/downloadFormatter.js';

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

  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    await interaction.reply({
      content: formatDownloadErrorMessage('Missing URL'),
      flags: MessageFlags.Ephemeral,
      allowedMentions: DOWNLOAD_SAFE_MENTION_OPTIONS,
    });
    return;
  }

  let validated;
  try {
    validated = validateMediaUrl(rawUrl);
  } catch (error) {
    await interaction.reply({
      content: formatDownloadErrorMessage(error),
      flags: MessageFlags.Ephemeral,
      allowedMentions: DOWNLOAD_SAFE_MENTION_OPTIONS,
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
    const statusText = formatDownloadProcessingMessage({ platformLabel, progress });
    lastProgressUpdateAt = now;
    await interaction
      .editReply({
        content: statusText,
        allowedMentions: DOWNLOAD_SAFE_MENTION_OPTIONS,
      })
      .catch(() => {});
  };

  try {
    await interaction.editReply({
      content: formatDownloadProcessingMessage({ platformLabel }),
      allowedMentions: DOWNLOAD_SAFE_MENTION_OPTIONS,
    });

    result = await downloader({
      url: validated.normalizedUrl,
      guild: interaction.guild,
      config: runtimeConfig,
      onProgress: handleProgress,
      deps: context.deps,
    });

    const rawItems = result.items || result.attachments || [];
    const attachments = rawItems.map(
      (item) => new AttachmentBuilder(item.filePath || item.buffer, { name: item.fileName }),
    );

    const content = formatDownloadSuccessMessage({
      author: result.author,
      platformLabel: result.platformLabel,
      platform: result.platform || validated.platform,
      extractor: result.extractor,
      title: result.title,
      fileFormat: result.fileFormat,
      formattedSize: result.formattedSize,
      totalBytes: result.totalBytes,
      items: rawItems,
    });

    await interaction.editReply({
      content,
      files: attachments,
      allowedMentions: DOWNLOAD_SAFE_MENTION_OPTIONS,
    });
  } catch (error) {
    const safeErrorCode = error instanceof DownloaderError ? error.code : 'UPLOAD_OR_INTERNAL_ERROR';
    console.error(
      `[Download] Command failed (${safeErrorCode}):`,
      sanitizeLogText(error instanceof Error ? error.message : error),
    );

    await interaction
      .editReply({
        content: formatDownloadErrorMessage(error),
        files: [],
        allowedMentions: DOWNLOAD_SAFE_MENTION_OPTIONS,
      })
      .catch(() => {});
  } finally {
    if (result?.jobDir) {
      await cleanup(result.jobDir);
    }
  }
}

export default { name: 'download', execute };
