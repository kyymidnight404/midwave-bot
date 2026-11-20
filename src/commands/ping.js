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
} from '../services/pingService.js';
import { buildErrorEmbed, getLogoFiles, hasLogoAsset } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

const IGNORED_DISCORD_ERROR_CODES = new Set([10008, 10062, 40060]);

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Cek latensi dan diagnostik koneksi serta sistem Midwave');

async function runAndRenderDiagnostics({
  client,
  prisma,
  messageLatencyMs,
  requester,
  canAttach,
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
  });

  const includeThumbnail = canAttach && hasLogoAsset();
  const embed = buildPingEmbed(report, { requester, includeThumbnail });
  const components = [buildPingComponents()];
  const files = includeThumbnail ? getLogoFiles() : [];

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

  const replyStart = performance.now();
  await interaction.reply({
    embeds: [buildPingCheckingEmbed()],
    allowedMentions: { parse: [], repliedUser: false },
  });
  const messageLatencyMs = Math.max(0, Math.round(performance.now() - replyStart));

  const { embed, components, files } = await runAndRenderDiagnostics({
    client,
    prisma,
    messageLatencyMs,
    requester: interaction.user ?? null,
    canAttach,
    context,
  });

  await interaction.editReply({
    embeds: [embed],
    components,
    files,
    allowedMentions: { parse: [], repliedUser: false },
  });
}

/**
 * Handles the Refresh button interaction (`ping:refresh`) for `/ping` and `!ping`.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} [context]
 */
export async function handlePingInteraction(interaction, context = {}) {
  if (interaction?.customId !== PING_REFRESH_CUSTOM_ID) {
    return;
  }

  const cooldowns = context?.cooldowns;
  const userId = interaction.user?.id ?? 'unknown';
  if (cooldowns && cooldowns.defaultTtlMs > 0) {
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

  try {
    const ackStart = performance.now();
    await interaction.deferUpdate();
    const messageLatencyMs = Math.max(0, Math.round(performance.now() - ackStart));

    const { embed, components, files } = await runAndRenderDiagnostics({
      client,
      prisma,
      messageLatencyMs,
      requester: interaction.user ?? null,
      canAttach: true,
      context,
    });

    await interaction.editReply({
      embeds: [embed],
      components,
      files,
      allowedMentions: { parse: [], repliedUser: false },
    });
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
  }
}

export { PING_COOLDOWN_MS, PING_CUSTOM_ID_PREFIX, PING_REFRESH_CUSTOM_ID };
export default { data, execute, PING_COOLDOWN_MS };
