import { SlashCommandBuilder } from 'discord.js';
import { SOCIAL_INTERACTIONS } from '../services/otakuGifsService.js';
import { executeSocialAction } from '../utils/socialCommand.js';

const SOCIAL_ACTION_CHOICES = Object.values(SOCIAL_INTERACTIONS).map((item) => ({
  name: `${item.command} — ${item.description}`,
  value: item.command,
}));

export const data = new SlashCommandBuilder()
  .setName('social')
  .setDescription('Lakukan interaksi sosial dan ekspresi dengan GIF anime')
  .addStringOption((option) =>
    option
      .setName('action')
      .setDescription('Jenis interaksi sosial atau ekspresi')
      .setRequired(true)
      .addChoices(...SOCIAL_ACTION_CHOICES),
  )
  .addUserOption((option) =>
    option
      .setName('user')
      .setDescription('Pengguna target (wajib untuk hug, pat, slap, bonk, poke, yeet, highfive, wave)')
      .setRequired(false),
  );

/**
 * Executes the consolidated `/social` slash command.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{ getReactionGif?: (reaction: string) => Promise<string> }} [context]
 */
export async function execute(interaction, context = {}) {
  const action = interaction.options?.getString?.('action', false) ?? '';
  return executeSocialAction(interaction, action, context);
}

export default { data, execute };
