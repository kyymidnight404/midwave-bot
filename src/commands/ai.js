import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getEmoji } from '../config/emojis.js';
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
import { buildErrorEmbed, buildSuccessEmbed } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

const AI_RESET_COMMAND_REGEX =
  /^(?:(?:reset|clear)(?:\s+(?:chat|riwayat|konteks|history|percakapan))?|hapus\s+(?:riwayat|konteks|percakapan|chat))$/i;

/**
 * Checks whether the user explicitly asked to delete their temporary AI conversation context.
 * @param {string} rawQuestion
 * @returns {boolean}
 */
export function isAiConversationResetCommand(rawQuestion) {
  return typeof rawQuestion === 'string' && AI_RESET_COMMAND_REGEX.test(rawQuestion.trim());
}

export const data = new SlashCommandBuilder()
  .setName('ai')
  .setDescription('Tanya apa saja ke Midwave AI — cerdas, ringkas, dan kontekstual')
  .addStringOption((option) =>
    option
      .setName('question')
      .setDescription(`Pertanyaan untuk Midwave AI (maksimal ${AI_MAX_QUESTION_LENGTH} karakter)`)
      .setRequired(true)
      .setMaxLength(AI_MAX_QUESTION_LENGTH),
  );

/**
 * Extracts text or embed summary from a replied-to Discord message on prefix `!ai`.
 * Never throws or assumes reply presence.
 *
 * @param {import('discord.js').ChatInputCommandInteraction | import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
 * @returns {Promise<string>}
 */
async function extractReplyContext(interaction) {
  const message = interaction?.message;
  if (!message?.reference?.messageId || typeof message.fetchReference !== 'function') {
    return '';
  }

  try {
    const referenced = await message.fetchReference();
    if (!referenced) {
      return '';
    }
    const textPart =
      (typeof referenced.cleanContent === 'string' && referenced.cleanContent.trim()) ||
      (typeof referenced.content === 'string' && referenced.content.trim()) ||
      (typeof referenced.embeds?.[0]?.description === 'string' && referenced.embeds[0].description.trim()) ||
      '';
    if (!textPart) {
      return '';
    }
    const snippet = textPart.slice(0, 1000).trim();
    const isFromBot = Boolean(referenced.author?.bot);
    const label = isFromBot
      ? 'Pesan respons Midwave yang direply pengguna'
      : `Pesan yang direply pengguna (${referenced.author?.globalName || referenced.author?.username || 'pengguna'})`;
    return `${label}:\n${snippet}`;
  } catch {
    return '';
  }
}

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
    console.error('[AI] Failed to deliver error embed:', sanitizeError(sendErr));
  }
}

/**
 * Executes `/ai` and `!ai` with contextual short-term RAM continuity, reply-chain awareness,
 * Global Bot Knowledge grounding, and selective Tavily Web Search.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{
 *   askGemini?: Function,
 *   askAiWithWebSearch?: typeof askAiWithWebSearch,
 *   aiConversationManager?: import('../managers/AiConversationManager.js').AiConversationManager,
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

  const conversationManager = context.aiConversationManager ?? null;
  const scope = {
    guildId: interaction.guildId ?? null,
    channelId: interaction.channelId ?? null,
    userId: interaction.user?.id ?? null,
  };

  if (isAiConversationResetCommand(question)) {
    const removed = conversationManager?.clearConversation?.(scope) ?? false;
    const message = removed
      ? 'Riwayat percakapan sementara kamu di channel ini telah dihapus dari RAM. Pertanyaan berikutnya akan memulai sesi baru.'
      : 'Tidak ada riwayat percakapan aktif untukmu di channel ini (riwayat sementara otomatis terhapus setelah 15 menit tidak aktif).';
    await interaction.reply({
      embeds: [buildSuccessEmbed(message, `${getEmoji('delete')} Riwayat Percakapan Dihapus`)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Questions, optional reply excerpts, and ephemeral 15m context are processed via Google Gemini (and Tavily for real-time web queries).
  await interaction.deferReply();

  const history =
    context.geminiOptions?.history ??
    (conversationManager ? conversationManager.getHistory(scope) : undefined);

  const replyContext = await extractReplyContext(interaction);
  const combinedContextText = [context.geminiOptions?.contextText, replyContext]
    .filter((item) => typeof item === 'string' && item.trim())
    .join('\n\n') || undefined;

  const geminiOptions =
    context.geminiOptions || (Array.isArray(history) && history.length > 0) || combinedContextText
      ? {
          ...(context.geminiOptions || {}),
          ...(Array.isArray(history) && history.length > 0 ? { history } : {}),
          ...(combinedContextText ? { contextText: combinedContextText } : {}),
        }
      : undefined;

  let aiResult;
  let chunks = [];
  let sanitizedText = '';
  try {
    const orchestrateFn = context.askAiWithWebSearch ?? askAiWithWebSearch;
    aiResult = await orchestrateFn(question, {
      userId: interaction.user?.id,
      ...(context.webSearchOptions || {}),
      askGeminiFn: context.askGemini,
      ...(geminiOptions ? { geminiOptions } : {}),
    });

    sanitizedText = sanitizeAiMentions(aiResult?.text).trim();
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

  conversationManager?.appendTurn(scope, question, sanitizedText);

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
    console.error('[AI] Discord failed to send response:', sanitizeError(discordError));
    await sendSafeAiError(
      interaction,
      'Gagal mengirim jawaban ke channel Discord. Pastikan bot memiliki izin mengirim pesan.',
    );
  }
}

export default { data, execute };
