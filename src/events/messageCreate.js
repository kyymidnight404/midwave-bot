import { Events } from 'discord.js';
import { handleAfkMessage } from '../services/afkService.js';

export default {
  name: Events.MessageCreate,
  once: false,
  /**
   * @param {import('discord.js').Message} message
   * @param {{
   *   prefixCommandHandler: import('../handlers/PrefixCommandHandler.js').PrefixCommandHandler,
   *   autoDownloaderHandler?: import('../handlers/AutoDownloaderHandler.js').AutoDownloaderHandler,
   *   handleAfkMessage?: typeof handleAfkMessage,
   * }} context
   */
  async execute(message, context) {
    const afkProcessor = context?.handleAfkMessage ?? handleAfkMessage;
    await afkProcessor(message, context);
    await context.prefixCommandHandler.handle(message);
    if (context.autoDownloaderHandler) {
      await context.autoDownloaderHandler.handle(message);
    }
  },
};
