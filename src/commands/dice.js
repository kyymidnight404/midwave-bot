import { SlashCommandBuilder } from 'discord.js';
import { DICE_CONFIG, GAME_TYPES } from '../utils/constants.js';
import { handleChallengeCommand, handleInstantSoloCommand } from '../utils/gameCommandHelpers.js';

export default {
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Lempar dadu secara Solo atau adu angka dalam Multiplayer')
    .addSubcommand((sub) =>
      sub
        .setName('solo')
        .setDescription('Lempar dadu secara solo')
        .addIntegerOption((opt) =>
          opt
            .setName('count')
            .setDescription(`Jumlah dadu (${DICE_CONFIG.MIN_COUNT}–${DICE_CONFIG.MAX_COUNT}, default 1)`)
            .setMinValue(DICE_CONFIG.MIN_COUNT)
            .setMaxValue(DICE_CONFIG.MAX_COUNT),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('sides')
            .setDescription(`Jumlah sisi per dadu (${DICE_CONFIG.MIN_SIDES}–${DICE_CONFIG.MAX_SIDES}, default 6)`)
            .setMinValue(DICE_CONFIG.MIN_SIDES)
            .setMaxValue(DICE_CONFIG.MAX_SIDES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('challenge')
        .setDescription('Tantang pemain lain adu lempar dadu')
        .addUserOption((opt) =>
          opt.setName('opponent').setDescription('Pemain yang ingin ditantang').setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('count')
            .setDescription(`Jumlah dadu (${DICE_CONFIG.MIN_COUNT}–${DICE_CONFIG.MAX_COUNT}, default 1)`)
            .setMinValue(DICE_CONFIG.MIN_COUNT)
            .setMaxValue(DICE_CONFIG.MAX_COUNT),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('sides')
            .setDescription(`Jumlah sisi per dadu (${DICE_CONFIG.MIN_SIDES}–${DICE_CONFIG.MAX_SIDES}, default 6)`)
            .setMinValue(DICE_CONFIG.MIN_SIDES)
            .setMaxValue(DICE_CONFIG.MAX_SIDES),
        ),
    ),

  async execute(interaction, context) {
    const sub = interaction.options.getSubcommand();
    const count = interaction.options.getInteger('count') ?? DICE_CONFIG.DEFAULT_COUNT;
    const sides = interaction.options.getInteger('sides') ?? DICE_CONFIG.DEFAULT_SIDES;

    if (sub === 'solo') {
      await handleInstantSoloCommand(interaction, context, {
        gameType: GAME_TYPES.DICE,
        config: { count, sides },
        action: {},
      });
      return;
    }

    if (sub === 'challenge') {
      await handleChallengeCommand(interaction, context, {
        gameType: GAME_TYPES.DICE,
        config: { count, sides },
        details: `Konfigurasi: **${count}d${sides}**`,
      });
    }
  },
};
