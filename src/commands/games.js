import { SlashCommandBuilder } from 'discord.js';
import { buildGamesListEmbed, getLogoFiles } from '../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('games')
    .setDescription('Menampilkan daftar seluruh permainan Midwave beserta cara bermainnya'),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    const embed = buildGamesListEmbed();
    await interaction.reply({
      embeds: [embed],
      files: getLogoFiles(),
    });
  },
};
