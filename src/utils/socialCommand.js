import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS } from './constants.js';
import { buildErrorEmbed, createBaseEmbed } from './embeds.js';
import {
  getReactionGif,
  OtakuGifsError,
  SOCIAL_INTERACTIONS,
} from '../services/otakuGifsService.js';

/**
 * Builds the minimalist Midwave Social Interactions embed with direct GIF image.
 * @param {{ message: string, gifUrl: string }} params
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildSocialEmbed({ message, gifUrl }) {
  return createBaseEmbed({
    description: message,
    color: COLORS.PRIMARY,
    includeThumbnail: false,
  })
    .setImage(gifUrl)
    .setFooter({ text: 'Midwave • Social Interactions' });
}

/**
 * Creates a reusable slash + prefix command module for a Midwave social interaction.
 * @param {keyof typeof SOCIAL_INTERACTIONS} commandName
 * @returns {{ data: import('discord.js').SlashCommandBuilder, execute: Function }}
 */
export function createSocialCommand(commandName) {
  const config = SOCIAL_INTERACTIONS[commandName];
  if (!config) {
    throw new Error(`Unknown social interaction command: ${commandName}`);
  }

  const builder = new SlashCommandBuilder()
    .setName(config.command)
    .setDescription(config.description);

  if (config.requiresTarget) {
    builder.addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Pengguna Discord yang menjadi target interaksi')
        .setRequired(true),
    );
  }

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ getReactionGif?: (reaction: string) => Promise<string> }} [context]
   */
  async function execute(interaction, context = {}) {
    const author = interaction.user;
    let target = null;

    if (config.requiresTarget) {
      target = interaction.options.getUser('user', false);
      if (!target) {
        await interaction.reply({
          embeds: [buildErrorEmbed('Kamu harus menyertakan pengguna target yang valid.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (target.bot) {
        await interaction.reply({
          embeds: [buildErrorEmbed('Kamu tidak bisa menargetkan bot dengan interaksi ini.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (target.id === author.id) {
        await interaction.reply({
          embeds: [buildErrorEmbed('Kamu tidak bisa melakukan interaksi ini kepada diri sendiri. Pilih pengguna lain!')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    await interaction.deferReply();

    try {
      const fetchGif = context.getReactionGif ?? getReactionGif;
      const gifUrl = await fetchGif(config.command);
      const authorMention = `<@${author.id}>`;
      const targetMention = target ? `<@${target.id}>` : '';
      const message = config.formatMessage(authorMention, targetMention);

      await interaction.editReply({
        embeds: [buildSocialEmbed({ message, gifUrl })],
      });
    } catch (error) {
      const friendlyMessage =
        error instanceof OtakuGifsError
          ? error.message
          : 'Gagal memuat GIF interaksi sosial. Silakan coba lagi nanti.';
      if (!(error instanceof OtakuGifsError)) {
        console.error(`[Social:${config.command}] Failed:`, error instanceof Error ? error.message : error);
      }
      await interaction.editReply({
        embeds: [buildErrorEmbed(friendlyMessage)],
      });
    }
  }

  return { data: builder, execute };
}
