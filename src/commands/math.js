import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { getEmoji } from '../config/emojis.js';
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
 * Builds the minimalist Midwave Math embed containing only Input and Output.
 * @param {{ input: string, formattedResult: string }} result
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildMathEmbed({ input, formattedResult }) {
  const safeInput = input.replace(/`/g, "'");
  return createBaseEmbed({
    color: COLORS.PRIMARY,
    includeThumbnail: false,
  })
    .addFields(
      { name: 'Input', value: `\`${safeInput}\``, inline: false },
      { name: 'Output', value: `\`${formattedResult}\``, inline: false },
    );
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
      embeds: [
        buildErrorEmbed(
          error instanceof Error ? error.message : 'Ekspresi matematika tidak valid.',
          `${getEmoji('calculator')} Midwave Math`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: [buildMathEmbed(result)],
  });
}

export default { data, execute };
