import { Events } from 'discord.js';

export default {
  name: Events.MessageCreate,
  once: false,
  /**
   * @param {import('discord.js').Message} message
   * @param {{
   *   prefixCommandHandler: import('../handlers/PrefixCommandHandler.js').PrefixCommandHandler,
   *   autoDownloaderHandler?: import('../handlers/AutoDownloaderHandler.js').AutoDownloaderHandler,
   * }} context
   */
  async execute(message, context) {
    await context.prefixCommandHandler.handle(message);
    if (context.autoDownloaderHandler) {
      await context.autoDownloaderHandler.handle(message);
    }
  },
};
