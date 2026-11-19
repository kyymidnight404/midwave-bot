import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { resolveFeedbackChannel } from '../../src/services/feedbackService.js';
import { sanitizeError } from '../../src/utils/errorSanitizer.js';
import {
  assertSafeRemoteHost,
  isPrivateOrReservedIp,
} from '../../src/services/downloader/urlValidator.js';
import {
  createPinnedHttpsAgent,
  downloadMediaToTempFile,
} from '../../src/services/downloader/fileManager.js';
import {
  DOWNLOADER_ERROR_CODES,
  validateMediaUrl,
} from '../../src/services/downloader.js';

function createMockFeedbackClient({
  channelType = ChannelType.GuildText,
  isThread = false,
  everyoneCanView = false,
  overwrites = [],
  roles = [],
} = {}) {
  const guildId = '111111111111111111';
  const botId = '222222222222222222';
  const channelId = '333333333333333333';

  const everyoneRole = {
    id: guildId,
    managed: false,
    permissions: { has: () => false },
  };

  const roleMap = new Map([[guildId, everyoneRole]]);
  for (const r of roles) {
    roleMap.set(r.id, r);
  }

  const overwriteMap = new Map();
  for (const ow of overwrites) {
    overwriteMap.set(ow.id, ow);
  }

  const channel = {
    id: channelId,
    type: channelType,
    isTextBased: () => true,
    isThread: () => isThread,
    permissionOverwrites: {
      cache: overwriteMap,
    },
    guild: {
      id: guildId,
      members: {
        me: { id: botId },
      },
      roles: {
        everyone: everyoneRole,
        cache: roleMap,
      },
    },
    permissionsFor: (target) => {
      if (target?.id === botId) {
        return {
          has: (perm) =>
            perm === PermissionFlagsBits.ViewChannel ||
            perm === PermissionFlagsBits.SendMessages ||
            perm === PermissionFlagsBits.EmbedLinks,
        };
      }
      if (target?.id === guildId) {
        return { has: () => everyoneCanView };
      }
      const ow = overwriteMap.get(target?.id);
      const canView = ow ? ow.allow.has(PermissionFlagsBits.ViewChannel) : false;
      return { has: (perm) => (perm === PermissionFlagsBits.ViewChannel ? canView : false) };
    },
  };

  return {
    user: { id: botId },
    channels: {
      cache: new Map([[channelId, channel]]),
    },
  };
}

describe('Security Hardening Phase 2 Regression Tests', () => {
  it('1. rejects feedback channel when a non-staff role has ViewChannel overwrite', async () => {
    const nonStaffRoleId = '444444444444444444';
    const staffRoleId = '555555555555555555';
    const client = createMockFeedbackClient({
      overwrites: [
        {
          id: nonStaffRoleId,
          type: OverwriteType.Role,
          allow: { has: (p) => p === PermissionFlagsBits.ViewChannel },
        },
      ],
      roles: [
        { id: nonStaffRoleId, managed: false, permissions: { has: () => false } },
      ],
    });

    const result = await resolveFeedbackChannel(client, {
      env: {
        FEEDBACK_CHANNEL_ID: '333333333333333333',
        FEEDBACK_STAFF_ROLE_IDS: staffRoleId,
      },
      logger: { error: () => {} },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'CHANNEL_NOT_PRIVATE');
  });

  it('2. rejects public thread for feedback channel', async () => {
    const client = createMockFeedbackClient({
      channelType: ChannelType.PublicThread,
      isThread: true,
    });

    const result = await resolveFeedbackChannel(client, {
      env: {
        FEEDBACK_CHANNEL_ID: '333333333333333333',
        FEEDBACK_STAFF_ROLE_IDS: '555555555555555555',
      },
      logger: { error: () => {} },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'UNSUPPORTED_CHANNEL_TYPE');
  });

  it('3. accepts staff-only private feedback channel', async () => {
    const staffRoleId = '555555555555555555';
    const client = createMockFeedbackClient({
      overwrites: [
        {
          id: staffRoleId,
          type: OverwriteType.Role,
          allow: { has: (p) => p === PermissionFlagsBits.ViewChannel },
        },
      ],
      roles: [
        { id: staffRoleId, managed: false, permissions: { has: () => false } },
      ],
    });

    const result = await resolveFeedbackChannel(client, {
      env: {
        FEEDBACK_CHANNEL_ID: '333333333333333333',
        FEEDBACK_STAFF_ROLE_IDS: staffRoleId,
      },
      logger: { error: () => {} },
    });

    assert.equal(result.ok, true);
    assert.ok(result.channel);
  });

  it('4. redacts Authorization header from sanitized error', () => {
    const err = new Error('Request failed with authorization: Bearer super-secret-jwt-token');
    const safe = sanitizeError(err);
    assert.ok(!safe.includes('super-secret-jwt-token'));
    assert.match(safe, /\[REDACTED\]/);
  });

  it('5. redacts URL credentials and token query params from sanitized error', () => {
    const err = {
      name: 'AxiosError',
      code: 'ERR_BAD_REQUEST',
      response: { status: 401 },
      message: 'GET https://user:pass123@api.example.com/v1?token=abc123secret&x-rapidapi-key=key999 failed',
    };
    const safe = sanitizeError(err);
    assert.ok(!safe.includes('pass123'));
    assert.ok(!safe.includes('abc123secret'));
    assert.ok(!safe.includes('key999'));
    assert.match(safe, /\[AxiosError\]/);
    assert.match(safe, /status=401/);
  });

  it('6. blocks IPv4-compatible IPv6 addresses', () => {
    assert.equal(isPrivateOrReservedIp('::127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('::7f00:1'), true);
    assert.equal(isPrivateOrReservedIp('::10.0.0.1'), true);
  });

  it('7. blocks NAT64 and 6to4 addresses', () => {
    assert.equal(isPrivateOrReservedIp('64:ff9b::127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('64:ff9b:1::1'), true);
    assert.equal(isPrivateOrReservedIp('2002:7f00:0001::'), true);
    assert.equal(isPrivateOrReservedIp('2002:0a00:0001::'), true);
  });

  it('8. pins validated IP in HTTPS agent to prevent DNS rebinding', async () => {
    let lookupCalls = 0;
    const resolved = await assertSafeRemoteHost('cdn.tiktokcdn.com', {
      lookupFn: async () => {
        lookupCalls += 1;
        return [{ address: '93.184.216.34', family: 4 }];
      },
    });
    assert.equal(lookupCalls, 1);
    assert.equal(resolved.address, '93.184.216.34');

    const agent = createPinnedHttpsAgent('cdn.tiktokcdn.com', resolved);
    const pinned = await new Promise((resolve, reject) => {
      agent.options.lookup('cdn.tiktokcdn.com', {}, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });
    assert.equal(pinned.address, '93.184.216.34');
    assert.equal(pinned.family, 4);
  });

  it('9. rejects HTTP redirects pointing to private IP addresses', async () => {
    await assert.rejects(
      () =>
        downloadMediaToTempFile('https://cdn.tiktokcdn.com/video.mp4', {
          lookupFn: async (host) => {
            if (host === 'cdn.tiktokcdn.com') {
              return [{ address: '93.184.216.34', family: 4 }];
            }
            return [{ address: '127.0.0.1', family: 4 }];
          },
          fetchFn: async () => ({
            status: 302,
            headers: new Headers({ location: 'https://internal.example.local/secret' }),
            body: null,
          }),
        }),
      (err) => err?.code === 'UNSAFE_TARGET',
    );
  });

  it('10. rejects non-HTTP(S), embedded credentials, custom ports, and private IP URLs', async () => {
    assert.throws(() => validateMediaUrl('file:///etc/passwd'), (err) => err?.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('ftp://example.com/video.mp4'), (err) => err?.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('https://user:pass@youtube.com/watch?v=123'), (err) => err?.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('https://youtube.com:8443/watch?v=123'), (err) => err?.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('https://127.0.0.1/video.mp4'), (err) => err?.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET);
    assert.throws(() => validateMediaUrl('http://localhost/video.mp4'), (err) => err?.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET);
    assert.throws(() => validateMediaUrl('https://metadata.internal/latest'), (err) => err?.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET);

    await assert.rejects(
      () =>
        assertSafeRemoteHost('evil.example.com', {
          lookupFn: async () => [{ address: '10.0.0.5', family: 4 }],
        }),
      (err) => err?.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
    );
  });

  it('11. preserves production botKnowledge.json updatedAt timestamp', () => {
    const kbPath = path.resolve(process.cwd(), 'src/data/botKnowledge.json');
    const raw = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
    assert.ok(typeof raw.updatedAt === 'string' && raw.updatedAt.length > 0);
  });
});
