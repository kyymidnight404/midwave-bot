import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  AI_MAX_QUESTION_LENGTH,
  GeminiServiceError,
  askGemini,
  mapGeminiErrorToUserMessage,
  validateAiQuestion,
} from '../services/gemini.js';
import { formatDiscordAiChunks } from '../utils/aiFormatter.js';
import { buildErrorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('ai')
  .setDescription('Tanya apa saja ke Midwave AI (stateless, tanpa riwayat percakapan)')
  .addStringOption((option) =>
    option
      .setName('question')
      .setDescription(`Pertanyaan untuk Midwave AI (maksimal ${AI_MAX_QUESTION_LENGTH} karakter)`)
      .setRequired(true)
      .setMaxLength(AI_MAX_QUESTION_LENGTH),
  );

/**
 * Safely edits or sends a fallback error embed if Discord delivery permits.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} message
 */
async function sendSafeAiError(interaction, message) {
  try {
    await interaction.editReply({
      content: null,
      embeds: [buildErrorEmbed(message)],
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (sendErr) {
    console.error('[AI] Failed to deliver error embed:', sendErr?.code ?? sendErr?.message ?? 'unknown');
  }
}

/**
 * Executes the `/ai` and `!ai` command using stateless Gemini AI generation.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ askGemini?: typeof askGemini, geminiOptions?: object }} [context]
 */
export async function execute(interaction, context = {}) {
  if (interaction.user?.bot) {
    return;
  }

  const rawQuestion = interaction.options.getString('question', false) ?? '';
  let question;
  try {
    question = validateAiQuestion(rawQuestion);
  } catch (error) {
    await interaction.reply({
      embeds: [buildErrorEmbed(error.message)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  let chunks;
  try {
    const askFn = context.askGemini ?? askGemini;
    const result = await askFn(question, context.geminiOptions);
    chunks = formatDiscordAiChunks(result?.text);
    if (chunks.length === 0) {
      throw new GeminiServiceError(
        'EMPTY_RESPONSE',
        'Gemini AI tidak mengembalikan jawaban yang dapat ditampilkan. Coba ajukan ulang pertanyaanmu.',
      );
    }
  } catch (error) {
    const mapped = mapGeminiErrorToUserMessage(error);
    console.error(
      `[AI] Gemini request failed (${mapped.code})${mapped.debugDetail ? ` | ${mapped.debugDetail}` : ''}`,
    );
    await sendSafeAiError(interaction, mapped.message);
    return;
  }

  try {
    const safeMentions = { parse: [], repliedUser: false };
    await interaction.editReply({
      content: chunks[0],
      embeds: [],
      allowedMentions: safeMentions,
    });

    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({
        content: chunks[i],
        allowedMentions: safeMentions,
      });
    }
  } catch (discordError) {
    console.error(
      '[AI] Discord failed to send response:',
      discordError?.code ?? discordError?.message ?? 'unknown',
    );
    await sendSafeAiError(
      interaction,
      'Gagal mengirim jawaban ke channel Discord. Pastikan bot memiliki izin mengirim pesan.',
    );
  }
}

export default { data, execute };
