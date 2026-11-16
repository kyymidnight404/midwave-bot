import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { prisma } from '../../src/services/prisma.js';
import { execute as executeAutorole } from '../../src/commands/autorole.js';
import guildMemberAddEvent from '../../src/events/guildMemberAdd.js';

describe('Auto Role Prisma Database & Service', () => {
  const testGuildId = 'guild_test_999';
  const testRoleId1 = 'role_test_001';
  const testRoleId2 = 'role_test_002';

  before(async () => {
    // Clean up any test records
    await prisma.autoRole.deleteMany({
      where: { guildId: testGuildId },
    });
  });

  after(async () => {
    await prisma.autoRole.deleteMany({
      where: { guildId: testGuildId },
    });
  });

  it('can create, read, and delete AutoRole records via Prisma Client', async () => {
    // 1. Create
    const created = await prisma.autoRole.create({
      data: {
        guildId: testGuildId,
        roleId: testRoleId1,
      },
    });
    assert.equal(created.guildId, testGuildId);
    assert.equal(created.roleId, testRoleId1);
    assert.ok(created.id);

    // 2. Read
    const found = await prisma.autoRole.findMany({
      where: { guildId: testGuildId },
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].roleId, testRoleId1);

    // 3. Enforce Unique constraint on (guildId, roleId)
    await assert.rejects(
      async () => {
        await prisma.autoRole.create({
          data: {
            guildId: testGuildId,
            roleId: testRoleId1,
          },
        });
      },
      (err) => err?.code === 'P2002'
    );

    // 4. Delete
    const deleted = await prisma.autoRole.deleteMany({
      where: { guildId: testGuildId, roleId: testRoleId1 },
    });
    assert.equal(deleted.count, 1);

    const afterDelete = await prisma.autoRole.findMany({
      where: { guildId: testGuildId },
    });
    assert.equal(afterDelete.length, 0);
  });

  it('handles /autorole add, list, delete commands through Prisma context', async () => {
    const rolesCache = new Map([
      [testRoleId1, { id: testRoleId1, name: 'MemberRole', guild: { id: testGuildId }, toString: () => '<@&role_test_001>', comparePositionTo: () => -1 }],
      [testRoleId2, { id: testRoleId2, name: 'GamerRole', guild: { id: testGuildId }, toString: () => '<@&role_test_002>', comparePositionTo: () => -1 }],
    ]);

    const createMockInteraction = (subcommand, roleParam = null) => {
      let replyData = null;
      return {
        guild: {
          id: testGuildId,
          roles: { cache: rolesCache },
          members: {
            me: {
              roles: { highest: { position: 10 } },
              permissions: { has: (p) => (p & PermissionFlagsBits.ManageRoles) !== 0n },
            },
          },
        },
        memberPermissions: {
          has: (p) => (p & PermissionFlagsBits.Administrator) !== 0n,
        },
        inGuild: () => true,
        options: {
          getSubcommand: () => subcommand,
          getRole: () => roleParam,
        },
        reply: async (data) => {
          replyData = data;
          return data;
        },
        getReply: () => replyData,
      };
    };

    // 1. Add role 1
    const addInt1 = createMockInteraction('add', rolesCache.get(testRoleId1));
    await executeAutorole(addInt1, { prisma });
    assert.ok(addInt1.getReply()?.embeds[0]?.data?.description?.includes('berhasil ditambahkan'));

    // 2. Duplicate add role 1
    const addIntDup = createMockInteraction('add', rolesCache.get(testRoleId1));
    await executeAutorole(addIntDup, { prisma });
    assert.ok(addIntDup.getReply()?.embeds[0]?.data?.description?.includes('sudah terdaftar'));

    // 3. List
    const listInt = createMockInteraction('list');
    await executeAutorole(listInt, { prisma });
    assert.ok(listInt.getReply()?.embeds[0]?.data?.description?.includes('<@&role_test_001>'));

    // 4. Delete role 1
    const delInt = createMockInteraction('delete', rolesCache.get(testRoleId1));
    await executeAutorole(delInt, { prisma });
    assert.ok(delInt.getReply()?.embeds[0]?.data?.description?.includes('dihapus dari Auto Role'));

    // 5. Delete non-existent role
    const delIntMissing = createMockInteraction('delete', rolesCache.get(testRoleId2));
    await executeAutorole(delIntMissing, { prisma });
    assert.ok(delIntMissing.getReply()?.embeds[0]?.data?.description?.includes('tidak ditemukan'));
  });

  it('assigns auto roles on guildMemberAdd event', async () => {
    // Setup 1 active role in DB
    await prisma.autoRole.create({
      data: { guildId: testGuildId, roleId: testRoleId2 },
    });

    const assignedRoles = [];
    const mockMember = {
      id: 'user_test_555',
      guild: {
        id: testGuildId,
        roles: {
          cache: new Map([
            [testRoleId2, { id: testRoleId2, comparePositionTo: () => -1, managed: false }],
          ]),
        },
        members: {
          me: {
            roles: { highest: { position: 10 } },
            permissions: { has: () => true },
          },
        },
      },
      roles: {
        add: async (roles, reason) => {
          assignedRoles.push({ roles, reason });
        },
      },
    };

    await guildMemberAddEvent.execute(mockMember, { prisma });

    assert.equal(assignedRoles.length, 1);
    assert.equal(assignedRoles[0].reason, 'MIDWAVE Auto Role');
    assert.equal(assignedRoles[0].roles[0].id, testRoleId2);

    // Clean up
    await prisma.autoRole.deleteMany({
      where: { guildId: testGuildId },
    });
  });
});
