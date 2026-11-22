import { createRpsMatchState } from '../games/engines/rockPaperScissors.js';
import { GAME_CENTER_TYPES } from '../games/services/scoreService.js';
import { launchTwoPlayerChallenge } from '../games/utils/challengeLauncher.js';
import { launchUnifiedGameLobby } from '../games/utils/gameLobby.js';
import { GAME_TYPES } from '../utils/constants.js';

export default {
  name: 'rps',
  /**
   * Executes `!rps` (unified lobby) or `!rps @user` Game Center Rock Paper Scissors challenge.
   * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
   * @param {object} [context]
   */
  async execute(interaction, context = {}) {
    const subcommand = interaction.options?.getSubcommand?.(false);
    if (subcommand === 'lobby') {
      return launchUnifiedGameLobby({
        interaction,
        context,
        gameType: GAME_TYPES.RPS,
      });
    }

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
