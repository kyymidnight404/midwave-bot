import { SlashCommandBuilder } from 'discord.js';
import { DIFFICULTY_LABELS, GAME_TYPES, TTT_POSITIONS } from '../utils/constants.js';
import {
  handleChallengeCommand,
  handleSessionActionCommand,
  handleSoloSessionStart,
} from '../utils/gameCommandHelpers.js';

const DIFFICULTY_CHOICES = [
  { name: 'Easy', value: 'easy' },
  { name: 'Normal', value: 'normal' },
  { name: 'Hard (Minimax)', value: 'hard' },
];

const POSITION_CHOICES = TTT_POSITIONS.map((pos) => ({ name: pos, value: pos }));

export default {
  data: new SlashCommandBuilder()
    .setName('tictactoe')
    .setDescription('Mainkan Tic Tac Toe 3×3 dalam mode Solo atau Multiplayer')
    .addSubcommand((sub) =>
      sub
        .setName('solo')
        .setDescription('Mainkan Tic Tac Toe melawan AI bot')
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
        .setDescription('Tantang pemain lain bermain Tic Tac Toe')
        .addUserOption((opt) =>
          opt.setName('opponent').setDescription('Pemain yang ingin ditantang').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('move')
        .setDescription('Letakkan simbol di koordinat papan (A1–C3)')
        .addStringOption((opt) =>
          opt
            .setName('position')
            .setDescription('Koordinat kotak (A1 sampai C3)')
            .setRequired(true)
            .addChoices(...POSITION_CHOICES),
        ),
    ),

  async execute(interaction, context) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'solo') {
      const difficulty = interaction.options.getString('difficulty') ?? 'normal';
      await handleSoloSessionStart(interaction, context, {
        gameType: GAME_TYPES.TICTACTOE,
        config: { difficulty },
      });
      return;
    }

    if (sub === 'challenge') {
      await handleChallengeCommand(interaction, context, {
        gameType: GAME_TYPES.TICTACTOE,
        details: `Papan 3×3 (Koordinat A1–C3) | Difficulty AI: N/A (${DIFFICULTY_LABELS.normal} hanya untuk Solo)`,
      });
      return;
    }

    if (sub === 'move') {
      const position = interaction.options.getString('position', true);
      await handleSessionActionCommand(interaction, context, {
        gameType: GAME_TYPES.TICTACTOE,
        action: { position },
        formatEphemeralMessage: (outcome) =>
          outcome.finished
            ? `Langkah **${position}** tercatat. Pertandingan selesai!`
            : `Langkah **${position}** tercatat dan papan telah diperbarui.`,
      });
    }
  },
};
