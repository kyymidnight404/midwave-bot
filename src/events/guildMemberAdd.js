import { Events, PermissionFlagsBits } from 'discord.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member, context = {}) {
    const db = context.prisma;
    if (!db?.autoRole) return;
    try {
      const entries = await db.autoRole.findMany({ where: { guildId: member.guild.id } });
      if (!entries.length) return;

      const botMember = member.guild.members.me ?? await member.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        context.logger?.warn?.(`[AutoRole] Missing ManageRoles permission in guild ${member.guild.id}`);
        return;
      }
      const roles = entries
        .map(({ roleId }) => member.guild.roles.cache.get(roleId))
        .filter((role) => role && !role.managed && role.id !== member.guild.id && role.comparePositionTo(botMember.roles.highest) < 0);
      if (roles.length) await member.roles.add(roles, 'MIDWAVE Auto Role');
    } catch (error) {
      const errorCode =
        typeof error?.code === 'string' && /^[A-Z0-9_ -]{1,40}$/i.test(error.code)
          ? error.code
          : 'UNKNOWN_ERROR';
      context.logger?.error?.(`[AutoRole] Failed assigning roles (${errorCode})`);
    }
  },
};
