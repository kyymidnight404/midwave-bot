import { SlashCommandBuilder } from 'discord.js';
import {
  DIFFICULTY_LABELS,
  GAME_TYPES,
  TRIVIA_CATEGORIES,
  TRIVIA_CATEGORY_LABELS,
} from '../utils/constants.js';
import {
  handleChallengeCommand,
  handleSessionActionCommand,
  handleSoloSessionStart,
} from '../utils/gameCommandHelpers.js';

const CATEGORY_CHOICES = TRIVIA_CATEGORIES.map((cat) => ({
  name: TRIVIA_CATEGORY_LABELS[cat],
  value: cat,
}));

const DIFFICULTY_CHOICES = [
  { name: 'Easy', value: 'easy' },
  { name: 'Normal', value: 'normal' },
  { name: 'Hard', value: 'hard' },
];

const OPTION_CHOICES = [
  { name: 'A', value: 'A' },
  { name: 'B', value: 'B' },
  { name: 'C', value: 'C' },
  { name: 'D', value: 'D' },
];

export default {
  data: new SlashCommandBuilder()
    .setName('trivia')
    .setDescription('Mainkan Trivia Quiz (5 ronde) dalam mode Solo atau Multiplayer')
    .addSubcommand((sub) =>
      sub
        .setName('solo')
        .setDescription('Mulai kuis Trivia solo melawan skor target')
        .addStringOption((opt) =>
          opt
            .setName('category')
            .setDescription('Kategori pertanyaan (default General Knowledge)')
            .addChoices(...CATEGORY_CHOICES),
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
        .setName('challenge')
        .setDescription('Tantang pemain lain beradu cepat menjawab Trivia (20 detik/ronde)')
        .addUserOption((opt) =>
          opt.setName('opponent').setDescription('Pemain yang ingin ditantang').setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('category')
            .setDescription('Kategori pertanyaan (default General Knowledge)')
            .addChoices(...CATEGORY_CHOICES),
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
        .setName('answer')
        .setDescription('Kirim jawaban Trivia secara privat (ephemeral)')
        .addStringOption((opt) =>
          opt
            .setName('option')
            .setDescription('Pilihan jawaban A, B, C, atau D')
            .setRequired(true)
            .addChoices(...OPTION_CHOICES),
        ),
    ),

  async execute(interaction, context) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'solo') {
      const category = interaction.options.getString('category') ?? 'general';
      const difficulty = interaction.options.getString('difficulty') ?? 'normal';
      await handleSoloSessionStart(interaction, context, {
        gameType: GAME_TYPES.TRIVIA,
        config: { category, difficulty },
      });
      return;
    }

    if (sub === 'challenge') {
      const category = interaction.options.getString('category') ?? 'general';
      const difficulty = interaction.options.getString('difficulty') ?? 'normal';
      await handleChallengeCommand(interaction, context, {
        gameType: GAME_TYPES.TRIVIA,
        config: { category, difficulty },
        details: `Kategori: **${TRIVIA_CATEGORY_LABELS[category]}** | Difficulty: **${DIFFICULTY_LABELS[difficulty]}** (5 ronde, 20 detik/ronde)`,
      });
      return;
    }

    if (sub === 'answer') {
      const option = interaction.options.getString('option', true);
      await handleSessionActionCommand(interaction, context, {
        gameType: GAME_TYPES.TRIVIA,
        action: { option },
        formatEphemeralMessage: (outcome) => {
          const fb = outcome.privateView?.feedback;
          if (!fb) return `Jawaban **${option}** diterima.`;
          if (fb.correct) {
            return outcome.finished
              ? `Jawaban **${option}** benar! (+1 poin) Pertandingan selesai.`
              : `Jawaban **${option}** benar! (+1 poin) Lanjut ke ronde berikutnya.`;
          }
          if (outcome.session.mode === 'solo') {
            return `Jawaban **${option}** kurang tepat. Jawaban yang benar: **${fb.correctLetter}. ${fb.correctText}**.`;
          }
          if (fb.roundSkipped) {
            return `Jawaban **${option}** salah. Kedua pemain salah sehingga ronde dilewati.`;
          }
          return `Jawaban **${option}** salah! Kamu terkunci sampai ronde berikutnya.`;
        },
      });
    }
  },
};
