import {
  BOT_PLAYER_ID,
  DIFFICULTY_LABELS,
  GAME_MODES,
  MATCH_STATUS,
  TTT_POSITIONS,
} from '../utils/constants.js';
import { defaultRng } from '../utils/random.js';
import { isValidDifficulty, isValidTttPosition } from '../utils/validators.js';
import { chooseTicTacToeMove, evaluateTicTacToeBoard } from './ai/ticTacToeAI.js';

const CELL_GLYPHS = {
  X: '❌',
  O: '⭕',
  EMPTY: '⬜',
};

function positionToIndex(pos) {
  return TTT_POSITIONS.indexOf(String(pos).toUpperCase());
}

function indexToPosition(idx) {
  return TTT_POSITIONS[idx];
}

function renderBoardText(board) {
  const rows = [];
  rows.push('`   A  B  C `');
  for (let r = 0; r < 3; r += 1) {
    const cells = [];
    for (let c = 0; c < 3; c += 1) {
      const val = board[r * 3 + c];
      cells.push(val ? CELL_GLYPHS[val] : CELL_GLYPHS.EMPTY);
    }
    rows.push(`\`${r + 1}\` ${cells.join(' ')}`);
  }
  return rows.join('\n');
}

function buildResultFromEvaluation(state, evalRes) {
  const [p1, p2] = state.players;
  if (evalRes.isDraw) {
    return {
      winnerId: null,
      loserId: null,
      isDraw: true,
      finalScore: 'Draw (Papan Penuh)',
      description: 'Papan penuh tanpa pemenang. Pertandingan berakhir **Draw**!',
    };
  }
  const winnerId = evalRes.winner === 'X' ? p1 : p2;
  const loserId = winnerId === p1 ? p2 : p1;
  const winnerLabel = winnerId === BOT_PLAYER_ID ? 'Midwave Bot' : `<@${winnerId}>`;
  return {
    winnerId,
    loserId,
    isDraw: false,
    finalScore: `Simbol Pemenang: **${evalRes.winner}**`,
    description: `${winnerLabel} (${evalRes.winner}) menang dengan tiga simbol sejajar!`,
  };
}

/**
 * Pure Tic Tac Toe 3x3 game engine (Solo & 2-player Multiplayer).
 */
export const TicTacToeGame = {
  create(config, players) {
    const mode = config?.mode ?? (players.includes(BOT_PLAYER_ID) ? GAME_MODES.SOLO : GAME_MODES.MULTIPLAYER);
    const difficulty = isValidDifficulty(config?.difficulty) ? config.difficulty : 'normal';
    const [p1, p2] = players;

    return {
      mode,
      difficulty,
      players: [p1, p2],
      marks: { [p1]: 'X', [p2]: 'O' },
      board: Array(9).fill(null),
      currentTurn: p1,
      lastMove: null,
      status: MATCH_STATUS.ACTIVE,
      result: null,
    };
  },

  applyAction(state, playerId, action, rng = defaultRng) {
    if (state.status !== MATCH_STATUS.ACTIVE) {
      return { error: 'Pertandingan Tic Tac Toe sudah selesai.' };
    }
    if (!state.players.includes(playerId)) {
      return { error: 'Kamu bukan peserta pertandingan ini.' };
    }
    if (state.currentTurn !== playerId) {
      return { error: `Sekarang giliran <@${state.currentTurn}>.` };
    }

    const pos = String(action?.position ?? '').toUpperCase();
    if (!isValidTttPosition(pos)) {
      return { error: 'Koordinat tidak valid. Gunakan A1–C3 (contoh: `B2`).' };
    }

    const idx = positionToIndex(pos);
    if (state.board[idx] !== null) {
      return { error: `Kotak **${pos}** sudah terisi! Pilih kotak kosong lain.` };
    }

    const nextBoard = [...state.board];
    const mark = state.marks[playerId];
    nextBoard[idx] = mark;

    const evalAfterHuman = evaluateTicTacToeBoard(nextBoard);
    if (evalAfterHuman.winner || evalAfterHuman.isDraw) {
      const result = buildResultFromEvaluation(state, evalAfterHuman);
      return {
        state: {
          ...state,
          board: nextBoard,
          lastMove: `${pos} (${mark})`,
          currentTurn: null,
          status: MATCH_STATUS.FINISHED,
          result,
        },
        finished: true,
        result,
      };
    }

    // Solo mode: AI immediately takes its turn
    if (state.mode === GAME_MODES.SOLO) {
      const aiMark = state.marks[BOT_PLAYER_ID];
      const aiIdx = chooseTicTacToeMove(nextBoard, state.difficulty, aiMark, rng);
      if (aiIdx !== -1) {
        nextBoard[aiIdx] = aiMark;
      }

      const evalAfterAi = evaluateTicTacToeBoard(nextBoard);
      const aiMoveLabel = aiIdx !== -1 ? `${indexToPosition(aiIdx)} (${aiMark})` : null;

      if (evalAfterAi.winner || evalAfterAi.isDraw) {
        const result = buildResultFromEvaluation(state, evalAfterAi);
        return {
          state: {
            ...state,
            board: nextBoard,
            lastMove: aiMoveLabel ?? `${pos} (${mark})`,
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
          lastMove: `Kamu: ${pos}, Bot: ${indexToPosition(aiIdx)}`,
          currentTurn: playerId,
        },
        finished: false,
      };
    }

    // Multiplayer: switch turn to opponent
    const nextTurn = state.players.find((p) => p !== playerId);
    return {
      state: {
        ...state,
        board: nextBoard,
        lastMove: `${pos} (${mark})`,
        currentTurn: nextTurn,
      },
      finished: false,
    };
  },

  getPublicView(state) {
    const [p1, p2] = state.players;
    const p2Label = p2 === BOT_PLAYER_ID ? `Midwave Bot (${DIFFICULTY_LABELS[state.difficulty]})` : `<@${p2}>`;
    const legend = `❌ <@${p1}> | ⭕ ${p2Label}`;
    const parts = [legend, '', renderBoardText(state.board)];

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
          : 'Gunakan `/game action:move game:tictactoe position:<A1-C3>` untuk menaruh simbol.',
    };
  },

  getPrivateView(state, playerId) {
    return {
      mark: state.marks[playerId] ?? null,
      lastMove: state.lastMove,
    };
  },
};
