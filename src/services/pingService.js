import os from 'node:os';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Routes,
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
  UNAVAILABLE: 'unavailable',
});

export const PING_THRESHOLDS = Object.freeze({
  wsDegradedMs: 250,
  restDegradedMs: 500,
  dbDegradedMs: 250,
  messageDegradedMs: 600,
});

const DEFAULT_PROBE_TIMEOUT_MS = 4000;

/**
 * Runs an async probe with a hard timeout that cleans up its timer on completion.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
async function runWithTimeout(fn, timeoutMs) {
  let timerId = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timerId = setTimeout(() => {
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
 * Computes normalized process CPU usage percentage.
 * Uses the diagnostic probe window when long enough; otherwise falls back to process-lifetime CPU average.
 * @param {NodeJS.CpuUsage} cpuStart
 * @param {bigint} wallStartNs
 * @returns {number}
 */
export function computeCpuUsagePercent(cpuStart, wallStartNs) {
  const cpuCores = Math.max(1, os.cpus()?.length || 1);
  const elapsedUs = Number(process.hrtime.bigint() - wallStartNs) / 1000;

  if (elapsedUs >= 20_000) {
    const delta = process.cpuUsage(cpuStart);
    const totalCpuUs = Math.max(0, delta.user + delta.system);
    const pct = (totalCpuUs / (elapsedUs * cpuCores)) * 100;
    return Number(Math.min(100, Math.max(0, pct)).toFixed(1));
  }

  const processUptimeUs = Math.max(1, process.uptime() * 1_000_000);
  const current = process.cpuUsage();
  const totalCpuUs = Math.max(0, current.user + current.system);
  const pct = (totalCpuUs / (processUptimeUs * cpuCores)) * 100;
  return Number(Math.min(100, Math.max(0, pct)).toFixed(1));
}

function classifyLatency(latencyMs, degradedThresholdMs) {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return HEALTH_STATUS.UNAVAILABLE;
  }
  return latencyMs >= degradedThresholdMs ? HEALTH_STATUS.DEGRADED : HEALTH_STATUS.HEALTHY;
}

function collectGuildStats(client) {
  const cache = client?.guilds?.cache;
  if (!cache || typeof cache.size !== 'number') {
    return { guildCount: 0, memberCount: 0 };
  }

  let memberCount = 0;
  for (const guild of cache.values()) {
    const count = guild?.memberCount ?? guild?.members?.cache?.size ?? 0;
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
      memberCount += count;
    }
  }

  return {
    guildCount: cache.size,
    memberCount,
  };
}

async function measureDiscordRestLatency(client, { restProbe, timeoutMs }) {
  const start = performance.now();
  if (typeof restProbe === 'function') {
    await runWithTimeout(() => restProbe(client), timeoutMs);
    return Math.max(0, Math.round(performance.now() - start));
  }

  if (typeof client?.rest?.get === 'function') {
    await runWithTimeout(() => client.rest.get(Routes.gateway()), timeoutMs);
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
 * Evaluates overall health status from collected connection probe results.
 * @param {{
 *   messageLatencyMs: number | null,
 *   wsPingMs: number | null,
 *   restLatencyMs: number | null,
 *   dbLatencyMs: number | null,
 * }} metrics
 * @returns {'healthy' | 'degraded' | 'unavailable'}
 */
export function evaluateHealthStatus({ messageLatencyMs, wsPingMs, restLatencyMs, dbLatencyMs }) {
  const wsStatus = classifyLatency(wsPingMs, PING_THRESHOLDS.wsDegradedMs);
  const restStatus = classifyLatency(restLatencyMs, PING_THRESHOLDS.restDegradedMs);
  const dbStatus = classifyLatency(dbLatencyMs, PING_THRESHOLDS.dbDegradedMs);
  const msgStatus =
    messageLatencyMs === null
      ? HEALTH_STATUS.HEALTHY
      : classifyLatency(messageLatencyMs, PING_THRESHOLDS.messageDegradedMs);

  const discordUnavailable =
    wsStatus === HEALTH_STATUS.UNAVAILABLE && restStatus === HEALTH_STATUS.UNAVAILABLE;
  const allCoreUnavailable =
    discordUnavailable && dbStatus === HEALTH_STATUS.UNAVAILABLE;

  if (discordUnavailable || allCoreUnavailable) {
    return HEALTH_STATUS.UNAVAILABLE;
  }

  const statuses = [wsStatus, restStatus, dbStatus, msgStatus];
  if (statuses.includes(HEALTH_STATUS.UNAVAILABLE) || statuses.includes(HEALTH_STATUS.DEGRADED)) {
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
  } = options;

  const cpuStart = process.cpuUsage();
  const wallStartNs = process.hrtime.bigint();

  const [restResult, dbResult] = await Promise.allSettled([
    measureDiscordRestLatency(client, { restProbe, timeoutMs: restTimeoutMs }),
    measurePrismaDbLatency(prisma, { dbProbe, timeoutMs: dbTimeoutMs }),
  ]);

  const rawWsPing = client?.ws?.ping;
  const wsPingMs =
    typeof rawWsPing === 'number' && Number.isFinite(rawWsPing) && rawWsPing >= 0
      ? Math.round(rawWsPing)
      : null;

  const restLatencyMs = restResult.status === 'fulfilled' ? restResult.value : null;
  const dbLatencyMs = dbResult.status === 'fulfilled' ? dbResult.value : null;

  const normalizedMessageLatencyMs =
    typeof messageLatencyMs === 'number' && Number.isFinite(messageLatencyMs) && messageLatencyMs >= 0
      ? Math.round(messageLatencyMs)
      : null;

  const restTimedOut = restResult.status === 'rejected' && restResult.reason?.code === 'PROBE_TIMEOUT';
  const dbTimedOut = dbResult.status === 'rejected' && dbResult.reason?.code === 'PROBE_TIMEOUT';

  const memoryUsage = process.memoryUsage();
  const cpuPercent = computeCpuUsagePercent(cpuStart, wallStartNs);
  const uptimeMs =
    typeof client?.uptime === 'number' && Number.isFinite(client.uptime) && client.uptime >= 0
      ? client.uptime
      : Math.round(process.uptime() * 1000);

  const { guildCount, memberCount } = collectGuildStats(client);

  const checks = {
    message: {
      latencyMs: normalizedMessageLatencyMs,
      status:
        normalizedMessageLatencyMs === null
          ? HEALTH_STATUS.UNAVAILABLE
          : classifyLatency(normalizedMessageLatencyMs, PING_THRESHOLDS.messageDegradedMs),
    },
    ws: {
      latencyMs: wsPingMs,
      status: classifyLatency(wsPingMs, PING_THRESHOLDS.wsDegradedMs),
    },
    rest: {
      latencyMs: restLatencyMs,
      status: classifyLatency(restLatencyMs, PING_THRESHOLDS.restDegradedMs),
      timedOut: restTimedOut,
    },
    database: {
      latencyMs: dbLatencyMs,
      status: classifyLatency(dbLatencyMs, PING_THRESHOLDS.dbDegradedMs),
      timedOut: dbTimedOut,
    },
  };

  const overallStatus = evaluateHealthStatus({
    messageLatencyMs: normalizedMessageLatencyMs,
    wsPingMs,
    restLatencyMs,
    dbLatencyMs,
  });

  const mainLatencyMs = wsPingMs ?? restLatencyMs ?? normalizedMessageLatencyMs ?? null;
  const mainLatencySource =
    wsPingMs !== null
      ? 'WebSocket'
      : restLatencyMs !== null
        ? 'REST API'
        : normalizedMessageLatencyMs !== null
          ? 'Message'
          : 'Unavailable';

  return {
    overallStatus,
    mainLatencyMs,
    mainLatencySource,
    checks,
    system: {
      memoryRssBytes: memoryUsage.rss,
      cpuPercent,
      uptimeMs,
      guildCount,
      memberCount,
      nodeVersion: process.version,
      discordJsVersion: `v${discordJsVersion}`,
    },
    checkedAt: new Date(),
  };
}

const STATUS_META = Object.freeze({
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
  [HEALTH_STATUS.UNAVAILABLE]: Object.freeze({
    emoji: '🔴',
    label: 'Unavailable',
    color: COLORS.ERROR,
  }),
});

function formatCheckLine(label, check) {
  const meta = STATUS_META[check.status] ?? STATUS_META[HEALTH_STATUS.UNAVAILABLE];
  if (check.latencyMs === null) {
    const reason = check.timedOut ? 'Timeout' : 'Unavailable';
    return `${meta.emoji} **${label}:** \`${reason}\``;
  }
  return `${meta.emoji} **${label}:** \`${check.latencyMs} ms\``;
}

function formatRequesterFooter(requester) {
  if (!requester) {
    return { text: 'Requested by Midwave User' };
  }
  const rawName = requester.globalName || requester.username || 'Midwave User';
  const cleanName = String(rawName).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 64) || 'Midwave User';
  const iconURL =
    typeof requester.displayAvatarURL === 'function'
      ? requester.displayAvatarURL({ extension: 'png', size: 64 })
      : undefined;

  return iconURL ? { text: `Requested by ${cleanName}`, iconURL } : { text: `Requested by ${cleanName}` };
}

/**
 * Builds the initial Midwave-blue embed shown briefly while probes are executing.
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildPingCheckingEmbed() {
  return createBaseEmbed({
    title: 'MIDWAVE — CONNECTION DIAGNOSTICS',
    description: '🔄 **Mengukur latensi koneksi dan kesehatan sistem...**',
    color: COLORS.PRIMARY,
    includeThumbnail: false,
    timestamp: true,
  });
}

/**
 * Builds the clean Midwave Ping & Connection Diagnostics embed.
 * @param {Awaited<ReturnType<typeof collectPingDiagnostics>>} report
 * @param {{ requester?: import('discord.js').User | null, includeThumbnail?: boolean }} [options]
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildPingEmbed(report, { requester = null, includeThumbnail = true } = {}) {
  const overallMeta = STATUS_META[report.overallStatus] ?? STATUS_META[HEALTH_STATUS.UNAVAILABLE];
  const mainLatencyText =
    report.mainLatencyMs !== null
      ? `\`${report.mainLatencyMs} ms\` (${report.mainLatencySource})`
      : '`Unavailable`';

  const descriptionLines = [
    `**Overall Status:** ${overallMeta.emoji} **${overallMeta.label}**`,
    `**Main Latency:** ${mainLatencyText}`,
  ];

  const connectionLines = [
    formatCheckLine('Message Response', report.checks.message),
    formatCheckLine('Discord WebSocket', report.checks.ws),
    formatCheckLine('Discord REST API', report.checks.rest),
    formatCheckLine('Database (Prisma)', report.checks.database),
  ];

  const systemLines = [
    `• **Memory (RSS):** \`${formatMemoryMb(report.system.memoryRssBytes)}\``,
    `• **CPU Usage:** \`${report.system.cpuPercent.toFixed(1)}%\``,
    `• **Bot Uptime:** \`${formatUptime(report.system.uptimeMs)}\``,
    `• **Guilds / Members:** \`${report.system.guildCount.toLocaleString('en-US')}\` guilds / \`~${report.system.memberCount.toLocaleString('en-US')}\` members`,
    `• **Runtime:** \`Node.js ${report.system.nodeVersion}\` • \`discord.js ${report.system.discordJsVersion}\``,
  ];

  const embed = createBaseEmbed({
    title: 'MIDWAVE — CONNECTION DIAGNOSTICS',
    description: descriptionLines.join('\n'),
    color: overallMeta.color,
    includeThumbnail,
    footer: formatRequesterFooter(requester),
    timestamp: report.checkedAt ?? true,
  });

  embed.addFields(
    {
      name: '📡 Connection Diagnostics',
      value: connectionLines.join('\n'),
      inline: false,
    },
    {
      name: '⚙️ System Information',
      value: systemLines.join('\n'),
      inline: false,
    },
  );

  return embed;
}

/**
 * Builds the interactive Refresh button row for `/ping` and `!ping`.
 * @param {{ disabled?: boolean }} [options]
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
export function buildPingComponents({ disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(PING_REFRESH_CUSTOM_ID)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}
