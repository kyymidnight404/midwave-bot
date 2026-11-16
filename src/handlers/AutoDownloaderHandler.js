import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from 'discord.js';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from '../services/downloader/errors.js';
import {
  cleanupTempDir,
  downloadViaRapidApi,
  getDownloaderConfig,
  getRapidApiConfig,
  MAX_DISCORD_ATTACHMENTS,
  PLATFORMS,
  sanitizeLogText,
  validateMediaUrl,
} from '../services/downloader.js';
import { COLORS } from '../config/colors.js';
import { buildErrorEmbed, createBaseEmbed } from '../utils/embeds.js';
import { detectFirstMediaUrl } from '../utils/urlDetector.js';

export const AUTO_DOWNLOAD_COOLDOWN_MS = 10_000;

const PLATFORM_META = Object.freeze({
  tiktok: { label: 'TikTok', icon: '🎵' },
  instagram: { label: 'Instagram', icon: '📸' },
});

/**
 * Truncates caption/title safely for Discord embed descriptions.
 *
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {string}
 */
function truncateText(text, maxLength = 220) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 3)}...`;
}

/**
 * Sends a message safely as a reply (with channel.send fallback).
 *
 * @param {import('discord.js').Message} message
 * @param {object} payload
 */
async function sendMessageReply(message, payload) {
  if (typeof message.reply === 'function') {
    return message.reply({
      ...payload,
      allowedMentions: { repliedUser: false },
    });
  }
  if (typeof message.channel?.send === 'function') {
    return message.channel.send(payload);
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
 * Builds the Midwave embed for successful auto-downloaded attachments.
 *
 * @param {{
 *   platform: 'tiktok' | 'instagram',
 *   author?: string,
 *   title?: string,
 *   formattedSize: string,
 *   attachmentCount: number,
 *   truncatedCount?: number,
 *   requesterId: string,
 * }} params
 */
function buildAutoDownloadEmbed(params) {
  const meta = PLATFORM_META[params.platform] || { label: params.platform, icon: '🎬' };
  const lines = [`${meta.icon} **${meta.label} Auto-Downloader**`];

  if (params.author) {
    lines.push(`• **Kreator:** ${truncateText(params.author, 80)}`);
  }
  if (params.title) {
    lines.push(`• **Keterangan:** ${truncateText(params.title, 180)}`);
  }
  lines.push(`• **Ukuran Total:** ${params.formattedSize} (${params.attachmentCount} file)`);

  if (params.truncatedCount > 0) {
    lines.push(
      `⚠️ *${params.truncatedCount} item lainnya dilewati karena batas maksimal ${MAX_DISCORD_ATTACHMENTS} lampiran atau 10 MB.*`,
    );
  }

  lines.push('', `Diminta oleh: <@${params.requesterId}>`);

  return createBaseEmbed({
    title: 'MIDWAVE AUTO DOWNLOADER',
    description: lines.join('\n'),
    color: COLORS.SUCCESS,
    includeThumbnail: false,
  });
}

/**
 * Builds fallback embed + link button when direct attachment exceeds 10 MB or CDN upload fails.
 *
 * @param {{
 *   platform: 'tiktok' | 'instagram',
 *   author?: string,
 *   title?: string,
 *   reason: string,
 *   primaryCdnUrl: string,
 *   cdnLinks?: string[],
 *   requesterId: string,
 * }} params
 */
function buildFallbackCdnResponse(params) {
  const meta = PLATFORM_META[params.platform] || { label: params.platform, icon: '🔗' };
  const lines = [
    `${meta.icon} **${meta.label} Auto-Downloader (Tautan Langsung)**`,
    '',
    `ℹ️ ${params.reason}`,
  ];

  if (params.author) {
    lines.push(`• **Kreator:** ${truncateText(params.author, 80)}`);
  }
  if (params.title) {
    lines.push(`• **Keterangan:** ${truncateText(params.title, 180)}`);
  }

  const extraLinks = Array.isArray(params.cdnLinks) ? params.cdnLinks.slice(0, 5) : [params.primaryCdnUrl];
  if (extraLinks.length === 1) {
    lines.push('', `🔗 **[Klik di sini untuk menonton / mengunduh langsung](${extraLinks[0]})**`);
  } else {
    lines.push('', '**Tautan Media Langsung:**');
    extraLinks.forEach((link, idx) => {
      lines.push(`${idx + 1}. [Unduh Item #${idx + 1}](${link})`);
    });
  }

  lines.push('', `Diminta oleh: <@${params.requesterId}>`);

  const embed = createBaseEmbed({
    title: 'MIDWAVE AUTO DOWNLOADER',
    description: lines.join('\n'),
    color: COLORS.WARNING,
    includeThumbnail: false,
  });

  const components = [];
  if (params.primaryCdnUrl && params.primaryCdnUrl.length <= 512) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Tonton / Unduh Video')
          .setStyle(ButtonStyle.Link)
          .setURL(params.primaryCdnUrl),
      ),
    );
  }

  return { embeds: [embed], components };
}

/**
 * Detects TikTok & Instagram links inside regular chat messages and auto-downloads them via RapidAPI.
 */
export class AutoDownloaderHandler {
  /**
   * @param {{
   *   cooldowns: import('../utils/cooldown.js').CooldownManager,
   *   prefix?: string,
   *   downloadFn?: typeof downloadViaRapidApi,
   *   getConfig?: typeof getRapidApiConfig,
   *   logger?: Console,
   * }} options
   */
  constructor({
    cooldowns,
    prefix = '!',
    downloadFn = downloadViaRapidApi,
    getConfig = getRapidApiConfig,
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
    if (!config.configured) {
      return false;
    }

    const perms = checkBotChannelPermissions(message);
    if (!perms.canSend) {
      return false;
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
      const downloaderConfig =
        config.fullConfig ||
        getDownloaderConfig({
          RAPIDAPI_KEY: config.apiKey,
          RAPIDAPI_HOST: config.apiHost,
          RAPIDAPI_ENDPOINT: config.endpoint,
        });

      result = await this.downloadFn({
        url: validated.normalizedUrl,
        platform: validated.platform,
        config: downloaderConfig,
      });

      const items = result.items || result.attachments || [];
      if (result.mode === 'attachments' && perms.canAttach && items.length > 0) {
        const files = items
          .slice(0, MAX_DISCORD_ATTACHMENTS)
          .map((item) => new AttachmentBuilder(item.filePath || item.buffer, { name: item.fileName }));

        const embed = buildAutoDownloadEmbed({
          platform: result.platform,
          author: result.author,
          title: result.title,
          formattedSize: result.formattedSize,
          attachmentCount: files.length,
          truncatedCount: result.truncatedCount,
          requesterId: message.author.id,
        });

        await sendMessageReply(message, { embeds: [embed], files });
      } else {
        const fallbackPayload = buildFallbackCdnResponse({
          platform: result.platform,
          author: result.author,
          title: result.title,
          reason:
            result.mode === 'attachments' && !perms.canAttach
              ? 'Bot tidak memiliki izin `Attach Files` di channel ini; gunakan tautan CDN langsung berikut.'
              : result.reason || 'File melebihi batas lampiran 10 MB Discord.',
          primaryCdnUrl: result.primaryCdnUrl,
          cdnLinks: result.cdnLinks,
          requesterId: message.author.id,
        });

        await sendMessageReply(message, fallbackPayload);
      }

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

      const userMessage =
        error instanceof DownloaderError
          ? error.userMessage
          : 'Gagal mengunduh media dari tautan tersebut. Pastikan postingan bersifat publik.';

      await sendMessageReply(message, {
        embeds: [buildErrorEmbed(userMessage, 'Gagal Mengunduh Media')],
      }).catch(() => {});
      return true;
    } finally {
      if (result?.jobDir) {
        await cleanupTempDir(result.jobDir);
      }
    }
  }
}
