import { SlashCommandBuilder } from 'discord.js';
import { getLogoFiles } from '../utils/embeds.js';
import {
  buildDynamicHelpEmbed,
  discoverHelpEntries,
} from '../services/helpService.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Tampilkan panduan penggunaan command dan aturan permainan Midwave');

/**
 * Executes the `/help` and `!help` command with dynamic discovery.
 * @param {import('discord.js').ChatInputCommandInteraction | import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
 * @param {object} [context]
 */
export async function execute(interaction, context = {}) {
  const prefix =
    typeof context?.prefix === 'string' && context.prefix.trim() ? context.prefix.trim() : '!';
  const memberPermissions =
    interaction?.memberPermissions ?? interaction?.member?.permissions ?? null;

  const discoverOptions = {
    commandHandler: context?.commandHandler ?? null,
    memberPermissions,
    prefix,
  };
  if (context?.commandStructure) {
    discoverOptions.commandStructure = context.commandStructure;
  }
  if (context?.handlerRegistry) {
    discoverOptions.handlerRegistry = context.handlerRegistry;
  }
  if (context?.registeredPrefixCommands) {
    discoverOptions.registeredPrefixCommands = context.registeredPrefixCommands;
  }

  const entries = discoverHelpEntries(discoverOptions);
  const initialEmbed = buildDynamicHelpEmbed({
    entries,
    categoryKey: 'all',
    prefix,
  });

  await interaction.reply({
    embeds: [initialEmbed],
    files: getLogoFiles(),
    allowedMentions: { parse: [], repliedUser: false },
  });
}

export default { data, execute };
