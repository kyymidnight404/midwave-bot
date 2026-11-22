import { Events } from 'discord.js';
import { validateApplicationEmojis } from '../config/emojis.js';
import { recoverGameCenterSessions } from './gameInteraction.js';
import { ensureQuizQuestionsSeeded } from '../games/services/questionService.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

export default {
  name: Events.ClientReady,
  once: true,
  /**
   * @param {import('discord.js').Client} client
   * @param {{ commandHandler?: import('../handlers/CommandHandler.js').CommandHandler, prisma?: any, logger?: Console }} context
   */
  execute(client, context = {}) {
    const commandCount = context.commandHandler?.commands?.size ?? 0;
    const guildCount = client.guilds?.cache?.size ?? 0;
    console.log(
      `[Midwave] Logged in as ${client.user?.tag ?? 'unknown'} | Guilds: ${guildCount} | Commands: ${commandCount}`,
    );

    validateApplicationEmojis(client, { logger: context.logger ?? console }).catch((err) => {
      (context.logger ?? console).warn?.('[Midwave] Emoji validation skipped:', sanitizeError(err));
    });

    ensureQuizQuestionsSeeded(context.prisma).catch((err) => {
      (context.logger ?? console).error?.('[GameCenter] Quiz seed on startup failed:', sanitizeError(err));
    });
    recoverGameCenterSessions({
      prisma: context.prisma,
      client,
      logger: context.logger ?? console,
    }).catch((err) => {
      (context.logger ?? console).error?.('[GameCenter] Session recovery on startup failed:', sanitizeError(err));
    });
  },
};
