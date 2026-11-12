import { Events } from 'discord.js';

export default {
  name: Events.InteractionCreate,
  once: false,
  /**
   * @param {import('discord.js').Interaction} interaction
   * @param {{ interactionHandler: import('../handlers/InteractionHandler.js').InteractionHandler }} context
   */
  async execute(interaction, context) {
    await context.interactionHandler.handle(interaction);
  },
};
