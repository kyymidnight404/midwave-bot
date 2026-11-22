import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { COLORS } from '../config/colors.js';
import { getEmoji } from '../config/emojis.js';
import { buildErrorEmbed, buildInfoEmbed, buildSuccessEmbed } from '../utils/embeds.js';

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator));
}

function canAssignRole(role, botMember) {
  if (!role || role.id === role.guild.id || role.managed) return false;
  if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return false;
  return Boolean(botMember.roles?.highest && role.comparePositionTo(botMember.roles.highest) < 0);
}

export async function execute(interaction, context = {}) {
  const reply = (embed) => interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  if (!interaction.inGuild?.() || !interaction.guild) {
    return reply(buildErrorEmbed('Command ini hanya dapat digunakan di dalam server.'));
  }
  if (!isAdmin(interaction)) {
    return reply(
      buildErrorEmbed(
        'Hanya Admin server yang dapat mengelola Auto Role.',
        `${getEmoji('shield')} Akses Ditolak`,
      ),
    );
  }

  const db = context.prisma;
  if (!db?.autoRole) throw new Error('Prisma Auto Role client tidak tersedia.');
  const sub = interaction.options.getSubcommand(true);
  const guildId = interaction.guild.id;

  if (sub === 'list') {
    const entries = await db.autoRole.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } });
    const roles = entries.map(({ roleId }) => interaction.guild.roles.cache.get(roleId)).filter(Boolean);
    const description = roles.length
      ? roles.map((role) => `• ${role}`).join('\n')
      : 'Belum ada role Auto Role yang terdaftar.';
    return reply(buildInfoEmbed(`${getEmoji('users')} Auto Role MIDWAVE`, description, COLORS.PRIMARY));
  }

  const role = interaction.options.getRole('role', false);
  if (!role) {
    return reply(buildErrorEmbed('Pilih parameter `role` terlebih dahulu untuk aksi `add` atau `delete`.'));
  }
  if (role.guild?.id !== guildId || !interaction.guild.roles.cache.has(role.id)) {
    return reply(buildErrorEmbed('Role tersebut tidak ditemukan di server ini.'));
  }
  const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
  if (!role || !canAssignRole(role, botMember)) {
    return reply(buildErrorEmbed('Role tidak valid untuk Auto Role. Pastikan bot memiliki **Manage Roles** dan role berada di bawah role tertinggi bot. Role terkelola atau @everyone tidak dapat digunakan.'));
  }

  if (sub === 'add') {
    try {
      await db.autoRole.create({ data: { guildId, roleId: role.id } });
      return reply(
        buildSuccessEmbed(
          `Role ${role} berhasil ditambahkan ke Auto Role.`,
          `${getEmoji('add')} Auto Role Ditambahkan`,
        ),
      );
    } catch (error) {
      if (error?.code === 'P2002') {
        return reply(
          buildInfoEmbed(`${getEmoji('info')} Auto Role MIDWAVE`, `${role} sudah terdaftar.`, COLORS.WARNING),
        );
      }
      throw error;
    }
  }

  if (sub === 'delete') {
    const result = await db.autoRole.deleteMany({ where: { guildId, roleId: role.id } });
    if (!result.count) {
      return reply(
        buildInfoEmbed(
          `${getEmoji('warning')} Auto Role MIDWAVE`,
          `${role} tidak ditemukan di daftar Auto Role.`,
          COLORS.WARNING,
        ),
      );
    }
    return reply(
      buildSuccessEmbed(
        `${role} dihapus dari Auto Role. Role ini tetap dimiliki member yang sudah menerimanya.`,
        `${getEmoji('remove')} Auto Role Dihapus`,
      ),
    );
  }
}
