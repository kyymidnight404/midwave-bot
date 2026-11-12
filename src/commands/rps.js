import { SlashCommandBuilder } from 'discord.js';
import { GAME_TYPES } from '../utils/constants.js';
import {
  handleChallengeCommand,
  handleInstantSoloCommand,
  handleSessionActionCommand,
} from '../utils/gameCommandHelpers.js';

const RPS_CHOICES_OPT = [
  { name: 'Rock (Batu)', value: 'rock' },
  { name: 'Paper (Kertas)', value: 'paper' },
  { name: 'Scissors (Gunting)', value: 'scissors' },
];

export default {
  data: new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Mainkan Rock Paper Scissors dalam mode Solo atau Multiplayer')
    .addSubcommand((sub) =>
      sub
        .setName('solo')
        .setDescription('Lawan Midwave Bot di Rock Paper Scissors')
        .addStringOption((opt) =>
          opt
            .setName('choice')
            .setDescription('Pilihanmu')
            .setRequired(true)
            .addChoices(...RPS_CHOICES_OPT),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('challenge')
        .setDescription('Tantang pemain lain di Rock Paper Scissors')
        .addUserOption((opt) =>
          opt.setName('opponent').setDescription('Pemain yang ingin ditantang').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('choose')
        .setDescription('Pilih Rock, Paper, atau Scissors secara rahasia')
        .addStringOption((opt) =>
          opt
            .setName('choice')
            .setDescription('Pilihanmu')
            .setRequired(true)
            .addChoices(...RPS_CHOICES_OPT),
        ),
    ),

  async execute(interaction, context) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'solo') {
      const choice = interaction.options.getString('choice', true);
      await handleInstantSoloCommand(interaction, context, {
        gameType: GAME_TYPES.RPS,
        action: { choice },
      });
      return;
    }

    if (sub === 'challenge') {
      await handleChallengeCommand(interaction, context, {
        gameType: GAME_TYPES.RPS,
      });
      return;
    }

    if (sub === 'choose') {
      const choice = interaction.options.getString('choice', true);
      await handleSessionActionCommand(interaction, context, {
        gameType: GAME_TYPES.RPS,
        action: { choice },
        formatEphemeralMessage: (outcome) =>
          outcome.finished
            ? `Pilihan rahasiamu (**${choice}**) tercatat. Hasil pertandingan ditampilkan di papan!`
            : `Pilihan rahasiamu (**${choice}**) dikunci secara privat. Menunggu lawan memilih.`,
      });
    }
  },
};
