import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { extractQcSourceFromMessage, renderAndReplyQc } from '../prefixCommands/qc.js';
import { buildErrorEmbed } from '../utils/embeds.js';

export const data = new ContextMenuCommandBuilder()
  .setName('Generate QC')
  .setType(ApplicationCommandType.Message);

/**
 * Executes the "Generate QC" message context menu command.
 * Uses the target message text with the current execution timestamp without username/avatar.
 * @param {import('discord.js').MessageContextMenuCommandInteraction} interaction
 * @param {{ renderQcPng?: Function, timeZone?: string }} [context]
 */
export async function execute(interaction, context = {}) {
  let source;
  try {
    source = extractQcSourceFromMessage(interaction.targetMessage);
  } catch (error) {
    await interaction.reply({
      embeds: [buildErrorEmbed(error instanceof Error ? error.message : 'Pesan tidak dapat diproses.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await renderAndReplyQc(interaction, {
    rawText: source.rawText,
    timestamp: new Date(),
    context,
  });
}

export default { data, execute };
