import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client, GatewayIntentBits } from 'discord.js';
import { CommandHandler } from './handlers/CommandHandler.js';
import { AutoDownloaderHandler } from './handlers/AutoDownloaderHandler.js';
import { InteractionHandler } from './handlers/InteractionHandler.js';
import { PrefixCommandHandler } from './handlers/PrefixCommandHandler.js';
import { SessionManager } from './managers/SessionManager.js';
import { InviteManager } from './managers/InviteManager.js';
import { GameManager } from './managers/GameManager.js';
import { AiConversationManager } from './managers/AiConversationManager.js';
import { CooldownManager } from './utils/cooldown.js';
import { redactSensitiveText, sanitizeError } from './utils/errorSanitizer.js';
import { GAME_TYPES } from './utils/constants.js';
import { resolvePrefix } from './utils/prefixParser.js';
import { CoinFlipGame } from './games/CoinFlipGame.js';
import { RPSGame } from './games/RPSGame.js';
import { TicTacToeGame } from './games/TicTacToeGame.js';
import readyEvent from './events/ready.js';
import interactionCreateEvent from './events/interactionCreate.js';
import messageCreateEvent from './events/messageCreate.js';
import guildMemberAddEvent from './events/guildMemberAdd.js';
import guildCreateEvent from './events/guildCreate.js';
import { clearAllGameCenterTimers } from './games/services/sessionService.js';
import { cleanupStaleTempDirs, getDownloaderConfig } from './services/downloader.js';
import { prisma as defaultPrisma } from './services/prisma.js';

/**
 * Registers all pure game engines on a GameManager instance.
 * Engines are added incrementally as each phase completes.
 */
export function registerDefaultGames(gameManager) {
  gameManager.registerGame(GAME_TYPES.COINFLIP, CoinFlipGame);
  gameManager.registerGame(GAME_TYPES.RPS, RPSGame);
  gameManager.registerGame(GAME_TYPES.TICTACTOE, TicTacToeGame);
}

/**
 * Creates and wires the Midwave Discord bot application without logging in.
 */
export async function createBotApp(options = {}) {
  const logger = options.logger ?? console;
  const client =
    options.client ??
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
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
  const aiConversationManager = options.aiConversationManager ?? new AiConversationManager();

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
    aiConversationManager,
    prisma: options.prisma ?? defaultPrisma,
    logger,
  };

  const interactionHandler = new InteractionHandler({
    commandHandler,
    cooldowns,
    context,
    logger,
  });
  context.interactionHandler = interactionHandler;

  const prefixCommandHandler = new PrefixCommandHandler({
    commandHandler,
    cooldowns,
    prefix,
    context,
    logger,
  });
  context.prefixCommandHandler = prefixCommandHandler;

  const autoDownloaderHandler =
    options.autoDownloaderHandler ??
    new AutoDownloaderHandler({
      cooldowns,
      prefix,
    });
  context.autoDownloaderHandler = autoDownloaderHandler;

  if (!options.skipTempCleanup) {
    cleanupStaleTempDirs(getDownloaderConfig().tempBaseDir).catch(() => {});
  }

  const events = [readyEvent, interactionCreateEvent, messageCreateEvent, guildMemberAddEvent, guildCreateEvent];
  for (const event of events) {
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, context));
    } else {
      client.on(event.name, (...args) => event.execute(...args, context));
    }
  }

  client.on?.('error', (err) => {
    logger.error?.('[Midwave] Discord client error:', sanitizeError(err));
  });

  client.on?.('warn', (message) => {
    logger.warn?.('[Midwave] Discord client warning:', redactSensitiveText(message));
  });

  client.on?.('shardDisconnect', (event, shardId) => {
    logger.warn?.(`[Midwave] Shard ${shardId} disconnected (code=${event?.code ?? 'unknown'}).`);
  });

  client.on?.('shardReconnecting', (shardId) => {
    logger.log?.(`[Midwave] Shard ${shardId} reconnecting to Discord Gateway...`);
  });

  client.on?.('shardError', (err, shardId) => {
    logger.error?.(`[Midwave] Shard ${shardId} error:`, sanitizeError(err));
  });

  client.rest?.on?.('rateLimited', (info) => {
    const retrySec =
      typeof info?.retryAfter === 'number' && Number.isFinite(info.retryAfter)
        ? (info.retryAfter / 1000).toFixed(1)
        : 'unknown';
    logger.warn?.(
      `[Midwave] Discord REST rate-limited (route=${info?.route ?? 'unknown'}, scope=${info?.scope ?? 'unknown'}, global=${Boolean(info?.global)}, retryAfter=${retrySec}s)`,
    );
  });

  return {
    client,
    prefix,
    commandHandler,
    interactionHandler,
    prefixCommandHandler,
    autoDownloaderHandler,
    cooldowns,
    sessionManager,
    inviteManager,
    gameManager,
    aiConversationManager,
    context,
    shutdown: () => {
      sessionManager.clearAll();
      inviteManager.clearAll();
      aiConversationManager.clear();
      cooldowns.clear();
      clearAllGameCenterTimers();
      if (!options.prisma) defaultPrisma.$disconnect().catch(() => {});
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
    console.error('[Midwave] Unhandled promise rejection:', sanitizeError(reason));
  });

  process.on('uncaughtException', (err) => {
    console.error('[Midwave] Uncaught exception:', sanitizeError(err));
  });

  console.log(
    `[Midwave] Starting bot (prefix=${app.prefix}, commands=${app.commandHandler.commands.size}) — connecting to Discord Gateway...`,
  );

  try {
    await app.client.login(token);
  } catch (err) {
    app.shutdown();
    throw err;
  }
  return app;
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  startBot().catch((err) => {
    console.error('[Midwave] Fatal startup error:', sanitizeError(err));
    process.exit(1);
  });
}
