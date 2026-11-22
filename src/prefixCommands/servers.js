import { MessageFlags } from 'discord.js';
import { MessageCommandAdapter } from '../handlers/MessageCommandAdapter.js';
import { isAuthorizedKnowledgeAdmin } from '../services/knowledge/index.js';
import {
  SERVERS_CUSTOM_ID_PREFIX,
  buildServersView,
  extractBotServers,
  parseServersCustomId,
} from '../services/serversService.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

export const SERVERS_OWNER_ONLY_MESSAGE = 'This command is restricted to the bot owner.';

const IGNORED_DISCORD_ERROR_CODES = new Set([10003, 10008, 10062, 40060]);

function isBotOwner(userId, context = {}) {
  return isAuthorizedKnowledgeAdmin(userId, {
    authorizedUserIds: context.authorizedUserIds ?? context.botOwnerIds,
    env: context.env ?? process.env,
  });
}

async function replyOwnerRestricted(interaction) {
  const payload = {
    embeds: [buildErrorEmbed(SERVERS_OWNER_ONLY_MESSAGE)],
    flags: MessageFlags.Ephemeral,
  };
  try {
    if (interaction.deferred) {
      await interaction.editReply({ embeds: payload.embeds });
    } else if (interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    if (!IGNORED_DISCORD_ERROR_CODES.has(err?.code)) {
      console.error('[Servers] Failed to send authorization error:', sanitizeError(err));
    }
  }
}

/**
 * Executes `!servers` / `!guilds` for authorized Bot Owners only.
 *
 * @param {import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter | import('discord.js').Message} interactionOrMessage
 * @param {object | string[]} [contextOrArgs]
 * @param {object} [maybeContext]
 */
export async function execute(interactionOrMessage, contextOrArgs = {}, maybeContext = {}) {
  if (!interactionOrMessage) {
    return;
  }

  let interaction = interactionOrMessage;
  let context = contextOrArgs && !Array.isArray(contextOrArgs) ? contextOrArgs : maybeContext;

  if (typeof interactionOrMessage.options?.getString !== 'function') {
    const message = interactionOrMessage;
    if (message.author?.bot) {
      return;
    }
    if (!Array.isArray(contextOrArgs)) {
      context = contextOrArgs || {};
    }
    interaction = new MessageCommandAdapter({
      message,
      parsed: {
        commandName: 'servers',
        subcommand: null,
        options: {},
      },
    });
  }

  if (interaction.user?.bot) {
    return;
  }

  if (!isBotOwner(interaction.user?.id, context)) {
    await replyOwnerRestricted(interaction);
    return;
  }

  const client = context?.client ?? interaction?.client ?? null;
  const snapshot = extractBotServers(client);
  const payload = buildServersView({
    snapshot,
    page: 0,
    ownerId: interaction.user.id,
  });

  await interaction.reply(payload);
}

/**
 * Handles `servers:prev:<page>:<ownerId>` and `servers:next:<page>:<ownerId>` button pagination.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} [context]
 * @returns {Promise<boolean>}
 */
export async function handleServersInteraction(interaction, context = {}) {
  const parsed = parseServersCustomId(interaction?.customId);
  if (!parsed.valid) {
    return false;
  }

  const userId = interaction.user?.id ?? null;
  if (!userId || userId !== parsed.ownerId || !isBotOwner(userId, context)) {
    await replyOwnerRestricted(interaction);
    return true;
  }

  const client = context?.client ?? interaction?.client ?? null;
  const snapshot = extractBotServers(client);
  const payload = buildServersView({
    snapshot,
    page: parsed.targetPage,
    ownerId: parsed.ownerId,
  });

  try {
    await interaction.update(payload);
  } catch (err) {
    if (!IGNORED_DISCORD_ERROR_CODES.has(err?.code)) {
      context?.logger?.error?.('[Servers] Failed updating pagination embed:', sanitizeError(err));
    }
  }

  return true;
}

export { SERVERS_CUSTOM_ID_PREFIX };
export default {
  name: 'servers',
  aliases: ['guilds'],
  execute,
};
