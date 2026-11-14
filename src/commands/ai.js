import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  AI_MAX_QUESTION_LENGTH,
  GeminiServiceError,
  mapGeminiErrorToUserMessage,
  validateAiQuestion,
} from '../services/gemini.js';
import { askAiWithWebSearch } from '../services/webSearch/index.js';
import {
  DISCORD_EMBED_DESCRIPTION_LIMIT,
  buildWebSearchEmbed,
  formatDiscordAiChunks,
  sanitizeAiMentions,
} from '../utils/aiFormatter.js';
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
 * Executes the `/ai` and `!ai` command using stateless Gemini AI generation
 * with intent-based Tavily Web Search grounding when real-time info is needed.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{
 *   askGemini?: Function,
 *   askAiWithWebSearch?: typeof askAiWithWebSearch,
 *   geminiOptions?: object,
 *   webSearchOptions?: object,
 * }} [context]
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

  let aiResult;
  let chunks = [];
  try {
    const orchestrateFn = context.askAiWithWebSearch ?? askAiWithWebSearch;
    aiResult = await orchestrateFn(question, {
      userId: interaction.user?.id,
      ...(context.webSearchOptions || {}),
      askGeminiFn: context.askGemini,
      geminiOptions: context.geminiOptions,
    });

    const sanitizedText = sanitizeAiMentions(aiResult?.text).trim();
    if (!sanitizedText) {
      throw new GeminiServiceError(
        'EMPTY_RESPONSE',
        'Gemini AI tidak mengembalikan jawaban yang dapat ditampilkan. Coba ajukan ulang pertanyaanmu.',
      );
    }

    chunks = formatDiscordAiChunks(sanitizedText);
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
    const isWebMode = aiResult?.mode === 'web_search' || aiResult?.mode === 'fallback';

    if (isWebMode) {
      const fullText = sanitizeAiMentions(aiResult.text).trim();
      if (fullText.length <= DISCORD_EMBED_DESCRIPTION_LIMIT) {
        const embed = buildWebSearchEmbed({
          description: fullText,
          sources: aiResult.sources,
          searchedAt: aiResult.searchedAt,
          cached: aiResult.cached,
          mode: aiResult.mode,
          fallbackNotice: aiResult.fallbackNotice,
        });
        await interaction.editReply({
          content: null,
          embeds: [embed],
          allowedMentions: safeMentions,
        });
        return;
      }

      // Long web-grounded answer: split text cleanly across messages and attach sources embed on the last chunk.
      const summaryEmbed = buildWebSearchEmbed({
        description:
          aiResult.fallbackNotice ||
          'Sumber dan waktu pencarian untuk jawaban di atas:',
        sources: aiResult.sources,
        searchedAt: aiResult.searchedAt,
        cached: aiResult.cached,
        mode: aiResult.mode,
      });

      await interaction.editReply({
        content: chunks[0],
        embeds: chunks.length === 1 ? [summaryEmbed] : [],
        allowedMentions: safeMentions,
      });

      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({
          content: chunks[i],
          embeds: i === chunks.length - 1 ? [summaryEmbed] : [],
          allowedMentions: safeMentions,
        });
      }
      return;
    }

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
