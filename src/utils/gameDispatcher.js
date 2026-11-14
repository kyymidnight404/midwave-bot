import { MessageFlags } from 'discord.js';
import {
  COLORS,
  DICE_CONFIG,
  DIFFICULTY_LABELS,
  GAME_METADATA,
  GAME_TYPES,
  GUESS_CONFIG,
  TRIVIA_CATEGORY_LABELS,
} from './constants.js';
import { updatePublicMessage } from './discordBoard.js';
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
  isValidConnect4Column,
  isValidDifficulty,
  isValidRpsChoice,
  isValidTriviaCategory,
  isValidTriviaOption,
  isValidTttPosition,
  validateDiceConfig,
} from './validators.js';

export const GAME_ACTION_CHOICES = Object.freeze([
  'solo',
  'challenge',
  'choose',
  'drop',
  'move',
  'answer',
  'status',
  'cancel',
]);

export const VALID_ACTIONS_BY_GAME = Object.freeze({
  [GAME_TYPES.COINFLIP]: new Set(['solo', 'challenge', 'choose', 'status', 'cancel']),
  [GAME_TYPES.CONNECT4]: new Set(['solo', 'challenge', 'drop', 'status', 'cancel']),
  [GAME_TYPES.DICE]: new Set(['solo', 'challenge', 'status', 'cancel']),
  [GAME_TYPES.GUESS]: new Set(['solo', 'challenge', 'answer', 'status', 'cancel']),
  [GAME_TYPES.RPS]: new Set(['solo', 'challenge', 'choose', 'status', 'cancel']),
  [GAME_TYPES.TICTACTOE]: new Set(['solo', 'challenge', 'move', 'status', 'cancel']),
  [GAME_TYPES.TRIVIA]: new Set(['solo', 'challenge', 'answer', 'status', 'cancel']),
});

const SESSION_PLAY_ACTIONS = new Set(['choose', 'drop', 'move', 'answer']);

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
        COLORS.MUTED,
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
      { embeds: [cancelEmbed] },
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
      { embeds: [cancelEmbed] },
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

async function dispatchDice(interaction, context, actionName) {
  const count = interaction.options.getInteger?.('count', false) ?? DICE_CONFIG.DEFAULT_COUNT;
  const sides = interaction.options.getInteger?.('sides', false) ?? DICE_CONFIG.DEFAULT_SIDES;
  const diceCheck = validateDiceConfig(count, sides);
  if (!diceCheck.valid) {
    await replyEphemeralError(interaction, diceCheck.error);
    return;
  }

  if (actionName === 'solo') {
    await handleInstantSoloCommand(interaction, context, {
      gameType: GAME_TYPES.DICE,
      config: { count, sides },
      action: {},
    });
    return;
  }

  await handleChallengeCommand(interaction, context, {
    gameType: GAME_TYPES.DICE,
    config: { count, sides },
    details: `Konfigurasi: **${count}d${sides}**`,
  });
}

async function dispatchGuess(interaction, context, actionName) {
  if (actionName === 'solo' || actionName === 'challenge') {
    const rawDiff = interaction.options.getString?.('difficulty', false);
    const difficulty = rawDiff ? rawDiff.trim().toLowerCase() : 'normal';
    if (!isValidDifficulty(difficulty)) {
      await replyEphemeralError(interaction, 'Tingkat kesulitan tidak valid. Pilih `easy`, `normal`, atau `hard`.');
      return;
    }

    if (actionName === 'solo') {
      await handleSoloSessionStart(interaction, context, {
        gameType: GAME_TYPES.GUESS,
        config: { difficulty },
      });
      return;
    }

    const cfg = GUESS_CONFIG[difficulty];
    await handleChallengeCommand(interaction, context, {
      gameType: GAME_TYPES.GUESS,
      config: { difficulty },
      details: `Difficulty: **${DIFFICULTY_LABELS[difficulty]}** (${cfg.min}–${cfg.max}, ${cfg.maxAttempts} percobaan)`,
    });
    return;
  }

  const numberOpt = interaction.options.getInteger?.('number', false);
  let number = typeof numberOpt === 'number' ? numberOpt : null;
  if (number === null) {
    const answerStr = interaction.options.getString?.('answer', false);
    if (typeof answerStr === 'string' && /^-?\d+$/.test(answerStr.trim())) {
      number = Number.parseInt(answerStr.trim(), 10);
    }
  }

  if (!Number.isInteger(number) || number < 1 || number > 200) {
    await replyEphemeralError(
      interaction,
      'Masukkan angka tebakan bulat antara 1 sampai 200 pada parameter `answer`.',
    );
    return;
  }

  await handleSessionActionCommand(interaction, context, {
    gameType: GAME_TYPES.GUESS,
    action: { number },
    formatEphemeralMessage: (outcome) => {
      if (outcome.finished) return `Tebakan **${number}** tercatat. Pertandingan selesai!`;
      const hint = outcome.privateView?.lastHint;
      const rem = outcome.privateView?.remainingAttempts;
      return `Tebakan **${number}** → **${hint}**! (Sisa percobaan: ${rem})`;
    },
  });
}

async function dispatchTrivia(interaction, context, actionName) {
  if (actionName === 'solo' || actionName === 'challenge') {
    const rawCategory = interaction.options.getString?.('category', false);
    const rawDiff = interaction.options.getString?.('difficulty', false);
    const category = rawCategory ? rawCategory.trim().toLowerCase() : 'general';
    const difficulty = rawDiff ? rawDiff.trim().toLowerCase() : 'normal';

    if (!isValidTriviaCategory(category)) {
      await replyEphemeralError(interaction, 'Kategori Trivia tidak valid.');
      return;
    }
    if (!isValidDifficulty(difficulty)) {
      await replyEphemeralError(interaction, 'Tingkat kesulitan tidak valid. Pilih `easy`, `normal`, atau `hard`.');
      return;
    }

    if (actionName === 'solo') {
      await handleSoloSessionStart(interaction, context, {
        gameType: GAME_TYPES.TRIVIA,
        config: { category, difficulty },
      });
      return;
    }

    await handleChallengeCommand(interaction, context, {
      gameType: GAME_TYPES.TRIVIA,
      config: { category, difficulty },
      details: `Kategori: **${TRIVIA_CATEGORY_LABELS[category]}** | Difficulty: **${DIFFICULTY_LABELS[difficulty]}** (5 ronde, 20 detik/ronde)`,
    });
    return;
  }

  const rawAnswer =
    interaction.options.getString?.('answer', false) ??
    interaction.options.getString?.('option', false);
  const option = typeof rawAnswer === 'string' ? rawAnswer.trim().toUpperCase() : '';

  if (!isValidTriviaOption(option)) {
    await replyEphemeralError(interaction, 'Pilih jawaban `A`, `B`, `C`, atau `D` pada parameter `answer` untuk Trivia.');
    return;
  }

  await handleSessionActionCommand(interaction, context, {
    gameType: GAME_TYPES.TRIVIA,
    action: { option },
    formatEphemeralMessage: (outcome) => {
      const fb = outcome.privateView?.feedback;
      if (!fb) return `Jawaban **${option}** diterima.`;
      if (fb.correct) {
        return outcome.finished
          ? `Jawaban **${option}** benar! (+1 poin) Pertandingan selesai.`
          : `Jawaban **${option}** benar! (+1 poin) Lanjut ke ronde berikutnya.`;
      }
      if (outcome.session.mode === 'solo') {
        return `Jawaban **${option}** kurang tepat. Jawaban yang benar: **${fb.correctLetter}. ${fb.correctText}**.`;
      }
      if (fb.roundSkipped) {
        return `Jawaban **${option}** salah. Kedua pemain salah sehingga ronde dilewati.`;
      }
      return `Jawaban **${option}** salah! Kamu terkunci sampai ronde berikutnya.`;
    },
  });
}

async function dispatchTicTacToe(interaction, context, actionName) {
  if (actionName === 'solo') {
    const rawDiff = interaction.options.getString?.('difficulty', false);
    const difficulty = rawDiff ? rawDiff.trim().toLowerCase() : 'normal';
    if (!isValidDifficulty(difficulty)) {
      await replyEphemeralError(interaction, 'Tingkat kesulitan tidak valid. Pilih `easy`, `normal`, atau `hard`.');
      return;
    }
    await handleSoloSessionStart(interaction, context, {
      gameType: GAME_TYPES.TICTACTOE,
      config: { difficulty },
    });
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

async function dispatchConnect4(interaction, context, actionName) {
  if (actionName === 'solo') {
    const rawDiff = interaction.options.getString?.('difficulty', false);
    const difficulty = rawDiff ? rawDiff.trim().toLowerCase() : 'normal';
    if (!isValidDifficulty(difficulty)) {
      await replyEphemeralError(interaction, 'Tingkat kesulitan tidak valid. Pilih `easy`, `normal`, atau `hard`.');
      return;
    }
    await handleSoloSessionStart(interaction, context, {
      gameType: GAME_TYPES.CONNECT4,
      config: { difficulty },
    });
    return;
  }

  if (actionName === 'challenge') {
    await handleChallengeCommand(interaction, context, {
      gameType: GAME_TYPES.CONNECT4,
      details: 'Papan 7 kolom × 6 baris',
    });
    return;
  }

  const column = interaction.options.getInteger?.('column', false);
  if (!isValidConnect4Column(column)) {
    await replyEphemeralError(
      interaction,
      'Masukkan nomor kolom antara `1` sampai `7` pada parameter `column` untuk Connect Four.',
    );
    return;
  }

  await handleSessionActionCommand(interaction, context, {
    gameType: GAME_TYPES.CONNECT4,
    action: { column },
    formatEphemeralMessage: (outcome) =>
      outcome.finished
        ? `Keping dijatuhkan di kolom **${column}**. Pertandingan selesai!`
        : `Keping dijatuhkan di kolom **${column}** dan papan telah diperbarui.`,
  });
}

const GAME_DISPATCHERS = Object.freeze({
  [GAME_TYPES.COINFLIP]: dispatchCoinFlip,
  [GAME_TYPES.CONNECT4]: dispatchConnect4,
  [GAME_TYPES.DICE]: dispatchDice,
  [GAME_TYPES.GUESS]: dispatchGuess,
  [GAME_TYPES.RPS]: dispatchRps,
  [GAME_TYPES.TICTACTOE]: dispatchTicTacToe,
  [GAME_TYPES.TRIVIA]: dispatchTrivia,
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
