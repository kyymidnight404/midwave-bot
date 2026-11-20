import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, PermissionFlagsBits, version as discordJsVersion } from 'discord.js';
import { COLORS } from '../../src/config/colors.js';
import { createBotApp } from '../../src/index.js';
import { prisma as realPrisma } from '../../src/services/prisma.js';
import {
  HEALTH_STATUS,
  PING_REFRESH_CUSTOM_ID,
  buildPingCheckingEmbed,
  buildPingComponents,
  buildPingEmbed,
  collectPingDiagnostics,
  evaluateHealthStatus,
  formatMemoryMb,
  formatUptime,
} from '../../src/services/pingService.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

function createFakePingClient({
  wsPing = 42,
  uptime = 3_725_000,
  restShouldFail = false,
  restDelayMs = 0,
  guilds = [
    { id: 'g1', memberCount: 120 },
    { id: 'g2', memberCount: 380 },
  ],
} = {}) {
  const guildMap = new Map(guilds.map((g) => [g.id, g]));
  return {
    user: { id: 'bot-1', username: 'Midwave' },
    ws: { ping: wsPing },
    uptime,
    guilds: { cache: guildMap },
    rest: {
      async get() {
        if (restDelayMs > 0) {
          await new Promise((r) => setTimeout(r, restDelayMs));
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

  it('formats uptime and memory metrics accurately', () => {
    assert.equal(formatUptime(0), '0s');
    assert.equal(formatUptime(90_000), '1m 30s');
    assert.equal(formatUptime(3_661_000), '1h 1m 1s');
    assert.equal(formatUptime(90_061_000), '1d 1h 1m 1s');
    assert.equal(formatMemoryMb(100 * 1024 * 1024), '100.0 MB');
  });

  it('evaluates healthy, degraded, and unavailable statuses accurately', () => {
    assert.equal(
      evaluateHealthStatus({
        messageLatencyMs: 60,
        wsPingMs: 35,
        restLatencyMs: 80,
        dbLatencyMs: 5,
      }),
      HEALTH_STATUS.HEALTHY,
    );

    assert.equal(
      evaluateHealthStatus({
        messageLatencyMs: 60,
        wsPingMs: 320,
        restLatencyMs: 80,
        dbLatencyMs: 5,
      }),
      HEALTH_STATUS.DEGRADED,
    );

    assert.equal(
      evaluateHealthStatus({
        messageLatencyMs: 60,
        wsPingMs: 40,
        restLatencyMs: 90,
        dbLatencyMs: null,
      }),
      HEALTH_STATUS.DEGRADED,
    );

    assert.equal(
      evaluateHealthStatus({
        messageLatencyMs: 60,
        wsPingMs: null,
        restLatencyMs: null,
        dbLatencyMs: 5,
      }),
      HEALTH_STATUS.UNAVAILABLE,
    );
  });

  it('collects live diagnostics for healthy state including real Prisma query and system metrics', async () => {
    const client = createFakePingClient({ wsPing: 38, uptime: 5_000_000 });
    const report = await collectPingDiagnostics({
      client,
      prisma: realPrisma,
      messageLatencyMs: 54,
    });

    assert.equal(report.overallStatus, HEALTH_STATUS.HEALTHY);
    assert.equal(report.checks.ws.latencyMs, 38);
    assert.equal(report.checks.message.latencyMs, 54);
    assert.equal(typeof report.checks.rest.latencyMs, 'number');
    assert.equal(typeof report.checks.database.latencyMs, 'number');
    assert.ok(report.system.memoryRssBytes > 0);
    assert.ok(report.system.cpuPercent >= 0);
    assert.equal(report.system.guildCount, 2);
    assert.equal(report.system.memberCount, 500);
    assert.equal(report.system.nodeVersion, process.version);
    assert.equal(report.system.discordJsVersion, `v${discordJsVersion}`);

    const requester = {
      id: 'u-1',
      username: 'kyy',
      globalName: 'Kyy',
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/u-1/abc.png',
    };
    const embed = buildPingEmbed(report, { requester }).toJSON();
    assert.equal(embed.color, COLORS.SUCCESS);
    assert.match(embed.description, /Healthy/i);
    assert.match(embed.description, /38 ms/);
    assert.equal(embed.fields.length, 2);
    assert.match(embed.fields[0].name, /Connection Diagnostics/i);
    assert.match(embed.fields[1].name, /System Information/i);
    assert.match(embed.fields[1].value, /Memory \(RSS\)/i);
    assert.match(embed.fields[1].value, /CPU Usage/i);
    assert.match(embed.fields[1].value, /500/);
    assert.ok(embed.timestamp);
    assert.equal(embed.footer.text, 'Requested by Kyy');

    const row = buildPingComponents().toJSON();
    assert.equal(row.components[0].custom_id, PING_REFRESH_CUSTOM_ID);
    assert.equal(row.components[0].style, ButtonStyle.Primary);

    assert.equal(buildPingCheckingEmbed().toJSON().color, COLORS.PRIMARY);
  });

  it('handles degraded database failure and timeout gracefully without leaking sensitive info', async () => {
    const client = createFakePingClient({ wsPing: 45 });
    const failingPrisma = createFakePrisma({ shouldFail: true });

    const report = await collectPingDiagnostics({
      client,
      prisma: failingPrisma,
      messageLatencyMs: 70,
    });

    assert.equal(report.overallStatus, HEALTH_STATUS.DEGRADED);
    assert.equal(report.checks.database.status, HEALTH_STATUS.UNAVAILABLE);
    assert.equal(report.checks.database.latencyMs, null);
    assert.equal(report.checks.rest.status, HEALTH_STATUS.HEALTHY);

    const embedJson = JSON.stringify(buildPingEmbed(report).toJSON());
    assert.equal(buildPingEmbed(report).toJSON().color, COLORS.WARNING);
    assert.match(embedJson, /Degraded/i);
    assert.match(embedJson, /Unavailable/i);
    assert.equal(embedJson.includes('SQLITE_CANTOPEN'), false);
    assert.equal(embedJson.includes('DATABASE_URL'), false);
    assert.equal(embedJson.includes('dev.db'), false);
  });

  it('handles full connection failure (Discord REST + WS unavailable) cleanly with red status and no secrets', async () => {
    const client = createFakePingClient({ wsPing: -1, restShouldFail: true });
    const failingPrisma = createFakePrisma({ shouldFail: true });

    const report = await collectPingDiagnostics({
      client,
      prisma: failingPrisma,
      messageLatencyMs: null,
    });

    assert.equal(report.overallStatus, HEALTH_STATUS.UNAVAILABLE);
    assert.equal(report.checks.ws.status, HEALTH_STATUS.UNAVAILABLE);
    assert.equal(report.checks.rest.status, HEALTH_STATUS.UNAVAILABLE);
    assert.equal(report.checks.database.status, HEALTH_STATUS.UNAVAILABLE);

    const embed = buildPingEmbed(report).toJSON();
    const serialized = JSON.stringify(embed);
    assert.equal(embed.color, COLORS.ERROR);
    assert.match(embed.description, /Unavailable/i);
    assert.equal(serialized.includes('secret_token_12345'), false);
    assert.equal(serialized.includes('DATABASE_URL'), false);
  });

  it('handles probe timeouts cleanly without hanging', async () => {
    const client = createFakePingClient({ wsPing: 40, restDelayMs: 200 });
    const slowPrisma = createFakePrisma({ delayMs: 200 });

    const report = await collectPingDiagnostics({
      client,
      prisma: slowPrisma,
      messageLatencyMs: 25,
      restTimeoutMs: 20,
      dbTimeoutMs: 20,
    });

    assert.equal(report.checks.rest.timedOut, true);
    assert.equal(report.checks.database.timedOut, true);
    assert.equal(report.overallStatus, HEALTH_STATUS.DEGRADED);
    const serialized = JSON.stringify(buildPingEmbed(report).toJSON());
    assert.match(serialized, /Timeout/);
  });

  it('executes /ping, !ping, and Refresh button consistently via createBotApp', async () => {
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
    assert.equal(slashEmbed.color, COLORS.SUCCESS);
    assert.equal(slashEmbed.footer.text, 'Requested by Slash User');
    assert.equal(slashEdits[0].components[0].toJSON().components[0].custom_id, PING_REFRESH_CUSTOM_ID);

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
    assert.equal(prefixEmbed.color, COLORS.SUCCESS);
    assert.equal(prefixEmbed.fields.length, slashEmbed.fields.length);
    assert.equal(prefixEmbed.fields[0].name, slashEmbed.fields[0].name);
    assert.equal(prefixEmbed.fields[1].name, slashEmbed.fields[1].name);
    assert.equal(prefixEmbed.footer.text, 'Requested by Prefix User');
    assert.deepEqual(prefixEdits[0].files, []);

    // 3. Refresh button interaction
    let refreshDeferred = false;
    const refreshEdits = [];
    const buttonInteraction = {
      customId: PING_REFRESH_CUSTOM_ID,
      client: fakeClient,
      user: {
        id: 'u-refresh',
        username: 'refresher',
        globalName: 'Refresher',
        displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/2.png',
      },
      deferred: false,
      replied: false,
      isButton: () => true,
      isChatInputCommand: () => false,
      isMessageContextMenuCommand: () => false,
      async deferUpdate() {
        refreshDeferred = true;
        this.deferred = true;
      },
      async editReply(payload) {
        refreshEdits.push(payload);
        return payload;
      },
    };

    await app.interactionHandler.handle(buttonInteraction);
    assert.equal(refreshDeferred, true);
    assert.equal(refreshEdits.length, 1);
    assert.equal(refreshEdits[0].embeds[0].toJSON().color, COLORS.SUCCESS);
    assert.equal(refreshEdits[0].embeds[0].toJSON().footer.text, 'Requested by Refresher');

    app.shutdown();
  });
});
