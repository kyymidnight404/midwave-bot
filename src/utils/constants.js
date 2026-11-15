import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COLORS } from '../config/colors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const LOGO_FILENAME = 'logo.png';
export const LOGO_PATH = path.join(PROJECT_ROOT, 'assets', LOGO_FILENAME);
export const LOGO_ATTACHMENT_URL = `attachment://${LOGO_FILENAME}`;

export { COLORS };

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
    command: '/game action:solo game:guess',
    description: 'Tebak angka rahasia dengan petunjuk Higher atau Lower.',
    soloCommands: '`/game action:solo game:guess` lalu `/game action:answer game:guess answer:<angka>`',
    multiplayerCommands: '`/game action:challenge game:guess opponent:<user>` → `/game action:answer game:guess answer:<angka>`',
  },
  [GAME_TYPES.RPS]: {
    id: GAME_TYPES.RPS,
    name: 'Rock Paper Scissors',
    command: '/game action:solo game:rps',
    description: 'Batu, Gunting, Kertas klasik dengan pilihan rahasia.',
    soloCommands: '`/game action:solo game:rps choice:<rock|paper|scissors>`',
    multiplayerCommands: '`/game action:challenge game:rps opponent:<user>` → `/game action:choose game:rps choice:<...>`',
  },
  [GAME_TYPES.TRIVIA]: {
    id: GAME_TYPES.TRIVIA,
    name: 'Trivia Quiz',
    command: '/game action:solo game:trivia',
    description: 'Kuis pengetahuan umum 5 ronde dengan berbagai kategori dan tingkat kesulitan.',
    soloCommands: '`/game action:solo game:trivia` lalu `/game action:answer game:trivia answer:<A|B|C|D>`',
    multiplayerCommands: '`/game action:challenge game:trivia opponent:<user>` → `/game action:answer game:trivia answer:<A|B|C|D>`',
  },
  [GAME_TYPES.COINFLIP]: {
    id: GAME_TYPES.COINFLIP,
    name: 'Coin Flip',
    command: '/game action:solo game:coinflip',
    description: 'Tebak hasil lemparan koin: Heads atau Tails.',
    soloCommands: '`/game action:solo game:coinflip choice:<heads|tails>`',
    multiplayerCommands: '`/game action:challenge game:coinflip opponent:<user>` → `/game action:choose game:coinflip choice:<heads|tails>`',
  },
  [GAME_TYPES.DICE]: {
    id: GAME_TYPES.DICE,
    name: 'Dice Rolling',
    command: '/game action:solo game:dice',
    description: 'Lempar hingga 10 dadu dengan 2–100 sisi dan adu total angka.',
    soloCommands: '`/game action:solo game:dice [count] [sides]`',
    multiplayerCommands: '`/game action:challenge game:dice opponent:<user> [count] [sides]`',
  },
  [GAME_TYPES.TICTACTOE]: {
    id: GAME_TYPES.TICTACTOE,
    name: 'Tic Tac Toe',
    command: '/game action:solo game:tictactoe',
    description: 'Permainan papan 3×3 klasik melawan AI (termasuk Minimax) atau pemain lain.',
    soloCommands: '`/game action:solo game:tictactoe [difficulty]` lalu `/game action:move game:tictactoe position:<A1-C3>`',
    multiplayerCommands: '`/game action:challenge game:tictactoe opponent:<user>` → `/game action:move game:tictactoe position:<A1-C3>`',
  },
  [GAME_TYPES.CONNECT4]: {
    id: GAME_TYPES.CONNECT4,
    name: 'Connect Four',
    command: '/game action:solo game:connect4',
    description: 'Susun 4 keping berurutan di papan 7×6 melawan AI atau pemain lain.',
    soloCommands: '`/game action:solo game:connect4 [difficulty]` lalu `/game action:drop game:connect4 column:<1-7>`',
    multiplayerCommands: '`/game action:challenge game:connect4 opponent:<user>` → `/game action:drop game:connect4 column:<1-7>`',
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
