import { SlashCommandBuilder } from 'discord.js';
import { GAME_TYPES } from '../utils/constants.js';
import {
  handleChallengeCommand,
  handleSessionActionCommand,
  handleSoloSessionStart,
} from '../utils/gameCommandHelpers.js';

const DIFFICULTY_CHOICES = [
  { name: 'Easy', value: 'easy' },
  { name: 'Normal', value: 'normal' },
  { name: 'Hard', value: 'hard' },
];

export default {
  data: new SlashCommandBuilder()
    .setName('connect4')
    .setDescription('Mainkan Connect Four (7×6) dalam mode Solo atau Multiplayer')
    .addSubcommand((sub) =>
      sub
        .setName('solo')
        .setDescription('Mainkan Connect Four melawan AI bot')
        .addStringOption((opt) =>
          opt
            .setName('difficulty')
            .setDescription('Tingkat kesulitan AI (default Normal)')
            .addChoices(...DIFFICULTY_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('challenge')
        .setDescription('Tantang pemain lain bermain Connect Four')
        .addUserOption((opt) =>
          opt.setName('opponent').setDescription('Pemain yang ingin ditantang').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('drop')
        .setDescription('Jatuhkan keping ke dalam kolom 1–7')
        .addIntegerOption((opt) =>
          opt
            .setName('column')
            .setDescription('Nomor kolom (1 sampai 7)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(7),
        ),
    ),

  async execute(interaction, context) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'solo') {
      const difficulty = interaction.options.getString('difficulty') ?? 'normal';
      await handleSoloSessionStart(interaction, context, {
        gameType: GAME_TYPES.CONNECT4,
        config: { difficulty },
      });
      return;
    }

    if (sub === 'challenge') {
      await handleChallengeCommand(interaction, context, {
        gameType: GAME_TYPES.CONNECT4,
        details: 'Papan 7 kolom × 6 baris',
      });
      return;
    }

    if (sub === 'drop') {
      const column = interaction.options.getInteger('column', true);
      await handleSessionActionCommand(interaction, context, {
        gameType: GAME_TYPES.CONNECT4,
        action: { column },
        formatEphemeralMessage: (outcome) =>
          outcome.finished
            ? `Keping dijatuhkan di kolom **${column}**. Pertandingan selesai!`
            : `Keping dijatuhkan di kolom **${column}** dan papan telah diperbarui.`,
      });
    }
  },
};
