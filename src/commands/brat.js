import { AttachmentBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  BRAT_ATTACHMENT_NAME,
  BRAT_MAX_LENGTH,
  renderBratPngAsync,
  validateBratText,
} from '../utils/bratGenerator.js';
import { buildErrorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('brat')
  .setDescription('Buat gambar teks bergaya Brat minimalis (1024x1024 PNG)')
  .addStringOption((option) =>
    option
      .setName('text')
      .setDescription(`Teks yang ingin ditampilkan (maksimal ${BRAT_MAX_LENGTH} karakter)`)
      .setRequired(true)
      .setMaxLength(BRAT_MAX_LENGTH),
  );

/**
 * Executes the `/brat` utility command.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ renderBratPng?: (text: string) => Buffer | Promise<Buffer> }} [context]
 */
export async function execute(interaction, context = {}) {
  const rawText = interaction.options.getString('text', true);

  try {
    validateBratText(rawText);
  } catch (error) {
    await interaction.reply({
      embeds: [buildErrorEmbed(error.message)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const renderer = context.renderBratPng ?? renderBratPngAsync;
    const pngBuffer = await renderer(rawText);
    const attachment = new AttachmentBuilder(pngBuffer, { name: BRAT_ATTACHMENT_NAME });

    await interaction.editReply({ files: [attachment] });
  } catch (error) {
    console.error('[Brat] Render failed:', error instanceof Error ? error.message : error);
    await interaction.editReply({
      embeds: [buildErrorEmbed('Gagal merender gambar Brat. Silakan coba lagi.')],
    });
  }
}

export default { data, execute };
