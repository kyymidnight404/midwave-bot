import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { prisma as defaultPrisma } from '../services/prisma.js';
import {
  PING_COOLDOWN_MS,
  PING_CUSTOM_ID_PREFIX,
  PING_REFRESH_CUSTOM_ID,
  buildPingCheckingEmbed,
  buildPingComponents,
  buildPingEmbed,
  collectPingDiagnostics,
  parsePingRefreshCustomId,
} from '../services/pingService.js';
import { buildErrorEmbed, getLogoFiles, hasLogoAsset } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

const IGNORED_DISCORD_ERROR_CODES = new Set([10008, 10062, 40060]);
const MAX_INTERACTION_AGE_MS = 14.5 * 60 * 1000;
const activePingRefreshes = new Set();

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Cek latensi dan diagnostik koneksi serta sistem Midwave');

async function runAndRenderDiagnostics({
  client,
  prisma,
  messageLatencyMs,
  requester,
  requesterId,
  canAttach,
  attachLogoFiles = canAttach,
  context,
}) {
  const report = await collectPingDiagnostics({
    client,
    prisma,
    messageLatencyMs,
    restProbe: context?.restProbe,
    dbProbe: context?.dbProbe,
    restTimeoutMs: context?.restTimeoutMs,
    dbTimeoutMs: context?.dbTimeoutMs,
    minCpuSampleWindowMs: context?.minCpuSampleWindowMs,
  });

  const includeThumbnail = canAttach && hasLogoAsset();
  const embed = buildPingEmbed(report, { requester, includeThumbnail });
  const components = [buildPingComponents({ requesterId })];
  const files = includeThumbnail && attachLogoFiles ? getLogoFiles() : undefined;

  return { report, embed, components, files };
}

/**
 * Executes both `/ping` and `!ping` using the shared diagnostic service.
 * @param {import('discord.js').ChatInputCommandInteraction | import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
 * @param {object} [context]
 */
export async function execute(interaction, context = {}) {
  const client = context?.client ?? interaction?.client ?? null;
  const prisma = context?.prisma ?? defaultPrisma;
  const canAttach = interaction.canAttachFiles !== false;
  const requesterId = interaction.user?.id ?? null;

  const handlerStart =
    typeof context?.handlerStartTime === 'number' ? context.handlerStartTime : performance.now();

  await interaction.reply({
    embeds: [buildPingCheckingEmbed()],
    allowedMentions: { parse: [], repliedUser: false },
  });
  const messageLatencyMs = Math.max(0, Math.round(performance.now() - handlerStart));

  const { embed, components, files } = await runAndRenderDiagnostics({
    client,
    prisma,
    messageLatencyMs,
    requester: interaction.user ?? null,
    requesterId,
    canAttach,
    attachLogoFiles: canAttach,
    context,
  });

  await interaction.editReply({
    embeds: [embed],
    components,
    files: files ?? [],
    allowedMentions: { parse: [], repliedUser: false },
  });
}

/**
 * Handles the Refresh button interaction (`ping:refresh` or `ping:refresh:<ownerId>`).
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} [context]
 */
export async function handlePingInteraction(interaction, context = {}) {
  const parsed = parsePingRefreshCustomId(interaction?.customId);
  if (!parsed.valid) {
    return;
  }

  const userId = interaction.user?.id ?? null;
  if (parsed.ownerId && userId !== parsed.ownerId) {
    try {
      await interaction.reply({
        embeds: [
          buildErrorEmbed(
            'Hanya pengguna yang menjalankan perintah ini yang dapat menekan tombol Refresh.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      // Ignore transient reply errors
    }
    return;
  }

  if (
    typeof interaction.createdTimestamp === 'number' &&
    Date.now() - interaction.createdTimestamp > MAX_INTERACTION_AGE_MS
  ) {
    try {
      await interaction.reply({
        embeds: [buildErrorEmbed('Interaksi ini sudah kedaluwarsa. Jalankan `/ping` atau `!ping` lagi.')],
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      // Ignore expired interaction acknowledgement errors
    }
    return;
  }

  const refreshKey = interaction.message?.id ?? interaction.customId;
  if (activePingRefreshes.has(refreshKey)) {
    try {
      await interaction.reply({
        embeds: [buildErrorEmbed('Diagnostik sedang diperbarui. Harap tunggu sebentar.')],
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      // Ignore transient reply errors
    }
    return;
  }

  const cooldowns = context?.cooldowns;
  if (cooldowns && cooldowns.defaultTtlMs > 0 && userId) {
    const ttl = Math.max(cooldowns.defaultTtlMs, PING_COOLDOWN_MS);
    const cd = cooldowns.tryAcquire(`${userId}:ping:refresh`, ttl);
    if (!cd.allowed) {
      const waitSec = Math.max(0.5, cd.remainingMs / 1000).toFixed(1);
      try {
        await interaction.reply({
          embeds: [buildErrorEmbed(`Terlalu cepat! Tunggu ${waitSec} detik sebelum refresh lagi.`)],
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // Ignore transient reply errors
      }
      return;
    }
  }

  const client = context?.client ?? interaction?.client ?? null;
  const prisma = context?.prisma ?? defaultPrisma;
  const requesterId = parsed.ownerId ?? userId;
  const handlerStart =
    typeof context?.handlerStartTime === 'number' ? context.handlerStartTime : performance.now();

  activePingRefreshes.add(refreshKey);
  try {
    if (typeof interaction.update === 'function') {
      await interaction.update({
        embeds: [buildPingCheckingEmbed()],
        components: [buildPingComponents({ disabled: true, requesterId })],
      });
    } else {
      await interaction.deferUpdate();
    }
    const messageLatencyMs = Math.max(0, Math.round(performance.now() - handlerStart));

    // Avoid re-uploading logo attachment on refresh if the message already carries attachments.
    const hasExistingAttachments = Boolean(interaction.message?.attachments?.size > 0);
    const { embed, components, files } = await runAndRenderDiagnostics({
      client,
      prisma,
      messageLatencyMs,
      requester: interaction.user ?? null,
      requesterId,
      canAttach: true,
      attachLogoFiles: !hasExistingAttachments,
      context,
    });

    const editPayload = {
      embeds: [embed],
      components,
      allowedMentions: { parse: [], repliedUser: false },
    };
    if (files !== undefined) {
      editPayload.files = files;
    }

    await interaction.editReply(editPayload);
  } catch (err) {
    if (IGNORED_DISCORD_ERROR_CODES.has(err?.code)) {
      return;
    }
    context?.logger?.error?.('[Ping] Failed handling refresh interaction:', sanitizeError(err));
    try {
      const errEmbed = buildErrorEmbed('Gagal memperbarui diagnostik koneksi. Silakan coba lagi.');
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ embeds: [errEmbed], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ embeds: [errEmbed], flags: MessageFlags.Ephemeral });
      }
    } catch {
      // Ignore secondary error delivery failures
    }
  } finally {
    activePingRefreshes.delete(refreshKey);
  }
}

export { PING_COOLDOWN_MS, PING_CUSTOM_ID_PREFIX, PING_REFRESH_CUSTOM_ID };
export default { data, execute, PING_COOLDOWN_MS };
