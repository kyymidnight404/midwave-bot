import { EmbedBuilder } from 'discord.js';
import { COLORS } from '../config/colors.js';

export const ABOUT_AUTHOR_NAME = 'Midwave';
export const ABOUT_DESCRIPTION = [
  'A multifunctional Discord companion.',
  '',
  'Midwave is a friendly and versatile Discord bot designed to bring convenience and entertainment to your server. From AI assistance and media downloads to social interactions, mini-games, and useful utilities, Midwave makes your Discord experience more enjoyable.',
].join('\n');
export const ABOUT_FOOTER_TEXT = 'Developed by kyymidnight';

/**
 * Resolves the bot avatar URL safely without throwing on partial or mocked clients.
 * @param {import('discord.js').Client | null | undefined} client
 * @returns {string | undefined}
 */
export function resolveBotAvatarUrl(client) {
  const botUser = client?.user;
  if (!botUser) {
    return undefined;
  }

  if (typeof botUser.displayAvatarURL === 'function') {
    const url = botUser.displayAvatarURL({ size: 256 });
    if (typeof url === 'string' && url.trim()) {
      return url.trim();
    }
  }

  if (typeof botUser.avatarURL === 'function') {
    const url = botUser.avatarURL({ size: 256 });
    if (typeof url === 'string' && url.trim()) {
      return url.trim();
    }
  }

  if (typeof botUser.avatar === 'string' && botUser.avatar.trim() && botUser.id) {
    return `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`;
  }

  return undefined;
}

/**
 * Builds the minimalist `!about` Discord embed.
 * @param {{ client?: import('discord.js').Client | null }} [options]
 * @returns {EmbedBuilder}
 */
export function buildAboutEmbed({ client = null } = {}) {
  const iconURL = resolveBotAvatarUrl(client);
  const author = iconURL
    ? { name: ABOUT_AUTHOR_NAME, iconURL }
    : { name: ABOUT_AUTHOR_NAME };

  return new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setAuthor(author)
    .setDescription(ABOUT_DESCRIPTION)
    .setFooter({ text: ABOUT_FOOTER_TEXT });
}

/**
 * Executes the `!about` prefix command.
 * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter | import('discord.js').Message} interactionOrMessage
 * @param {object} [context]
 */
export async function execute(interactionOrMessage, context = {}) {
  if (!interactionOrMessage) {
    return;
  }

  if (interactionOrMessage.author?.bot || interactionOrMessage.user?.bot) {
    return;
  }

  const client = context?.client ?? interactionOrMessage?.client ?? interactionOrMessage?.message?.client ?? null;
  const embed = buildAboutEmbed({ client });

  await interactionOrMessage.reply({
    embeds: [embed],
    allowedMentions: { parse: [], repliedUser: false },
  });
}

export default {
  name: 'about',
  execute,
};
