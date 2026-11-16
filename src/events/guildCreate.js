import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { createBaseEmbed, getIconFiles } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';
import { resolvePrefix } from '../utils/prefixParser.js';

function canSendInChannel(channel, botMember) {
  if (!channel || !channel.isTextBased?.()) return false;
  if (channel.isThread?.()) return false;
  const perms = typeof channel.permissionsFor === 'function' ? channel.permissionsFor(botMember) : null;
  if (!perms) return false;
  return perms.has(PermissionFlagsBits.ViewChannel) &&
    perms.has(PermissionFlagsBits.SendMessages) &&
    perms.has(PermissionFlagsBits.EmbedLinks);
}

/**
 * Resolves the best channel to post an automatic welcome message when the bot joins a guild.
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{ channel: import('discord.js').GuildTextBasedChannel, canAttachFiles: boolean } | null>}
 */
export async function resolveBotJoinChannel(guild) {
  if (!guild) return null;

  const botMember = guild.members?.me ?? (await guild.members?.fetchMe?.().catch(() => null));
  if (!botMember) return null;

  const checkPerms = (channel) => {
    const perms = typeof channel.permissionsFor === 'function' ? channel.permissionsFor(botMember) : null;
    return {
      canAttachFiles: Boolean(perms?.has(PermissionFlagsBits.AttachFiles)),
    };
  };

  if (canSendInChannel(guild.systemChannel, botMember)) {
    return { channel: guild.systemChannel, ...checkPerms(guild.systemChannel) };
  }

  const channels = guild.channels?.cache ? [...guild.channels.cache.values()] : [];
  const candidates = channels
    .filter((ch) => canSendInChannel(ch, botMember))
    .sort((a, b) => {
      const aText = a.type === ChannelType.GuildText ? 0 : 1;
      const bText = b.type === ChannelType.GuildText ? 0 : 1;
      if (aText !== bText) return aText - bText;
      return (a.position ?? 0) - (b.position ?? 0);
    });

  if (candidates.length === 0) return null;
  return { channel: candidates[0], ...checkPerms(candidates[0]) };
}

/**
 * Builds the automatic welcome embed shown when Midwave joins a new Discord server.
 * Uses `assets/icon/join.png` (wave icon) without an embed footer.
 * @param {import('discord.js').Guild} guild
 * @param {{ prefix?: string, includeThumbnail?: boolean }} [options]
 */
export function buildBotJoinEmbed(guild, { prefix = '!', includeThumbnail = true } = {}) {
  const guildName = guild?.name?.trim() || 'server ini';
  return createBaseEmbed({
    title: `Halo, ${guildName}! 👋`,
    description:
      `Terima kasih sudah mengundang **Midwave** ke **${guildName}**!\n\n` +
      `Ketik \`${prefix}menu\` atau \`/help\` untuk melihat daftar fitur yang tersedia:\n` +
      `• 🤖 **AI:** \`${prefix}ai\` atau \`/ai\`\n` +
      `• 🌤️ **Cuaca BMKG:** \`${prefix}weather <lokasi>\` atau \`/weather\`\n` +
      `• 🎮 **Mini Games:** \`${prefix}coinflip\`, \`${prefix}rps\`, \`${prefix}ttt @teman\`, \`${prefix}quiz\`\n` +
      `• 🛠️ **Media & Utilitas:** \`${prefix}qc\`, \`${prefix}brat\`, \`${prefix}lyrics\`, \`${prefix}download\`, \`${prefix}math\`, \`${prefix}igf\``,
    color: COLORS.PRIMARY,
    includeThumbnail,
    iconName: 'join',
  });
}

export default {
  name: Events.GuildCreate,
  once: false,
  async execute(guild, context = {}) {
    try {
      const target = await resolveBotJoinChannel(guild);
      if (!target) return;

      const prefix = resolvePrefix(context?.prefix ?? process.env.PREFIX);
      const embed = buildBotJoinEmbed(guild, {
        prefix,
        includeThumbnail: target.canAttachFiles,
      });

      await target.channel.send({
        embeds: [embed],
        files: target.canAttachFiles ? getIconFiles('join') : [],
      });
    } catch (error) {
      context.logger?.warn?.(
        `[GuildCreate] Failed sending welcome embed for guild ${guild?.id}:`,
        sanitizeError(error),
      );
    }
  },
};
