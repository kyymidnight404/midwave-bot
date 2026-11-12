import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, GAME_METADATA } from '../utils/constants.js';
import {
  buildErrorEmbed,
  buildInfoEmbed,
  buildLobbyEmbed,
  buildStatusEmbed,
  formatPlayer,
} from '../utils/embeds.js';
import { updatePublicMessage } from '../utils/discordBoard.js';

export default {
  data: new SlashCommandBuilder()
    .setName('game')
    .setDescription('Kelola pertandingan yang sedang berjalan')
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Lihat informasi pertandingan aktif atau undangan pending'),
    )
    .addSubcommand((sub) =>
      sub.setName('cancel').setDescription('Batalkan pertandingan aktif atau undangan yang kamu buat'),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {object} context
   */
  async execute(interaction, context) {
    const sub = interaction.options.getSubcommand();
    const { gameManager, client } = context;

    if (sub === 'status') {
      const status = gameManager.getStatus(interaction.user.id);
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
      return;
    }

    if (sub === 'cancel') {
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
  },
};
