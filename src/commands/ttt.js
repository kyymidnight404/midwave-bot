import { createTicTacToeState } from '../games/engines/ticTacToe.js';
import { GAME_CENTER_TYPES } from '../games/services/scoreService.js';
import { launchTwoPlayerChallenge } from '../games/utils/challengeLauncher.js';
import { launchUnifiedGameLobby } from '../games/utils/gameLobby.js';
import { GAME_TYPES } from '../utils/constants.js';

export default {
  name: 'ttt',
  /**
   * Executes `!ttt` (unified lobby) or `!ttt @user` Game Center Tic Tac Toe challenge.
   * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
   * @param {object} [context]
   */
  async execute(interaction, context = {}) {
    const subcommand = interaction.options?.getSubcommand?.(false);
    if (subcommand === 'lobby') {
      return launchUnifiedGameLobby({
        interaction,
        context,
        gameType: GAME_TYPES.TICTACTOE,
      });
    }

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
