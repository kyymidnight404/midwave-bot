import { Events } from 'discord.js';
import { purgeGuildPersistedData } from '../games/services/sessionService.js';
import { prisma as defaultPrisma } from '../services/prisma.js';
import { sanitizeError } from '../utils/errorSanitizer.js';

export default {
  name: Events.GuildDelete,
  once: false,
  async execute(guild, context = {}) {
    if (!guild?.id) return;
    const prisma = context.prisma ?? defaultPrisma;
    try {
      await purgeGuildPersistedData(guild.id, prisma);
    } catch (error) {
      context.logger?.warn?.(
        `[GuildDelete] Failed cleaning up persisted data for guild ${guild.id}:`,
        sanitizeError(error),
      );
    }
  },
};
