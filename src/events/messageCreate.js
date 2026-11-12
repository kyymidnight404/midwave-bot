import { Events } from 'discord.js';

export default {
  name: Events.MessageCreate,
  once: false,
  /**
   * @param {import('discord.js').Message} message
   * @param {{ prefixCommandHandler: import('../handlers/PrefixCommandHandler.js').PrefixCommandHandler }} context
   */
  async execute(message, context) {
    await context.prefixCommandHandler.handle(message);
  },
};
