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

export const WEATHER_MAX_LOCATION_LENGTH = 100;

export const BOT_PLAYER_ID = 'BOT';

export const GAME_TYPES = Object.freeze({
  RPS: 'rps',
  COINFLIP: 'coinflip',
  TICTACTOE: 'tictactoe',
});

export const GAME_METADATA = Object.freeze({
  [GAME_TYPES.RPS]: {
    id: GAME_TYPES.RPS,
    name: 'Rock Paper Scissors',
    command: '!rps',
    description: 'Batu, Gunting, Kertas klasik dengan pilihan rahasia.',
    soloCommands: '`!rps <rock|paper|scissors>`',
    multiplayerCommands: '`!rps @user`',
  },
  [GAME_TYPES.COINFLIP]: {
    id: GAME_TYPES.COINFLIP,
    name: 'Coin Flip',
    command: '!coinflip',
    description: 'Tebak hasil lemparan koin: Heads atau Tails.',
    soloCommands: '`!coinflip` atau `!coinflip <heads|tails>`',
    multiplayerCommands: '`!coinflip @user`',
  },
  [GAME_TYPES.TICTACTOE]: {
    id: GAME_TYPES.TICTACTOE,
    name: 'Tic Tac Toe',
    command: '!ttt',
    description: 'Permainan papan 3×3 klasik melawan AI atau pemain lain.',
    soloCommands: '`!ttt [easy|normal|hard]` lalu `!ttt <A1-C3>`',
    multiplayerCommands: '`!ttt @user`',
  },
});

export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);

export const DIFFICULTY_LABELS = Object.freeze({
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
});

export const RPS_CHOICES = Object.freeze(['rock', 'paper', 'scissors']);

export const COIN_CHOICES = Object.freeze(['heads', 'tails']);

export const QUIZ_CATEGORIES = Object.freeze([
  'general',
  'science',
  'technology',
  'geography',
  'history',
  'sports',
]);

export const QUIZ_CATEGORY_LABELS = Object.freeze({
  general: 'General Knowledge',
  science: 'Science',
  technology: 'Technology',
  geography: 'Geography',
  history: 'History',
  sports: 'Sports',
});

export const TTT_POSITIONS = Object.freeze([
  'A1', 'B1', 'C1',
  'A2', 'B2', 'C2',
  'A3', 'B3', 'C3',
]);

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
