import {
  BOT_PLAYER_ID,
  COIN_CHOICES,
  GAME_MODES,
  MATCH_STATUS,
} from '../utils/constants.js';
import { defaultRng } from '../utils/random.js';
import { isValidCoinChoice } from '../utils/validators.js';

const CHOICE_LABELS = {
  heads: 'Heads',
  tails: 'Tails',
};

function formatChoice(choice) {
  return CHOICE_LABELS[choice] ?? choice;
}

/**
 * Pure Coin Flip game engine (Solo & 2-player Multiplayer).
 */
export const CoinFlipGame = {
  /**
   * @param {{ mode?: string }} config
   * @param {string[]} players
   */
  create(config, players) {
    const mode = config?.mode ?? (players.includes(BOT_PLAYER_ID) ? GAME_MODES.SOLO : GAME_MODES.MULTIPLAYER);
    return {
      mode,
      players: [...players],
      currentTurn: null,
      choices: {},
      coinResult: null,
      status: MATCH_STATUS.ACTIVE,
      result: null,
    };
  },

  /**
   * @param {object} state
   * @param {string} playerId
   * @param {{ choice: string }} action
   * @param {object} [rng]
   */
  applyAction(state, playerId, action, rng = defaultRng) {
    if (state.status !== MATCH_STATUS.ACTIVE) {
      return { error: 'Pertandingan Coin Flip sudah berakhir.' };
    }
    if (!state.players.includes(playerId)) {
      return { error: 'Kamu bukan peserta pertandingan ini.' };
    }

    const choice = String(action?.choice ?? '').toLowerCase();
    if (!isValidCoinChoice(choice)) {
      return { error: 'Pilihan harus `heads` atau `tails`.' };
    }

    if (state.mode === GAME_MODES.SOLO) {
      const coinResult = rng.pick(COIN_CHOICES);
      const playerWon = choice === coinResult;
      const result = {
        winnerId: playerWon ? playerId : BOT_PLAYER_ID,
        loserId: playerWon ? BOT_PLAYER_ID : playerId,
        isDraw: false,
        finalScore: `Tebakan: **${formatChoice(choice)}** | Hasil Koin: **${formatChoice(coinResult)}**`,
        description: playerWon
          ? `Tepat! Koin mendarat di **${formatChoice(coinResult)}**.`
          : `Meleset! Koin mendarat di **${formatChoice(coinResult)}**.`,
      };

      const nextState = {
        ...state,
        choices: { [playerId]: choice },
        coinResult,
        status: MATCH_STATUS.FINISHED,
        result,
      };
      return { state: nextState, finished: true, result };
    }

    // Multiplayer mode: secret choices until both choose
    if (state.choices[playerId]) {
      return { error: 'Kamu sudah menentukan pilihan rahasiamu. Menunggu lawan memilih.' };
    }

    const nextChoices = { ...state.choices, [playerId]: choice };
    const [p1, p2] = state.players;

    if (!nextChoices[p1] || !nextChoices[p2]) {
      const nextState = {
        ...state,
        choices: nextChoices,
      };
      return { state: nextState, finished: false };
    }

    const coinResult = rng.pick(COIN_CHOICES);
    const c1 = nextChoices[p1];
    const c2 = nextChoices[p2];

    let result;
    if (c1 === c2) {
      // Identical predictions always result in Draw (both right or both wrong)
      const bothCorrect = c1 === coinResult;
      result = {
        winnerId: null,
        loserId: null,
        isDraw: true,
        finalScore: `Koin: **${formatChoice(coinResult)}** | <@${p1}>: **${formatChoice(c1)}** | <@${p2}>: **${formatChoice(c2)}**`,
        description: bothCorrect
          ? `Kedua pemain sama-sama memilih **${formatChoice(c1)}** dan benar. Pertandingan berakhir **Draw**!`
          : `Kedua pemain sama-sama memilih **${formatChoice(c1)}** dan meleset (hasil **${formatChoice(coinResult)}**). Pertandingan berakhir **Draw**!`,
      };
    } else {
      const winnerId = c1 === coinResult ? p1 : p2;
      const loserId = winnerId === p1 ? p2 : p1;
      result = {
        winnerId,
        loserId,
        isDraw: false,
        finalScore: `Koin: **${formatChoice(coinResult)}** | <@${p1}>: **${formatChoice(c1)}** | <@${p2}>: **${formatChoice(c2)}**`,
        description: `Koin mendarat di **${formatChoice(coinResult)}**! <@${winnerId}> menebak dengan tepat.`,
      };
    }

    const nextState = {
      ...state,
      choices: nextChoices,
      coinResult,
      status: MATCH_STATUS.FINISHED,
      result,
    };
    return { state: nextState, finished: true, result };
  },

  /**
   * Public view strictly hides secret predictions until status is finished.
   */
  getPublicView(state) {
    if (state.status === MATCH_STATUS.FINISHED && state.result) {
      const lines = state.players
        .filter((p) => p !== BOT_PLAYER_ID)
        .map((p) => `• <@${p}>: **${formatChoice(state.choices[p])}**`);
      lines.push(`• Hasil Koin: **${formatChoice(state.coinResult)}**`);

      return {
        mode: state.mode,
        players: state.players,
        status: 'Selesai',
        currentTurn: null,
        boardOrInfo: lines.join('\n'),
      };
    }

    const statusLines = state.players.map((p) => {
      const ready = Boolean(state.choices[p]);
      return `• <@${p}>: ${ready ? 'Sudah memilih (rahasia)' : 'Menunggu pilihan...'}`;
    });

    return {
      mode: state.mode,
      players: state.players,
      status: 'Menunggu Pilihan Rahasia',
      currentTurn: null,
      boardOrInfo: statusLines.join('\n'),
      instructions: 'Klik tombol **Heads** atau **Tails** di bawah untuk menentukan prediksimu secara rahasia.',
    };
  },

  getPrivateView(state, playerId) {
    return {
      myChoice: state.choices[playerId] ?? null,
    };
  },
};
