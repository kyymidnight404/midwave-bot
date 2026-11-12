import {
  BOT_PLAYER_ID,
  DICE_CONFIG,
  GAME_MODES,
  MATCH_STATUS,
} from '../utils/constants.js';
import { defaultRng } from '../utils/random.js';
import { validateDiceConfig } from '../utils/validators.js';

function rollDiceSet(count, sides, rng) {
  const rolls = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    const val = rng.int(1, sides);
    rolls.push(val);
    total += val;
  }
  return { rolls, total };
}

function formatRollLine(label, { rolls, total }) {
  return `• ${label}: [${rolls.join(', ')}] = **${total}**`;
}

/**
 * Pure Dice Rolling game engine (Solo & 2-player Multiplayer).
 */
export const DiceGame = {
  /**
   * @param {{ mode?: string, count?: number, sides?: number }} config
   * @param {string[]} players
   * @param {object} [rng]
   */
  create(config, players, rng = defaultRng) {
    const count = config?.count ?? DICE_CONFIG.DEFAULT_COUNT;
    const sides = config?.sides ?? DICE_CONFIG.DEFAULT_SIDES;
    const check = validateDiceConfig(count, sides);
    if (!check.valid) {
      throw new Error(check.error);
    }

    const mode = config?.mode ?? (players.includes(BOT_PLAYER_ID) ? GAME_MODES.SOLO : GAME_MODES.MULTIPLAYER);

    if (mode === GAME_MODES.SOLO) {
      return {
        mode,
        players: [...players],
        count,
        sides,
        currentTurn: null,
        rollsByPlayer: {},
        status: MATCH_STATUS.ACTIVE,
        result: null,
      };
    }

    // Multiplayer rolls immediately for both players upon challenge acceptance
    const [p1, p2] = players;
    const r1 = rollDiceSet(count, sides, rng);
    const r2 = rollDiceSet(count, sides, rng);
    const rollsByPlayer = { [p1]: r1, [p2]: r2 };

    let winnerId = null;
    let loserId = null;
    let isDraw = false;
    let description;

    if (r1.total === r2.total) {
      isDraw = true;
      description = `Kedua pemain melempar **${count}d${sides}** dan memperoleh total yang sama (**${r1.total}**). Seri!`;
    } else {
      winnerId = r1.total > r2.total ? p1 : p2;
      loserId = winnerId === p1 ? p2 : p1;
      description = `<@${winnerId}> menang dengan total **${rollsByPlayer[winnerId].total}** melawan **${rollsByPlayer[loserId].total}** (${count}d${sides})!`;
    }

    const result = {
      winnerId,
      loserId,
      isDraw,
      finalScore: `<@${p1}>: **${r1.total}** | <@${p2}>: **${r2.total}**`,
      description,
    };

    return {
      mode,
      players: [...players],
      count,
      sides,
      currentTurn: null,
      rollsByPlayer,
      status: MATCH_STATUS.FINISHED,
      result,
    };
  },

  /**
   * @param {object} state
   * @param {string} playerId
   * @param {object} _action
   * @param {object} [rng]
   */
  applyAction(state, playerId, _action = {}, rng = defaultRng) {
    if (state.status !== MATCH_STATUS.ACTIVE) {
      return { error: 'Pertandingan Dice Rolling sudah selesai.' };
    }
    if (!state.players.includes(playerId)) {
      return { error: 'Kamu bukan peserta pertandingan ini.' };
    }

    const roll = rollDiceSet(state.count, state.sides, rng);
    const result = {
      winnerId: null,
      loserId: null,
      isDraw: false,
      finalScore: `Total: **${roll.total}** (${state.count}d${state.sides})`,
      description: `<@${playerId}> melempar **${state.count}d${state.sides}** dan mendapatkan total **${roll.total}**.`,
    };

    const nextState = {
      ...state,
      rollsByPlayer: { [playerId]: roll },
      status: MATCH_STATUS.FINISHED,
      result,
    };
    return { state: nextState, finished: true, result };
  },

  getPublicView(state) {
    const lines = [];
    for (const p of state.players) {
      if (p === BOT_PLAYER_ID) continue;
      const data = state.rollsByPlayer[p];
      if (data) {
        lines.push(formatRollLine(`<@${p}>`, data));
      }
    }

    return {
      mode: state.mode,
      players: state.players,
      status: state.status === MATCH_STATUS.FINISHED ? 'Selesai' : 'Aktif',
      currentTurn: null,
      boardOrInfo: lines.length > 0 ? lines.join('\n') : `Konfigurasi: **${state.count}d${state.sides}**`,
    };
  },

  getPrivateView(state, playerId) {
    return {
      myRoll: state.rollsByPlayer[playerId] ?? null,
    };
  },
};
