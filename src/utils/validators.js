import {
  COIN_CHOICES,
  CONNECT4_CONFIG,
  DICE_CONFIG,
  DIFFICULTIES,
  RPS_CHOICES,
  TRIVIA_CATEGORIES,
  TRIVIA_CONFIG,
  TTT_POSITIONS,
} from './constants.js';

/**
 * Validates that an opponent user is eligible for a multiplayer challenge.
 * @param {string} challengerId
 * @param {{ id: string, bot?: boolean } | null | undefined} opponent
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateOpponent(challengerId, opponent) {
  if (!opponent || !opponent.id) {
    return { valid: false, error: 'Lawan tidak valid.' };
  }
  if (opponent.bot) {
    return { valid: false, error: 'Kamu tidak dapat menantang bot di mode multiplayer. Gunakan mode `/... solo`.' };
  }
  if (opponent.id === challengerId) {
    return { valid: false, error: 'Kamu tidak dapat menantang dirimu sendiri.' };
  }
  return { valid: true };
}

/**
 * @param {string} difficulty
 * @returns {boolean}
 */
export function isValidDifficulty(difficulty) {
  return DIFFICULTIES.includes(difficulty);
}

/**
 * @param {string} category
 * @returns {boolean}
 */
export function isValidTriviaCategory(category) {
  return TRIVIA_CATEGORIES.includes(category);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateIntRange(value, min, max, label = 'Nilai') {
  if (!Number.isInteger(value)) {
    return { valid: false, error: `${label} harus berupa bilangan bulat.` };
  }
  if (value < min || value > max) {
    return { valid: false, error: `${label} harus berada di antara ${min} dan ${max}.` };
  }
  return { valid: true };
}

/**
 * Validates Dice Rolling configuration.
 * @param {number} count
 * @param {number} sides
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateDiceConfig(count, sides) {
  const countCheck = validateIntRange(count, DICE_CONFIG.MIN_COUNT, DICE_CONFIG.MAX_COUNT, 'Jumlah dadu');
  if (!countCheck.valid) return countCheck;

  const sidesCheck = validateIntRange(sides, DICE_CONFIG.MIN_SIDES, DICE_CONFIG.MAX_SIDES, 'Jumlah sisi');
  if (!sidesCheck.valid) return sidesCheck;

  return { valid: true };
}

/**
 * @param {string} choice
 * @returns {boolean}
 */
export function isValidRpsChoice(choice) {
  return RPS_CHOICES.includes(choice);
}

/**
 * @param {string} choice
 * @returns {boolean}
 */
export function isValidCoinChoice(choice) {
  return COIN_CHOICES.includes(choice);
}

/**
 * @param {string} letter
 * @returns {boolean}
 */
export function isValidTriviaOption(letter) {
  return TRIVIA_CONFIG.OPTION_LETTERS.includes(String(letter).toUpperCase());
}

/**
 * Validates Tic Tac Toe coordinate (A1-C3).
 * @param {string} pos
 * @returns {boolean}
 */
export function isValidTttPosition(pos) {
  return TTT_POSITIONS.includes(String(pos).toUpperCase());
}

/**
 * Validates Connect Four 1-based column (1-7).
 * @param {number} column
 * @returns {boolean}
 */
export function isValidConnect4Column(column) {
  return Number.isInteger(column) && column >= 1 && column <= CONNECT4_CONFIG.COLS;
}
