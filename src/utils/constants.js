import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const LOGO_FILENAME = 'logo.png';
export const LOGO_PATH = path.join(PROJECT_ROOT, 'assets', LOGO_FILENAME);
export const LOGO_ATTACHMENT_URL = `attachment://${LOGO_FILENAME}`;

export const COLORS = Object.freeze({
  PRIMARY: 0x101b2d,
  SECONDARY: 0x245b8f,
  ACCENT: 0x63a9d8,
  TEXT: 0xffffff,
  MUTED: 0x91a2b8,
  SUCCESS: 0x43b581,
  DANGER: 0xed4245,
  WARNING: 0xfaa61a,
});

export const EMBED_FOOTER = 'Midwave • Discord Game Bot';

export const BOT_PLAYER_ID = 'BOT';

export const GAME_TYPES = Object.freeze({
  GUESS: 'guess',
  RPS: 'rps',
  TRIVIA: 'trivia',
  COINFLIP: 'coinflip',
  DICE: 'dice',
  TICTACTOE: 'tictactoe',
  CONNECT4: 'connect4',
});

export const GAME_METADATA = Object.freeze({
  [GAME_TYPES.GUESS]: {
    id: GAME_TYPES.GUESS,
    name: 'Number Guessing',
    command: '/guess',
    description: 'Tebak angka rahasia dengan petunjuk Higher atau Lower.',
    soloCommands: '`/guess solo` lalu `/guess play number:<angka>`',
    multiplayerCommands: '`/guess challenge opponent:<user>` → `/guess play number:<angka>`',
  },
  [GAME_TYPES.RPS]: {
    id: GAME_TYPES.RPS,
    name: 'Rock Paper Scissors',
    command: '/rps',
    description: 'Batu, Gunting, Kertas klasik dengan pilihan rahasia.',
    soloCommands: '`/rps solo choice:<rock|paper|scissors>`',
    multiplayerCommands: '`/rps challenge opponent:<user>` → `/rps choose choice:<...>`',
  },
  [GAME_TYPES.TRIVIA]: {
    id: GAME_TYPES.TRIVIA,
    name: 'Trivia Quiz',
    command: '/trivia',
    description: 'Kuis pengetahuan umum 5 ronde dengan berbagai kategori dan tingkat kesulitan.',
    soloCommands: '`/trivia solo` lalu `/trivia answer option:<A|B|C|D>`',
    multiplayerCommands: '`/trivia challenge opponent:<user>` → `/trivia answer option:<A|B|C|D>`',
  },
  [GAME_TYPES.COINFLIP]: {
    id: GAME_TYPES.COINFLIP,
    name: 'Coin Flip',
    command: '/coinflip',
    description: 'Tebak hasil lemparan koin: Heads atau Tails.',
    soloCommands: '`/coinflip solo choice:<heads|tails>`',
    multiplayerCommands: '`/coinflip challenge opponent:<user>` → `/coinflip choose choice:<heads|tails>`',
  },
  [GAME_TYPES.DICE]: {
    id: GAME_TYPES.DICE,
    name: 'Dice Rolling',
    command: '/dice',
    description: 'Lempar hingga 10 dadu dengan 2–100 sisi dan adu total angka.',
    soloCommands: '`/dice solo [count] [sides]`',
    multiplayerCommands: '`/dice challenge opponent:<user> [count] [sides]`',
  },
  [GAME_TYPES.TICTACTOE]: {
    id: GAME_TYPES.TICTACTOE,
    name: 'Tic Tac Toe',
    command: '/tictactoe',
    description: 'Permainan papan 3×3 klasik melawan AI (termasuk Minimax) atau pemain lain.',
    soloCommands: '`/tictactoe solo [difficulty]` lalu `/tictactoe move position:<A1-C3>`',
    multiplayerCommands: '`/tictactoe challenge opponent:<user>` → `/tictactoe move position:<A1-C3>`',
  },
  [GAME_TYPES.CONNECT4]: {
    id: GAME_TYPES.CONNECT4,
    name: 'Connect Four',
    command: '/connect4',
    description: 'Susun 4 keping berurutan di papan 7×6 melawan AI atau pemain lain.',
    soloCommands: '`/connect4 solo [difficulty]` lalu `/connect4 drop column:<1-7>`',
    multiplayerCommands: '`/connect4 challenge opponent:<user>` → `/connect4 drop column:<1-7>`',
  },
});

export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);

export const DIFFICULTY_LABELS = Object.freeze({
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
});

export const GUESS_CONFIG = Object.freeze({
  easy: { min: 1, max: 50, maxAttempts: 8 },
  normal: { min: 1, max: 100, maxAttempts: 10 },
  hard: { min: 1, max: 200, maxAttempts: 12 },
});

export const RPS_CHOICES = Object.freeze(['rock', 'paper', 'scissors']);

export const COIN_CHOICES = Object.freeze(['heads', 'tails']);

export const TRIVIA_CATEGORIES = Object.freeze([
  'general',
  'science',
  'technology',
  'geography',
  'history',
  'sports',
]);

export const TRIVIA_CATEGORY_LABELS = Object.freeze({
  general: 'General Knowledge',
  science: 'Science',
  technology: 'Technology',
  geography: 'Geography',
  history: 'History',
  sports: 'Sports',
});

export const TRIVIA_CONFIG = Object.freeze({
  ROUNDS_PER_MATCH: 5,
  ROUND_DURATION_MS: 20_000,
  QUESTIONS_PER_BUCKET: 5,
  OPTION_LETTERS: ['A', 'B', 'C', 'D'],
});

export const DICE_CONFIG = Object.freeze({
  DEFAULT_COUNT: 1,
  DEFAULT_SIDES: 6,
  MIN_COUNT: 1,
  MAX_COUNT: 10,
  MIN_SIDES: 2,
  MAX_SIDES: 100,
});

export const TTT_POSITIONS = Object.freeze([
  'A1', 'B1', 'C1',
  'A2', 'B2', 'C2',
  'A3', 'B3', 'C3',
]);

export const CONNECT4_CONFIG = Object.freeze({
  ROWS: 6,
  COLS: 7,
  CONNECT_LENGTH: 4,
  AI_TIME_BUDGET_MS: 120,
});

export const TIMEOUTS = Object.freeze({
  INVITE_MS: 60_000,
  SESSION_IDLE_MS: 120_000,
  COOLDOWN_MS: 2_000,
  MAX_ACTIVE_SESSIONS: 200,
});

export const MATCH_STATUS = Object.freeze({
  WAITING: 'waiting',
  ACTIVE: 'active',
  FINISHED: 'finished',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
});

export const GAME_MODES = Object.freeze({
  SOLO: 'solo',
  MULTIPLAYER: 'multiplayer',
});
