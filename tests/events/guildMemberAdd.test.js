import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import guildMemberAddEvent from '../../src/events/guildMemberAdd.js';

describe('guildMemberAdd AutoRole error logging', () => {
  it('does not pass raw exception details to the logger', async () => {
    const secretMessage = 'request failed with authorization=super-secret-token';
    const logged = [];
    const member = {
      id: 'member-1',
      guild: {
        id: 'guild-1',
        members: {
          me: {
            permissions: { has: () => true },
            roles: { highest: {} },
          },
        },
        roles: { cache: new Map() },
      },
      roles: {
        add: async () => {
          throw Object.assign(new Error(secretMessage), { code: 'API_ERROR' });
        },
      },
    };
    const prisma = {
      autoRole: {
        findMany: async () => [{ roleId: 'role-1' }],
      },
    };
    member.guild.roles.cache.set('role-1', {
      id: 'role-1',
      managed: false,
      comparePositionTo: () => -1,
    });

    await guildMemberAddEvent.execute(member, {
      prisma,
      logger: {
        error: (...args) => logged.push(args),
      },
    });

    assert.equal(logged.length, 1);
    assert.equal(logged[0].length, 1);
    assert.match(logged[0][0], /API_ERROR/);
    assert.equal(logged[0][0].includes(secretMessage), false);
    assert.equal(logged[0][0].includes('super-secret-token'), false);
  });
});
