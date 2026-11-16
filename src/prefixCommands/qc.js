import { AttachmentBuilder, MessageFlags } from 'discord.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';
import {
  QC_ATTACHMENT_NAME,
  renderQcPng,
  validateQcText,
} from '../utils/qcGenerator.js';

/**
 * Extracts text from a Discord message (reply or context menu).
 * Never extracts username, display name, or avatar.
 * @param {import('discord.js').Message | null | undefined} targetMessage
 * @returns {{ rawText: string }}
 */
export function extractQcSourceFromMessage(targetMessage) {
  if (!targetMessage) {
    throw new Error('Pesan target tidak ditemukan atau sudah dihapus.');
  }

  const cleanText =
    typeof targetMessage.cleanContent === 'string' && targetMessage.cleanContent.trim()
      ? targetMessage.cleanContent
      : typeof targetMessage.content === 'string' && targetMessage.content.trim()
        ? targetMessage.content
        : '';

  if (!cleanText) {
    throw new Error('Pesan yang dipilih tidak memiliki teks untuk dibuatkan gambar QC.');
  }

  return { rawText: cleanText };
}

/**
 * Fetches the replied message when `!qc` is invoked without manual text.
 * @param {import('discord.js').Message} message
 * @param {string} prefix
 * @returns {Promise<import('discord.js').Message>}
 */
async function resolveRepliedMessage(message, prefix = '!') {
  const refId = message?.reference?.messageId;
  if (!refId) {
    throw new Error(
      `Masukkan teks atau reply sebuah pesan terlebih dahulu.\nContoh: \`${prefix}qc Halo, apa kabar?\` atau reply pesan lalu ketik \`${prefix}qc\`.`,
    );
  }

  let referenced = null;
  try {
    if (typeof message.fetchReference === 'function') {
      referenced = await message.fetchReference();
    } else if (typeof message.channel?.messages?.fetch === 'function') {
      referenced = await message.channel.messages.fetch(refId);
    }
  } catch {
    referenced = null;
  }

  if (!referenced) {
    throw new Error('Gagal mengambil pesan yang direply. Pastikan pesan tersebut masih tersedia.');
  }

  return referenced;
}

/**
 * Shared validation, rendering, and response sender for `/media action:qc`, `!qc`, and `Generate QC`.
 * @param {import('discord.js').Interaction} interaction
 * @param {{ rawText: string, timestamp?: Date | number, context?: { renderQcPng?: typeof renderQcPng, timeZone?: string } }} params
 */
export async function renderAndReplyQc(interaction, { rawText, timestamp, context = {} }) {
  let validatedText;
  try {
    validatedText = validateQcText(rawText);
  } catch (error) {
    await interaction.reply({
      embeds: [buildErrorEmbed(error instanceof Error ? error.message : 'Teks tidak valid.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const renderer = context.renderQcPng ?? renderQcPng;
    const pngBuffer = await renderer(validatedText, {
      timestamp: timestamp ?? new Date(),
      timeZone: context.timeZone,
    });
    const attachment = new AttachmentBuilder(pngBuffer, { name: QC_ATTACHMENT_NAME });
    await interaction.editReply({ files: [attachment] });
  } catch (error) {
    console.error('[QC] Render failed:', sanitizeError(error));
    await interaction.editReply({
      embeds: [buildErrorEmbed('Gagal merender gambar QC. Silakan coba lagi.')],
    });
  }
}

/**
 * Executes QC generation for both `/media action:qc` and `!qc`.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ prefix?: string, renderQcPng?: typeof renderQcPng, timeZone?: string }} [context]
 */
export async function execute(interaction, context = {}) {
  const prefix = context.prefix ?? '!';
  const manualText = interaction.options?.getString?.('text', false) ?? null;

  let rawText = manualText;

  if (!rawText || !rawText.trim()) {
    if (interaction.message) {
      try {
        const repliedMsg = await resolveRepliedMessage(interaction.message, prefix);
        const extracted = extractQcSourceFromMessage(repliedMsg);
        rawText = extracted.rawText;
      } catch (error) {
        await interaction.reply({
          embeds: [buildErrorEmbed(error instanceof Error ? error.message : 'Input QC tidak valid.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
  }

  await renderAndReplyQc(interaction, { rawText, timestamp: new Date(), context });
}

export default { name: 'qc', execute };
