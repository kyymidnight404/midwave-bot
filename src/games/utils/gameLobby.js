import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  UserSelectMenuBuilder,
} from 'discord.js';
import { COLORS } from '../../config/colors.js';
import { getEmoji } from '../../config/emojis.js';
import { prisma as defaultPrisma } from '../../services/prisma.js';
import { buildCoinflipBoardEmbed, buildCoinflipChoiceComponents, buildCoinflipSoloPromptPayload } from '../../utils/coinflipComponents.js';
import { GAME_TYPES, RPS_CHOICES } from '../../utils/constants.js';
import { createSessionTimeoutHandler } from '../../utils/discordBoard.js';
import { buildErrorEmbed, createBaseEmbed, getIconAttachmentUrl, getIconFiles } from '../../utils/embeds.js';
import { sanitizeError } from '../../utils/errorSanitizer.js';
import { RPSGame } from '../RPSGame.js';
import { createRpsMatchState } from '../engines/rockPaperScissors.js';
import { createTicTacToeState } from '../engines/ticTacToe.js';
import { GAME_CENTER_TYPES } from '../services/scoreService.js';
import {
  CHALLENGE_TTL_MS,
  createPersistedSession,
  findActiveUserSession,
  GAME_INACTIVITY_TTL_MS,
  updatePersistedSession,
} from '../services/sessionService.js';
import { safeUpdateMessage } from '../../events/gameInteraction.js';
import { buildRpsMessage, buildTicTacToeMessage } from './gameUi.js';

export const GAME_LOBBY_CUSTOM_ID_PREFIX = 'lobby';
export const DEFAULT_GAME_LOBBY_TTL_MS = CHALLENGE_TTL_MS;

const LOBBY_CONFIGS = Object.freeze({
  [GAME_TYPES.TICTACTOE]: Object.freeze({
    gameType: GAME_TYPES.TICTACTOE,
    gcType: GAME_CENTER_TYPES.TTT,
    title: 'Tic Tac Toe',
    iconName: 'tic-tac-toe',
    description: 'Challenge a server member to a 3×3 X vs O duel and line up three marks to win.',
    supportsSolo: false,
    roles: ['X', 'O'],
  }),
  [GAME_TYPES.RPS]: Object.freeze({
    gameType: GAME_TYPES.RPS,
    gcType: GAME_CENTER_TYPES.RPS,
    title: 'Rock Paper Scissors',
    iconName: 'rps',
    description: 'Pick Rock, Paper, or Scissors and outsmart your opponent in a Best of 3 match or solo round.',
    supportsSolo: true,
    roles: ['P1', 'P2'],
  }),
  [GAME_TYPES.COINFLIP]: Object.freeze({
    gameType: GAME_TYPES.COINFLIP,
    gcType: null,
    title: 'Coin Flip',
    iconName: 'coinflip',
    description: 'Predict Heads or Tails to win solo or face a server member in a head-to-head coin toss.',
    supportsSolo: true,
    roles: ['P1', 'P2'],
  }),
});

/**
 * Resolves normalized lobby configuration for a prefix game command.
 * @param {string} gameType
 */
export function getLobbyConfig(gameType) {
  const key = gameType === 'ttt' ? GAME_TYPES.TICTACTOE : gameType;
  return LOBBY_CONFIGS[key] ?? null;
}

/**
 * Manages pending prefix game lobbies with per-host deduplication, locking, and expiration timers.
 */
export class GameLobbyManager {
  /**
   * @param {{ ttlMs?: number, nowFn?: () => number }} [options]
   */
  constructor({ ttlMs = DEFAULT_GAME_LOBBY_TTL_MS, nowFn = () => Date.now() } = {}) {
    this.ttlMs = Math.max(0, ttlMs);
    this.nowFn = nowFn;
    /** @type {Map<string, object>} */
    this.lobbies = new Map();
    /** @type {Map<string, string>} */
    this.hostIndex = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    this.locks = new Map();
  }

  _hostKey(guildId, hostId) {
    return `${guildId || 'dm'}:${hostId}`;
  }

  /**
   * Removes expired pending lobbies.
   */
  pruneExpired() {
    const now = this.nowFn();
    for (const [id, lobby] of this.lobbies.entries()) {
      if (lobby.expiresAt && lobby.expiresAt <= now) {
        this.closeLobby(id);
      }
    }
  }

  /**
   * Checks whether `hostId` already owns an active pending lobby in `guildId`.
   * @param {string} guildId
   * @param {string} hostId
   */
  getHostLobby(guildId, hostId) {
    this.pruneExpired();
    const id = this.hostIndex.get(this._hostKey(guildId, hostId));
    return id ? this.lobbies.get(id) ?? null : null;
  }

  /**
   * Creates and registers a new pending game lobby.
   */
  createLobby({
    gameType,
    guildId,
    channelId,
    hostId,
    opponentId = null,
    ttlMs = this.ttlMs,
    onExpire = null,
  }) {
    const config = getLobbyConfig(gameType);
    if (!config) {
      throw new Error(`Game "${gameType}" tidak mendukung lobby ini.`);
    }

    this.pruneExpired();
    const existing = this.getHostLobby(guildId, hostId);
    if (existing) {
      throw new Error(
        'Kamu masih memiliki lobby permainan yang belum dimulai. Pilih lawan, mulai, atau batalkan lobby sebelumnya terlebih dahulu.',
      );
    }

    const id = crypto.randomBytes(5).toString('hex');
    const now = this.nowFn();
    const effectiveTtl = typeof ttlMs === 'number' ? Math.max(0, ttlMs) : this.ttlMs;

    const lobby = {
      id,
      gameType: config.gameType,
      guildId,
      channelId,
      hostId,
      opponentId,
      mode: opponentId ? 'multiplayer' : null,
      messageRef: null,
      createdAt: now,
      expiresAt: effectiveTtl > 0 ? now + effectiveTtl : null,
      started: false,
      closed: false,
      timer: null,
    };

    if (effectiveTtl > 0) {
      lobby.timer = setTimeout(() => {
        const current = this.lobbies.get(id);
        if (!current || current.started || current.closed) {
          return;
        }
        this.closeLobby(id);
        if (typeof onExpire === 'function') {
          Promise.resolve(onExpire(current)).catch(() => {});
        }
      }, effectiveTtl);
      lobby.timer.unref?.();
    }

    this.lobbies.set(id, lobby);
    this.hostIndex.set(this._hostKey(guildId, hostId), id);
    return lobby;
  }

  /**
   * Returns a live lobby by ID or `null` if missing/expired.
   * @param {string} lobbyId
   */
  getLobby(lobbyId) {
    this.pruneExpired();
    return this.lobbies.get(lobbyId) ?? null;
  }

  /**
   * Stores the Discord message reference for expiration edits.
   */
  setMessageRef(lobbyId, messageRef) {
    const lobby = this.lobbies.get(lobbyId);
    if (lobby) {
      lobby.messageRef = messageRef;
    }
  }

  /**
   * Closes a lobby and clears timers/indexes.
   * @param {string} lobbyId
   */
  closeLobby(lobbyId) {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) {
      return null;
    }
    lobby.closed = true;
    if (lobby.timer) {
      clearTimeout(lobby.timer);
      lobby.timer = null;
    }
    this.lobbies.delete(lobbyId);
    const key = this._hostKey(lobby.guildId, lobby.hostId);
    if (this.hostIndex.get(key) === lobbyId) {
      this.hostIndex.delete(key);
    }
    return lobby;
  }

  /**
   * Serializes concurrent interactions against the same lobby ID.
   * @template T
   * @param {string} lobbyId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async withLock(lobbyId, fn) {
    const prev = this.locks.get(lobbyId) ?? Promise.resolve();
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const chained = prev.then(() => next);
    this.locks.set(lobbyId, chained);

    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.locks.get(lobbyId) === chained) {
        this.locks.delete(lobbyId);
      }
    }
  }

  /**
   * Clears all pending lobbies and timers (used on shutdown).
   */
  clearAll() {
    for (const id of [...this.lobbies.keys()]) {
      this.closeLobby(id);
    }
    this.hostIndex.clear();
  }
}

export const defaultGameLobbyManager = new GameLobbyManager();

function resolveLobbyManager(context = {}) {
  return context?.gameLobbyManager ?? defaultGameLobbyManager;
}

/**
 * Builds the Unified Game Lobby message payload in consistent MIDWAVE order:
 * 1. Header (`Nama Game` + icon)
 * 2. Brief description + selected player/mode
 * 3. Opponent selection (UserSelectMenu)
 * 4. Start button row
 */
export function buildUnifiedLobbyMessage({
  lobby,
  includeThumbnail = true,
  statusOverride = null,
}) {
  const config = getLobbyConfig(lobby.gameType);
  const ended = statusOverride === 'expired' || statusOverride === 'cancelled' || lobby.closed || lobby.started;
  const canStart = lobby.mode === 'solo' || Boolean(lobby.opponentId);

  let statusLine = '**Opponent:** *Select an opponent below*';
  if (lobby.mode === 'solo') {
    statusLine = '**Mode:** Solo (vs Bot)';
  } else if (lobby.opponentId) {
    statusLine = `**Opponent:** <@${lobby.opponentId}>`;
  } else if (config.supportsSolo) {
    statusLine = '**Opponent:** *Select an opponent below or choose Solo Mode*';
  }

  let color = COLORS.PRIMARY;
  let extraStatus = '';
  if (statusOverride === 'expired') {
    color = COLORS.WARNING;
    extraStatus = `\n\n${getEmoji('timer')} Lobby kedaluwarsa karena tidak digunakan.`;
  } else if (statusOverride === 'cancelled') {
    color = COLORS.ERROR;
    extraStatus = `\n\n${getEmoji('error')} Lobby dibatalkan oleh Host.`;
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(config.title)
    .setDescription(`${config.description}\n\n**Host:** <@${lobby.hostId}>\n${statusLine}${extraStatus}`);

  if (includeThumbnail) {
    embed.setThumbnail(getIconAttachmentUrl(config.iconName));
  }

  const selectRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`${GAME_LOBBY_CUSTOM_ID_PREFIX}:select:${lobby.id}`)
      .setPlaceholder('Pilih lawan bermain...')
      .setMinValues(1)
      .setMaxValues(1)
      .setDisabled(ended),
  );

  const actionRow = new ActionRowBuilder();
  if (config.supportsSolo) {
    actionRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${GAME_LOBBY_CUSTOM_ID_PREFIX}:solo:${lobby.id}`)
        .setLabel(lobby.mode === 'solo' ? 'Solo Mode ✓' : 'Solo Mode')
        .setStyle(lobby.mode === 'solo' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(ended),
    );
  }

  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`${GAME_LOBBY_CUSTOM_ID_PREFIX}:start:${lobby.id}`)
      .setLabel('Start')
      .setStyle(ButtonStyle.Success)
      .setDisabled(ended || !canStart),
    new ButtonBuilder()
      .setCustomId(`${GAME_LOBBY_CUSTOM_ID_PREFIX}:cancel:${lobby.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(ended),
  );

  return {
    embeds: [embed],
    components: [selectRow, actionRow],
  };
}

/**
 * Builds Solo RPS interactive button prompt displayed in-place after clicking Start on Solo Mode.
 */
export function buildRpsSoloPromptPayload(ownerId, { includeThumbnail = true } = {}) {
  const embed = createBaseEmbed({
    title: 'Rock Paper Scissors — Solo',
    description: `<@${ownerId}>, pilih **Rock**, **Paper**, atau **Scissors** di bawah untuk bermain melawan bot.`,
    color: COLORS.PRIMARY,
    includeThumbnail,
    iconName: 'rps',
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${GAME_LOBBY_CUSTOM_ID_PREFIX}:rps_solo:${ownerId}:rock`)
      .setLabel('Rock')
      .setEmoji('🪨')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${GAME_LOBBY_CUSTOM_ID_PREFIX}:rps_solo:${ownerId}:paper`)
      .setLabel('Paper')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${GAME_LOBBY_CUSTOM_ID_PREFIX}:rps_solo:${ownerId}:scissors`)
      .setLabel('Scissors')
      .setEmoji('✂️')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

function buildRpsSoloResultEmbed(ownerId, state, result, { includeThumbnail = true } = {}) {
  const choiceLabel = { rock: '🪨 Rock', paper: '📄 Paper', scissors: '✂️ Scissors' };
  const playerChoice = choiceLabel[state?.choices?.[ownerId]] ?? state?.choices?.[ownerId];
  const botChoice = choiceLabel[state?.botChoice] ?? state?.botChoice;

  let color = COLORS.WARNING;
  let headline = '🤝 **Seri!**';
  if (result?.winnerId === ownerId) {
    color = COLORS.SUCCESS;
    headline = `${getEmoji('trophy')} **Menang!** <@${ownerId}> mengalahkan bot!`;
  } else if (result?.winnerId && result.winnerId !== ownerId) {
    color = COLORS.DANGER;
    headline = `😔 **Kalah!** Bot menang ronde ini.`;
  }

  return createBaseEmbed({
    title: 'Rock Paper Scissors — Hasil',
    description: `${headline}\n\n<@${ownerId}>: **${playerChoice}** vs ${getEmoji('ai')} Bot: **${botChoice}**`,
    color,
    includeThumbnail,
    iconName: 'rps',
  });
}

async function replyLobbyEphemeral(interaction, message) {
  const payload = {
    embeds: [buildErrorEmbed(message)],
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
  } catch {
    // Ignore interaction delivery race errors
  }
}

async function resolveTargetMemberUser(interaction, targetId) {
  let user = interaction.users?.get?.(targetId) ?? interaction.client?.users?.cache?.get?.(targetId) ?? null;
  let member = interaction.members?.get?.(targetId) ?? null;

  if (!member && interaction.guild?.members?.fetch) {
    try {
      member = await interaction.guild.members.fetch(targetId);
    } catch {
      return { inGuild: false, user: null, member: null };
    }
  }

  if (member?.user) {
    user = member.user;
  }

  if (!user && !member && interaction.guild?.members?.fetch) {
    return { inGuild: false, user: null, member: null };
  }

  return { inGuild: true, user, member };
}

function createLobbyExpireHandler(client, logger = console) {
  return async (expiredLobby) => {
    const ref = expiredLobby?.messageRef;
    if (!ref?.channelId || !ref?.messageId || !client?.channels?.fetch) {
      return;
    }
    try {
      const channel = await client.channels.fetch(ref.channelId);
      const msg = await channel?.messages?.fetch?.(ref.messageId);
      if (msg) {
        await safeUpdateMessage(
          msg,
          buildUnifiedLobbyMessage({ lobby: expiredLobby, statusOverride: 'expired' }),
          false,
        );
      }
    } catch (err) {
      logger.warn?.('[GameLobby] Failed updating expired lobby message:', sanitizeError(err));
    }
  };
}

/**
 * Launches a Unified Game Lobby for `!ttt`, `!rps`, or `!coinflip`.
 */
export async function launchUnifiedGameLobby({
  interaction,
  context = {},
  gameType,
}) {
  const config = getLobbyConfig(gameType);
  if (!config) {
    return null;
  }

  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Lobby permainan hanya dapat digunakan di dalam server Discord.')],
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const hostUser = interaction.user;
  const prisma = context.prisma ?? defaultPrisma;
  const lobbyManager = resolveLobbyManager(context);
  const client = context.client ?? interaction.client ?? interaction.message?.client;

  if (config.gcType && prisma?.gameSession) {
    const activeGc = await findActiveUserSession(interaction.guildId, hostUser.id, prisma);
    if (activeGc) {
      await interaction.reply({
        embeds: [buildErrorEmbed('Kamu masih memiliki sesi Game Center aktif atau menunggu di server ini.')],
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }
  }

  if (
    context.sessionManager?.hasActiveSession?.(hostUser.id) ||
    context.inviteManager?.getOutgoingInvite?.(hostUser.id)
  ) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Kamu masih memiliki pertandingan atau undangan aktif.')],
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  let lobby;
  try {
    lobby = lobbyManager.createLobby({
      gameType: config.gameType,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      hostId: hostUser.id,
      ttlMs: context.lobbyTtlMs,
      onExpire: createLobbyExpireHandler(client, context.logger),
    });
  } catch (err) {
    await interaction.reply({
      embeds: [buildErrorEmbed(err.message)],
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const canAttach = interaction.canAttachFiles !== false;
  const iconFiles = canAttach ? getIconFiles(config.iconName) : [];
  const hasIcon = iconFiles.length > 0;
  const payload = buildUnifiedLobbyMessage({ lobby, includeThumbnail: hasIcon });

  let sentMsg;
  try {
    sentMsg = await interaction.reply({
      ...payload,
      files: iconFiles,
    });
  } catch (replyErr) {
    if (iconFiles.length === 0) {
      lobbyManager.closeLobby(lobby.id);
      throw replyErr;
    }
    sentMsg = await interaction.reply(
      buildUnifiedLobbyMessage({ lobby, includeThumbnail: false }),
    );
  }

  if (sentMsg?.id) {
    lobbyManager.setMessageRef(lobby.id, {
      channelId: sentMsg.channelId ?? interaction.channelId,
      messageId: sentMsg.id,
    });
  }

  return lobby;
}

async function startMultiplayerFromLobby(interaction, lobby, config, context) {
  const prisma = context.prisma ?? defaultPrisma;
  const client = context.client ?? interaction.client;

  if (config.gcType && prisma?.gameSession) {
    const [hostActive, oppActive] = await Promise.all([
      findActiveUserSession(lobby.guildId, lobby.hostId, prisma),
      findActiveUserSession(lobby.guildId, lobby.opponentId, prisma),
    ]);
    if (hostActive) {
      await replyLobbyEphemeral(interaction, 'Kamu masih memiliki sesi Game Center aktif atau menunggu di server ini.');
      return false;
    }
    if (oppActive) {
      await replyLobbyEphemeral(interaction, `<@${lobby.opponentId}> sedang berada di sesi Game Center lain.`);
      return false;
    }

    const initialState =
      config.gameType === GAME_TYPES.TICTACTOE
        ? createTicTacToeState({ hostId: lobby.hostId, opponentId: lobby.opponentId })
        : createRpsMatchState({ hostId: lobby.hostId, opponentId: lobby.opponentId });

    const session = await createPersistedSession({
      prisma,
      guildId: lobby.guildId,
      channelId: lobby.channelId,
      gameType: config.gcType,
      status: 'active',
      hostId: lobby.hostId,
      currentTurnId: initialState.currentTurnId ?? null,
      state: initialState,
      participants: [
        { userId: lobby.hostId, username: interaction.user?.username ?? null, role: config.roles[0] },
        { userId: lobby.opponentId, username: null, role: config.roles[1] },
      ],
      ttlMs: GAME_INACTIVITY_TTL_MS,
    });

    if (interaction.message?.id) {
      await updatePersistedSession(session.id, { messageId: interaction.message.id }, prisma);
    }

    const boardPayload =
      config.gameType === GAME_TYPES.TICTACTOE
        ? buildTicTacToeMessage({ sessionId: session.id, state: initialState, status: 'active' })
        : buildRpsMessage({ sessionId: session.id, state: initialState, status: 'active' });

    await safeUpdateMessage(interaction, boardPayload, true);
    return true;
  }

  if (!context.gameManager) {
    await replyLobbyEphemeral(interaction, 'Layanan permainan belum siap. Silakan coba lagi.');
    return false;
  }

  let started;
  try {
    started = context.gameManager.startMultiplayerSession({
      gameType: GAME_TYPES.COINFLIP,
      channelId: lobby.channelId,
      hostId: lobby.hostId,
      opponentId: lobby.opponentId,
      onTimeout: createSessionTimeoutHandler(client),
    });
  } catch (err) {
    await replyLobbyEphemeral(interaction, err.message);
    return false;
  }

  if (interaction.message?.id && context.sessionManager) {
    context.sessionManager.setBoardMessageRef(started.session.sessionId, {
      channelId: interaction.channelId ?? lobby.channelId,
      messageId: interaction.message.id,
    });
  }

  await safeUpdateMessage(
    interaction,
    {
      embeds: [buildCoinflipBoardEmbed(started.session.state)],
      components: buildCoinflipChoiceComponents(started.session.sessionId),
    },
    true,
  );
  return true;
}

/**
 * Handles all `lobby:*` interactions (UserSelectMenu + Solo/Start/Cancel/RPS-Solo buttons).
 */
export async function handleGameLobbyInteraction(interaction, context = {}) {
  const customId = interaction?.customId ?? '';
  if (!customId.startsWith(`${GAME_LOBBY_CUSTOM_ID_PREFIX}:`)) {
    return false;
  }

  const [, action, targetId, extra] = customId.split(':');

  if (action === 'rps_solo' && targetId && extra) {
    if (interaction.user?.id !== targetId) {
      await replyLobbyEphemeral(interaction, 'Tombol permainan ini hanya untuk pembuat lobby.');
      return true;
    }
    if (!RPS_CHOICES.includes(extra)) {
      await replyLobbyEphemeral(interaction, 'Pilihan Rock Paper Scissors tidak valid.');
      return true;
    }

    const outcome = context.gameManager
      ? context.gameManager.playInstantSolo({
          gameType: GAME_TYPES.RPS,
          playerId: targetId,
          action: { choice: extra },
        })
      : (() => {
          const initial = RPSGame.create({ mode: 'solo' }, [targetId, 'BOT']);
          const applied = RPSGame.applyAction(initial, targetId, { choice: extra });
          return { state: applied.state, result: applied.result, error: applied.error };
        })();

    if (outcome?.error) {
      await replyLobbyEphemeral(interaction, outcome.error);
      return true;
    }

    await safeUpdateMessage(
      interaction,
      { embeds: [buildRpsSoloResultEmbed(targetId, outcome.state, outcome.result)], components: [] },
      true,
    );
    return true;
  }

  const lobbyManager = resolveLobbyManager(context);
  const lobbyId = targetId;
  if (!lobbyId || !action) {
    return false;
  }

  await lobbyManager.withLock(lobbyId, async () => {
    const lobby = lobbyManager.getLobby(lobbyId);
    if (!lobby) {
      await replyLobbyEphemeral(interaction, 'Lobby ini sudah kedaluwarsa, dibatalkan, atau sudah dimulai.');
      return;
    }

    if (interaction.user?.id !== lobby.hostId) {
      await replyLobbyEphemeral(interaction, 'Hanya pembuat lobby yang dapat mengontrol lobby ini.');
      return;
    }

    const config = getLobbyConfig(lobby.gameType);
    if (!config) {
      await replyLobbyEphemeral(interaction, 'Konfigurasi game lobby tidak ditemukan.');
      return;
    }

    if (action === 'select') {
      const selectedId = interaction.values?.[0];
      if (!selectedId) {
        await replyLobbyEphemeral(interaction, 'Pilih salah satu pengguna sebagai lawan.');
        return;
      }
      if (selectedId === lobby.hostId) {
        await replyLobbyEphemeral(interaction, 'Kamu tidak bisa memilih dirimu sendiri sebagai lawan.');
        return;
      }

      const resolved = await resolveTargetMemberUser(interaction, selectedId);
      if (!resolved.inGuild) {
        await replyLobbyEphemeral(interaction, 'Pengguna tersebut sudah keluar dari server atau tidak lagi tersedia.');
        return;
      }
      if (resolved.user?.bot) {
        await replyLobbyEphemeral(interaction, 'Kamu tidak bisa memilih bot sebagai lawan pada mode ini.');
        return;
      }

      lobby.opponentId = selectedId;
      lobby.mode = 'multiplayer';
      await safeUpdateMessage(interaction, buildUnifiedLobbyMessage({ lobby }), true);
      return;
    }

    if (action === 'solo') {
      if (!config.supportsSolo) {
        await replyLobbyEphemeral(interaction, 'Game ini hanya mendukung mode multiplayer melawan teman.');
        return;
      }
      lobby.mode = 'solo';
      lobby.opponentId = null;
      await safeUpdateMessage(interaction, buildUnifiedLobbyMessage({ lobby }), true);
      return;
    }

    if (action === 'cancel') {
      lobbyManager.closeLobby(lobby.id);
      await safeUpdateMessage(
        interaction,
        buildUnifiedLobbyMessage({ lobby, statusOverride: 'cancelled' }),
        true,
      );
      return;
    }

    if (action === 'start') {
      if (lobby.started || lobby.closed) {
        await replyLobbyEphemeral(interaction, 'Permainan ini sudah dimulai atau lobby telah ditutup.');
        return;
      }

      if (lobby.mode !== 'solo' && !lobby.opponentId) {
        await replyLobbyEphemeral(interaction, 'Pilih lawan terlebih dahulu sebelum menekan Start.');
        return;
      }

      if (lobby.mode === 'solo') {
        if (!config.supportsSolo) {
          await replyLobbyEphemeral(interaction, 'Game ini memerlukan lawan pemain lain.');
          return;
        }
        lobby.started = true;
        lobbyManager.closeLobby(lobby.id);

        if (config.gameType === GAME_TYPES.COINFLIP) {
          const { files: _ignoredFiles, ...promptNoFiles } = buildCoinflipSoloPromptPayload(lobby.hostId);
          await safeUpdateMessage(interaction, promptNoFiles, true);
          return;
        }
        if (config.gameType === GAME_TYPES.RPS) {
          await safeUpdateMessage(interaction, buildRpsSoloPromptPayload(lobby.hostId), true);
          return;
        }
        return;
      }

      const resolved = await resolveTargetMemberUser(interaction, lobby.opponentId);
      if (!resolved.inGuild || resolved.user?.bot) {
        lobby.opponentId = null;
        lobby.mode = null;
        await safeUpdateMessage(interaction, buildUnifiedLobbyMessage({ lobby }), true);
        await interaction.followUp?.({
          embeds: [
            buildErrorEmbed(
              resolved.user?.bot
                ? 'Bot tidak dapat menjadi lawan. Pilih anggota server lain.'
                : 'Lawan yang dipilih sudah keluar dari server atau tidak tersedia. Pilih lawan lain.',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const startedOk = await startMultiplayerFromLobby(interaction, lobby, config, context);
      if (startedOk) {
        lobby.started = true;
        lobbyManager.closeLobby(lobby.id);
      }
    }
  });

  return true;
}
