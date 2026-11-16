import { createTicTacToeState } from '../games/engines/ticTacToe.js';
import { GAME_CENTER_TYPES } from '../games/services/scoreService.js';
import { launchTwoPlayerChallenge } from '../games/utils/challengeLauncher.js';

export default {
  name: 'ttt',
  /**
   * Executes `!ttt @user` Game Center Tic Tac Toe challenge.
   * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
   * @param {object} [context]
   */
  async execute(interaction, context = {}) {
    return launchTwoPlayerChallenge({
      interaction,
      context,
      gameType: GAME_CENTER_TYPES.TTT,
      createInitialState: createTicTacToeState,
      roles: ['X', 'O'],
      usageHint: '!ttt @user',
    });
  },
};
