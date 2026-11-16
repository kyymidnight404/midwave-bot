import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import {
  resolveAndValidateRedirects,
  validateMediaUrl,
} from '../../src/services/downloader/urlValidator.js';
import {
  downloadViaRapidApi,
  getDownloaderConfig,
  sanitizeCdnUrl,
  validateAllCdnCandidates,
  validateCdnFallbackUrl,
} from '../../src/services/downloader.js';
import { sanitizeError } from '../../src/utils/errorSanitizer.js';
import { InteractionHandler } from '../../src/handlers/InteractionHandler.js';
import { isStaffMember, resolveFeedbackChannel } from '../../src/services/feedbackService.js';

function createMockHttpsRequest(handler) {
  return (parsedUrl, opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = (err) => {
      if (err) req.emit('error', err);
    };
    req.end = () => {
      Promise.resolve(handler(parsedUrl, opts)).then(
        ({ status = 200, headers = {}, lookupResult }) => {
          if (opts.agent && opts.agent.options?.lookup) {
            opts.agent.options.lookup(parsedUrl.hostname, {}, (err, address, family) => {
              if (err) {
                req.emit('error', err);
                return;
              }
              if (typeof lookupResult === 'function') {
                lookupResult({ address, family });
              }
              const res = new EventEmitter();
              res.statusCode = status;
              res.headers = headers;
              res.destroy = () => {};
              cb(res);
            });
            return;
          }
          const res = new EventEmitter();
          res.statusCode = status;
          res.headers = headers;
          res.destroy = () => {};
          cb(res);
        },
        (err) => req.emit('error', err),
      );
    };
    return req;
  };
}

describe('Security Remediation Phase 3.1 Regression Tests', () => {
  it('1 & 2. enforces DNS-pinned HTTPS resolver with TLS SNI on short-links and prevents DNS rebinding', async () => {
    const shortHosts = ['instagr.am', 'vm.tiktok.com', 'vt.tiktok.com', 't.tiktok.com'];

    for (const host of shortHosts) {
      let dnsCalls = 0;
      let capturedSocketIp = null;
      let capturedTlsOpts = null;

      const validated = validateMediaUrl(`https://${host}/abc123`);
      const resolved = await resolveAndValidateRedirects(validated, {
        lookupFn: async (lookupHost) => {
          if (lookupHost === 'www.tiktok.com') {
            return [{ address: '93.184.216.34', family: 4 }];
          }
          dnsCalls += 1;
          if (dnsCalls === 1) {
            return [{ address: '93.184.216.34', family: 4 }];
          }
          // Simulated DNS rebinding if a second lookup were ever attempted for the short-link
          return [{ address: '127.0.0.1', family: 4 }];
        },
        httpsRequestFn: createMockHttpsRequest((parsedUrl, opts) => {
          capturedTlsOpts = {
            servername: opts.servername,
            rejectUnauthorized: opts.rejectUnauthorized,
          };
          return {
            status: 302,
            headers: { location: 'https://www.tiktok.com/@midwave/video/1234567890' },
            lookupResult: ({ address }) => {
              capturedSocketIp = address;
            },
          };
        }),
      });

      assert.equal(capturedSocketIp, '93.184.216.34');
      assert.equal(capturedTlsOpts.servername, host);
      assert.equal(capturedTlsOpts.rejectUnauthorized, true);
      assert.equal(resolved.hostname, 'www.tiktok.com');
    }
  });

  it('3. blocks short-link redirect pointing to private IP or internal domain', async () => {
    const validated = validateMediaUrl('https://vm.tiktok.com/short1');
    await assert.rejects(
      () =>
        resolveAndValidateRedirects(validated, {
          lookupFn: async (host) => {
            if (host === 'vm.tiktok.com') return [{ address: '93.184.216.34', family: 4 }];
            return [{ address: '169.254.169.254', family: 4 }];
          },
          httpsRequestFn: createMockHttpsRequest(() => ({
            status: 302,
            headers: { location: 'https://169.254.169.254/latest/meta-data/' },
          })),
        }),
      (err) => err?.code === 'UNSAFE_TARGET',
    );

    await assert.rejects(
      () =>
        resolveAndValidateRedirects(validated, {
          lookupFn: async (host) => {
            if (host === 'vm.tiktok.com') return [{ address: '93.184.216.34', family: 4 }];
            return [{ address: '10.0.0.8', family: 4 }];
          },
          httpsRequestFn: createMockHttpsRequest(() => ({
            status: 302,
            headers: { location: 'https://www.tiktok.com/@user/video/999' },
          })),
        }),
      (err) => err?.code === 'UNSAFE_TARGET',
    );
  });

  it('4. sanitizes Axios error with Authorization header inside InteractionHandler without raw leak', async () => {
    const logged = [];
    const commands = new Map([
      [
        'testcmd',
        {
          execute: async () => {
            const axiosErr = new Error('Request failed: authorization: Bearer secret-jwt-xyz');
            axiosErr.name = 'AxiosError';
            axiosErr.code = 'ERR_BAD_REQUEST';
            axiosErr.config = { headers: { Authorization: 'Bearer secret-jwt-xyz' } };
            throw axiosErr;
          },
        },
      ],
    ]);
    const handler = new InteractionHandler({
      commandHandler: {
        get: (name) => commands.get(name),
      },
      cooldowns: {
        defaultTtlMs: 3000,
        tryAcquire: () => ({ allowed: true }),
      },
      logger: {
        error: (...args) => logged.push(args.join(' ')),
        warn: () => {},
      },
    });

    await handler.handle({
      isChatInputCommand: () => true,
      commandName: 'testcmd',
      user: { id: '123456789012345678' },
      replied: false,
      deferred: false,
      reply: async () => {},
    });

    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes('secret-jwt-xyz'));
    assert.ok(!logged[0].includes('"config"'));
    assert.match(logged[0], /\[AxiosError\]/);
  });

  it('5. sanitizes Discord REST error while preserving code and status', () => {
    const restErr = {
      name: 'DiscordAPIError[50013]',
      code: 50013,
      status: 403,
      message:
        'Missing Permissions at https://bot:supersecret@discord.com/api/v10/channels/1?token=tok123',
      requestBody: { files: [] },
    };

    const safe = sanitizeError(restErr);
    assert.match(safe, /DiscordAPIError\[50013\]/);
    assert.match(safe, /code=50013/);
    assert.match(safe, /status=403/);
    assert.ok(!safe.includes('supersecret'));
    assert.ok(!safe.includes('tok123'));
  });

  it('6. validates every CDN candidate (not just candidates[0]) before request or fallback', async () => {
    await assert.rejects(
      () =>
        validateAllCdnCandidates(
          [
            { url: 'https://v16.tiktokcdn.com/valid.mp4' },
            { url: 'https://evil-cdn.example.com/malicious.mp4' },
          ],
          { lookupFn: async () => [{ address: '93.184.216.34', family: 4 }] },
        ),
      (err) => err?.code === 'UNSAFE_TARGET',
    );

    await assert.rejects(
      () =>
        downloadViaRapidApi({
          url: 'https://www.tiktok.com/@midwave/video/1234567890123',
          config: getDownloaderConfig({ RAPIDAPI_KEY: 'test-key' }),
          deps: {
            lookupFn: async (host) => {
              if (host === 'v16.tiktokcdn.com') return [{ address: '93.184.216.34', family: 4 }];
              if (host === 'v19.tiktokcdn.com') return [{ address: '127.0.0.1', family: 4 }];
              return [{ address: '93.184.216.34', family: 4 }];
            },
            axiosClient: {
              get: async () => ({
                data: {
                  links: [
                    { quality: 'hd_no_watermark', link: 'https://v16.tiktokcdn.com/valid.mp4' },
                    { quality: 'sd', link: 'https://v19.tiktokcdn.com/ssrf.mp4' },
                  ],
                },
              }),
            },
          },
        }),
      (err) => err?.code === 'UNSAFE_TARGET',
    );
  });

  it('7. rejects disallowed and generic multi-tenant CDN domains', async () => {
    assert.equal(sanitizeCdnUrl('https://d123456.cloudfront.net/video.mp4'), null);
    assert.equal(sanitizeCdnUrl('https://evil.akamaized.net/video.mp4'), null);
    assert.equal(sanitizeCdnUrl('https://evil-tiktokcdn.com/video.mp4'), null);

    await assert.rejects(
      () => validateCdnFallbackUrl('https://d123456.cloudfront.net/video.mp4'),
      (err) => err?.code === 'UNSAFE_TARGET',
    );
  });

  it('8. error sanitizer never throws on hostile or malformed error objects', () => {
    const circular = { name: 'CircularError' };
    circular.self = circular;

    const throwingGetter = {};
    Object.defineProperty(throwingGetter, 'message', {
      get() {
        throw new Error('getter boom');
      },
    });

    assert.equal(sanitizeError(null), 'Unknown error');
    assert.equal(sanitizeError(undefined), 'Unknown error');
    assert.equal(typeof sanitizeError(circular), 'string');
    assert.equal(typeof sanitizeError(throwingGetter), 'string');
    assert.equal(typeof sanitizeError(12345), 'string');
  });

  it('9. enforces feedback administrator policy and fail-closed empty staff allowlist', async () => {
    const guildId = '111111111111111111';
    const botId = '222222222222222222';
    const adminRoleId = '333333333333333333';
    const memberRoleId = '444444444444444444';

    assert.equal(
      isStaffMember(
        { permissions: { has: (p) => p === PermissionFlagsBits.Administrator }, roles: [] },
        { FEEDBACK_STAFF_ROLE_IDS: '' },
      ),
      true,
    );
    assert.equal(
      isStaffMember(
        { permissions: { has: () => false }, roles: [memberRoleId] },
        { FEEDBACK_STAFF_ROLE_IDS: '' },
      ),
      false,
    );

    const adminRole = {
      id: adminRoleId,
      managed: false,
      permissions: { has: (p) => p === PermissionFlagsBits.Administrator },
    };
    const memberRole = {
      id: memberRoleId,
      managed: false,
      permissions: { has: () => false },
    };
    const everyoneRole = {
      id: guildId,
      managed: false,
      permissions: { has: () => false },
    };

    const channel = {
      id: '555555555555555555',
      type: ChannelType.GuildText,
      isTextBased: () => true,
      isThread: () => false,
      permissionOverwrites: { cache: new Map() },
      guild: {
        id: guildId,
        members: { me: { id: botId } },
        roles: {
          everyone: everyoneRole,
          cache: new Map([
            [guildId, everyoneRole],
            [adminRoleId, adminRole],
            [memberRoleId, memberRole],
          ]),
        },
      },
      permissionsFor: (target) => {
        if (target?.id === botId) {
          return {
            has: (p) =>
              p === PermissionFlagsBits.ViewChannel ||
              p === PermissionFlagsBits.SendMessages ||
              p === PermissionFlagsBits.EmbedLinks,
          };
        }
        if (target?.id === adminRoleId) {
          return { has: (p) => p === PermissionFlagsBits.ViewChannel };
        }
        return { has: () => false };
      },
    };

    const client = {
      user: { id: botId },
      channels: { cache: new Map([[channel.id, channel]]) },
    };

    const res = await resolveFeedbackChannel(client, {
      env: {
        FEEDBACK_CHANNEL_ID: channel.id,
        FEEDBACK_STAFF_ROLE_IDS: '',
      },
      logger: { error: () => {} },
    });

    assert.equal(res.ok, true);
  });
});
