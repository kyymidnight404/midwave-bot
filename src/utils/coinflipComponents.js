import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { getComponentEmoji, getEmoji } from '../config/emojis.js';
import { BOT_PLAYER_ID, GAME_TYPES } from './constants.js';
import {
  buildErrorEmbed,
  createBaseEmbed,
  getIconFiles,
} from './embeds.js';
import {
  createSessionTimeoutHandler,
  updatePublicMessage,
} from './discordBoard.js';
import { isValidCoinChoice } from './validators.js';

export const COINFLIP_CUSTOM_ID_PREFIX = 'cf';

const CHOICE_DISPLAY = Object.freeze({
  heads: 'Heads',
  tails: 'Tails',
});

function formatCoinChoice(choice) {
  return CHOICE_DISPLAY[choice] ?? choice;
}

/**
 * Builds the simplified Coin Flip challenge/invite embed with a compact status badge.
 * @param {{
 *   hostId: string,
 *   opponentId: string,
 *   status?: 'pending' | 'accepted' | 'rejected' | 'expired',
 *   rejectedById?: string | null,
 *   includeThumbnail?: boolean,
 * }} params
 */
export function buildCoinflipInviteEmbed({
  hostId,
  opponentId,
  status = 'pending',
  rejectedById = null,
  includeThumbnail = true,
}) {
  let color = COLORS.PRIMARY;
  let description = `🟡 **Menunggu Konfirmasi** (60 detik)\n<@${hostId}> menantang <@${opponentId}> — Klik **Accept** atau **Reject**.`;

  if (status === 'accepted') {
    color = COLORS.SUCCESS;
    description = `🟢 **Diterima** — <@${opponentId}> menerima tantangan, pilih **Heads** atau **Tails** di bawah.`;
  } else if (status === 'rejected') {
    color = COLORS.ERROR;
    description = `🔴 **Ditolak** — <@${rejectedById ?? opponentId}> menolak tantangan ini.`;
  } else if (status === 'expired') {
    color = COLORS.WARNING;
    description = `${getEmoji('timer')} **Kedaluwarsa** — Tantangan berakhir tanpa jawaban.`;
  }

  return createBaseEmbed({
    title: `${getEmoji('coin')} Coin Flip`,
    description,
    color,
    includeThumbnail,
    iconName: 'coinflip',
  });
}

/**
 * Builds the simplified active Coin Flip board embed (no Mode/Status grid, single sentence instruction).
 * @param {object} state
 * @param {{ includeThumbnail?: boolean }} [options]
 */
export function buildCoinflipBoardEmbed(state, { includeThumbnail = true } = {}) {
  const playerLines = (state?.players ?? [])
    .filter((p) => p !== BOT_PLAYER_ID)
    .map((p) => `• <@${p}>: ${state?.choices?.[p] ? `${getEmoji('success')} Sudah memilih (rahasia)` : `${getEmoji('loading')} Menunggu pilihan...`}`);

  return createBaseEmbed({
    title: `${getEmoji('coin')} Coin Flip`,
    description: `${playerLines.join('\n')}\n\nPilih **Heads** atau **Tails** secara rahasia di bawah.`,
    color: COLORS.PRIMARY,
    includeThumbnail,
    iconName: 'coinflip',
  });
}

/**
 * Builds the simplified Coin Flip result embed (one concise summary without Mode/Durasi/Detail fields).
 * @param {object} state
 * @param {{ includeThumbnail?: boolean }} [options]
 */
export function buildCoinflipResultEmbed(state, { includeThumbnail = true } = {}) {
  const coin = formatCoinChoice(state?.coinResult);
  const humanPlayers = (state?.players ?? []).filter((p) => p !== BOT_PLAYER_ID);

  if (humanPlayers.length === 1) {
    const playerId = humanPlayers[0];
    const picked = state?.choices?.[playerId];
    const won = picked === state?.coinResult;
    const summary = won
      ? `🎉 **Menang!** <@${playerId}> menebak **${formatCoinChoice(picked)}** — Koin mendarat di **${coin}**.`
      : `😔 **Kalah!** <@${playerId}> menebak **${formatCoinChoice(picked)}** — Koin mendarat di **${coin}**.`;

    return createBaseEmbed({
      title: `${getEmoji('coin')} Coin Flip — Hasil Akhir`,
      description: summary,
      color: won ? COLORS.SUCCESS : COLORS.DANGER,
      includeThumbnail,
      iconName: 'coinflip',
    });
  }

  const [p1, p2] = humanPlayers;
  const c1 = formatCoinChoice(state?.choices?.[p1]);
  const c2 = formatCoinChoice(state?.choices?.[p2]);

  if (state?.result?.isDraw) {
    return createBaseEmbed({
      title: `${getEmoji('coin')} Coin Flip — Hasil Akhir`,
      description: `🤝 **Draw** (<@${p1}> vs <@${p2}>)\n${getEmoji('coin')} Hasil Koin: **${coin}** · Kedua pemain memilih **${c1}**`,
      color: COLORS.WARNING,
      includeThumbnail,
      iconName: 'coinflip',
    });
  }

  const winnerId = state?.result?.winnerId;
  return createBaseEmbed({
    title: `${getEmoji('coin')} Coin Flip — Hasil Akhir`,
    description: `${getEmoji('trophy')} **Pemenang:** <@${winnerId}>\n${getEmoji('coin')} Hasil Koin: **${coin}** · <@${p1}>: **${c1}** · <@${p2}>: **${c2}**`,
    color: COLORS.SUCCESS,
    includeThumbnail,
    iconName: 'coinflip',
  });
}

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
        .setEmoji(getComponentEmoji('success'))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${COINFLIP_CUSTOM_ID_PREFIX}:invite:reject:${inviteId}`)
        .setLabel('Reject')
        .setEmoji(getComponentEmoji('error'))
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
        .setEmoji(getComponentEmoji('coin'))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${COINFLIP_CUSTOM_ID_PREFIX}:choose:tails:${sessionId}`)
        .setLabel('Tails')
        .setEmoji(getComponentEmoji('tails'))
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * Builds Heads / Tails choice buttons for an instant Solo Coin Flip prompt.
 * @param {string} userId
 */
export function buildCoinflipSoloPromptPayload(userId) {
  const embed = createBaseEmbed({
    title: `${getEmoji('coin')} Coin Flip`,
    description: 'Pilih **Heads** atau **Tails** untuk melempar koin.',
    color: COLORS.PRIMARY,
    iconName: 'coinflip',
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COINFLIP_CUSTOM_ID_PREFIX}:solo:heads:${userId}`)
      .setLabel('Heads')
      .setEmoji(getComponentEmoji('coin'))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${COINFLIP_CUSTOM_ID_PREFIX}:solo:tails:${userId}`)
      .setLabel('Tails')
      .setEmoji(getComponentEmoji('tails'))
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], files: getIconFiles('coinflip') };
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

  if (action === 'reject') {
    try {
      gameManager.declineChallenge(interaction.user.id);
    } catch (err) {
      await replyEphemeralError(interaction, err.message);
      return;
    }

    const declinedLobby = buildCoinflipInviteEmbed({
      hostId: invite.hostId,
      opponentId: invite.opponentId,
      status: 'rejected',
      rejectedById: interaction.user.id,
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

    const { session } = accepted;
    const acceptedLobby = buildCoinflipInviteEmbed({
      hostId: invite.hostId,
      opponentId: invite.opponentId,
      status: 'accepted',
    });
    await interaction.update({ embeds: [acceptedLobby], components: [] });

    const boardEmbed = buildCoinflipBoardEmbed(session.state);
    const boardPayload = {
      embeds: [boardEmbed],
      components: buildCoinflipChoiceComponents(session.sessionId),
      files: getIconFiles('coinflip'),
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

  const embed = outcome.finished
    ? buildCoinflipResultEmbed(outcome.state)
    : buildCoinflipBoardEmbed(outcome.state);

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

  const embed = buildCoinflipResultEmbed(outcome.state);
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
