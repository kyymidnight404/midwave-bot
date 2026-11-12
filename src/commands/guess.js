import { SlashCommandBuilder } from 'discord.js';
import { DIFFICULTY_LABELS, GAME_TYPES, GUESS_CONFIG } from '../utils/constants.js';
import {
  handleChallengeCommand,
  handleSessionActionCommand,
  handleSoloSessionStart,
} from '../utils/gameCommandHelpers.js';

const DIFFICULTY_CHOICES = [
  { name: 'Easy (1–50, 8 percobaan)', value: 'easy' },
  { name: 'Normal (1–100, 10 percobaan)', value: 'normal' },
  { name: 'Hard (1–200, 12 percobaan)', value: 'hard' },
];

export default {
  data: new SlashCommandBuilder()
    .setName('guess')
    .setDescription('Mainkan Number Guessing dalam mode Solo atau Multiplayer')
    .addSubcommand((sub) =>
      sub
        .setName('solo')
        .setDescription('Mulai permainan tebak angka solo melawan bot')
        .addStringOption((opt) =>
          opt
            .setName('difficulty')
            .setDescription('Tingkat kesulitan (default Normal)')
            .addChoices(...DIFFICULTY_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('challenge')
        .setDescription('Tantang pemain lain adu cepat menebak angka')
        .addUserOption((opt) =>
          opt.setName('opponent').setDescription('Pemain yang ingin ditantang').setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('difficulty')
            .setDescription('Tingkat kesulitan (default Normal)')
            .addChoices(...DIFFICULTY_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Masukkan tebakan angka pada pertandingan aktif')
        .addIntegerOption((opt) =>
          opt
            .setName('number')
            .setDescription('Angka tebakanmu')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(200),
        ),
    ),

  async execute(interaction, context) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'solo') {
      const difficulty = interaction.options.getString('difficulty') ?? 'normal';
      await handleSoloSessionStart(interaction, context, {
        gameType: GAME_TYPES.GUESS,
        config: { difficulty },
      });
      return;
    }

    if (sub === 'challenge') {
      const difficulty = interaction.options.getString('difficulty') ?? 'normal';
      const cfg = GUESS_CONFIG[difficulty];
      await handleChallengeCommand(interaction, context, {
        gameType: GAME_TYPES.GUESS,
        config: { difficulty },
        details: `Difficulty: **${DIFFICULTY_LABELS[difficulty]}** (${cfg.min}–${cfg.max}, ${cfg.maxAttempts} percobaan)`,
      });
      return;
    }

    if (sub === 'play') {
      const number = interaction.options.getInteger('number', true);
      await handleSessionActionCommand(interaction, context, {
        gameType: GAME_TYPES.GUESS,
        action: { number },
        formatEphemeralMessage: (outcome) => {
          if (outcome.finished) return `Tebakan **${number}** tercatat. Pertandingan selesai!`;
          const hint = outcome.privateView?.lastHint;
          const rem = outcome.privateView?.remainingAttempts;
          return `Tebakan **${number}** → **${hint}**! (Sisa percobaan: ${rem})`;
        },
      });
    }
  },
};
