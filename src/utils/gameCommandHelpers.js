import { MessageFlags } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { GAME_METADATA, GAME_TYPES } from './constants.js';
import {
  buildCoinflipBoardEmbed,
  buildCoinflipChoiceComponents,
  buildCoinflipInviteComponents,
  buildCoinflipInviteEmbed,
  buildCoinflipResultEmbed,
} from './coinflipComponents.js';
import { buildErrorEmbed, buildLobbyEmbed, formatPlayer, getIconFiles } from './embeds.js';
import { validateOpponent } from './validators.js';
import {
  createInviteExpireHandler,
  createSessionTimeoutHandler,
  renderGameOrResultEmbed,
  updatePublicMessage,
} from './discordBoard.js';

/**
 * Handles creating a multiplayer challenge and sending the public lobby embed.
 */
export async function handleChallengeCommand(interaction, context, { gameType, config = {}, details = null }) {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Tantangan multiplayer hanya dapat dilakukan di dalam server Discord.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const opponent = interaction.options.getUser('opponent', false);
  if (!opponent) {
    await interaction.reply({
      embeds: [buildErrorEmbed('Pilih pemain lawan pada parameter `opponent` untuk mengirim tantangan.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const check = validateOpponent(interaction.user.id, opponent);
  if (!check.valid) {
    await interaction.reply({
      embeds: [buildErrorEmbed(check.error)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { gameManager, inviteManager, client } = context;
  let invite;
  try {
    invite = gameManager.createChallenge({
      gameType,
      channelId: interaction.channelId,
      hostId: interaction.user.id,
      opponentId: opponent.id,
      config,
      onExpire: createInviteExpireHandler(client),
    });
  } catch (err) {
    await interaction.reply({
      embeds: [buildErrorEmbed(err.message)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const meta = GAME_METADATA[gameType];
  const isCoinflip = gameType === GAME_TYPES.COINFLIP;
  const lobbyEmbed = isCoinflip
    ? buildCoinflipInviteEmbed({
        hostId: invite.hostId,
        opponentId: invite.opponentId,
        status: 'pending',
        includeThumbnail: true,
      })
    : buildLobbyEmbed({
        gameTitle: meta?.name ?? gameType,
        gameDescription: meta?.description,
        hostId: invite.hostId,
        opponentId: invite.opponentId,
        status: 'Menunggu konfirmasi (60 detik)',
        details,
      });

  const iconName =
    gameType === GAME_TYPES.COINFLIP
      ? 'coinflip'
      : gameType === GAME_TYPES.RPS
        ? 'rps'
        : gameType === GAME_TYPES.TICTACTOE
          ? 'tic-tac-toe'
          : null;

  await interaction.reply({
    content: isCoinflip
      ? `<@${opponent.id}>`
      : `${formatPlayer(opponent.id)}, kamu mendapat tantangan **${meta?.name ?? gameType}**!`,
    embeds: [lobbyEmbed],
    ...(isCoinflip ? { components: buildCoinflipInviteComponents(invite.inviteId) } : {}),
    files: getIconFiles(iconName),
  });

  try {
    const msg = await interaction.fetchReply();
    inviteManager.setLobbyMessageRef(invite.inviteId, {
      channelId: msg.channelId,
      messageId: msg.id,
    });
  } catch {
    // Non-fatal if fetchReply isn't available in mocks
  }
}

/**
 * Handles starting a stateful solo session and posting the initial public board embed.
 */
export async function handleSoloSessionStart(interaction, context, { gameType, config = {} }) {
  const { gameManager, sessionManager, client } = context;

  let started;
  try {
    started = gameManager.startSoloSession({
      gameType,
      channelId: interaction.channelId,
      playerId: interaction.user.id,
      config,
      onTimeout: createSessionTimeoutHandler(client),
    });
  } catch (err) {
    await interaction.reply({
      embeds: [buildErrorEmbed(err.message)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = renderGameOrResultEmbed(gameType, started.publicView, null, 0);
  await interaction.reply({
    embeds: [embed],
    files: getLogoFiles(),
  });

  try {
    const msg = await interaction.fetchReply();
    sessionManager.setBoardMessageRef(started.session.sessionId, {
      channelId: msg.channelId,
      messageId: msg.id,
    });
  } catch {
    // Non-fatal in test mocks
  }
}

/**
 * Handles an in-game slash command action inside an active session.
 * Edits the public board message and sends an ephemeral confirmation/feedback to the player.
 */
export async function handleSessionActionCommand(
  interaction,
  context,
  { gameType, action, formatEphemeralMessage },
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { gameManager, sessionManager, client } = context;
  const outcome = await gameManager.submitAction(interaction.user.id, gameType, action);

  if (outcome.error) {
    await interaction.editReply({
      embeds: [buildErrorEmbed(outcome.error)],
    });
    return;
  }

  const embed =
    gameType === GAME_TYPES.COINFLIP
      ? outcome.finished
        ? buildCoinflipResultEmbed(outcome.state)
        : buildCoinflipBoardEmbed(outcome.state)
      : renderGameOrResultEmbed(
          gameType,
          outcome.publicView,
          outcome.finished ? outcome.result : null,
          outcome.durationMs ?? 0,
        );

  const components =
    gameType === GAME_TYPES.COINFLIP
      ? outcome.finished
        ? []
        : buildCoinflipChoiceComponents(outcome.session.sessionId)
      : undefined;

  const newRef = await updatePublicMessage(
    client,
    outcome.session.boardMessageRef,
    {
      embeds: [embed],
      ...(components !== undefined ? { components } : {}),
    },
    outcome.session.channelId ?? interaction.channelId,
  );

  if (!outcome.finished && newRef) {
    sessionManager.setBoardMessageRef(outcome.session.sessionId, newRef);
  }

  const ackText = formatEphemeralMessage
    ? formatEphemeralMessage(outcome)
    : outcome.finished
      ? 'Langkah diproses. Pertandingan selesai!'
      : 'Langkahmu telah dicatat.';

  await interaction.editReply({
    content: ackText,
    embeds: [],
  });
}

/**
 * Helper to execute an instant single-turn solo game (RPS, CoinFlip, Dice solo).
 */
export async function handleInstantSoloCommand(interaction, context, { gameType, config = {}, action }) {
  const { gameManager } = context;
  const outcome = gameManager.playInstantSolo({
    gameType,
    playerId: interaction.user.id,
    config,
    action,
  });

  if (outcome.error) {
    await interaction.reply({
      embeds: [buildErrorEmbed(outcome.error)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const iconName =
    gameType === GAME_TYPES.COINFLIP
      ? 'coinflip'
      : gameType === GAME_TYPES.RPS
        ? 'rps'
        : gameType === GAME_TYPES.TICTACTOE
          ? 'tic-tac-toe'
          : null;

  const embed =
    gameType === GAME_TYPES.COINFLIP
      ? buildCoinflipResultEmbed(outcome.state, { includeThumbnail: true })
      : renderGameOrResultEmbed(gameType, outcome.publicView, outcome.result, 0);
  await interaction.reply({
    embeds: [embed],
    files: getIconFiles(iconName),
  });
}

// Re-export helpers so commands need minimal imports
export { COLORS };
