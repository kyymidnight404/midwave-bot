import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client, GatewayIntentBits } from 'discord.js';
import { CommandHandler } from './handlers/CommandHandler.js';
import { InteractionHandler } from './handlers/InteractionHandler.js';
import { PrefixCommandHandler } from './handlers/PrefixCommandHandler.js';
import { SessionManager } from './managers/SessionManager.js';
import { InviteManager } from './managers/InviteManager.js';
import { GameManager } from './managers/GameManager.js';
import { CooldownManager } from './utils/cooldown.js';
import { GAME_TYPES } from './utils/constants.js';
import { resolvePrefix } from './utils/prefixParser.js';
import { CoinFlipGame } from './games/CoinFlipGame.js';
import { DiceGame } from './games/DiceGame.js';
import { RPSGame } from './games/RPSGame.js';
import { GuessGame } from './games/GuessGame.js';
import { TriviaGame } from './games/TriviaGame.js';
import { loadTriviaBank } from './games/TriviaBank.js';
import { TicTacToeGame } from './games/TicTacToeGame.js';
import { ConnectFourGame } from './games/ConnectFourGame.js';
import readyEvent from './events/ready.js';
import interactionCreateEvent from './events/interactionCreate.js';
import messageCreateEvent from './events/messageCreate.js';

/**
 * Registers all pure game engines on a GameManager instance.
 * Engines are added incrementally as each phase completes.
 */
export function registerDefaultGames(gameManager) {
  loadTriviaBank();
  gameManager.registerGame(GAME_TYPES.COINFLIP, CoinFlipGame);
  gameManager.registerGame(GAME_TYPES.DICE, DiceGame);
  gameManager.registerGame(GAME_TYPES.RPS, RPSGame);
  gameManager.registerGame(GAME_TYPES.GUESS, GuessGame);
  gameManager.registerGame(GAME_TYPES.TRIVIA, TriviaGame);
  gameManager.registerGame(GAME_TYPES.TICTACTOE, TicTacToeGame);
  gameManager.registerGame(GAME_TYPES.CONNECT4, ConnectFourGame);
}

/**
 * Creates and wires the Midwave Discord bot application without logging in.
 */
export async function createBotApp(options = {}) {
  const client =
    options.client ??
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

  const prefix = resolvePrefix(options.prefix ?? process.env.PREFIX);
  const commandHandler = options.commandHandler ?? new CommandHandler();
  await commandHandler.loadCommands();

  const cooldowns = options.cooldowns ?? new CooldownManager();
  const sessionManager = options.sessionManager ?? new SessionManager();
  const inviteManager = options.inviteManager ?? new InviteManager({ sessionManager });
  const gameManager = options.gameManager ?? new GameManager({ sessionManager, inviteManager });

  if (!options.gameManager) {
    registerDefaultGames(gameManager);
  }

  const context = {
    client,
    prefix,
    commandHandler,
    cooldowns,
    sessionManager,
    inviteManager,
    gameManager,
  };

  const interactionHandler = new InteractionHandler({
    commandHandler,
    cooldowns,
    context,
  });
  context.interactionHandler = interactionHandler;

  const prefixCommandHandler = new PrefixCommandHandler({
    commandHandler,
    cooldowns,
    prefix,
    context,
  });
  context.prefixCommandHandler = prefixCommandHandler;

  const events = [readyEvent, interactionCreateEvent, messageCreateEvent];
  for (const event of events) {
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, context));
    } else {
      client.on(event.name, (...args) => event.execute(...args, context));
    }
  }

  client.on('error', (err) => {
    console.error('[Midwave] Discord client error:', err);
  });

  return {
    client,
    prefix,
    commandHandler,
    interactionHandler,
    prefixCommandHandler,
    cooldowns,
    sessionManager,
    inviteManager,
    gameManager,
    context,
    shutdown: () => {
      sessionManager.clearAll();
      inviteManager.clearAll();
      cooldowns.clear();
      client.destroy();
    },
  };
}

/**
 * Boots the bot and logs into Discord using `process.env.DISCORD_TOKEN`.
 */
export async function startBot() {
  if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env');
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN environment variable. Check your .env file.');
  }

  const app = await createBotApp();

  const handleSignal = (signal) => {
    console.log(`[Midwave] Received ${signal}, shutting down cleanly...`);
    app.shutdown();
    process.exit(0);
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[Midwave] Unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[Midwave] Uncaught exception:', err);
  });

  await app.client.login(token);
  return app;
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  startBot().catch((err) => {
    console.error('[Midwave] Fatal startup error:', err.message);
    process.exit(1);
  });
}
