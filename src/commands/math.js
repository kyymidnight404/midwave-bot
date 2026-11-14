import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS } from '../utils/constants.js';
import { buildErrorEmbed, createBaseEmbed } from '../utils/embeds.js';
import { evaluateMathExpression, MATH_MAX_LENGTH } from '../utils/mathEvaluator.js';

export const data = new SlashCommandBuilder()
  .setName('math')
  .setDescription('Hitung ekspresi matematika secara aman dan cepat')
  .addStringOption((option) =>
    option
      .setName('expression')
      .setDescription(`Ekspresi matematika (maksimal ${MATH_MAX_LENGTH} karakter)`)
      .setRequired(true)
      .setMaxLength(MATH_MAX_LENGTH),
  );

/**
 * Builds the MIDWAVE CALCULATOR embed with consistent Midnight Ocean styling.
 * @param {{ input: string, formattedResult: string, operation: string }} result
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildMathEmbed({ input, formattedResult, operation }) {
  const safeInput = input.replace(/`/g, "'");
  return createBaseEmbed({
    title: 'MIDWAVE CALCULATOR',
    color: COLORS.PRIMARY,
    includeThumbnail: false,
  })
    .addFields(
      { name: 'Input', value: `\`${safeInput}\``, inline: false },
      { name: 'Result', value: `\`${formattedResult}\``, inline: false },
      {
        name: 'Additional Information',
        value: `• Operation: ${operation}\n• Status: Success`,
        inline: false,
      },
    )
    .setFooter({ text: 'Midwave • Math Utility' });
}

/**
 * Executes the `/math` and `!math` calculator command.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const rawExpression = interaction.options.getString('expression', true);

  let result;
  try {
    result = evaluateMathExpression(rawExpression);
  } catch (error) {
    await interaction.reply({
      embeds: [buildErrorEmbed(error instanceof Error ? error.message : 'Ekspresi matematika tidak valid.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: [buildMathEmbed(result)],
  });
}

export default { data, execute };
