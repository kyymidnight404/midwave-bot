import { SlashCommandBuilder } from 'discord.js';
import {
  DICE_CONFIG,
  GAME_TYPES,
  TRIVIA_CATEGORIES,
  TRIVIA_CATEGORY_LABELS,
  TTT_POSITIONS,
} from '../utils/constants.js';
import { executeGameCommand } from '../utils/gameDispatcher.js';

const ACTION_CHOICES = [
  { name: 'Solo (Main vs Bot/AI)', value: 'solo' },
  { name: 'Challenge (Tantang Pemain)', value: 'challenge' },
  { name: 'Choose (Pilih RPS / Coin Flip)', value: 'choose' },
  { name: 'Drop (Jatuhkan Keping Connect4)', value: 'drop' },
  { name: 'Move (Langkah Tic Tac Toe)', value: 'move' },
  { name: 'Answer (Tebak Guess / Jawab Trivia)', value: 'answer' },
  { name: 'Status (Lihat Sesi/Undangan Aktif)', value: 'status' },
  { name: 'Cancel (Batalkan Sesi/Undangan)', value: 'cancel' },
];

const GAME_CHOICES = [
  { name: 'Coin Flip', value: GAME_TYPES.COINFLIP },
  { name: 'Connect Four', value: GAME_TYPES.CONNECT4 },
  { name: 'Dice Rolling', value: GAME_TYPES.DICE },
  { name: 'Number Guessing', value: GAME_TYPES.GUESS },
  { name: 'Rock Paper Scissors', value: GAME_TYPES.RPS },
  { name: 'Tic Tac Toe', value: GAME_TYPES.TICTACTOE },
  { name: 'Trivia Quiz', value: GAME_TYPES.TRIVIA },
];

const CHOICE_OPTIONS = [
  { name: 'Rock (Batu — RPS)', value: 'rock' },
  { name: 'Paper (Kertas — RPS)', value: 'paper' },
  { name: 'Scissors (Gunting — RPS)', value: 'scissors' },
  { name: 'Heads (Coin Flip)', value: 'heads' },
  { name: 'Tails (Coin Flip)', value: 'tails' },
];

const POSITION_OPTIONS = TTT_POSITIONS.map((pos) => ({ name: pos, value: pos }));

const DIFFICULTY_OPTIONS = [
  { name: 'Easy', value: 'easy' },
  { name: 'Normal', value: 'normal' },
  { name: 'Hard', value: 'hard' },
];

const CATEGORY_OPTIONS = TRIVIA_CATEGORIES.map((cat) => ({
  name: TRIVIA_CATEGORY_LABELS[cat],
  value: cat,
}));

export const data = new SlashCommandBuilder()
  .setName('game')
  .setDescription('Mainkan seluruh mini-game Midwave dan kelola sesi pertandingan')
  .addStringOption((opt) =>
    opt
      .setName('action')
      .setDescription('Aksi yang ingin dijalankan')
      .setRequired(true)
      .addChoices(...ACTION_CHOICES),
  )
  .addStringOption((opt) =>
    opt
      .setName('game')
      .setDescription('Pilih jenis mini-game')
      .setRequired(false)
      .addChoices(...GAME_CHOICES),
  )
  .addUserOption((opt) =>
    opt
      .setName('opponent')
      .setDescription('Pemain lawan (untuk aksi challenge)')
      .setRequired(false),
  )
  .addStringOption((opt) =>
    opt
      .setName('choice')
      .setDescription('Pilihan untuk RPS (rock/paper/scissors) atau Coin Flip (heads/tails)')
      .setRequired(false)
      .addChoices(...CHOICE_OPTIONS),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('column')
      .setDescription('Nomor kolom 1–7 (untuk Connect Four drop)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(7),
  )
  .addStringOption((opt) =>
    opt
      .setName('position')
      .setDescription('Koordinat papan A1–C3 (untuk Tic Tac Toe move)')
      .setRequired(false)
      .addChoices(...POSITION_OPTIONS),
  )
  .addStringOption((opt) =>
    opt
      .setName('answer')
      .setDescription('Tebakan angka 1–200 (Guess) atau jawaban A/B/C/D (Trivia)')
      .setRequired(false),
  )
  .addStringOption((opt) =>
    opt
      .setName('game_id')
      .setDescription('Opsional ID sesi atau undangan (untuk status / cancel)')
      .setRequired(false),
  )
  .addStringOption((opt) =>
    opt
      .setName('difficulty')
      .setDescription('Tingkat kesulitan AI/game (default Normal)')
      .setRequired(false)
      .addChoices(...DIFFICULTY_OPTIONS),
  )
  .addStringOption((opt) =>
    opt
      .setName('category')
      .setDescription('Kategori soal Trivia (default General Knowledge)')
      .setRequired(false)
      .addChoices(...CATEGORY_OPTIONS),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('count')
      .setDescription(`Jumlah dadu Dice (${DICE_CONFIG.MIN_COUNT}–${DICE_CONFIG.MAX_COUNT}, default 1)`)
      .setRequired(false)
      .setMinValue(DICE_CONFIG.MIN_COUNT)
      .setMaxValue(DICE_CONFIG.MAX_COUNT),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('sides')
      .setDescription(`Jumlah sisi dadu Dice (${DICE_CONFIG.MIN_SIDES}–${DICE_CONFIG.MAX_SIDES}, default 6)`)
      .setRequired(false)
      .setMinValue(DICE_CONFIG.MIN_SIDES)
      .setMaxValue(DICE_CONFIG.MAX_SIDES),
  );

/**
 * Executes the consolidated `/game` slash command (and `!game status|cancel` via prefix).
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} [context]
 */
export async function execute(interaction, context = {}) {
  return executeGameCommand(interaction, context);
}

export default { data, execute };
