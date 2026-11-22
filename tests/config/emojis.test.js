import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMOJI_FALLBACKS,
  EMOJI_IDS,
  EMOJI_NAMES,
  EMOJIS,
  getComponentEmoji,
  getEmoji,
  getEmojiValidationStatus,
  hasCustomEmojisAvailable,
  resetEmojiValidationCache,
  setEmojiAvailability,
  validateApplicationEmojis,
} from '../../src/config/emojis.js';
import readyEvent from '../../src/events/ready.js';
import '../../src/handlers/PrefixCommandHandler.js';
import guildCreateEvent, { buildBotJoinEmbed } from '../../src/events/guildCreate.js';
import { buildErrorEmbed, buildSuccessEmbed, buildWarningEmbed } from '../../src/utils/embeds.js';
import { buildDynamicHelpEmbed, buildHelpCategoryMenu } from '../../src/services/helpService.js';
import { buildWebSearchEmbed } from '../../src/utils/aiFormatter.js';
import {
  formatDownloadErrorMessage,
  formatDownloadProcessingMessage,
  formatDownloadSuccessMessage,
} from '../../src/utils/downloadFormatter.js';
import { buildPinterestActionRow } from '../../src/utils/pinterestEmbed.js';
import { buildLyricsEmbed, buildLyricsPaginationRow } from '../../src/utils/lyricsFormatter.js';
import { buildAnimeComponents, buildAnimeEmbed, buildAnimeLoadingEmbed } from '../../src/utils/animeEmbed.js';
import {
  HEALTH_STATUS,
  buildPingCheckingEmbed,
  buildPingComponents,
  buildPingEmbed,
} from '../../src/services/pingService.js';
import { buildServersEmbed, buildServersPaginationRow } from '../../src/services/serversService.js';
import { buildWeatherEmbed } from '../../src/services/weatherService.js';
import {
  buildFeedbackPromptComponents,
  buildFeedbackPromptEmbed,
  buildFeedbackReportEmbed,
} from '../../src/services/feedbackService.js';
import { buildAboutEmbed } from '../../src/prefixCommands/about.js';

const EXPECTED_EMOJI_KEYS = [
  'success',
  'error',
  'warning',
  'info',
  'loading',
  'refresh',
  'home',
  'search',
  'back',
  'next',
  'add',
  'remove',
  'edit',
  'delete',
  'download',
  'upload',
  'folder',
  'file',
  'users',
  'analytics',
  'calendar',
  'clock',
  'notification',
  'link',
  'ai',
  'calculator',
  'image',
  'video',
  'music',
  'shield',
];

function collectJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

describe('MIDWAVE Custom Application Emoji System', () => {
  afterEach(() => {
    resetEmojiValidationCache();
  });

  it('registers all 30 mw_* emojis with verified unique Discord snowflake IDs and zero placeholders', () => {
    const registeredKeys = Object.keys(EMOJI_IDS);
    assert.equal(registeredKeys.length, 30);
    assert.deepEqual([...registeredKeys].sort(), [...EXPECTED_EMOJI_KEYS].sort());

    const seenIds = new Set();
    for (const key of EXPECTED_EMOJI_KEYS) {
      const id = EMOJI_IDS[key];
      const name = EMOJI_NAMES[key];
      const formatted = EMOJIS[key];
      const fallback = EMOJI_FALLBACKS[key];

      assert.equal(name, `mw_${key}`);
      assert.match(id, /^\d{17,22}$/, `Invalid snowflake ID for ${name}`);
      assert.equal(id.includes('placeholder') || id.includes('00000000000000000'), false);
      assert.equal(seenIds.has(id), false, `Duplicate ID detected for ${name}`);
      seenIds.add(id);

      assert.equal(formatted, `<:mw_${key}:${id}>`);
      assert.ok(typeof fallback === 'string' && fallback.length > 0);
      assert.equal(getEmoji(key), formatted);
      assert.equal(getEmoji(`mw_${key}`), formatted);
      assert.deepEqual(getComponentEmoji(key), { id, name });
    }

    assert.equal(seenIds.size, 30);
    assert.equal(hasCustomEmojisAvailable(), true);
  });

  it('never returns undefined and falls back safely to Unicode when unavailable or validated missing', async () => {
    assert.ok(typeof getEmoji('non_existent_key') === 'string' && getEmoji('non_existent_key').length > 0);
    assert.ok(typeof getEmoji(null) === 'string' && getEmoji(null).length > 0);
    assert.ok(typeof getEmoji(undefined) === 'string' && getEmoji(undefined).length > 0);
    assert.ok(typeof getComponentEmoji('non_existent_key') === 'string');

    assert.equal(getEmoji('success', { useFallback: true }), EMOJI_FALLBACKS.success);
    assert.equal(getComponentEmoji('refresh', { useFallback: true }), EMOJI_FALLBACKS.refresh);

    setEmojiAvailability('ai', false);
    assert.equal(getEmoji('ai'), EMOJI_FALLBACKS.ai);
    assert.equal(getComponentEmoji('ai'), EMOJI_FALLBACKS.ai);
    assert.equal(hasCustomEmojisAvailable(), false);

    setEmojiAvailability('ai', true);
    assert.equal(getEmoji('ai'), EMOJIS.ai);

    // Partial API validation marks missing emojis unavailable without affecting present ones
    const partialCollection = new Map([
      ['1', { id: EMOJI_IDS.success, name: 'mw_success' }],
      ['2', { id: EMOJI_IDS.ai, name: 'mw_ai' }],
    ]);
    const status = await validateApplicationEmojis({
      application: { emojis: { fetch: async () => partialCollection } },
    });
    assert.equal(status.validated, true);
    assert.equal(status.availableCount, 2);
    assert.equal(status.missingKeys.length, 28);
    assert.equal(getEmoji('success'), EMOJIS.success);
    assert.equal(getEmoji('ai'), EMOJIS.ai);
    assert.equal(getEmoji('error'), EMOJI_FALLBACKS.error);
    assert.equal(buildErrorEmbed('Gagal test').toJSON().title, `${EMOJI_FALLBACKS.error} Tidak Dapat Diproses`);

    // Failing API fetch must never crash and keeps valid cache/fallback safely
    resetEmojiValidationCache();
    const logs = [];
    await validateApplicationEmojis(
      { application: { emojis: { fetch: async () => { throw new Error('API down'); } } } },
      { logger: { warn: (...args) => logs.push(args.join(' ')) } },
    );
    assert.equal(logs.length, 1);
    assert.equal(getEmoji('success'), EMOJIS.success);

    // ClientReady runs startup validation gracefully
    readyEvent.execute({ user: { tag: 'Midwave#0001' }, guilds: { cache: new Map() } }, { logger: { warn() {}, error() {} } });
    assert.equal(getEmojiValidationStatus().validated, false);
  });

  it('integrates every single one of the 30 mw_* emoji keys across src/ without placeholders', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    const srcFiles = collectJsFiles(srcDir).filter((f) => !f.endsWith(`${path.sep}config${path.sep}emojis.js`));
    const combinedSrc = srcFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

    for (const key of EXPECTED_EMOJI_KEYS) {
      const pattern = new RegExp(`get(?:Component)?Emoji\\(\\s*['"](?:mw_)?${key}['"]`);
      assert.match(combinedSrc, pattern, `Expected custom emoji "${key}" to be integrated in src/`);
    }

    assert.equal(combinedSrc.includes('EMOJI_ID_PLACEHOLDER'), false);
    assert.equal(combinedSrc.includes('<:mw_ai:>'), false);
  });

  it('renders custom emojis cleanly across status embeds, commands, and UI components', () => {
    assert.equal(buildSuccessEmbed('Done').toJSON().title, `${EMOJIS.success} Berhasil`);
    assert.equal(buildErrorEmbed('Fail').toJSON().title, `${EMOJIS.error} Tidak Dapat Diproses`);
    assert.equal(buildWarningEmbed('Warn').toJSON().title, `${EMOJIS.warning} Peringatan`);

    const helpEmbed = buildDynamicHelpEmbed({ prefix: '!' }).toJSON();
    assert.ok(helpEmbed.fields.some((f) => f.name.startsWith(`${EMOJIS.ai} AI & Knowledge`)));
    assert.ok(helpEmbed.fields.some((f) => f.name.startsWith(`${EMOJIS.users} Social Interactions`)));
    assert.ok(helpEmbed.fields.some((f) => f.name.startsWith(`${EMOJIS.folder} Media & Utilities`)));
    assert.ok(helpEmbed.fields.some((f) => f.name.startsWith(`${EMOJIS.home} General`)));
    assert.ok(helpEmbed.fields.some((f) => f.name.startsWith(`${EMOJIS.info} Information`)));

    const helpMenu = buildHelpCategoryMenu().toJSON();
    assert.equal(helpMenu.components[0].options[1].emoji.id, EMOJI_IDS.ai);

    const aiEmbed = buildWebSearchEmbed({
      description: 'Jawaban AI',
      sources: [{ title: 'Docs', url: 'https://example.com' }],
      fallbackNotice: 'Mode non real-time',
    }).toJSON();
    assert.equal(aiEmbed.title, `${EMOJIS.ai} Midwave AI • Web Search`);
    assert.equal(aiEmbed.fields[0].name, `${EMOJIS.search} Status Pencarian Web`);
    assert.equal(aiEmbed.fields[1].name, `${EMOJIS.link} Sumber:`);

    assert.match(
      formatDownloadSuccessMessage({ author: 'user', platformLabel: 'TikTok', title: 'Clip', fileFormat: 'mp4', totalBytes: 2048 }),
      new RegExp(`^${EMOJIS.success.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(
      formatDownloadProcessingMessage({ platformLabel: 'TikTok', progress: { stage: 'uploading' } }),
      new RegExp(`^${EMOJIS.upload.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(
      formatDownloadProcessingMessage({ platformLabel: 'TikTok', progress: { stage: 'downloading' } }),
      new RegExp(`^${EMOJIS.download.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(
      formatDownloadErrorMessage('Missing URL'),
      new RegExp(`^${EMOJIS.error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Download failed`),
    );

    const pinRow = buildPinterestActionRow({
      currentIndex: 1,
      total: 3,
      pinUrl: 'https://pinterest.com/pin/1',
      sessionId: 's1',
      ownerId: 'u1',
    }).toJSON();
    assert.equal(pinRow.components[0].emoji.id, EMOJI_IDS.back);
    assert.equal(pinRow.components[1].emoji.id, EMOJI_IDS.link);
    assert.equal(pinRow.components[2].emoji.id, EMOJI_IDS.next);

    const lyricsEmbed = buildLyricsEmbed({
      track: { title: 'Song', artist: 'Artist', sourceName: 'LRCLIB', sourceUrl: 'https://lrclib.net' },
      pages: ['La la la'],
      pageIndex: 0,
    }).toJSON();
    assert.equal(lyricsEmbed.title, `${EMOJIS.music} Lyrics Finder`);
    const lyricsRow = buildLyricsPaginationRow({ currentPage: 1, totalPages: 3 }).toJSON();
    assert.equal(lyricsRow.components[0].emoji.id, EMOJI_IDS.back);
    assert.equal(lyricsRow.components[2].emoji.id, EMOJI_IDS.next);

    const animeLoading = buildAnimeLoadingEmbed('Frieren').toJSON();
    assert.equal(animeLoading.title, `${EMOJIS.search} Mencari Informasi Anime...`);
    assert.ok(animeLoading.description.startsWith(EMOJIS.loading));

    const animeEmbed = buildAnimeEmbed({
      id: 1,
      title: { romaji: 'Frieren', english: 'Frieren' },
      format: 'TV',
      status: 'FINISHED',
      episodes: 28,
      duration: 24,
      seasonYear: 2023,
      startDate: { year: 2023, month: 9, day: 29 },
    }).toJSON();
    assert.equal(animeEmbed.title, `${EMOJIS.video} Frieren`);
    assert.ok(animeEmbed.fields.some((f) => f.name === `${EMOJIS.calendar} Tahun Rilis`));
    assert.ok(animeEmbed.fields.some((f) => f.name === `${EMOJIS.clock} Durasi Episode`));
    const animeRows = buildAnimeComponents({
      anime: { siteUrl: 'https://anilist.co/anime/1', trailer: { url: 'https://youtube.com/watch?v=123' } },
    }).map((r) => r.toJSON());
    assert.equal(animeRows[0].components[0].emoji.id, EMOJI_IDS.link);
    assert.equal(animeRows[0].components[1].emoji.id, EMOJI_IDS.video);

    const weatherEmbed = buildWeatherEmbed({
      location: { kotkab: 'Jakarta' },
      current: { weather_desc: 'Cerah', t: 31, hu: 65, ws: 10, tcc: 20 },
      upcoming: [{ local_datetime: '2026-11-22 18:00:00', weather_desc: 'Cerah Berawan', t: 29, hu: 70 }],
    }).toJSON();
    assert.ok(weatherEmbed.title.startsWith('☀️ Prakiraan Cuaca'));
    assert.ok(weatherEmbed.fields.some((f) => f.name === `${EMOJIS.clock} Waktu Prakiraan`));
    assert.ok(weatherEmbed.fields.some((f) => f.name === `${EMOJIS.calendar} Prakiraan Berikutnya (Per 3 Jam)`));

    const pingChecking = buildPingCheckingEmbed().toJSON();
    assert.ok(pingChecking.description.startsWith(EMOJIS.loading));
    const pingEmbed = buildPingEmbed({
      overallStatus: HEALTH_STATUS.HEALTHY,
      checks: {
        ws: { status: 'healthy', latencyMs: 40, connectionState: 'connected' },
        message: { status: 'healthy', latencyMs: 12 },
        rest: { status: 'healthy', latencyMs: 30 },
        database: { status: 'healthy', latencyMs: 4 },
      },
      system: { uptimeMs: 60_000 },
    }).toJSON();
    assert.ok(pingEmbed.description.includes(EMOJIS.success));
    assert.equal(pingEmbed.fields[0].name, `${EMOJIS.analytics} Connection Diagnostics`);
    const pingRow = buildPingComponents().toJSON();
    assert.equal(pingRow.components[0].emoji.id, EMOJI_IDS.refresh);

    const serversEmbed = buildServersEmbed({
      items: [{ id: '1', name: 'Guild One', memberCount: 10, iconUrl: null }],
      totalServers: 1,
      totalMembers: 10,
      currentPage: 0,
      totalPages: 2,
      startIndex: 0,
    }).toJSON();
    assert.equal(serversEmbed.title, `${EMOJIS.users} Midwave — Server List`);
    const serversRow = buildServersPaginationRow({ currentPage: 1, totalPages: 2, ownerId: '1' }).toJSON();
    assert.equal(serversRow.components[0].emoji.id, EMOJI_IDS.back);
    assert.equal(serversRow.components[1].emoji.id, EMOJI_IDS.next);

    const joinEmbed = buildBotJoinEmbed({ name: 'Test Guild' }).toJSON();
    assert.ok(joinEmbed.description.includes(`${EMOJIS.ai} **AI:**`));
    assert.ok(joinEmbed.title.includes('👋'));

    const feedbackPrompt = buildFeedbackPromptEmbed({ attachmentUrl: 'https://cdn.discordapp.com/a.png' }).toJSON();
    assert.ok(feedbackPrompt.description.includes(EMOJIS.image));
    const feedbackComps = buildFeedbackPromptComponents('p1', 'u1')[0].toJSON();
    assert.equal(feedbackComps.components[0].options[3].emoji.id, EMOJI_IDS.warning);
    const feedbackReport = buildFeedbackReportEmbed({
      reportId: 'MW-1',
      category: 'other',
      subject: 'Issue',
      description: 'Details',
      reporterTag: 'user#1',
      reporterId: '1',
      guildName: 'Guild',
      guildId: '2',
    }).toJSON();
    assert.ok(feedbackReport.title.startsWith(EMOJIS.notification));

    // Guardrail: !about remains minimalist without extra custom emoji icons
    const aboutJson = buildAboutEmbed({ user: { username: 'Midwave', displayAvatarURL: () => 'https://example.com/a.png' } }).toJSON();
    assert.equal(aboutJson.title, undefined);
    assert.equal(aboutJson.author.name, 'Midwave');
    assert.equal(aboutJson.description.includes('<:mw_'), false);
  });
});
