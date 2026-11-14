import { AttachmentBuilder, MessageFlags } from 'discord.js';
import {
  BRAT_ATTACHMENT_NAME,
  renderBratPngAsync,
  validateBratText,
} from '../utils/bratGenerator.js';
import { buildErrorEmbed } from '../utils/embeds.js';

/**
 * Executes Brat image generation for both `/media action:brat` and `!brat`.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ renderBratPng?: (text: string) => Buffer | Promise<Buffer> }} [context]
 */
export async function execute(interaction, context = {}) {
  const rawText = interaction.options?.getString?.('text', false) ?? '';

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

export default { name: 'brat', execute };
