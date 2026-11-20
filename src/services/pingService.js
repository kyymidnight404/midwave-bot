import os from 'node:os';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Routes,
  Status,
  version as discordJsVersion,
} from 'discord.js';
import { COLORS } from '../config/colors.js';
import { createBaseEmbed } from '../utils/embeds.js';

export const PING_COOLDOWN_MS = 3000;
export const PING_CUSTOM_ID_PREFIX = 'ping';
export const PING_REFRESH_CUSTOM_ID = 'ping:refresh';

export const HEALTH_STATUS = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
});

export const WS_CONNECTION_STATUS = Object.freeze({
  CONNECTED: 'connected',
  CONNECTING: 'connecting',
  DISCONNECTED: 'disconnected',
  UNAVAILABLE: 'unavailable',
});

export const PING_THRESHOLDS = Object.freeze({
  wsDegradedMs: 250,
  restDegradedMs: 500,
  dbDegradedMs: 250,
  messageDegradedMs: 600,
});

const DEFAULT_PROBE_TIMEOUT_MS = 4000;
const DEFAULT_CPU_SAMPLE_WINDOW_MS = 100;

const WS_CONNECTING_STATUSES = new Set([
  Status.Connecting,
  Status.Reconnecting,
  Status.Nearly,
  Status.WaitingForGuilds,
  Status.Identifying,
  Status.Resuming,
]);

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Runs an async probe with a hard timeout and optional AbortSignal, cleaning up timers on completion.
 * @template T
 * @param {(signal?: AbortSignal) => Promise<T>} fn
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
async function runWithTimeout(fn, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timerId = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(controller?.signal)),
      new Promise((_, reject) => {
        timerId = setTimeout(() => {
          controller?.abort();
          const err = new Error('Diagnostic probe timed out');
          err.code = 'PROBE_TIMEOUT';
          reject(err);
        }, timeoutMs);
        timerId.unref?.();
      }),
    ]);
  } finally {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
  }
}

/**
 * Formats milliseconds uptime into a compact human-readable duration string.
 * @param {number} uptimeMs
 * @returns {string}
 */
export function formatUptime(uptimeMs) {
  if (typeof uptimeMs !== 'number' || !Number.isFinite(uptimeMs) || uptimeMs < 0) {
    return '0s';
  }
  const totalSeconds = Math.floor(uptimeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * Formats byte count as megabytes (MB).
 * @param {number} bytes
 * @returns {string}
 */
export function formatMemoryMb(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '0.0 MB';
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Computes normalized process CPU usage percentage strictly from a measured time interval.
 * Returns `null` if the measurement interval was too short to avoid misrepresenting cumulative CPU.
 * @param {NodeJS.CpuUsage} cpuStart
 * @param {bigint} wallStartNs
 * @returns {{ cpuPercent: number | null, sampleWindowMs: number }}
 */
export function computeCpuIntervalPercent(cpuStart, wallStartNs) {
  const elapsedUs = Number(process.hrtime.bigint() - wallStartNs) / 1000;
  const sampleWindowMs = Math.max(0, Math.round(elapsedUs / 1000));

  if (elapsedUs < 20_000) {
    return { cpuPercent: null, sampleWindowMs };
  }

  const cpuCores = Math.max(1, os.cpus()?.length || 1);
  const delta = process.cpuUsage(cpuStart);
  const totalCpuUs = Math.max(0, delta.user + delta.system);
  const pct = (totalCpuUs / (elapsedUs * cpuCores)) * 100;

  return {
    cpuPercent: Number(Math.min(100, Math.max(0, pct)).toFixed(1)),
    sampleWindowMs,
  };
}

/**
 * Inspects Discord.js client readiness, WebSocketManager status, and shard pings.
 * Distinguishes Connected (including awaiting first heartbeat), Connecting, Disconnected, and Unavailable.
 * @param {import('discord.js').Client | null | undefined} client
 * @returns {{
 *   connectionState: 'connected' | 'connecting' | 'disconnected' | 'unavailable',
 *   clientReady: boolean,
 *   pingMs: number | null,
 * }}
 */
export function inspectWebSocketState(client) {
  const ws = client?.ws;
  if (!client || !ws) {
    return {
      connectionState: WS_CONNECTION_STATUS.UNAVAILABLE,
      clientReady: false,
      pingMs: null,
    };
  }

  if (ws.destroyed === true || ws.status === Status.Disconnected) {
    return {
      connectionState: WS_CONNECTION_STATUS.DISCONNECTED,
      clientReady: false,
      pingMs: null,
    };
  }

  const shards = ws.shards;
  const shardList =
    shards && typeof shards.values === 'function' ? Array.from(shards.values()) : [];

  const validShardPings = shardList
    .map((shard) => shard?.ping)
    .filter((p) => typeof p === 'number' && Number.isFinite(p) && p >= 0);

  let pingMs = null;
  if (validShardPings.length > 0) {
    const sum = validShardPings.reduce((acc, p) => acc + p, 0);
    pingMs = Math.round(sum / validShardPings.length);
  } else if (typeof ws.ping === 'number' && Number.isFinite(ws.ping) && ws.ping >= 0) {
    pingMs = Math.round(ws.ping);
  }

  const clientReady =
    typeof client.isReady === 'function'
      ? Boolean(client.isReady())
      : ws.status === Status.Ready || (ws.status === undefined && pingMs !== null);

  if (shardList.length > 0 && shardList.every((s) => s?.status === Status.Disconnected)) {
    return {
      connectionState: WS_CONNECTION_STATUS.DISCONNECTED,
      clientReady: false,
      pingMs: null,
    };
  }

  if (ws.status === Status.Ready || clientReady) {
    return {
      connectionState: WS_CONNECTION_STATUS.CONNECTED,
      clientReady: true,
      pingMs,
    };
  }

  if (
    WS_CONNECTING_STATUSES.has(ws.status) ||
    shardList.some((s) => WS_CONNECTING_STATUSES.has(s?.status))
  ) {
    return {
      connectionState: WS_CONNECTION_STATUS.CONNECTING,
      clientReady: false,
      pingMs,
    };
  }

  if (ws.status === Status.Idle) {
    return {
      connectionState:
        shardList.length === 0 ? WS_CONNECTION_STATUS.DISCONNECTED : WS_CONNECTION_STATUS.CONNECTING,
      clientReady: false,
      pingMs: null,
    };
  }

  return {
    connectionState: WS_CONNECTION_STATUS.UNAVAILABLE,
    clientReady: false,
    pingMs,
  };
}

function classifyLatency(latencyMs, degradedThresholdMs) {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return 'unavailable';
  }
  return latencyMs >= degradedThresholdMs ? 'degraded' : 'healthy';
}

function collectGuildStats(client) {
  const cache = client?.guilds?.cache;
  if (!cache || typeof cache.size !== 'number') {
    return { guildCount: 0, memberCount: 0, isMemberEstimate: true };
  }

  let memberCount = 0;
  let isMemberEstimate = false;

  for (const guild of cache.values()) {
    if (guild?.available === false) {
      isMemberEstimate = true;
    }

    if (typeof guild?.memberCount === 'number' && Number.isFinite(guild.memberCount) && guild.memberCount >= 0) {
      memberCount += guild.memberCount;
    } else {
      isMemberEstimate = true;
      const cachedCount = guild?.members?.cache?.size ?? 0;
      if (typeof cachedCount === 'number' && Number.isFinite(cachedCount) && cachedCount > 0) {
        memberCount += cachedCount;
      }
    }
  }

  return {
    guildCount: cache.size,
    memberCount,
    isMemberEstimate,
  };
}

function classifyRestError(err) {
  if (err?.code === 'PROBE_TIMEOUT' || err?.name === 'AbortError') {
    return { status: 'degraded', timedOut: true, errorType: 'timeout' };
  }
  const statusCode = err?.status ?? err?.statusCode ?? err?.rawError?.code;
  if (statusCode === 429) {
    return { status: 'degraded', timedOut: false, errorType: 'rate_limit' };
  }
  if (typeof statusCode === 'number' && statusCode >= 400) {
    return { status: 'unavailable', timedOut: false, errorType: 'http_error' };
  }
  if (NETWORK_ERROR_CODES.has(err?.code) || NETWORK_ERROR_CODES.has(err?.cause?.code)) {
    return { status: 'unavailable', timedOut: false, errorType: 'network_error' };
  }
  return { status: 'unavailable', timedOut: false, errorType: 'error' };
}

async function measureDiscordRestLatency(client, { restProbe, timeoutMs }) {
  const start = performance.now();
  if (typeof restProbe === 'function') {
    await runWithTimeout((signal) => restProbe(client, signal), timeoutMs);
    return Math.max(0, Math.round(performance.now() - start));
  }

  if (typeof client?.rest?.get === 'function') {
    await runWithTimeout((signal) => client.rest.get(Routes.gateway(), { signal }), timeoutMs);
    return Math.max(0, Math.round(performance.now() - start));
  }

  if (typeof client?.users?.fetch === 'function' && client?.user?.id) {
    await runWithTimeout(() => client.users.fetch(client.user.id), timeoutMs);
    return Math.max(0, Math.round(performance.now() - start));
  }

  throw new Error('Discord REST client unavailable');
}

async function measurePrismaDbLatency(prisma, { dbProbe, timeoutMs }) {
  const start = performance.now();
  if (typeof dbProbe === 'function') {
    await runWithTimeout(() => dbProbe(prisma), timeoutMs);
    return Math.max(0, Math.round(performance.now() - start));
  }

  if (typeof prisma?.$queryRaw === 'function') {
    await runWithTimeout(() => prisma.$queryRaw`SELECT 1`, timeoutMs);
    return Math.max(0, Math.round(performance.now() - start));
  }

  throw new Error('Prisma client unavailable');
}

/**
 * Centralized overall health status classifier.
 * Distinguishes Healthy, Degraded, and Unhealthy across connection states and critical dependencies.
 * @param {{
 *   clientReady?: boolean,
 *   wsStatus?: 'connected' | 'connecting' | 'disconnected' | 'unavailable',
 *   wsPingMs?: number | null,
 *   restCheck?: { status: string, latencyMs: number | null, timedOut?: boolean, errorType?: string | null },
 *   dbCheck?: { status: string, latencyMs: number | null, timedOut?: boolean, errorType?: string | null },
 *   messageCheck?: { status: string, latencyMs: number | null },
 * }} input
 * @returns {'healthy' | 'degraded' | 'unhealthy'}
 */
export function evaluateHealthStatus({
  clientReady = false,
  wsStatus = WS_CONNECTION_STATUS.UNAVAILABLE,
  wsPingMs = null,
  restCheck = { status: 'unavailable', latencyMs: null, timedOut: false, errorType: null },
  dbCheck = { status: 'unavailable', latencyMs: null, timedOut: false, errorType: null },
  messageCheck = { status: 'healthy', latencyMs: null },
}) {
  // Critical failures -> Unhealthy
  if (wsStatus === WS_CONNECTION_STATUS.DISCONNECTED) {
    return HEALTH_STATUS.UNHEALTHY;
  }
  if (dbCheck.status === 'unavailable' && !dbCheck.timedOut) {
    return HEALTH_STATUS.UNHEALTHY;
  }
  if (
    restCheck.status === 'unavailable' &&
    !restCheck.timedOut &&
    restCheck.errorType !== 'rate_limit'
  ) {
    return HEALTH_STATUS.UNHEALTHY;
  }

  // Non-critical / transient / unverified metrics -> Degraded
  if (
    !clientReady ||
    wsStatus === WS_CONNECTION_STATUS.CONNECTING ||
    wsStatus === WS_CONNECTION_STATUS.UNAVAILABLE
  ) {
    return HEALTH_STATUS.DEGRADED;
  }

  if (wsPingMs === null || wsPingMs >= PING_THRESHOLDS.wsDegradedMs) {
    return HEALTH_STATUS.DEGRADED;
  }

  if (
    restCheck.timedOut ||
    restCheck.errorType === 'rate_limit' ||
    restCheck.status !== 'healthy' ||
    dbCheck.timedOut ||
    dbCheck.status !== 'healthy' ||
    messageCheck.status === 'degraded' ||
    messageCheck.status === 'unavailable'
  ) {
    return HEALTH_STATUS.DEGRADED;
  }

  return HEALTH_STATUS.HEALTHY;
}

/**
 * Collects live connection diagnostics and system resource metrics without throwing on partial failures.
 * @param {{
 *   client?: import('discord.js').Client | null,
 *   prisma?: import('@prisma/client').PrismaClient | null,
 *   messageLatencyMs?: number | null,
 *   restProbe?: Function,
 *   dbProbe?: Function,
 *   restTimeoutMs?: number,
 *   dbTimeoutMs?: number,
 *   minCpuSampleWindowMs?: number,
 * }} [options]
 */
export async function collectPingDiagnostics(options = {}) {
  const {
    client = null,
    prisma = null,
    messageLatencyMs = null,
    restProbe = null,
    dbProbe = null,
    restTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    dbTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    minCpuSampleWindowMs = DEFAULT_CPU_SAMPLE_WINDOW_MS,
  } = options;

  const cpuStart = process.cpuUsage();
  const wallStartNs = process.hrtime.bigint();

  const [restResult, dbResult] = await Promise.allSettled([
    measureDiscordRestLatency(client, { restProbe, timeoutMs: restTimeoutMs }),
    measurePrismaDbLatency(prisma, { dbProbe, timeoutMs: dbTimeoutMs }),
  ]);

  // Ensure a valid non-blocking measurement interval for process.cpuUsage()
  const elapsedAfterProbesMs = Number(process.hrtime.bigint() - wallStartNs) / 1_000_000;
  if (minCpuSampleWindowMs > 0 && elapsedAfterProbesMs < minCpuSampleWindowMs) {
    await delay(Math.ceil(minCpuSampleWindowMs - elapsedAfterProbesMs));
  }

  const { cpuPercent, sampleWindowMs } = computeCpuIntervalPercent(cpuStart, wallStartNs);
  const wsState = inspectWebSocketState(client);

  const normalizedMessageLatencyMs =
    typeof messageLatencyMs === 'number' && Number.isFinite(messageLatencyMs) && messageLatencyMs >= 0
      ? Math.round(messageLatencyMs)
      : null;

  const messageCheck = {
    latencyMs: normalizedMessageLatencyMs,
    status:
      normalizedMessageLatencyMs === null
        ? 'unavailable'
        : classifyLatency(normalizedMessageLatencyMs, PING_THRESHOLDS.messageDegradedMs),
  };

  let restCheck;
  if (restResult.status === 'fulfilled') {
    restCheck = {
      latencyMs: restResult.value,
      status: classifyLatency(restResult.value, PING_THRESHOLDS.restDegradedMs),
      timedOut: false,
      errorType: null,
    };
  } else {
    const classified = classifyRestError(restResult.reason);
    restCheck = {
      latencyMs: null,
      status: classified.status,
      timedOut: classified.timedOut,
      errorType: classified.errorType,
    };
  }

  let dbCheck;
  if (dbResult.status === 'fulfilled') {
    dbCheck = {
      latencyMs: dbResult.value,
      status: classifyLatency(dbResult.value, PING_THRESHOLDS.dbDegradedMs),
      timedOut: false,
      errorType: null,
    };
  } else {
    const timedOut = dbResult.reason?.code === 'PROBE_TIMEOUT';
    dbCheck = {
      latencyMs: null,
      status: timedOut ? 'degraded' : 'unavailable',
      timedOut,
      errorType: timedOut ? 'timeout' : 'disconnected',
    };
  }

  const wsCheck = {
    latencyMs: wsState.pingMs,
    connectionState: wsState.connectionState,
    clientReady: wsState.clientReady,
    status:
      wsState.connectionState === WS_CONNECTION_STATUS.CONNECTED
        ? wsState.pingMs === null
          ? 'degraded'
          : classifyLatency(wsState.pingMs, PING_THRESHOLDS.wsDegradedMs)
        : wsState.connectionState === WS_CONNECTION_STATUS.CONNECTING ||
            wsState.connectionState === WS_CONNECTION_STATUS.UNAVAILABLE
          ? 'degraded'
          : 'unavailable',
  };

  const overallStatus = evaluateHealthStatus({
    clientReady: wsState.clientReady,
    wsStatus: wsState.connectionState,
    wsPingMs: wsState.pingMs,
    restCheck,
    dbCheck,
    messageCheck,
  });

  const memoryUsage = process.memoryUsage();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const { guildCount, memberCount, isMemberEstimate } = collectGuildStats(client);

  const mainLatencyMs =
    wsCheck.latencyMs ?? restCheck.latencyMs ?? messageCheck.latencyMs ?? null;
  const mainLatencySource =
    wsCheck.latencyMs !== null
      ? 'WebSocket'
      : restCheck.latencyMs !== null
        ? 'REST API'
        : messageCheck.latencyMs !== null
          ? 'Message'
          : 'Unavailable';

  return {
    overallStatus,
    mainLatencyMs,
    mainLatencySource,
    checks: {
      message: messageCheck,
      ws: wsCheck,
      rest: restCheck,
      database: dbCheck,
    },
    system: {
      memoryRssBytes: memoryUsage.rss,
      cpuPercent,
      cpuSampleWindowMs: sampleWindowMs,
      uptimeMs,
      guildCount,
      memberCount,
      isMemberEstimate,
      nodeVersion: process.version,
      discordJsVersion: `v${discordJsVersion}`,
    },
    checkedAt: new Date(),
  };
}

const OVERALL_META = Object.freeze({
  [HEALTH_STATUS.HEALTHY]: Object.freeze({
    emoji: '🟢',
    label: 'Healthy',
    color: COLORS.SUCCESS,
  }),
  [HEALTH_STATUS.DEGRADED]: Object.freeze({
    emoji: '🟡',
    label: 'Degraded',
    color: COLORS.WARNING,
  }),
  [HEALTH_STATUS.UNHEALTHY]: Object.freeze({
    emoji: '🔴',
    label: 'Unhealthy',
    color: COLORS.ERROR,
  }),
});

const STATUS_BADGE = Object.freeze({
  healthy: '🟢',
  degraded: '🟡',
  unavailable: '🔴',
});

function formatWsMainLatency(wsCheck) {
  if (wsCheck.latencyMs !== null) {
    return `\`${wsCheck.latencyMs} ms\``;
  }
  if (wsCheck.connectionState === WS_CONNECTION_STATUS.CONNECTED) {
    return '`Awaiting heartbeat`';
  }
  if (wsCheck.connectionState === WS_CONNECTION_STATUS.CONNECTING) {
    return '`Connecting`';
  }
  if (wsCheck.connectionState === WS_CONNECTION_STATUS.DISCONNECTED) {
    return '`Disconnected`';
  }
  return '`Unavailable`';
}

function formatGatewayLine(wsCheck) {
  const emoji = STATUS_BADGE[wsCheck.status] ?? '🔴';
  if (wsCheck.connectionState === WS_CONNECTION_STATUS.CONNECTED) {
    return `${emoji} **Gateway:** \`Connected\``;
  }
  if (wsCheck.connectionState === WS_CONNECTION_STATUS.CONNECTING) {
    return `${emoji} **Gateway:** \`Connecting\``;
  }
  if (wsCheck.connectionState === WS_CONNECTION_STATUS.DISCONNECTED) {
    return `${emoji} **Gateway:** \`Disconnected\``;
  }
  return `${emoji} **Gateway:** \`Unavailable\``;
}

function formatCheckLine(label, check) {
  const emoji = STATUS_BADGE[check.status] ?? '🔴';
  if (check.latencyMs === null) {
    if (check.timedOut) return `${emoji} **${label}:** \`Timeout\``;
    if (check.errorType === 'rate_limit') return `${emoji} **${label}:** \`Rate Limited\``;
    if (check.errorType === 'http_error') return `${emoji} **${label}:** \`HTTP Error\``;
    if (check.errorType === 'network_error') return `${emoji} **${label}:** \`Network Error\``;
    if (check.errorType === 'disconnected') return `${emoji} **${label}:** \`Disconnected\``;
    return `${emoji} **${label}:** \`Unavailable\``;
  }
  return `${emoji} **${label}:** \`${check.latencyMs} ms\``;
}

function formatCompactFooter(requester, uptimeMs) {
  const uptimeText = `Uptime: ${formatUptime(uptimeMs)}`;
  const rawName = requester?.globalName || requester?.username || 'Midwave User';
  const cleanName =
    String(rawName).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 64) || 'Midwave User';
  const iconURL =
    typeof requester?.displayAvatarURL === 'function'
      ? requester.displayAvatarURL({ extension: 'png', size: 64 })
      : undefined;

  const text = `${uptimeText} • Requested by ${cleanName}`;
  return iconURL ? { text, iconURL } : { text };
}

/**
 * Parses a ping Refresh button customId (`ping:refresh` or `ping:refresh:<ownerId>`).
 * @param {string} customId
 * @returns {{ valid: boolean, ownerId: string | null }}
 */
export function parsePingRefreshCustomId(customId) {
  if (customId === PING_REFRESH_CUSTOM_ID) {
    return { valid: true, ownerId: null };
  }
  if (typeof customId === 'string' && customId.startsWith(`${PING_REFRESH_CUSTOM_ID}:`)) {
    const ownerId = customId.slice(`${PING_REFRESH_CUSTOM_ID}:`.length).trim();
    return { valid: ownerId.length > 0, ownerId: ownerId || null };
  }
  return { valid: false, ownerId: null };
}

/**
 * Builds the initial Midwave-blue embed shown briefly while probes are executing.
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildPingCheckingEmbed() {
  return createBaseEmbed({
    title: 'MIDWAVE — PONG!',
    description: '🔄 **Checking connection diagnostics...**',
    color: COLORS.PRIMARY,
    includeThumbnail: false,
    timestamp: true,
  });
}

/**
 * Builds the compact, minimalist Midwave Ping & Connection Diagnostics embed.
 * Displays only overall status, WebSocket latency, 2-column connection diagnostics, uptime, requester, and timestamp.
 * @param {Awaited<ReturnType<typeof collectPingDiagnostics>>} report
 * @param {{ requester?: import('discord.js').User | null, includeThumbnail?: boolean }} [options]
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildPingEmbed(report, { requester = null, includeThumbnail = true } = {}) {
  const overallMeta = OVERALL_META[report.overallStatus] ?? OVERALL_META[HEALTH_STATUS.UNHEALTHY];
  const wsMainText = formatWsMainLatency(report.checks.ws);

  const descriptionLines = [
    `**Status:** ${overallMeta.emoji} **${overallMeta.label}**`,
    `**WebSocket:** **${wsMainText}**`,
  ];

  const leftColumn = [
    formatCheckLine('Message', report.checks.message),
    formatCheckLine('REST API', report.checks.rest),
  ].join('\n');

  const rightColumn = [
    formatCheckLine('Database', report.checks.database),
    formatGatewayLine(report.checks.ws),
  ].join('\n');

  const embed = createBaseEmbed({
    title: 'MIDWAVE — PONG!',
    description: descriptionLines.join('\n'),
    color: overallMeta.color,
    includeThumbnail,
    footer: formatCompactFooter(requester, report.system.uptimeMs),
    timestamp: report.checkedAt ?? true,
  });

  embed.addFields(
    {
      name: '📡 Connection Diagnostics',
      value: leftColumn,
      inline: true,
    },
    {
      name: '\u200B',
      value: rightColumn,
      inline: true,
    },
  );

  return embed;
}

/**
 * Builds the interactive Refresh button row for `/ping` and `!ping`.
 * @param {{ disabled?: boolean, requesterId?: string | null }} [options]
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildPingComponents({ disabled = false, requesterId = null } = {}) {
  const customId = requesterId ? `${PING_REFRESH_CUSTOM_ID}:${requesterId}` : PING_REFRESH_CUSTOM_ID;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}
