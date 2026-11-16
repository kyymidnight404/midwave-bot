import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { GAME_METADATA, GAME_TYPES } from '../utils/constants.js';
import { buildCoinflipChoiceComponents } from '../utils/coinflipComponents.js';
import {
  buildErrorEmbed,
  buildLobbyEmbed,
  formatPlayer,
  getLogoFiles,
} from '../utils/embeds.js';
import {
  createSessionTimeoutHandler,
  renderGameOrResultEmbed,
  updatePublicMessage,
} from '../utils/discordBoard.js';

export default {
  data: new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Terima atau tolak undangan pertandingan multiplayer')
    .addSubcommand((sub) =>
      sub.setName('accept').setDescription('Menerima undangan pertandingan terbaru untukmu'),
    )
    .addSubcommand((sub) =>
      sub.setName('decline').setDescription('Menolak undangan pertandingan yang masuk'),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {object} context
   */
  async execute(interaction, context) {
    const sub = interaction.options.getSubcommand();
    const { gameManager, sessionManager, client } = context;

    if (sub === 'accept') {
      await interaction.deferReply();

      let accepted;
      try {
        accepted = gameManager.acceptChallenge(interaction.user.id, {
          onTimeout: createSessionTimeoutHandler(client),
        });
      } catch (err) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(err.message)],
        });
        return;
      }

      const { invite, session, immediateFinished, result, publicView } = accepted;
      const meta = GAME_METADATA[invite.gameType];
      const gameTitle = meta?.name ?? invite.gameType;

      // Update old lobby message to show Accepted
      const acceptedLobby = buildLobbyEmbed({
        gameTitle,
        hostId: invite.hostId,
        opponentId: invite.opponentId,
        status: 'Diterima',
        instructions: 'Pertandingan dimulai!',
        color: COLORS.SUCCESS,
      });
      await updatePublicMessage(client, invite.lobbyMessageRef, {
        embeds: [acceptedLobby],
        components: [],
      });

      const boardEmbed = renderGameOrResultEmbed(
        invite.gameType,
        publicView,
        immediateFinished ? result : null,
        0,
      );

      const isCoinflipBoard = !immediateFinished && session && invite.gameType === GAME_TYPES.COINFLIP;
      await interaction.editReply({
        embeds: [boardEmbed],
        ...(isCoinflipBoard ? { components: buildCoinflipChoiceComponents(session.sessionId) } : {}),
        files: getLogoFiles(),
      });

      if (!immediateFinished && session) {
        try {
          const replyMsg = await interaction.fetchReply();
          sessionManager.setBoardMessageRef(session.sessionId, {
            channelId: replyMsg.channelId,
            messageId: replyMsg.id,
          });
        } catch {
          // Safe fallback if message ref fetch fails
        }
      }
      return;
    }

    if (sub === 'decline') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let declined;
      try {
        declined = gameManager.declineChallenge(interaction.user.id);
      } catch (err) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(err.message)],
        });
        return;
      }

      const meta = GAME_METADATA[declined.gameType];
      const declinedLobby = buildLobbyEmbed({
        gameTitle: meta?.name ?? declined.gameType,
        hostId: declined.hostId,
        opponentId: declined.opponentId,
        status: 'Ditolak',
        instructions: `${formatPlayer(interaction.user.id)} menolak undangan ini.`,
        color: COLORS.ERROR,
      });

      await updatePublicMessage(client, declined.lobbyMessageRef, {
        embeds: [declinedLobby],
        components: [],
      });

      await interaction.editReply({
        content: `Undangan dari ${formatPlayer(declined.hostId)} telah kamu tolak.`,
      });
    }
  },
};
