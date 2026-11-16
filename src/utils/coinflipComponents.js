import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { GAME_METADATA, GAME_TYPES } from './constants.js';
import {
  buildErrorEmbed,
  buildInfoEmbed,
  buildLobbyEmbed,
  formatPlayer,
  getLogoFiles,
} from './embeds.js';
import {
  createSessionTimeoutHandler,
  renderGameOrResultEmbed,
  updatePublicMessage,
} from './discordBoard.js';
import { isValidCoinChoice } from './validators.js';

export const COINFLIP_CUSTOM_ID_PREFIX = 'cf';

const CHOICE_DISPLAY = Object.freeze({
  heads: 'Heads',
  tails: 'Tails',
});

/**
 * Builds Accept / Reject buttons for a Coin Flip multiplayer invitation.
 * @param {string} inviteId
 */
export function buildCoinflipInviteComponents(inviteId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${COINFLIP_CUSTOM_ID_PREFIX}:invite:accept:${inviteId}`)
        .setLabel('Accept')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${COINFLIP_CUSTOM_ID_PREFIX}:invite:reject:${inviteId}`)
        .setLabel('Reject')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

/**
 * Builds Heads / Tails choice buttons for an active multiplayer Coin Flip session.
 * @param {string} sessionId
 */
export function buildCoinflipChoiceComponents(sessionId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${COINFLIP_CUSTOM_ID_PREFIX}:choose:heads:${sessionId}`)
        .setLabel('Heads')
        .setEmoji('🪙')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${COINFLIP_CUSTOM_ID_PREFIX}:choose:tails:${sessionId}`)
        .setLabel('Tails')
        .setEmoji('🌗')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * Builds Heads / Tails choice buttons for an instant Solo Coin Flip prompt.
 * @param {string} userId
 */
export function buildCoinflipSoloPromptPayload(userId) {
  const meta = GAME_METADATA[GAME_TYPES.COINFLIP];
  const embed = buildInfoEmbed(
    meta?.name ?? 'Coin Flip',
    'Pilih sisi koin yang ingin kamu tebak menggunakan tombol di bawah ini:',
    COLORS.PRIMARY,
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COINFLIP_CUSTOM_ID_PREFIX}:solo:heads:${userId}`)
      .setLabel('Heads')
      .setEmoji('🪙')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${COINFLIP_CUSTOM_ID_PREFIX}:solo:tails:${userId}`)
      .setLabel('Tails')
      .setEmoji('🌗')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], files: getLogoFiles() };
}

async function replyEphemeralError(interaction, message) {
  const payload = { embeds: [buildErrorEmbed(message)], flags: MessageFlags.Ephemeral };
  if (interaction.deferred) {
    await interaction.editReply({ embeds: payload.embeds });
  } else if (interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

async function handleCoinflipInviteButton(interaction, action, inviteId, context) {
  const { gameManager, inviteManager, sessionManager, client } = context;
  const invite = inviteManager?.pendingInvites?.get(inviteId);

  if (!invite || invite.gameType !== GAME_TYPES.COINFLIP) {
    await replyEphemeralError(
      interaction,
      'Undangan Coin Flip ini sudah kedaluwarsa, dibatalkan, atau tidak tersedia lagi.',
    );
    return;
  }

  if (invite.opponentId !== interaction.user.id) {
    await replyEphemeralError(
      interaction,
      'Hanya pemain yang ditantang yang dapat merespons undangan ini.',
    );
    return;
  }

  const meta = GAME_METADATA[GAME_TYPES.COINFLIP];
  const gameTitle = meta?.name ?? 'Coin Flip';

  if (action === 'reject') {
    try {
      gameManager.declineChallenge(interaction.user.id);
    } catch (err) {
      await replyEphemeralError(interaction, err.message);
      return;
    }

    const declinedLobby = buildLobbyEmbed({
      gameTitle,
      hostId: invite.hostId,
      opponentId: invite.opponentId,
      status: 'Ditolak',
      instructions: `${formatPlayer(interaction.user.id)} menolak undangan ini.`,
      color: COLORS.ERROR,
    });
    await interaction.update({ embeds: [declinedLobby], components: [] });
    return;
  }

  if (action === 'accept') {
    let accepted;
    try {
      accepted = gameManager.acceptChallenge(interaction.user.id, {
        onTimeout: createSessionTimeoutHandler(client),
      });
    } catch (err) {
      await replyEphemeralError(interaction, err.message);
      return;
    }

    const { session, publicView } = accepted;
    const acceptedLobby = buildLobbyEmbed({
      gameTitle,
      hostId: invite.hostId,
      opponentId: invite.opponentId,
      status: 'Diterima',
      instructions: 'Pertandingan dimulai! Pilih Heads atau Tails pada papan di bawah.',
      color: COLORS.SUCCESS,
    });
    await interaction.update({ embeds: [acceptedLobby], components: [] });

    const boardEmbed = renderGameOrResultEmbed(GAME_TYPES.COINFLIP, publicView, null, 0);
    const boardPayload = {
      embeds: [boardEmbed],
      components: buildCoinflipChoiceComponents(session.sessionId),
      files: getLogoFiles(),
    };

    let boardMsg = null;
    if (typeof interaction.followUp === 'function') {
      boardMsg = await interaction.followUp(boardPayload);
    } else if (typeof interaction.channel?.send === 'function') {
      boardMsg = await interaction.channel.send(boardPayload);
    }

    if (boardMsg?.channelId && boardMsg?.id) {
      sessionManager.setBoardMessageRef(session.sessionId, {
        channelId: boardMsg.channelId,
        messageId: boardMsg.id,
      });
    }
  }
}

async function handleCoinflipChoiceButton(interaction, choice, sessionId, context) {
  if (!isValidCoinChoice(choice)) {
    await replyEphemeralError(interaction, 'Pilihan Coin Flip tidak valid.');
    return;
  }

  const { gameManager, sessionManager, client } = context;
  const liveSession = sessionManager?.getSession?.(sessionId);

  if (!liveSession || liveSession.gameType !== GAME_TYPES.COINFLIP) {
    await replyEphemeralError(interaction, 'Pertandingan Coin Flip ini sudah berakhir atau tidak ditemukan.');
    return;
  }

  if (!liveSession.players.includes(interaction.user.id)) {
    await replyEphemeralError(interaction, 'Kamu bukan peserta dalam pertandingan Coin Flip ini.');
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const outcome = await gameManager.submitAction(interaction.user.id, GAME_TYPES.COINFLIP, { choice });
  if (outcome.error) {
    await interaction.editReply({ embeds: [buildErrorEmbed(outcome.error)] });
    return;
  }

  const embed = renderGameOrResultEmbed(
    GAME_TYPES.COINFLIP,
    outcome.publicView,
    outcome.finished ? outcome.result : null,
    outcome.durationMs ?? 0,
  );

  const fallbackRef =
    outcome.session?.boardMessageRef ??
    (interaction.message?.id
      ? { channelId: interaction.channelId, messageId: interaction.message.id }
      : null);

  const newRef = await updatePublicMessage(
    client,
    fallbackRef,
    {
      embeds: [embed],
      components: outcome.finished ? [] : buildCoinflipChoiceComponents(sessionId),
    },
    outcome.session?.channelId ?? interaction.channelId,
  );

  if (!outcome.finished && newRef) {
    sessionManager.setBoardMessageRef(sessionId, newRef);
  }

  const displayChoice = CHOICE_DISPLAY[choice] ?? choice;
  const ack = outcome.finished
    ? `Prediksi rahasiamu (**${displayChoice}**) tercatat. Kedua pemain sudah memilih — hasil diumumkan di papan!`
    : `Prediksi rahasiamu (**${displayChoice}**) telah dikunci secara privat. Menunggu lawan memilih.`;

  await interaction.editReply({ content: ack, embeds: [] });
}

async function handleCoinflipSoloButton(interaction, choice, ownerId, context) {
  if (interaction.user.id !== ownerId) {
    await replyEphemeralError(interaction, 'Tombol Coin Flip ini hanya untuk pembuat perintah.');
    return;
  }
  if (!isValidCoinChoice(choice)) {
    await replyEphemeralError(interaction, 'Pilihan Coin Flip tidak valid.');
    return;
  }

  const outcome = context.gameManager.playInstantSolo({
    gameType: GAME_TYPES.COINFLIP,
    playerId: ownerId,
    action: { choice },
  });

  if (outcome.error) {
    await replyEphemeralError(interaction, outcome.error);
    return;
  }

  const embed = renderGameOrResultEmbed(GAME_TYPES.COINFLIP, outcome.publicView, outcome.result, 0);
  await interaction.update({ embeds: [embed], components: [] });
}

/**
 * Routes all `cf:*` Coin Flip button interactions.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} context
 */
export async function handleCoinflipInteraction(interaction, context = {}) {
  const customId = interaction?.customId ?? '';
  const parts = customId.split(':');
  if (parts[0] !== COINFLIP_CUSTOM_ID_PREFIX) return false;

  const [, scope, arg1, arg2] = parts;

  if (scope === 'invite' && (arg1 === 'accept' || arg1 === 'reject') && arg2) {
    await handleCoinflipInviteButton(interaction, arg1, arg2, context);
    return true;
  }

  if (scope === 'choose' && arg1 && arg2) {
    await handleCoinflipChoiceButton(interaction, arg1, arg2, context);
    return true;
  }

  if (scope === 'solo' && arg1 && arg2) {
    await handleCoinflipSoloButton(interaction, arg1, arg2, context);
    return true;
  }

  return false;
}
