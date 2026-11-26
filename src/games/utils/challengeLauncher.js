import { MessageFlags } from 'discord.js';
import { prisma as defaultPrisma } from '../../services/prisma.js';
import { buildErrorEmbed, getIconFiles } from '../../utils/embeds.js';
import {
  CHALLENGE_TTL_MS,
  createPersistedSession,
  findActiveUserSession,
  releaseUnconsentedSessionsForUser,
  updatePersistedSession,
  withSessionLock,
} from '../services/sessionService.js';
import { buildChallengeMessage } from './gameUi.js';

/**
 * Shared launcher for 2-player Game Center challenges (`!ttt @user`, `!connect4 @user`, `!rps @user`).
 * Validates guild, opponent, active session locks, persists challenge in SQLite, and stores `messageId`.
 *
 * @param {{
 *   interaction: import('../../handlers/MessageCommandAdapter.js').MessageCommandAdapter,
 *   context: object,
 *   gameType: 'ttt' | 'connect4' | 'rps',
 *   createInitialState: (params: { hostId: string, opponentId: string }) => object,
 *   roles: [string, string],
 *   usageHint: string,
 * }} params
 */
export async function launchTwoPlayerChallenge({
  interaction,
  context = {},
  gameType,
  createInitialState,
  roles,
  usageHint,
}) {
  const prisma = context.prisma ?? defaultPrisma;
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Command Game Center hanya dapat digunakan di dalam server.')],
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const hostUser = interaction.user;
  const opponentUser = interaction.options?.getUser?.('opponent', false) ?? null;
  if (!opponentUser) {
    await interaction.reply({
      embeds: [buildErrorEmbed(`Mention lawan yang valid. Contoh: \`${usageHint}\`.`)],
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  if (opponentUser.id === hostUser.id) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Kamu tidak bisa menantang dirimu sendiri.')],
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  if (opponentUser.bot) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Kamu tidak bisa menantang bot pada mode Game Center.')],
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const session = await withSessionLock(`create:${guildId}:${hostUser.id}`, async () => {
    const hostActive = await findActiveUserSession(guildId, hostUser.id, prisma);
    if (hostActive) {
      await interaction.reply({
        embeds: [buildErrorEmbed('Kamu masih memiliki sesi Game Center aktif atau menunggu di server ini.')],
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    const oppActive = await findActiveUserSession(guildId, opponentUser.id, prisma);
    if (oppActive) {
      await interaction.reply({
        embeds: [buildErrorEmbed(`<@${opponentUser.id}> sedang berada di sesi Game Center lain.`)],
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    await releaseUnconsentedSessionsForUser(guildId, hostUser.id, prisma);

    const initialState = createInitialState({
      hostId: hostUser.id,
      opponentId: opponentUser.id,
    });

    return createPersistedSession({
      prisma,
      guildId,
      channelId: interaction.channelId,
      gameType,
      status: 'pending',
      hostId: hostUser.id,
      currentTurnId: initialState.currentTurnId ?? null,
      state: initialState,
      participants: [
        { userId: hostUser.id, username: hostUser.username ?? null, role: roles[0] },
        { userId: opponentUser.id, username: opponentUser.username ?? null, role: roles[1] },
      ],
      ttlMs: CHALLENGE_TTL_MS,
    });
  });

  if (!session) {
    return null;
  }

  const canAttach = interaction.canAttachFiles !== false;
  const payload = buildChallengeMessage({
    sessionId: session.id,
    gameType,
    hostId: hostUser.id,
    opponentId: opponentUser.id,
    includeThumbnail: canAttach,
  });

  const sentMsg = await interaction.reply({
    ...payload,
    files: canAttach ? getIconFiles(gameType) : [],
  });

  if (sentMsg?.id) {
    await updatePersistedSession(session.id, { messageId: sentMsg.id }, prisma);
  }

  return session;
}
