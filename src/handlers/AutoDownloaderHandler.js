import {
  AttachmentBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from '../services/downloader/errors.js';
import {
  MAX_DISCORD_ATTACHMENTS,
  PLATFORMS,
  STANDARD_DISCORD_UPLOAD_LIMIT_BYTES,
  cleanupTempDir,
  downloadMediaFromUrl,
  getDownloaderConfig,
  sanitizeLogText,
  validateMediaUrl,
} from '../services/downloader.js';
import {
  DOWNLOAD_SAFE_MENTION_OPTIONS,
  formatDownloadErrorMessage,
  formatDownloadSuccessMessage,
} from '../utils/downloadFormatter.js';
import { detectFirstMediaUrl } from '../utils/urlDetector.js';

export const AUTO_DOWNLOAD_COOLDOWN_MS = 10_000;

/**
 * Sends a message safely as a reply (with channel.send fallback).
 *
 * @param {import('discord.js').Message} message
 * @param {object} payload
 */
async function sendMessageReply(message, payload) {
  const safePayload = {
    ...payload,
    allowedMentions: payload.allowedMentions ?? DOWNLOAD_SAFE_MENTION_OPTIONS,
  };
  if (typeof message.reply === 'function') {
    return message.reply(safePayload);
  }
  if (typeof message.channel?.send === 'function') {
    return message.channel.send(safePayload);
  }
  return null;
}

/**
 * Checks whether the bot has required channel permissions to send auto-download responses.
 *
 * @param {import('discord.js').Message} message
 */
function checkBotChannelPermissions(message) {
  if (!message.guild || typeof message.channel?.permissionsFor !== 'function') {
    return { canSend: true, canAttach: true };
  }
  const me = message.guild.members?.me;
  if (!me) {
    return { canSend: true, canAttach: true };
  }
  const perms = message.channel.permissionsFor(me);
  if (!perms) {
    return { canSend: true, canAttach: true };
  }
  const canSend =
    perms.has(PermissionFlagsBits.ViewChannel) &&
    perms.has(PermissionFlagsBits.SendMessages) &&
    perms.has(PermissionFlagsBits.EmbedLinks);
  const canAttach = perms.has(PermissionFlagsBits.AttachFiles);
  return { canSend, canAttach };
}

/**
 * Detects TikTok & Instagram links inside regular chat messages and auto-downloads them via yt-dlp.
 */
export class AutoDownloaderHandler {
  /**
   * @param {{
   *   cooldowns: import('../utils/cooldown.js').CooldownManager,
   *   prefix?: string,
   *   downloadFn?: typeof downloadMediaFromUrl,
   *   getConfig?: typeof getDownloaderConfig,
   *   logger?: Console,
   * }} options
   */
  constructor({
    cooldowns,
    prefix = '!',
    downloadFn = downloadMediaFromUrl,
    getConfig = getDownloaderConfig,
    logger = console,
  }) {
    this.cooldowns = cooldowns;
    this.prefix = prefix;
    this.downloadFn = downloadFn;
    this.getConfig = getConfig;
    this.logger = logger;
  }

  /**
   * Processes a Discord MessageCreate event if it contains a supported TikTok or Instagram URL.
   *
   * @param {import('discord.js').Message} message
   * @returns {Promise<boolean>} true if an auto-download was handled
   */
  async handle(message) {
    if (!message || message.author?.bot || typeof message.content !== 'string') {
      return false;
    }

    const trimmed = message.content.trim();
    if (!trimmed || (this.prefix && trimmed.startsWith(this.prefix))) {
      return false;
    }

    const detected = detectFirstMediaUrl(trimmed);
    if (!detected) {
      return false;
    }

    let validated;
    try {
      validated = validateMediaUrl(detected.url);
    } catch {
      return false;
    }
    if (validated.platform !== PLATFORMS.TIKTOK && validated.platform !== PLATFORMS.INSTAGRAM) {
      return false;
    }

    const config = this.getConfig();
    if (config?.autoDownloadEnabled === false) {
      return false;
    }

    const perms = checkBotChannelPermissions(message);
    if (!perms.canSend) {
      return false;
    }

    if (!perms.canAttach) {
      await sendMessageReply(message, {
        content: formatDownloadErrorMessage('Missing Attach Files permission'),
        allowedMentions: DOWNLOAD_SAFE_MENTION_OPTIONS,
      }).catch(() => {});
      return true;
    }

    if (this.cooldowns) {
      const cd = this.cooldowns.tryAcquire(`${message.author.id}:autodownload`, AUTO_DOWNLOAD_COOLDOWN_MS);
      if (!cd.allowed) {
        return false;
      }
    }

    await message.channel?.sendTyping?.().catch(() => {});

    let result = null;
    try {
      const downloaderConfig = config?.fullConfig || config || getDownloaderConfig();

      result = await this.downloadFn({
        url: validated.normalizedUrl,
        guild: message.guild,
        maxBytesOverride: STANDARD_DISCORD_UPLOAD_LIMIT_BYTES,
        config: downloaderConfig,
      });

      const items = result.items || result.attachments || [];
      if (items.length === 0) {
        throw new DownloaderError(
          DOWNLOADER_ERROR_CODES.NOT_FOUND,
          'Tidak ada file media yang berhasil diunduh dari tautan tersebut.',
        );
      }

      const files = items
        .slice(0, MAX_DISCORD_ATTACHMENTS)
        .map((item) => new AttachmentBuilder(item.filePath || item.buffer, { name: item.fileName }));

      const content = formatDownloadSuccessMessage({
        author: result.author,
        platformLabel: result.platformLabel,
        platform: result.platform || validated.platform,
        extractor: result.extractor,
        title: result.title,
        fileFormat: result.fileFormat,
        formattedSize: result.formattedSize,
        totalBytes: result.totalBytes,
        items: items.slice(0, MAX_DISCORD_ATTACHMENTS),
      });

      await sendMessageReply(message, {
        content,
        files,
        allowedMentions: DOWNLOAD_SAFE_MENTION_OPTIONS,
      });

      if (typeof message.suppressEmbeds === 'function') {
        await message.suppressEmbeds(true).catch(() => {});
      }
      return true;
    } catch (error) {
      const safeCode = error instanceof DownloaderError ? error.code : DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED;
      this.logger.error(
        `[AutoDownloader] Failed (${safeCode}):`,
        sanitizeLogText(error instanceof Error ? error.message : error),
      );

      await sendMessageReply(message, {
        content: formatDownloadErrorMessage(error),
        allowedMentions: DOWNLOAD_SAFE_MENTION_OPTIONS,
      }).catch(() => {});
      return true;
    } finally {
      if (result?.jobDir) {
        await cleanupTempDir(result.jobDir);
      }
    }
  }
}
