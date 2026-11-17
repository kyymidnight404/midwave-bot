import { execute as executeSlashAnime } from '../anime.js';
import { MessageCommandAdapter } from '../../handlers/MessageCommandAdapter.js';
import { ANIME_COOLDOWN_MS } from '../../services/animeService.js';

/**
 * Executes the `!anime [judul]` prefix command.
 * Supports both `MessageCommandAdapter` (dispatched by `PrefixCommandHandler`)
 * and direct Discord `Message` invocations (`execute(message, args, context)`).
 *
 * @param {import('../../handlers/MessageCommandAdapter.js').MessageCommandAdapter | import('discord.js').Message} interactionOrMessage
 * @param {object | string[]} [contextOrArgs]
 * @param {object} [maybeContext]
 */
export async function execute(interactionOrMessage, contextOrArgs = {}, maybeContext = {}) {
  if (!interactionOrMessage) {
    return;
  }

  // Standard Midwave dispatch via MessageCommandAdapter or ChatInputCommandInteraction
  if (typeof interactionOrMessage.options?.getString === 'function') {
    const context =
      contextOrArgs && !Array.isArray(contextOrArgs) ? contextOrArgs : maybeContext;
    return executeSlashAnime(interactionOrMessage, context);
  }

  // Fallback for direct raw Discord Message calls: execute(message, args, context)
  const message = interactionOrMessage;
  if (message.author?.bot) {
    return;
  }

  let query = '';
  let context = maybeContext || {};

  if (Array.isArray(contextOrArgs)) {
    query = contextOrArgs.join(' ').trim();
  } else if (typeof message.content === 'string') {
    context = contextOrArgs || {};
    const prefix = context.prefix || '!';
    const raw = message.content.startsWith(prefix)
      ? message.content.slice(prefix.length).trim()
      : message.content.trim();
    query = raw.replace(/^anime\b/i, '').trim();
  }

  const adapter = new MessageCommandAdapter({
    message,
    parsed: {
      commandName: 'anime',
      subcommand: null,
      options: query ? { query } : {},
    },
  });

  return executeSlashAnime(adapter, context);
}

export default {
  name: 'anime',
  aliases: ['anilist'],
  cooldownMs: ANIME_COOLDOWN_MS,
  execute,
};
