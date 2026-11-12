import { SlashCommandBuilder } from 'discord.js';
import { buildHelpEmbed, getLogoFiles } from '../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Menampilkan panduan penggunaan Midwave dan alur bermain Solo/Multiplayer'),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ prefix?: string }} [context]
   */
  async execute(interaction, context = {}) {
    const embed = buildHelpEmbed(context?.prefix);
    await interaction.reply({
      embeds: [embed],
      files: getLogoFiles(),
    });
  },
};
