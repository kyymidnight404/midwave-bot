import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { createBaseEmbed, getIconFiles } from '../utils/embeds.js';

export const DONATE_TITLE = '☕ Buy Me a Coffee?';
export const DONATE_DESCRIPTION =
  'Enjoying Midwave? Consider buying me a coffee! Every little support helps keep this project alive. Thank you for being here! 💙';
export const DONATE_FOOTER = 'Thank you for supporting Midwave!';

export const DONATE_LINKS = Object.freeze([
  Object.freeze({
    label: '🇮🇩 Donate via Saweria',
    url: 'https://saweria.co/kyymidnight',
  }),
  Object.freeze({
    label: '🌍 Donate via Ko-fi',
    url: 'https://ko-fi.com/kyymidnight',
  }),
]);

export const data = new SlashCommandBuilder()
  .setName('donate')
  .setDescription('Dukung pengembangan Midwave melalui Saweria atau Ko-fi');

/**
 * Builds the Midwave-themed `/donate` embed.
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildDonateEmbed() {
  return createBaseEmbed({
    title: DONATE_TITLE,
    description: DONATE_DESCRIPTION,
    color: COLORS.PRIMARY,
    includeThumbnail: true,
    iconName: 'donate',
    footer: DONATE_FOOTER,
  });
}

/**
 * Builds the ActionRow containing Discord Link Buttons for Saweria and Ko-fi.
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildDonateComponents() {
  const buttons = DONATE_LINKS.map((link) =>
    new ButtonBuilder()
      .setLabel(link.label)
      .setStyle(ButtonStyle.Link)
      .setURL(link.url),
  );

  return new ActionRowBuilder().addComponents(...buttons);
}

/**
 * Executes the `/donate` slash command.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  await interaction.reply({
    embeds: [buildDonateEmbed()],
    components: [buildDonateComponents()],
    files: getIconFiles('donate'),
    allowedMentions: { parse: [], repliedUser: false },
  });
}

export default { data, execute };
