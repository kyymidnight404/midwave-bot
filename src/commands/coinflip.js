import { SlashCommandBuilder } from 'discord.js';
import { GAME_TYPES } from '../utils/constants.js';
import {
  handleChallengeCommand,
  handleInstantSoloCommand,
  handleSessionActionCommand,
} from '../utils/gameCommandHelpers.js';

const COIN_CHOICES_OPT = [
  { name: 'Heads', value: 'heads' },
  { name: 'Tails', value: 'tails' },
];

export default {
  data: new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Mainkan Coin Flip dalam mode Solo atau Multiplayer')
    .addSubcommand((sub) =>
      sub
        .setName('solo')
        .setDescription('Tebak lemparan koin melawan bot')
        .addStringOption((opt) =>
          opt
            .setName('choice')
            .setDescription('Pilihan sisi koin')
            .setRequired(true)
            .addChoices(...COIN_CHOICES_OPT),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('challenge')
        .setDescription('Tantang pemain lain bermain Coin Flip')
        .addUserOption((opt) =>
          opt.setName('opponent').setDescription('Pemain yang ingin ditantang').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('choose')
        .setDescription('Kirim prediksi rahasiamu pada pertandingan Coin Flip aktif')
        .addStringOption((opt) =>
          opt
            .setName('choice')
            .setDescription('Pilihan sisi koin')
            .setRequired(true)
            .addChoices(...COIN_CHOICES_OPT),
        ),
    ),

  async execute(interaction, context) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'solo') {
      const choice = interaction.options.getString('choice', true);
      await handleInstantSoloCommand(interaction, context, {
        gameType: GAME_TYPES.COINFLIP,
        action: { choice },
      });
      return;
    }

    if (sub === 'challenge') {
      await handleChallengeCommand(interaction, context, {
        gameType: GAME_TYPES.COINFLIP,
      });
      return;
    }

    if (sub === 'choose') {
      const choice = interaction.options.getString('choice', true);
      await handleSessionActionCommand(interaction, context, {
        gameType: GAME_TYPES.COINFLIP,
        action: { choice },
        formatEphemeralMessage: (outcome) =>
          outcome.finished
            ? `Prediksi rahasiamu (**${choice}**) tercatat. Kedua pemain sudah memilih — hasil diumumkan di papan!`
            : `Prediksi rahasiamu (**${choice}**) telah dikunci secara privat. Menunggu lawan memilih.`,
      });
    }
  },
};
