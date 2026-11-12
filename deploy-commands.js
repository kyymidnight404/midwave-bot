import { REST, Routes } from 'discord.js';
import { CommandHandler } from './src/handlers/CommandHandler.js';

/**
 * Registers Midwave slash commands with Discord REST API.
 * Defaults to guild-scoped registration using GUILD_ID for fast development updates;
 * pass `--global` to deploy globally across all servers.
 */
export async function deployCommands({ global: isGlobal = false } = {}) {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token) {
    throw new Error('Missing DISCORD_TOKEN environment variable.');
  }
  if (!clientId) {
    throw new Error('Missing CLIENT_ID environment variable.');
  }
  if (!isGlobal && !guildId) {
    throw new Error('Missing GUILD_ID environment variable (required for guild command deployment, or pass --global).');
  }

  const handler = new CommandHandler();
  await handler.loadCommands();
  const payload = handler.toJSON();

  const rest = new REST({ version: '10' }).setToken(token);
  const route = isGlobal
    ? Routes.applicationCommands(clientId)
    : Routes.applicationGuildCommands(clientId, guildId);

  const scopeLabel = isGlobal ? 'global' : `guild (${guildId})`;
  console.log(`[Deploy] Registering ${payload.length} commands to ${scopeLabel}...`);

  const result = await rest.put(route, { body: payload });
  console.log(`[Deploy] Successfully registered ${Array.isArray(result) ? result.length : payload.length} commands.`);
  return result;
}

const isCli = process.argv[1]?.endsWith('deploy-commands.js');
if (isCli) {
  const isGlobal = process.argv.includes('--global');
  deployCommands({ global: isGlobal }).catch((err) => {
    console.error('[Deploy] Command registration failed:', err.message);
    process.exit(1);
  });
}
