import crypto from 'node:crypto';
import { MessageFlags } from 'discord.js';
import {
  buildFeedbackPromptComponents,
  buildFeedbackPromptEmbed,
  FEEDBACK_COOLDOWN_MS,
  registerFeedbackPrompt,
  resolveFeedbackChannel,
  validateScreenshotUrl,
} from '../services/feedbackService.js';
import { buildErrorEmbed, getIconFiles } from '../utils/embeds.js';

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)(\?.*)?$/i;

function extractOptionalImageAttachment(message) {
  const attachments = message?.attachments;
  if (!attachments) return null;

  const list = typeof attachments.values === 'function' ? [...attachments.values()] : [];
  for (const att of list) {
    const isImage =
      (typeof att?.contentType === 'string' && att.contentType.startsWith('image/')) ||
      (typeof att?.url === 'string' && IMAGE_EXT_RE.test(att.url));
    if (isImage && typeof att.url === 'string') {
      const check = validateScreenshotUrl(att.url);
      if (check.valid && check.url) return check.url;
    }
  }
  return null;
}

export default {
  name: 'feedback',
  /**
   * Executes the `!feedback` prefix command.
   * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
   * @param {object} [context]
   */
  async execute(interaction, context = {}) {
    const logger = context.logger ?? console;
    const userId = interaction.user?.id;

    if (context.cooldowns?.check && userId) {
      const cd = context.cooldowns.check(`feedback:submit:${userId}`);
      if (cd?.onCooldown) {
        const waitSec = Math.max(1, Math.ceil(cd.remainingMs / 1000));
        await interaction.reply({
          embeds: [
            buildErrorEmbed(
              `Anda baru saja mengirim feedback. Tunggu ${waitSec} detik sebelum mengirim lagi.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const channelCheck = await resolveFeedbackChannel(interaction.client ?? context.client, {
      env: context.env ?? process.env,
      logger,
    });

    if (!channelCheck.ok) {
      await interaction.reply({
        embeds: [buildErrorEmbed(channelCheck.userMessage)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const attachmentUrl = extractOptionalImageAttachment(interaction.message);
    const promptId = crypto.randomBytes(4).toString('hex');

    registerFeedbackPrompt(promptId, {
      userId,
      selectedCategory: null,
      attachmentUrl,
    });

    const canAttach = interaction.canAttachFiles !== false;
    const embed = buildFeedbackPromptEmbed({
      selectedCategory: null,
      attachmentUrl,
      includeThumbnail: canAttach,
    });
    const components = buildFeedbackPromptComponents(promptId, userId, {
      selectedCategory: null,
    });

    await interaction.reply({
      embeds: [embed],
      components,
      files: canAttach ? getIconFiles('feedback') : [],
    });
  },
};

export { FEEDBACK_COOLDOWN_MS };
