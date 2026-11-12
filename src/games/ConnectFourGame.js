import {
  BOT_PLAYER_ID,
  DIFFICULTY_LABELS,
  GAME_MODES,
  MATCH_STATUS,
} from '../utils/constants.js';
import { defaultRng } from '../utils/random.js';
import { isValidConnect4Column, isValidDifficulty } from '../utils/validators.js';
import {
  chooseConnect4Move,
  createEmptyConnect4Board,
  findDropRow,
  hasConnect4Win,
  isConnect4BoardFull,
} from './ai/connectFourAI.js';

const DISC_GLYPHS = {
  0: '⚫',
  1: '🔴',
  2: '🟡',
};

const COL_HEADERS = '1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣';

function renderConnect4Board(board) {
  const rows = board.map((row) => row.map((cell) => DISC_GLYPHS[cell]).join(''));
  rows.push(COL_HEADERS);
  return rows.join('\n');
}

function buildResult(state, winnerMark) {
  const [p1, p2] = state.players;
  if (winnerMark === 0) {
    return {
      winnerId: null,
      loserId: null,
      isDraw: true,
      finalScore: 'Draw (Papan 7×6 Penuh)',
      description: 'Seluruh papan terisi tanpa 4 keping berurutan. Pertandingan berakhir **Draw**!',
    };
  }
  const winnerId = winnerMark === 1 ? p1 : p2;
  const loserId = winnerId === p1 ? p2 : p1;
  const winnerLabel = winnerId === BOT_PLAYER_ID ? 'Midwave Bot' : `<@${winnerId}>`;
  const disc = DISC_GLYPHS[winnerMark];
  return {
    winnerId,
    loserId,
    isDraw: false,
    finalScore: `Keping Pemenang: ${disc}`,
    description: `${winnerLabel} (${disc}) menyusun 4 keping berurutan dan memenangkan pertandingan!`,
  };
}

/**
 * Pure Connect Four 7x6 game engine (Solo & 2-player Multiplayer).
 */
export const ConnectFourGame = {
  create(config, players) {
    const mode = config?.mode ?? (players.includes(BOT_PLAYER_ID) ? GAME_MODES.SOLO : GAME_MODES.MULTIPLAYER);
    const difficulty = isValidDifficulty(config?.difficulty) ? config.difficulty : 'normal';
    const [p1, p2] = players;

    return {
      mode,
      difficulty,
      players: [p1, p2],
      marks: { [p1]: 1, [p2]: 2 },
      board: createEmptyConnect4Board(),
      currentTurn: p1,
      lastMove: null,
      status: MATCH_STATUS.ACTIVE,
      result: null,
    };
  },

  applyAction(state, playerId, action, rng = defaultRng) {
    if (state.status !== MATCH_STATUS.ACTIVE) {
      return { error: 'Pertandingan Connect Four sudah berakhir.' };
    }
    if (!state.players.includes(playerId)) {
      return { error: 'Kamu bukan peserta pertandingan ini.' };
    }
    if (state.currentTurn !== playerId) {
      return { error: `Sekarang giliran <@${state.currentTurn}>.` };
    }

    const col1Based = Number(action?.column);
    if (!isValidConnect4Column(col1Based)) {
      return { error: 'Kolom harus berupa angka bulat antara 1 dan 7.' };
    }

    const col = col1Based - 1;
    const row = findDropRow(state.board, col);
    if (row === -1) {
      return { error: `Kolom **${col1Based}** sudah penuh! Pilih kolom lain.` };
    }

    const nextBoard = state.board.map((r) => [...r]);
    const mark = state.marks[playerId];
    nextBoard[row][col] = mark;

    if (hasConnect4Win(nextBoard, mark)) {
      const result = buildResult(state, mark);
      return {
        state: {
          ...state,
          board: nextBoard,
          lastMove: `Kolom ${col1Based} (${DISC_GLYPHS[mark]})`,
          currentTurn: null,
          status: MATCH_STATUS.FINISHED,
          result,
        },
        finished: true,
        result,
      };
    }

    if (isConnect4BoardFull(nextBoard)) {
      const result = buildResult(state, 0);
      return {
        state: {
          ...state,
          board: nextBoard,
          lastMove: `Kolom ${col1Based} (${DISC_GLYPHS[mark]})`,
          currentTurn: null,
          status: MATCH_STATUS.FINISHED,
          result,
        },
        finished: true,
        result,
      };
    }

    // Solo mode: AI responds immediately
    if (state.mode === GAME_MODES.SOLO) {
      const aiMark = state.marks[BOT_PLAYER_ID];
      const aiCol = chooseConnect4Move(nextBoard, state.difficulty, aiMark, rng);
      const aiRow = findDropRow(nextBoard, aiCol);
      if (aiRow !== -1) {
        nextBoard[aiRow][aiCol] = aiMark;
      }

      if (hasConnect4Win(nextBoard, aiMark)) {
        const result = buildResult(state, aiMark);
        return {
          state: {
            ...state,
            board: nextBoard,
            lastMove: `Kamu: Kolom ${col1Based}, Bot: Kolom ${aiCol + 1}`,
            currentTurn: null,
            status: MATCH_STATUS.FINISHED,
            result,
          },
          finished: true,
          result,
        };
      }

      if (isConnect4BoardFull(nextBoard)) {
        const result = buildResult(state, 0);
        return {
          state: {
            ...state,
            board: nextBoard,
            lastMove: `Kamu: Kolom ${col1Based}, Bot: Kolom ${aiCol + 1}`,
            currentTurn: null,
            status: MATCH_STATUS.FINISHED,
            result,
          },
          finished: true,
          result,
        };
      }

      return {
        state: {
          ...state,
          board: nextBoard,
          lastMove: `Kamu: Kolom ${col1Based}, Bot: Kolom ${aiCol + 1}`,
          currentTurn: playerId,
        },
        finished: false,
      };
    }

    const nextTurn = state.players.find((p) => p !== playerId);
    return {
      state: {
        ...state,
        board: nextBoard,
        lastMove: `Kolom ${col1Based} (${DISC_GLYPHS[mark]})`,
        currentTurn: nextTurn,
      },
      finished: false,
    };
  },

  getPublicView(state) {
    const [p1, p2] = state.players;
    const p2Label = p2 === BOT_PLAYER_ID ? `Midwave Bot (${DIFFICULTY_LABELS[state.difficulty]})` : `<@${p2}>`;
    const legend = `🔴 <@${p1}> | 🟡 ${p2Label}`;
    const parts = [legend, '', renderConnect4Board(state.board)];

    if (state.lastMove) {
      parts.push('', `Langkah terakhir: **${state.lastMove}**`);
    }

    return {
      mode: state.mode,
      players: state.players,
      status: state.status === MATCH_STATUS.FINISHED ? 'Selesai' : 'Berlangsung',
      currentTurn: state.currentTurn,
      boardOrInfo: parts.join('\n'),
      instructions:
        state.status === MATCH_STATUS.FINISHED
          ? undefined
          : 'Gunakan `/connect4 drop column:<1-7>` untuk menjatuhkan keping.',
    };
  },

  getPrivateView(state, playerId) {
    return {
      mark: state.marks[playerId] ?? null,
      lastMove: state.lastMove,
    };
  },
};
