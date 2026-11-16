import { MessageFlags } from 'discord.js';
import { COLORS } from '../config/colors.js';
import {
  DIFFICULTY_LABELS,
  GAME_METADATA,
  GAME_TYPES,
} from './constants.js';
import { updatePublicMessage } from './discordBoard.js';
import { buildCoinflipSoloPromptPayload } from './coinflipComponents.js';
import {
  buildErrorEmbed,
  buildInfoEmbed,
  buildLobbyEmbed,
  buildStatusEmbed,
  formatPlayer,
} from './embeds.js';
import {
  handleChallengeCommand,
  handleInstantSoloCommand,
  handleSessionActionCommand,
  handleSoloSessionStart,
} from './gameCommandHelpers.js';
import {
  isValidCoinChoice,
  isValidDifficulty,
  isValidRpsChoice,
  isValidTttPosition,
} from './validators.js';

export const GAME_ACTION_CHOICES = Object.freeze([
  'solo',
  'challenge',
  'choose',
  'move',
  'status',
  'cancel',
]);

export const VALID_ACTIONS_BY_GAME = Object.freeze({
  [GAME_TYPES.COINFLIP]: new Set(['solo', 'challenge', 'choose', 'status', 'cancel']),
  [GAME_TYPES.RPS]: new Set(['solo', 'challenge', 'choose', 'status', 'cancel']),
  [GAME_TYPES.TICTACTOE]: new Set(['solo', 'challenge', 'move', 'status', 'cancel']),
});

const SESSION_PLAY_ACTIONS = new Set(['choose', 'move']);

async function replyEphemeralError(interaction, message) {
  await interaction.reply({
    embeds: [buildErrorEmbed(message)],
    flags: MessageFlags.Ephemeral,
  });
}

function getActiveStatusMatchInfo(status) {
  if (!status || status.type === 'none') {
    return null;
  }
  if (status.type === 'session') {
    return {
      gameType: status.session.gameType,
      id: status.session.sessionId,
      label: GAME_METADATA[status.session.gameType]?.name ?? status.session.gameType,
    };
  }
  return {
    gameType: status.invite.gameType,
    id: status.invite.inviteId,
    label: GAME_METADATA[status.invite.gameType]?.name ?? status.invite.gameType,
  };
}

function validateStatusFilters(status, gameType, gameId) {
  const info = getActiveStatusMatchInfo(status);
  const trimmedId = typeof gameId === 'string' && gameId.trim() ? gameId.trim() : null;

  if (!info) {
    if (trimmedId) {
      return `Tidak ditemukan pertandingan atau undangan aktif dengan ID \`${trimmedId}\`.`;
    }
    return null;
  }

  if (gameType && gameType !== info.gameType) {
    const requestedLabel = GAME_METADATA[gameType]?.name ?? gameType;
    return `Pertandingan aktifmu saat ini adalah **${info.label}** (\`${info.gameType}\`), bukan **${requestedLabel}**.`;
  }

  if (trimmedId && trimmedId !== info.id) {
    return `Game ID \`${trimmedId}\` tidak cocok dengan pertandingan aktifmu (\`${info.id}\`).`;
  }

  return null;
}

async function handleStatusAction(interaction, context, { gameType, gameId }) {
  const { gameManager } = context;
  const status = gameManager.getStatus(interaction.user.id);

  const filterError = validateStatusFilters(status, gameType, gameId);
  if (filterError) {
    await replyEphemeralError(interaction, filterError);
    return;
  }

  if (status.type === 'session') {
    const embed = buildStatusEmbed(status.session);
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (status.type === 'invite') {
    const inv = status.invite;
    const meta = GAME_METADATA[inv.gameType];
    const remainingSec = Math.max(0, Math.ceil((inv.expiresAt - Date.now()) / 1000));
    const embed = buildLobbyEmbed({
      gameTitle: meta?.name ?? inv.gameType,
      hostId: inv.hostId,
      opponentId: inv.opponentId,
      status: `Menunggu respons (${remainingSec} detik tersisa)`,
    });
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    embeds: [
      buildInfoEmbed(
        'Tidak Ada Pertandingan Aktif',
        'Kamu sedang tidak berada di pertandingan atau undangan apa pun. Gunakan `/games` untuk melihat daftar game.',
        COLORS.INFO,
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCancelAction(interaction, context, { gameType, gameId }) {
  const { gameManager, client } = context;
  const currentStatus = gameManager.getStatus(interaction.user.id);

  if (currentStatus.type !== 'none') {
    const filterError = validateStatusFilters(currentStatus, gameType, gameId);
    if (filterError) {
      await replyEphemeralError(interaction, filterError);
      return;
    }
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let outcome;
  try {
    outcome = gameManager.cancelByUser(interaction.user.id);
  } catch (err) {
    await interaction.editReply({
      embeds: [buildErrorEmbed(err.message)],
    });
    return;
  }

  if (outcome.type === 'session') {
    const session = outcome.session;
    const meta = GAME_METADATA[session.gameType];
    const cancelEmbed = buildInfoEmbed(
      `${meta?.name ?? session.gameType} — Dibatalkan`,
      `Pertandingan dibatalkan oleh ${formatPlayer(interaction.user.id)}.`,
      COLORS.WARNING,
    );

    await updatePublicMessage(
      client,
      session.boardMessageRef,
      { embeds: [cancelEmbed], components: [] },
      session.channelId,
    );

    await interaction.editReply({
      content: 'Pertandingan aktif telah dibatalkan.',
    });
    return;
  }

  if (outcome.type === 'invite') {
    const inv = outcome.invite;
    const meta = GAME_METADATA[inv.gameType];
    const cancelEmbed = buildLobbyEmbed({
      gameTitle: meta?.name ?? inv.gameType,
      hostId: inv.hostId,
      opponentId: inv.opponentId,
      status: 'Dibatalkan oleh Host',
      instructions: 'Undangan dibatalkan.',
      color: COLORS.WARNING,
    });

    await updatePublicMessage(
      client,
      inv.lobbyMessageRef,
      { embeds: [cancelEmbed], components: [] },
      inv.channelId,
    );

    await interaction.editReply({
      embeds: [
        buildInfoEmbed(
          'Undangan Dibatalkan',
          `Undangan ke ${formatPlayer(inv.opponentId)} telah dibatalkan.`,
          COLORS.WARNING,
        ),
      ],
    });
  }
}

async function dispatchCoinFlip(interaction, context, actionName) {
  if (actionName === 'challenge') {
    await handleChallengeCommand(interaction, context, { gameType: GAME_TYPES.COINFLIP });
    return;
  }

  const rawChoice = interaction.options.getString?.('choice', false);
  const choice = typeof rawChoice === 'string' ? rawChoice.trim().toLowerCase() : '';

  if (actionName === 'solo' && !choice) {
    await interaction.reply(buildCoinflipSoloPromptPayload(interaction.user.id));
    return;
  }

  if (!isValidCoinChoice(choice)) {
    await replyEphemeralError(interaction, 'Pilih `heads` atau `tails` pada parameter `choice` untuk Coin Flip.');
    return;
  }

  if (actionName === 'solo') {
    await handleInstantSoloCommand(interaction, context, {
      gameType: GAME_TYPES.COINFLIP,
      action: { choice },
    });
    return;
  }

  await handleSessionActionCommand(interaction, context, {
    gameType: GAME_TYPES.COINFLIP,
    action: { choice },
    formatEphemeralMessage: (outcome) =>
      outcome.finished
        ? `Prediksi rahasiamu (**${choice}**) tercatat. Kedua pemain sudah memilih — hasil diumumkan di papan!`
        : `Prediksi rahasiamu (**${choice}**) telah dikunci secara privat. Menunggu lawan memilih.`,
  });
}

async function dispatchRps(interaction, context, actionName) {
  if (actionName === 'challenge') {
    await handleChallengeCommand(interaction, context, { gameType: GAME_TYPES.RPS });
    return;
  }

  const rawChoice = interaction.options.getString?.('choice', false);
  const choice = typeof rawChoice === 'string' ? rawChoice.trim().toLowerCase() : '';
  if (!isValidRpsChoice(choice)) {
    await replyEphemeralError(
      interaction,
      'Pilih `rock`, `paper`, atau `scissors` pada parameter `choice` untuk Rock Paper Scissors.',
    );
    return;
  }

  if (actionName === 'solo') {
    await handleInstantSoloCommand(interaction, context, {
      gameType: GAME_TYPES.RPS,
      action: { choice },
    });
    return;
  }

  await handleSessionActionCommand(interaction, context, {
    gameType: GAME_TYPES.RPS,
    action: { choice },
    formatEphemeralMessage: (outcome) =>
      outcome.finished
        ? `Pilihan rahasiamu (**${choice}**) tercatat. Hasil pertandingan ditampilkan di papan!`
        : `Pilihan rahasiamu (**${choice}**) dikunci secara privat. Menunggu lawan memilih.`,
  });
}

async function dispatchTicTacToe(interaction, context, actionName) {
  if (actionName === 'solo') {
    await replyEphemeralError(
      interaction,
      'Tic Tac Toe hanya bisa dimainkan bersama teman (bukan bot). Gunakan `!ttt @teman`.',
    );
    return;
  }

  if (actionName === 'challenge') {
    await handleChallengeCommand(interaction, context, {
      gameType: GAME_TYPES.TICTACTOE,
      details: `Papan 3×3 (Koordinat A1–C3) | Difficulty AI: N/A (${DIFFICULTY_LABELS.normal} hanya untuk Solo)`,
    });
    return;
  }

  const rawPos = interaction.options.getString?.('position', false);
  const position = typeof rawPos === 'string' ? rawPos.trim().toUpperCase() : '';
  if (!isValidTttPosition(position)) {
    await replyEphemeralError(
      interaction,
      'Pilih koordinat papan antara `A1` sampai `C3` pada parameter `position` untuk Tic Tac Toe.',
    );
    return;
  }

  await handleSessionActionCommand(interaction, context, {
    gameType: GAME_TYPES.TICTACTOE,
    action: { position },
    formatEphemeralMessage: (outcome) =>
      outcome.finished
        ? `Langkah **${position}** tercatat. Pertandingan selesai!`
        : `Langkah **${position}** tercatat dan papan telah diperbarui.`,
  });
}

const GAME_DISPATCHERS = Object.freeze({
  [GAME_TYPES.COINFLIP]: dispatchCoinFlip,
  [GAME_TYPES.RPS]: dispatchRps,
  [GAME_TYPES.TICTACTOE]: dispatchTicTacToe,
});

/**
 * Shared dispatcher for the consolidated `/game` slash command and legacy game prefix commands.
 * Enforces server-side validation for game/action combinations and per-game parameters.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} context
 * @param {{ forcedGameType?: string | null, forcedAction?: string | null }} [overrides]
 */
export async function executeGameCommand(interaction, context = {}, overrides = {}) {
  const rawAction =
    overrides.forcedAction ??
    interaction.options?.getString?.('action', false) ??
    interaction.options?.getSubcommand?.(false) ??
    '';
  const normalizedRawAction = typeof rawAction === 'string' ? rawAction.trim().toLowerCase() : '';
  const actionName = normalizedRawAction === 'play' ? 'answer' : normalizedRawAction;

  if (!GAME_ACTION_CHOICES.includes(actionName)) {
    await replyEphemeralError(
      interaction,
      `Aksi \`${rawAction || '(kosong)'}\` tidak dikenali. Pilih salah satu dari: ${GAME_ACTION_CHOICES.map((a) => `\`${a}\``).join(', ')}.`,
    );
    return;
  }

  const rawGame = overrides.forcedGameType ?? interaction.options?.getString?.('game', false) ?? null;
  let gameType = typeof rawGame === 'string' && rawGame.trim() ? rawGame.trim().toLowerCase() : null;
  const gameId = interaction.options?.getString?.('game_id', false) ?? null;

  if (gameType && !Object.hasOwn(VALID_ACTIONS_BY_GAME, gameType)) {
    await replyEphemeralError(interaction, `Game \`${gameType}\` tidak valid.`);
    return;
  }

  if (actionName === 'status') {
    await handleStatusAction(interaction, context, { gameType, gameId });
    return;
  }

  if (actionName === 'cancel') {
    await handleCancelAction(interaction, context, { gameType, gameId });
    return;
  }

  if (!gameType && SESSION_PLAY_ACTIONS.has(actionName)) {
    const activeStatus = context.gameManager?.getStatus?.(interaction.user.id);
    if (activeStatus?.type === 'session') {
      gameType = activeStatus.session.gameType;
    }
  }

  if (!gameType) {
    await replyEphemeralError(
      interaction,
      SESSION_PLAY_ACTIONS.has(actionName)
        ? 'Kamu tidak memiliki pertandingan aktif. Pilih parameter `game` atau mulai pertandingan terlebih dahulu.'
        : `Pilih parameter \`game\` terlebih dahulu untuk menjalankan aksi \`${actionName}\`.`,
    );
    return;
  }

  const validActions = VALID_ACTIONS_BY_GAME[gameType];
  if (!validActions.has(actionName)) {
    const gameLabel = GAME_METADATA[gameType]?.name ?? gameType;
    const allowedList = Array.from(validActions).map((a) => `\`${a}\``).join(', ');
    await replyEphemeralError(
      interaction,
      `Aksi \`${actionName}\` tidak tersedia untuk **${gameLabel}** (\`${gameType}\`). Aksi yang valid: ${allowedList}.`,
    );
    return;
  }

  await GAME_DISPATCHERS[gameType](interaction, context, actionName);
}
