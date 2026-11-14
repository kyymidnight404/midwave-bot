import {
  BOT_PLAYER_ID,
  GAME_MODES,
  MATCH_STATUS,
  RPS_CHOICES,
} from '../utils/constants.js';
import { defaultRng } from '../utils/random.js';
import { isValidRpsChoice } from '../utils/validators.js';

const LABELS = {
  rock: 'Rock (Batu)',
  paper: 'Paper (Kertas)',
  scissors: 'Scissors (Gunting)',
};

const BEATS = {
  rock: 'scissors',
  scissors: 'paper',
  paper: 'rock',
};

function formatChoice(c) {
  return LABELS[c] ?? c;
}

/**
 * Resolves a 2-player RPS round.
 * @returns {'draw' | 'p1' | 'p2'}
 */
export function resolveRpsWinner(choice1, choice2) {
  if (choice1 === choice2) return 'draw';
  return BEATS[choice1] === choice2 ? 'p1' : 'p2';
}

/**
 * Pure Rock Paper Scissors game engine (Solo & 2-player Multiplayer).
 */
export const RPSGame = {
  create(config, players) {
    const mode = config?.mode ?? (players.includes(BOT_PLAYER_ID) ? GAME_MODES.SOLO : GAME_MODES.MULTIPLAYER);
    return {
      mode,
      players: [...players],
      currentTurn: null,
      choices: {},
      status: MATCH_STATUS.ACTIVE,
      result: null,
    };
  },

  applyAction(state, playerId, action, rng = defaultRng) {
    if (state.status !== MATCH_STATUS.ACTIVE) {
      return { error: 'Pertandingan Rock Paper Scissors sudah selesai.' };
    }
    if (!state.players.includes(playerId)) {
      return { error: 'Kamu bukan peserta pertandingan ini.' };
    }

    const choice = String(action?.choice ?? '').toLowerCase();
    if (!isValidRpsChoice(choice)) {
      return { error: 'Pilihan harus `rock`, `paper`, atau `scissors`.' };
    }

    if (state.mode === GAME_MODES.SOLO) {
      const botChoice = rng.pick(RPS_CHOICES);
      const outcome = resolveRpsWinner(choice, botChoice);
      const isDraw = outcome === 'draw';
      const winnerId = isDraw ? null : outcome === 'p1' ? playerId : BOT_PLAYER_ID;
      const loserId = isDraw ? null : outcome === 'p1' ? BOT_PLAYER_ID : playerId;

      const description = isDraw
        ? `Seri! Kamu dan Midwave Bot sama-sama memilih **${formatChoice(choice)}**.`
        : outcome === 'p1'
          ? `Kamu menang! **${formatChoice(choice)}** mengalahkan **${formatChoice(botChoice)}**.`
          : `Kamu kalah! **${formatChoice(botChoice)}** mengalahkan **${formatChoice(choice)}**.`;

      const result = {
        winnerId,
        loserId,
        isDraw,
        finalScore: `Kamu: **${formatChoice(choice)}** | Bot: **${formatChoice(botChoice)}**`,
        description,
      };

      const nextState = {
        ...state,
        choices: { [playerId]: choice, [BOT_PLAYER_ID]: botChoice },
        status: MATCH_STATUS.FINISHED,
        result,
      };
      return { state: nextState, finished: true, result };
    }

    // Multiplayer
    if (state.choices[playerId]) {
      return { error: 'Kamu sudah mengunci pilihanmu. Menunggu lawan memilih.' };
    }

    const nextChoices = { ...state.choices, [playerId]: choice };
    const [p1, p2] = state.players;

    if (!nextChoices[p1] || !nextChoices[p2]) {
      return {
        state: { ...state, choices: nextChoices },
        finished: false,
      };
    }

    const c1 = nextChoices[p1];
    const c2 = nextChoices[p2];
    const outcome = resolveRpsWinner(c1, c2);
    const isDraw = outcome === 'draw';
    const winnerId = isDraw ? null : outcome === 'p1' ? p1 : p2;
    const loserId = isDraw ? null : outcome === 'p1' ? p2 : p1;

    const description = isDraw
      ? `Seri! Kedua pemain sama-sama memilih **${formatChoice(c1)}**.`
      : `<@${winnerId}> menang! **${formatChoice(nextChoices[winnerId])}** mengalahkan **${formatChoice(nextChoices[loserId])}**.`;

    const result = {
      winnerId,
      loserId,
      isDraw,
      finalScore: `<@${p1}>: **${formatChoice(c1)}** | <@${p2}>: **${formatChoice(c2)}**`,
      description,
    };

    const nextState = {
      ...state,
      choices: nextChoices,
      status: MATCH_STATUS.FINISHED,
      result,
    };
    return { state: nextState, finished: true, result };
  },

  /**
   * Public view hides choices until both players have chosen.
   */
  getPublicView(state) {
    if (state.status === MATCH_STATUS.FINISHED && state.result) {
      const lines = state.players.map((p) => {
        const label = p === BOT_PLAYER_ID ? 'Midwave Bot' : `<@${p}>`;
        return `• ${label}: **${formatChoice(state.choices[p])}**`;
      });

      return {
        mode: state.mode,
        players: state.players,
        status: 'Selesai',
        currentTurn: null,
        boardOrInfo: lines.join('\n'),
      };
    }

    const lines = state.players.map((p) => {
      const ready = Boolean(state.choices[p]);
      return `• <@${p}>: ${ready ? 'Sudah memilih (rahasia)' : 'Menunggu pilihan...'}`;
    });

    return {
      mode: state.mode,
      players: state.players,
      status: 'Menunggu Pilihan Rahasia',
      currentTurn: null,
      boardOrInfo: lines.join('\n'),
      instructions: 'Gunakan `/game action:choose game:rps choice:<rock|paper|scissors>` untuk memilih secara rahasia.',
    };
  },

  getPrivateView(state, playerId) {
    return {
      myChoice: state.choices[playerId] ?? null,
    };
  },
};
