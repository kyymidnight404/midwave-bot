export const GAME_CENTER_PREFIX = 'gc';

/**
 * Builds a structured Game Center button customId.
 * @param {string} scope
 * @param {string} targetId
 * @param {string} action
 * @param {...(string | number)} args
 * @returns {string}
 */
export function buildGameCustomId(scope, targetId, action, ...args) {
  const parts = [GAME_CENTER_PREFIX, scope, targetId, action, ...args.map(String)];
  return parts.join(':');
}

/**
 * Parses a Game Center button customId.
 * @param {string} customId
 */
export function parseGameCustomId(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(`${GAME_CENTER_PREFIX}:`)) {
    return null;
  }
  const parts = customId.split(':');
  if (parts.length < 4) {
    return null;
  }
  const [, scope, targetId, action, ...args] = parts;
  return { scope, targetId, action, args };
}
