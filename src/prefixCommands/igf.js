import { AttachmentBuilder } from 'discord.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import {
  IGF_ATTACHMENT_NAME,
  IGF_MAX_AVATAR_BYTES,
  IGF_MAX_IMAGE_BYTES,
  fetchValidatedImageBuffer,
  renderInstagramFrame,
  validateImageAttachmentMetadata,
} from '../utils/igfGenerator.js';

function toAttachmentArray(attachments) {
  if (!attachments) return [];
  if (Array.isArray(attachments)) return attachments;
  if (typeof attachments.values === 'function') return Array.from(attachments.values());
  return [];
}

/**
 * Builds clear usage instructions for `!igf` error responses.
 * @param {string} prefix
 * @returns {string}
 */
function buildIgfFormatGuide(prefix = '!') {
  return [
    '**Format Penggunaan:**',
    `• Upload **1 gambar** bersama \`${prefix}igf\` atau \`${prefix}igf <caption opsional>\``,
    `• Atau **reply** pesan yang berisi **1 gambar** lalu ketik \`${prefix}igf\` / \`${prefix}igf <caption opsional>\``,
    '• Format didukung: `PNG`, `JPG/JPEG`, `WebP`, `GIF` (maks. 10 MB)',
  ].join('\n');
}

/**
 * Resolves the single image attachment from the command message or its replied message.
 * @param {import('discord.js').Message} message
 * @param {string} [prefix]
 * @returns {Promise<import('discord.js').Attachment>}
 */
export async function resolveIgfAttachment(message, prefix = '!') {
  const formatGuide = buildIgfFormatGuide(prefix);
  const ownAttachments = toAttachmentArray(message?.attachments);
  if (ownAttachments.length > 1) {
    throw new Error(`Kirim hanya satu gambar untuk perintah \`${prefix}igf\`.\n\n${formatGuide}`);
  }
  if (ownAttachments.length === 1) {
    return ownAttachments[0];
  }

  const refMessageId = message?.reference?.messageId;
  if (!refMessageId) {
    throw new Error(
      `Kirim satu gambar bersama perintah \`${prefix}igf\` atau reply pesan yang memiliki satu gambar.\n\n${formatGuide}`,
    );
  }

  let referencedMessage = null;
  try {
    if (typeof message.fetchReference === 'function') {
      referencedMessage = await message.fetchReference();
    } else if (typeof message.channel?.messages?.fetch === 'function') {
      referencedMessage = await message.channel.messages.fetch(refMessageId);
    }
  } catch {
    referencedMessage = null;
  }

  if (!referencedMessage) {
    throw new Error('Gagal mengambil pesan yang direply. Pastikan pesan tersebut masih tersedia.');
  }

  const refAttachments = toAttachmentArray(referencedMessage.attachments);
  if (refAttachments.length === 0) {
    throw new Error(`Pesan yang direply tidak memiliki attachment gambar.\n\n${formatGuide}`);
  }
  if (refAttachments.length > 1) {
    throw new Error(
      `Pesan yang direply memiliki lebih dari satu attachment. Pilih pesan dengan satu gambar saja.\n\n${formatGuide}`,
    );
  }

  return refAttachments[0];
}

/**
 * Executes the `!igf` prefix command to generate a 1080x1080 minimalist Instagram Post Frame.
 * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} adapter
 * @param {{ prefix?: string, fetchFn?: typeof fetch, renderInstagramFrame?: typeof renderInstagramFrame }} [context]
 */
export async function executeIgf(adapter, context = {}) {
  const message = adapter.message;
  const prefix = context.prefix ?? '!';
  let attachment;

  try {
    attachment = await resolveIgfAttachment(message, prefix);
    validateImageAttachmentMetadata(attachment);
  } catch (error) {
    await adapter.reply({
      embeds: [buildErrorEmbed(error instanceof Error ? error.message : 'Input gambar tidak valid.')],
    });
    return;
  }

  await adapter.deferReply();

  let photoBuffer = null;
  let avatarBuffer = null;

  try {
    const username =
      message.member?.displayName || message.author.globalName || message.author.username;
    const caption = adapter.options?.getString?.('caption') ?? null;
    const avatarUrl = message.author.displayAvatarURL({ extension: 'png', size: 256 });
    const fetchFn = context.fetchFn ?? globalThis.fetch;

    [photoBuffer, avatarBuffer] = await Promise.all([
      fetchValidatedImageBuffer(attachment.url, {
        kind: 'photo',
        maxBytes: IGF_MAX_IMAGE_BYTES,
        fetchFn,
      }),
      fetchValidatedImageBuffer(avatarUrl, {
        kind: 'avatar',
        maxBytes: IGF_MAX_AVATAR_BYTES,
        fetchFn,
      }),
    ]);

    const renderer = context.renderInstagramFrame ?? renderInstagramFrame;
    const pngBuffer = await renderer({ photoBuffer, avatarBuffer, username, caption });
    const file = new AttachmentBuilder(pngBuffer, { name: IGF_ATTACHMENT_NAME });

    await adapter.editReply({ files: [file] });
  } catch (error) {
    const msg =
      error instanceof Error && error.message
        ? error.message
        : 'Gagal membuat Instagram post frame. Silakan coba lagi.';
    await adapter.editReply({
      embeds: [buildErrorEmbed(msg)],
    });
  } finally {
    photoBuffer = null;
    avatarBuffer = null;
  }
}

export default { name: 'igf', execute: executeIgf };
