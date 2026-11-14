import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandStructure as defaultCommandStructure } from './src/config/commandStructure.js';
import { DEFAULT_HANDLER_REGISTRY } from './src/config/commandRegistry.js';
import { CommandHandler } from './src/handlers/CommandHandler.js';
import { syncCommands } from './src/services/commandManager.js';

/**
 * Loads `.env` when running `node deploy-commands.js` directly without `--env-file=.env`.
 */
function ensureEnvLoaded() {
  if (!process.env.DISCORD_TOKEN && existsSync('.env') && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env');
  }
}

/**
 * Validates, previews, and registers Midwave Discord Application Commands from `commandStructure`.
 * Defaults to guild-scoped registration using GUILD_ID for fast development updates;
 * pass `--global` for production global registration or `--preview` for dry-run inspection.
 *
 * @param {{
 *   global?: boolean,
 *   dryRun?: boolean,
 *   commandHandler?: CommandHandler,
 *   commandStructure?: object,
 *   handlerRegistry?: Record<string, Function>,
 *   restClient?: { get?: Function, put: Function },
 *   env?: NodeJS.ProcessEnv,
 *   logger?: Console,
 * }} [options]
 */
export async function deployCommands(options = {}) {
  const {
    global: isGlobal = false,
    dryRun = false,
    commandHandler = null,
    commandStructure = defaultCommandStructure,
    handlerRegistry = DEFAULT_HANDLER_REGISTRY,
    restClient = null,
    env = process.env,
    logger = console,
  } = options;

  if (env === process.env) {
    ensureEnvLoaded();
  }

  const token = env.DISCORD_TOKEN;
  const clientId = env.CLIENT_ID;
  const guildId = env.GUILD_ID;

  if (!token && !dryRun) {
    throw new Error('Missing DISCORD_TOKEN environment variable.');
  }
  if (!clientId) {
    throw new Error('Missing CLIENT_ID environment variable.');
  }
  if (!isGlobal && !guildId) {
    throw new Error('Missing GUILD_ID environment variable (required for guild command deployment, or pass --global).');
  }

  const targetStructure = commandHandler?.getStructure?.() ?? commandStructure;
  const targetRegistry = commandHandler?.handlerRegistry ?? handlerRegistry;

  if (commandHandler) {
    await commandHandler.loadCommands();
  }

  const syncOutcome = await syncCommands({
    structure: targetStructure,
    handlerRegistry: targetRegistry,
    global: isGlobal,
    dryRun,
    restClient,
    token,
    clientId,
    guildId,
    logger,
  });

  return dryRun ? syncOutcome.preview : syncOutcome.result;
}

const currentFilePath = fileURLToPath(import.meta.url);
const isCli = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === currentFilePath;
if (isCli) {
  const isGlobal = process.argv.includes('--global');
  const isDryRun = process.argv.includes('--preview') || process.argv.includes('--dry-run');
  deployCommands({ global: isGlobal, dryRun: isDryRun }).catch((err) => {
    console.error('[Deploy] Command registration failed:', err.message);
    process.exit(1);
  });
}
