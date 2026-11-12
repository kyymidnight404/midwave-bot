import {
  BOT_PLAYER_ID,
  DIFFICULTY_LABELS,
  GAME_MODES,
  GUESS_CONFIG,
  MATCH_STATUS,
} from '../utils/constants.js';
import { defaultRng } from '../utils/random.js';
import { isValidDifficulty } from '../utils/validators.js';

/**
 * Pure Number Guessing game engine (Solo & 2-player Multiplayer).
 */
export const GuessGame = {
  create(config, players, rng = defaultRng) {
    const difficulty = isValidDifficulty(config?.difficulty) ? config.difficulty : 'normal';
    const settings = GUESS_CONFIG[difficulty];
    const mode = config?.mode ?? (players.includes(BOT_PLAYER_ID) ? GAME_MODES.SOLO : GAME_MODES.MULTIPLAYER);
    const secret = rng.int(settings.min, settings.max);

    return {
      mode,
      difficulty,
      min: settings.min,
      max: settings.max,
      maxAttempts: settings.maxAttempts,
      secret,
      players: [...players],
      currentTurn: players[0],
      attempts: [],
      lastHint: null,
      status: MATCH_STATUS.ACTIVE,
      result: null,
    };
  },

  applyAction(state, playerId, action) {
    if (state.status !== MATCH_STATUS.ACTIVE) {
      return { error: 'Pertandingan Number Guessing sudah berakhir.' };
    }
    if (!state.players.includes(playerId)) {
      return { error: 'Kamu bukan peserta pertandingan ini.' };
    }
    if (state.mode === GAME_MODES.MULTIPLAYER && state.currentTurn !== playerId) {
      return { error: `Sekarang giliran <@${state.currentTurn}> untuk menebak.` };
    }

    const guess = Number(action?.number);
    if (!Number.isInteger(guess) || guess < state.min || guess > state.max) {
      return { error: `Tebakan harus berupa bilangan bulat antara ${state.min} dan ${state.max}.` };
    }

    let hint = 'Correct';
    if (guess < state.secret) hint = 'Higher';
    else if (guess > state.secret) hint = 'Lower';

    const nextAttempts = [...state.attempts, { playerId, guess, hint }];
    const remaining = state.maxAttempts - nextAttempts.length;

    if (guess === state.secret) {
      const loserId = state.players.find((p) => p !== playerId) ?? null;
      const result = {
        winnerId: playerId,
        loserId,
        isDraw: false,
        finalScore: `Angka Rahasia: **${state.secret}** | Percobaan: **${nextAttempts.length}/${state.maxAttempts}**`,
        description: `<@${playerId}> berhasil menebak angka **${state.secret}** pada percobaan ke-${nextAttempts.length}!`,
      };
      return {
        state: {
          ...state,
          attempts: nextAttempts,
          lastHint: hint,
          currentTurn: null,
          status: MATCH_STATUS.FINISHED,
          result,
        },
        finished: true,
        result,
      };
    }

    if (remaining <= 0) {
      const isSolo = state.mode === GAME_MODES.SOLO;
      const result = {
        winnerId: isSolo ? BOT_PLAYER_ID : null,
        loserId: isSolo ? playerId : null,
        isDraw: !isSolo,
        finalScore: `Angka Rahasia: **${state.secret}** | Percobaan: **${nextAttempts.length}/${state.maxAttempts}**`,
        description: isSolo
          ? `Kesempatan habis! Angka rahasianya adalah **${state.secret}**.`
          : `Batas ${state.maxAttempts} percobaan tercapai! Angka rahasianya adalah **${state.secret}**. Pertandingan berakhir **Draw**.`,
      };
      return {
        state: {
          ...state,
          attempts: nextAttempts,
          lastHint: hint,
          currentTurn: null,
          status: MATCH_STATUS.FINISHED,
          result,
        },
        finished: true,
        result,
      };
    }

    const nextTurn =
      state.mode === GAME_MODES.MULTIPLAYER
        ? state.players.find((p) => p !== playerId)
        : playerId;

    return {
      state: {
        ...state,
        attempts: nextAttempts,
        lastHint: hint,
        currentTurn: nextTurn,
      },
      finished: false,
    };
  },

  /**
   * Never reveals `state.secret` while game is active.
   */
  getPublicView(state) {
    const remaining = state.maxAttempts - state.attempts.length;
    const recent = state.attempts.slice(-5).map((a, idx) => {
      const num = state.attempts.length - Math.min(5, state.attempts.length) + idx + 1;
      return `${num}. <@${a.playerId}> menebak **${a.guess}** → **${a.hint}**`;
    });

    const lines = [
      `Tingkat Kesulitan: **${DIFFICULTY_LABELS[state.difficulty]}** (Rentang **${state.min}–${state.max}**)`,
      `Sisa Percobaan: **${remaining}/${state.maxAttempts}**`,
    ];

    if (state.status === MATCH_STATUS.FINISHED) {
      lines.push(`Angka Rahasia: **${state.secret}**`);
    }

    if (recent.length > 0) {
      lines.push('', '**Riwayat Tebakan Terakhir:**', ...recent);
    }

    return {
      mode: state.mode,
      players: state.players,
      status: state.status === MATCH_STATUS.FINISHED ? 'Selesai' : 'Berlangsung',
      currentTurn: state.currentTurn,
      boardOrInfo: lines.join('\n'),
      instructions:
        state.status === MATCH_STATUS.FINISHED
          ? undefined
          : 'Gunakan `/guess play number:<angka>` untuk mengirim tebakan.',
    };
  },

  getPrivateView(state) {
    return {
      lastHint: state.lastHint,
      attemptsUsed: state.attempts.length,
      remainingAttempts: state.maxAttempts - state.attempts.length,
    };
  },
};
