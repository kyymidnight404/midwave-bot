import { Events } from 'discord.js';

export default {
  name: Events.ClientReady,
  once: true,
  /**
   * @param {import('discord.js').Client} client
   * @param {{ commandHandler?: import('../handlers/CommandHandler.js').CommandHandler }} context
   */
  execute(client, context = {}) {
    const commandCount = context.commandHandler?.commands?.size ?? 0;
    const guildCount = client.guilds?.cache?.size ?? 0;
    console.log(
      `[Midwave] Logged in as ${client.user?.tag ?? 'unknown'} | Guilds: ${guildCount} | Commands: ${commandCount}`,
    );
  },
};
