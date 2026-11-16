import { createConnectFourState } from '../games/engines/connectFour.js';
import { GAME_CENTER_TYPES } from '../games/services/scoreService.js';
import { launchTwoPlayerChallenge } from '../games/utils/challengeLauncher.js';

export default {
  name: 'connect4',
  /**
   * Executes `!connect4 @user` Game Center Connect Four challenge.
   * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
   * @param {object} [context]
   */
  async execute(interaction, context = {}) {
    return launchTwoPlayerChallenge({
      interaction,
      context,
      gameType: GAME_CENTER_TYPES.CONNECT4,
      createInitialState: createConnectFourState,
      roles: ['R', 'Y'],
      usageHint: '!connect4 @user',
    });
  },
};
