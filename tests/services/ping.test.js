import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  Status,
  version as discordJsVersion,
} from 'discord.js';
import { COLORS } from '../../src/config/colors.js';
import { createBotApp } from '../../src/index.js';
import { prisma as realPrisma } from '../../src/services/prisma.js';
import {
  HEALTH_STATUS,
  PING_REFRESH_CUSTOM_ID,
  WS_CONNECTION_STATUS,
  buildPingCheckingEmbed,
  buildPingComponents,
  buildPingEmbed,
  collectPingDiagnostics,
  computeCpuIntervalPercent,
  evaluateHealthStatus,
  formatMemoryMb,
  formatUptime,
  inspectWebSocketState,
} from '../../src/services/pingService.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

function createFakePingClient({
  wsPing = 42,
  wsStatus = Status.Ready,
  wsDestroyed = false,
  ready = true,
  shards = null,
  uptime = 3_725_000,
  restShouldFail = false,
  restError = null,
  restDelayMs = 0,
  guilds = [
    { id: 'g1', available: true, memberCount: 120 },
    { id: 'g2', available: true, memberCount: 380 },
  ],
} = {}) {
  const guildMap = new Map(guilds.map((g) => [g.id, g]));
  const shardMap =
    shards !== null
      ? new Map(shards.map((s, idx) => [s.id ?? idx, s]))
      : new Map([[0, { id: 0, status: wsStatus, ping: wsPing }]]);

  return {
    user: { id: 'bot-1', username: 'Midwave' },
    isReady: () => ready && !wsDestroyed && wsStatus === Status.Ready,
    ws: {
      ping: wsPing,
      status: wsStatus,
      destroyed: wsDestroyed,
      shards: shardMap,
    },
    uptime,
    guilds: { cache: guildMap },
    rest: {
      async get(_route, opts = {}) {
        if (restDelayMs > 0) {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, restDelayMs);
            opts.signal?.addEventListener?.(
              'abort',
              () => {
                clearTimeout(t);
                const abortErr = new Error('Aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
              },
              { once: true },
            );
          });
        }
        if (restError) {
          throw restError;
        }
        if (restShouldFail) {
          throw new Error('Discord REST error: token=Bot secret_token_12345 at https://discord.com/api');
        }
        return { url: 'wss://gateway.discord.gg' };
      },
    },
    once() {},
    on() {},
    destroy() {},
  };
}

function createFakePrisma({ shouldFail = false, delayMs = 0 } = {}) {
  return {
    async $queryRaw() {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (shouldFail) {
        throw new Error('SQLITE_CANTOPEN: C:\\secret\\prisma\\dev.db DATABASE_URL=file:./dev.db');
      }
      return [{ 1: 1 }];
    },
    async $disconnect() {},
  };
}

function assertCompactEmbedExcludesSystemFields(embedJson) {
  const serialized = JSON.stringify(embedJson);
  assert.equal(
    /\b(Memory|RAM|RSS|CPU|Guilds|Servers|Guild Count|Members|System Information|Node\.js|discord\.js)\b/i.test(
      serialized,
    ),
    false,
  );
}

describe('Midwave Ping & Connection Diagnostics (!ping and /ping)', () => {
  it('parses !ping cleanly with default and custom prefixes', () => {
    assert.deepEqual(parsePrefixInvocation('!ping'), {
      commandName: 'ping',
      subcommand: null,
      options: {},
    });
    assert.deepEqual(parsePrefixInvocation('?PING', { prefix: '?' }), {
      commandName: 'ping',
      subcommand: null,
      options: {},
    });
  });

  it('formats uptime and memory metrics accurately and never fakes short CPU intervals', () => {
    assert.equal(formatUptime(0), '0s');
    assert.equal(formatUptime(90_000), '1m 30s');
    assert.equal(formatUptime(3_661_000), '1h 1m 1s');
    assert.equal(formatUptime(90_061_000), '1d 1h 1m 1s');
    assert.equal(formatMemoryMb(100 * 1024 * 1024), '100.0 MB');

    const instantCpu = computeCpuIntervalPercent(process.cpuUsage(), process.hrtime.bigint());
    assert.equal(instantCpu.cpuPercent, null);
  });

  it('1-4. Inspects WebSocket readiness, Connected (including 0ms & awaiting heartbeat), Connecting, Disconnected, and Unavailable', () => {
    // Connected with normal ping
    assert.deepEqual(
      inspectWebSocketState(createFakePingClient({ wsPing: 35, wsStatus: Status.Ready, ready: true })),
      { connectionState: WS_CONNECTION_STATUS.CONNECTED, clientReady: true, pingMs: 35 },
    );

    // Connected with 0ms ping (must NOT treat 0 as missing/failed)
    assert.deepEqual(
      inspectWebSocketState(createFakePingClient({ wsPing: 0, wsStatus: Status.Ready, ready: true })),
      { connectionState: WS_CONNECTION_STATUS.CONNECTED, clientReady: true, pingMs: 0 },
    );

    // Connected & Ready before first Gateway heartbeat ACK (ping = -1)
    assert.deepEqual(
      inspectWebSocketState(createFakePingClient({ wsPing: -1, wsStatus: Status.Ready, ready: true })),
      { connectionState: WS_CONNECTION_STATUS.CONNECTED, clientReady: true, pingMs: null },
    );

    // Multi-shard: ignores uninitialized shard (-1) when averaging active shard pings
    assert.deepEqual(
      inspectWebSocketState(
        createFakePingClient({
          wsPing: 19.5,
          wsStatus: Status.Ready,
          ready: true,
          shards: [
            { id: 0, status: Status.Ready, ping: 40 },
            { id: 1, status: Status.Ready, ping: -1 },
          ],
        }),
      ),
      { connectionState: WS_CONNECTION_STATUS.CONNECTED, clientReady: true, pingMs: 40 },
    );

    // Connecting / Reconnecting
    assert.deepEqual(
      inspectWebSocketState(
        createFakePingClient({ wsPing: -1, wsStatus: Status.Connecting, ready: false }),
      ),
      { connectionState: WS_CONNECTION_STATUS.CONNECTING, clientReady: false, pingMs: null },
    );
    assert.deepEqual(
      inspectWebSocketState(
        createFakePingClient({ wsPing: -1, wsStatus: Status.Reconnecting, ready: false }),
      ),
      { connectionState: WS_CONNECTION_STATUS.CONNECTING, clientReady: false, pingMs: null },
    );

    // Disconnected
    assert.deepEqual(
      inspectWebSocketState(
        createFakePingClient({ wsPing: -1, wsStatus: Status.Disconnected, ready: false }),
      ),
      { connectionState: WS_CONNECTION_STATUS.DISCONNECTED, clientReady: false, pingMs: null },
    );
    assert.deepEqual(
      inspectWebSocketState(
        createFakePingClient({ wsPing: 25, wsStatus: Status.Ready, wsDestroyed: true, ready: false }),
      ),
      { connectionState: WS_CONNECTION_STATUS.DISCONNECTED, clientReady: false, pingMs: null },
    );

    // Unavailable (client/ws missing)
    assert.deepEqual(inspectWebSocketState(null), {
      connectionState: WS_CONNECTION_STATUS.UNAVAILABLE,
      clientReady: false,
      pingMs: null,
    });
  });

  it('11. Classifies Healthy, Degraded, and Unhealthy distinctly across all scenarios', () => {
    const okRest = { status: 'healthy', latencyMs: 80, timedOut: false, errorType: null };
    const okDb = { status: 'healthy', latencyMs: 5, timedOut: false, errorType: null };
    const okMsg = { status: 'healthy', latencyMs: 60 };

    // 1. All normal -> Healthy
    assert.equal(
      evaluateHealthStatus({
        clientReady: true,
        wsStatus: WS_CONNECTION_STATUS.CONNECTED,
        wsPingMs: 35,
        restCheck: okRest,
        dbCheck: okDb,
        messageCheck: okMsg,
      }),
      HEALTH_STATUS.HEALTHY,
    );

    // 2. WebSocket Connecting (not ready) -> Degraded (never Healthy!)
    assert.equal(
      evaluateHealthStatus({
        clientReady: false,
        wsStatus: WS_CONNECTION_STATUS.CONNECTING,
        wsPingMs: null,
        restCheck: okRest,
        dbCheck: okDb,
        messageCheck: okMsg,
      }),
      HEALTH_STATUS.DEGRADED,
    );

    // 4. WebSocket Connected but heartbeat ping unavailable -> Degraded
    assert.equal(
      evaluateHealthStatus({
        clientReady: true,
        wsStatus: WS_CONNECTION_STATUS.CONNECTED,
        wsPingMs: null,
        restCheck: okRest,
        dbCheck: okDb,
        messageCheck: okMsg,
      }),
      HEALTH_STATUS.DEGRADED,
    );

    // WebSocket metric Unavailable (distinct from Disconnected) -> Degraded
    assert.equal(
      evaluateHealthStatus({
        clientReady: false,
        wsStatus: WS_CONNECTION_STATUS.UNAVAILABLE,
        wsPingMs: null,
        restCheck: okRest,
        dbCheck: okDb,
        messageCheck: okMsg,
      }),
      HEALTH_STATUS.DEGRADED,
    );

    // 3. WebSocket Disconnected -> Unhealthy
    assert.equal(
      evaluateHealthStatus({
        clientReady: false,
        wsStatus: WS_CONNECTION_STATUS.DISCONNECTED,
        wsPingMs: null,
        restCheck: okRest,
        dbCheck: okDb,
        messageCheck: okMsg,
      }),
      HEALTH_STATUS.UNHEALTHY,
    );

    // 5. REST timeout -> Degraded
    assert.equal(
      evaluateHealthStatus({
        clientReady: true,
        wsStatus: WS_CONNECTION_STATUS.CONNECTED,
        wsPingMs: 40,
        restCheck: { status: 'degraded', latencyMs: null, timedOut: true, errorType: 'timeout' },
        dbCheck: okDb,
        messageCheck: okMsg,
      }),
      HEALTH_STATUS.DEGRADED,
    );

    // 6. REST HTTP/network error -> Unhealthy; REST rate limit -> Degraded
    assert.equal(
      evaluateHealthStatus({
        clientReady: true,
        wsStatus: WS_CONNECTION_STATUS.CONNECTED,
        wsPingMs: 40,
        restCheck: { status: 'unavailable', latencyMs: null, timedOut: false, errorType: 'http_error' },
        dbCheck: okDb,
        messageCheck: okMsg,
      }),
      HEALTH_STATUS.UNHEALTHY,
    );
    assert.equal(
      evaluateHealthStatus({
        clientReady: true,
        wsStatus: WS_CONNECTION_STATUS.CONNECTED,
        wsPingMs: 40,
        restCheck: { status: 'degraded', latencyMs: null, timedOut: false, errorType: 'rate_limit' },
        dbCheck: okDb,
        messageCheck: okMsg,
      }),
      HEALTH_STATUS.DEGRADED,
    );

    // 7. Database inaccessible -> Unhealthy
    assert.equal(
      evaluateHealthStatus({
        clientReady: true,
        wsStatus: WS_CONNECTION_STATUS.CONNECTED,
        wsPingMs: 40,
        restCheck: okRest,
        dbCheck: { status: 'unavailable', latencyMs: null, timedOut: false, errorType: 'disconnected' },
        messageCheck: okMsg,
      }),
      HEALTH_STATUS.UNHEALTHY,
    );

    // 8. Database timeout -> Degraded
    assert.equal(
      evaluateHealthStatus({
        clientReady: true,
        wsStatus: WS_CONNECTION_STATUS.CONNECTED,
        wsPingMs: 40,
        restCheck: okRest,
        dbCheck: { status: 'degraded', latencyMs: null, timedOut: true, errorType: 'timeout' },
        messageCheck: okMsg,
      }),
      HEALTH_STATUS.DEGRADED,
    );
  });

  it('1. Collects live diagnostics for healthy state including real Prisma query, valid CPU interval, and system metrics', async () => {
    const client = createFakePingClient({ wsPing: 38, uptime: 5_000_000 });
    const report = await collectPingDiagnostics({
      client,
      prisma: realPrisma,
      messageLatencyMs: 54,
    });

    assert.equal(report.overallStatus, HEALTH_STATUS.HEALTHY);
    assert.equal(report.checks.ws.connectionState, WS_CONNECTION_STATUS.CONNECTED);
    assert.equal(report.checks.ws.latencyMs, 38);
    assert.equal(report.checks.message.latencyMs, 54);
    assert.equal(typeof report.checks.rest.latencyMs, 'number');
    assert.equal(typeof report.checks.database.latencyMs, 'number');
    assert.ok(report.system.memoryRssBytes > 0);
    assert.equal(typeof report.system.cpuPercent, 'number');
    assert.ok(report.system.cpuSampleWindowMs >= 90);
    assert.equal(report.system.guildCount, 2);
    assert.equal(report.system.memberCount, 500);
    assert.equal(report.system.isMemberEstimate, false);
    assert.equal(report.system.nodeVersion, process.version);
    assert.equal(report.system.discordJsVersion, `v${discordJsVersion}`);

    const requester = {
      id: 'u-1',
      username: 'kyy',
      globalName: 'Kyy',
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/u-1/abc.png',
    };
    const embed = buildPingEmbed(report, { requester }).toJSON();
    assert.equal(embed.title, 'MIDWAVE — PONG!');
    assert.equal(embed.color, COLORS.SUCCESS);
    assert.match(embed.description, /Healthy/i);
    assert.match(embed.description, /WebSocket:.*38 ms/);
    assert.equal(embed.fields.length, 2);
    assert.equal(embed.fields[0].inline, true);
    assert.equal(embed.fields[1].inline, true);
    assert.match(embed.fields[0].name, /Connection Diagnostics/i);
    assert.match(embed.fields[0].value, /Message:/);
    assert.match(embed.fields[0].value, /REST API:/);
    assert.match(embed.fields[1].value, /Database:/);
    assert.match(embed.fields[1].value, /Gateway:.*Connected/);
    assert.ok(embed.timestamp);
    assert.match(embed.footer.text, /^Uptime: .+ • Requested by Kyy$/);
    assertCompactEmbedExcludesSystemFields(embed);

    const row = buildPingComponents({ requesterId: 'u-1' }).toJSON();
    assert.equal(row.components[0].custom_id, `${PING_REFRESH_CUSTOM_ID}:u-1`);
    assert.equal(row.components[0].style, ButtonStyle.Primary);

    const checkingEmbed = buildPingCheckingEmbed().toJSON();
    assert.equal(checkingEmbed.title, 'MIDWAVE — PONG!');
    assert.equal(checkingEmbed.color, COLORS.PRIMARY);
  });

  it('2-8 & 10. Handles WS Connecting, WS awaiting heartbeat, WS Disconnected, REST error/rate-limit, DB failure, timeouts, and partial member cache cleanly', async () => {
    // 2. WebSocket Connecting + incomplete member cache -> Degraded + estimate marker (excluded from compact embed)
    const connectingClient = createFakePingClient({
      wsPing: -1,
      wsStatus: Status.Connecting,
      ready: false,
      guilds: [{ id: 'g1', available: false, members: { cache: new Map([['u1', {}], ['u2', {}]]) } }],
    });
    const connectingReport = await collectPingDiagnostics({
      client: connectingClient,
      prisma: createFakePrisma(),
      messageLatencyMs: 30,
    });
    assert.equal(connectingReport.overallStatus, HEALTH_STATUS.DEGRADED);
    assert.equal(connectingReport.checks.ws.connectionState, WS_CONNECTION_STATUS.CONNECTING);
    assert.equal(connectingReport.system.isMemberEstimate, true);
    const connectingEmbed = buildPingEmbed(connectingReport).toJSON();
    assert.equal(connectingEmbed.color, COLORS.WARNING);
    assert.match(connectingEmbed.description, /Connecting/);
    assert.match(connectingEmbed.fields[1].value, /Gateway:.*Connecting/);
    assertCompactEmbedExcludesSystemFields(connectingEmbed);

    // 4. WebSocket Ready/Connected before first heartbeat (ws.ping = -1)
    const awaitingHbClient = createFakePingClient({ wsPing: -1, wsStatus: Status.Ready, ready: true });
    const awaitingHbReport = await collectPingDiagnostics({
      client: awaitingHbClient,
      prisma: createFakePrisma(),
      messageLatencyMs: 28,
    });
    assert.equal(awaitingHbReport.overallStatus, HEALTH_STATUS.DEGRADED);
    assert.equal(awaitingHbReport.checks.ws.connectionState, WS_CONNECTION_STATUS.CONNECTED);
    const awaitingHbEmbed = buildPingEmbed(awaitingHbReport).toJSON();
    assert.match(awaitingHbEmbed.description, /Awaiting heartbeat/);
    assert.match(awaitingHbEmbed.fields[1].value, /Gateway:.*Connected/);

    // 3. WebSocket Disconnected -> Unhealthy
    const disconnectedClient = createFakePingClient({ wsPing: -1, wsStatus: Status.Disconnected, ready: false });
    const disconnectedReport = await collectPingDiagnostics({
      client: disconnectedClient,
      prisma: createFakePrisma(),
      messageLatencyMs: 25,
    });
    assert.equal(disconnectedReport.overallStatus, HEALTH_STATUS.UNHEALTHY);
    const disconnectedEmbed = buildPingEmbed(disconnectedReport).toJSON();
    assert.equal(disconnectedEmbed.color, COLORS.ERROR);
    assert.match(disconnectedEmbed.fields[1].value, /Gateway:.*Disconnected/);

    // 6. REST HTTP error & Rate limit without leaking secrets
    const restHttpErr = Object.assign(new Error('HTTP 500 token=abc'), { status: 500 });
    const httpErrReport = await collectPingDiagnostics({
      client: createFakePingClient({ wsPing: 40, restError: restHttpErr }),
      prisma: createFakePrisma(),
      messageLatencyMs: 40,
    });
    assert.equal(httpErrReport.overallStatus, HEALTH_STATUS.UNHEALTHY);
    assert.equal(httpErrReport.checks.rest.errorType, 'http_error');
    const httpErrJson = JSON.stringify(buildPingEmbed(httpErrReport).toJSON());
    assert.match(httpErrJson, /HTTP Error/);
    assert.equal(httpErrJson.includes('token=abc'), false);

    const rateLimitErr = Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    const rateLimitReport = await collectPingDiagnostics({
      client: createFakePingClient({ wsPing: 40, restError: rateLimitErr }),
      prisma: createFakePrisma(),
      messageLatencyMs: 40,
    });
    assert.equal(rateLimitReport.overallStatus, HEALTH_STATUS.DEGRADED);
    assert.match(buildPingEmbed(rateLimitReport).toJSON().fields[0].value, /Rate Limited/);

    // 7. Database failure -> Unhealthy + no DATABASE_URL leaked
    const dbFailReport = await collectPingDiagnostics({
      client: createFakePingClient({ wsPing: 45 }),
      prisma: createFakePrisma({ shouldFail: true }),
      messageLatencyMs: 70,
    });
    assert.equal(dbFailReport.overallStatus, HEALTH_STATUS.UNHEALTHY);
    assert.equal(dbFailReport.checks.database.status, 'unavailable');
    const dbFailJson = JSON.stringify(buildPingEmbed(dbFailReport).toJSON());
    assert.equal(dbFailJson.includes('SQLITE_CANTOPEN'), false);
    assert.equal(dbFailJson.includes('DATABASE_URL'), false);
    assert.equal(dbFailJson.includes('dev.db'), false);

    // 5 & 8. REST + DB timeouts -> Degraded + Timeout label
    const timeoutReport = await collectPingDiagnostics({
      client: createFakePingClient({ wsPing: 40, restDelayMs: 250 }),
      prisma: createFakePrisma({ delayMs: 250 }),
      messageLatencyMs: 25,
      restTimeoutMs: 25,
      dbTimeoutMs: 25,
    });
    assert.equal(timeoutReport.checks.rest.timedOut, true);
    assert.equal(timeoutReport.checks.database.timedOut, true);
    assert.equal(timeoutReport.overallStatus, HEALTH_STATUS.DEGRADED);
    assert.match(JSON.stringify(buildPingEmbed(timeoutReport).toJSON()), /Timeout/);
  });

  it('9. Executes /ping, !ping, and Refresh button consistently, enforcing ownership, concurrency lock, cooldown, and expired interaction handling', async () => {
    const fakeClient = createFakePingClient({ wsPing: 29, uptime: 120_000 });
    const fakePrisma = createFakePrisma();
    const app = await createBotApp({
      client: fakeClient,
      prisma: fakePrisma,
      cooldowns: new CooldownManager(0),
    });

    // 1. Slash /ping
    const slashReplies = [];
    const slashEdits = [];
    const slashInteraction = {
      commandName: 'ping',
      client: fakeClient,
      user: {
        id: 'u-slash',
        username: 'slash_user',
        globalName: 'Slash User',
        displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
      },
      guildId: 'g1',
      channelId: 'c1',
      deferred: false,
      replied: false,
      isChatInputCommand: () => true,
      isMessageContextMenuCommand: () => false,
      options: {
        getSubcommand: () => null,
        getSubcommandGroup: () => null,
        getString: () => null,
      },
      async reply(payload) {
        this.replied = true;
        slashReplies.push(payload);
        return payload;
      },
      async editReply(payload) {
        slashEdits.push(payload);
        return payload;
      },
    };

    await app.interactionHandler.handle(slashInteraction);
    assert.equal(slashReplies.length, 1);
    assert.equal(slashReplies[0].embeds[0].toJSON().color, COLORS.PRIMARY);
    assert.equal(slashEdits.length, 1);
    const slashEmbed = slashEdits[0].embeds[0].toJSON();
    assert.equal(slashEmbed.title, 'MIDWAVE — PONG!');
    assert.equal(slashEmbed.color, COLORS.SUCCESS);
    assert.match(slashEmbed.footer.text, /^Uptime: .+ • Requested by Slash User$/);
    assertCompactEmbedExcludesSystemFields(slashEmbed);
    const slashBtnId = slashEdits[0].components[0].toJSON().components[0].custom_id;
    assert.equal(slashBtnId, `${PING_REFRESH_CUSTOM_ID}:u-slash`);

    // 2. Prefix !ping (without AttachFiles permission to verify graceful fallback)
    const prefixReplies = [];
    const prefixEdits = [];
    const prefixMsg = {
      id: 'msg-ping-1',
      content: '!ping',
      client: fakeClient,
      author: {
        id: 'u-prefix',
        bot: false,
        username: 'prefix_user',
        globalName: 'Prefix User',
        displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png',
      },
      guildId: 'g1',
      channelId: 'c1',
      guild: {
        id: 'g1',
        members: { me: { id: 'bot-1' } },
      },
      mentions: { users: new Map() },
      channel: {
        id: 'c1',
        isTextBased: () => true,
        permissionsFor: () =>
          new Set([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]),
      },
      async reply(payload) {
        prefixReplies.push(payload);
        return {
          async edit(editPayload) {
            prefixEdits.push(editPayload);
            return editPayload;
          },
        };
      },
    };

    await app.prefixCommandHandler.handle(prefixMsg);
    assert.equal(prefixReplies.length, 1);
    assert.equal(prefixEdits.length, 1);
    const prefixEmbed = prefixEdits[0].embeds[0].toJSON();
    assert.equal(prefixEmbed.title, 'MIDWAVE — PONG!');
    assert.equal(prefixEmbed.color, COLORS.SUCCESS);
    assert.equal(prefixEmbed.fields.length, slashEmbed.fields.length);
    assert.equal(prefixEmbed.fields[0].name, slashEmbed.fields[0].name);
    assert.equal(prefixEmbed.fields[1].name, slashEmbed.fields[1].name);
    assert.match(prefixEmbed.footer.text, /^Uptime: .+ • Requested by Prefix User$/);
    assertCompactEmbedExcludesSystemFields(prefixEmbed);
    assert.deepEqual(prefixEdits[0].files, []);

    // 3a. Non-owner clicking Refresh is blocked ephemerally
    const strangerReplies = [];
    await app.interactionHandler.handle({
      customId: slashBtnId,
      client: fakeClient,
      user: { id: 'u-stranger', username: 'stranger' },
      isButton: () => true,
      async reply(payload) {
        strangerReplies.push(payload);
      },
    });
    assert.equal(strangerReplies.length, 1);
    assert.equal(strangerReplies[0].flags, MessageFlags.Ephemeral);
    assert.match(strangerReplies[0].embeds[0].toJSON().description, /Hanya pengguna yang menjalankan perintah/i);

    // 3b. Concurrent Refresh prevention (second click while first is in flight is rejected cleanly)
    let releaseFirstRefresh;
    const slowGate = new Promise((r) => {
      releaseFirstRefresh = r;
    });
    app.interactionHandler.setContext({
      ...app.context,
      restProbe: async () => {
        await slowGate;
      },
    });

    const firstUpdates = [];
    const firstEdits = [];
    const secondReplies = [];
    const ownerButtonBase = {
      customId: slashBtnId,
      client: fakeClient,
      message: { id: 'msg-slash-1', attachments: new Map([['logo', {}]]) },
      createdTimestamp: Date.now(),
      user: {
        id: 'u-slash',
        username: 'slash_user',
        globalName: 'Slash User',
        displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
      },
      isButton: () => true,
      isChatInputCommand: () => false,
      isMessageContextMenuCommand: () => false,
    };

    const firstPromise = app.interactionHandler.handle({
      ...ownerButtonBase,
      async update(payload) {
        firstUpdates.push(payload);
      },
      async editReply(payload) {
        firstEdits.push(payload);
      },
    });

    // Wait a tick for first refresh to enter active lock
    await new Promise((r) => setTimeout(r, 15));

    await app.interactionHandler.handle({
      ...ownerButtonBase,
      async reply(payload) {
        secondReplies.push(payload);
      },
    });
    assert.equal(secondReplies.length, 1);
    assert.equal(secondReplies[0].flags, MessageFlags.Ephemeral);
    assert.match(secondReplies[0].embeds[0].toJSON().description, /sedang diperbarui/i);

    releaseFirstRefresh();
    await firstPromise;
    assert.equal(firstUpdates.length, 1);
    assert.equal(firstUpdates[0].components[0].toJSON().components[0].disabled, true);
    assert.equal(firstEdits.length, 1);
    const refreshedEmbed = firstEdits[0].embeds[0].toJSON();
    assert.equal(refreshedEmbed.title, 'MIDWAVE — PONG!');
    assert.equal(refreshedEmbed.color, COLORS.SUCCESS);
    assert.equal(refreshedEmbed.fields.length, 2);
    assertCompactEmbedExcludesSystemFields(refreshedEmbed);
    // Existing attachments preserved without re-uploading logo
    assert.equal(firstEdits[0].files, undefined);

    // 3c. Expired interaction (10062) handled gracefully without throwing
    app.interactionHandler.setContext(app.context);
    await app.interactionHandler.handle({
      ...ownerButtonBase,
      message: { id: 'msg-slash-expired', attachments: new Map() },
      async update() {
        const err = new Error('Unknown interaction');
        err.code = 10062;
        throw err;
      },
    });

    app.shutdown();
  });
});
