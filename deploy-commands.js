import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';
import { CommandHandler } from './src/handlers/CommandHandler.js';

/**
 * Loads `.env` when running `node deploy-commands.js` directly without `--env-file=.env`.
 */
function ensureEnvLoaded() {
  if (!process.env.DISCORD_TOKEN && existsSync('.env') && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env');
  }
}

/**
 * Registers Midwave slash commands with Discord REST API.
 * Defaults to guild-scoped registration using GUILD_ID for fast development updates;
 * pass `--global` to deploy globally across all servers.
 *
 * @param {{
 *   global?: boolean,
 *   commandHandler?: CommandHandler,
 *   restClient?: { put: Function },
 *   env?: NodeJS.ProcessEnv,
 *   logger?: Console,
 * }} [options]
 */
export async function deployCommands(options = {}) {
  const {
    global: isGlobal = false,
    commandHandler = new CommandHandler(),
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

  if (!token) {
    throw new Error('Missing DISCORD_TOKEN environment variable.');
  }
  if (!clientId) {
    throw new Error('Missing CLIENT_ID environment variable.');
  }
  if (!isGlobal && !guildId) {
    throw new Error('Missing GUILD_ID environment variable (required for guild command deployment, or pass --global).');
  }

  await commandHandler.loadCommands();
  const payload = commandHandler.toJSON();

  if (payload.length === 0) {
    throw new Error('No slash commands found to register.');
  }

  const rest = restClient ?? new REST({ version: '10' }).setToken(token);
  const route = isGlobal
    ? Routes.applicationCommands(clientId)
    : Routes.applicationGuildCommands(clientId, guildId);

  const scopeLabel = isGlobal ? 'global' : `guild (${guildId})`;
  logger.log(`[Deploy] Registering ${payload.length} commands to ${scopeLabel}...`);

  const result = await rest.put(route, { body: payload });
  const registeredNames = Array.isArray(result)
    ? result.map((cmd) => cmd.name).sort()
    : payload.map((cmd) => cmd.name).sort();

  const missingNames = payload
    .map((cmd) => cmd.name)
    .filter((name) => !registeredNames.includes(name));
  if (missingNames.length > 0) {
    throw new Error(`Discord API response missing expected commands: ${missingNames.join(', ')}`);
  }

  logger.log(
    `[Deploy] Successfully registered ${registeredNames.length} commands: ${registeredNames.join(', ')}`,
  );
  return result;
}

const currentFilePath = fileURLToPath(import.meta.url);
const isCli = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === currentFilePath;
if (isCli) {
  const isGlobal = process.argv.includes('--global');
  deployCommands({ global: isGlobal }).catch((err) => {
    console.error('[Deploy] Command registration failed:', err.message);
    process.exit(1);
  });
}
