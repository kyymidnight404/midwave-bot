import { createRpsMatchState } from '../games/engines/rockPaperScissors.js';
import { GAME_CENTER_TYPES } from '../games/services/scoreService.js';
import { launchTwoPlayerChallenge } from '../games/utils/challengeLauncher.js';

export default {
  name: 'rps',
  /**
   * Executes `!rps @user` Game Center Rock Paper Scissors (Best of 3) challenge.
   * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
   * @param {object} [context]
   */
  async execute(interaction, context = {}) {
    return launchTwoPlayerChallenge({
      interaction,
      context,
      gameType: GAME_CENTER_TYPES.RPS,
      createInitialState: createRpsMatchState,
      roles: ['P1', 'P2'],
      usageHint: '!rps @user',
    });
  },
};
