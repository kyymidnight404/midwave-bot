import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import animeCommand, { data as animeData, execute as executeAnime } from '../../src/commands/anime.js';
import animePrefixCommand, { execute as executePrefixAnime } from '../../src/commands/prefix/anime.js';
import { createBotApp } from '../../src/index.js';
import {
  ANILIST_GRAPHQL_ENDPOINT,
  ANIME_COOLDOWN_MS,
  ANIME_MAX_QUERY_LENGTH,
  AnimeCache,
  AnimeServiceError,
  cleanAnimeSynopsis,
  parseAniListMedia,
  parseAnimeTrailer,
  searchAnime,
  truncateSynopsis,
  validateAnimeQuery,
} from '../../src/services/animeService.js';
import {
  buildAnimeComponents,
  buildAnimeEmbed,
  buildAnimeLoadingEmbed,
  formatAnimeStartDate,
} from '../../src/utils/animeEmbed.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

function createFakeReplyMessage() {
  const collector = new EventEmitter();
  return {
    id: 'msg-anime-1',
    edits: [],
    async edit(payload) {
      this.edits.push(payload);
      return this;
    },
    createMessageComponentCollector(options) {
      collector.options = options;
      return collector;
    },
    getCollector: () => collector,
  };
}

function createMockAnimeInteraction({
  query = '',
  userId = 'u-anime-1',
  username = 'kyy',
  bot = false,
} = {}) {
  const events = [];
  const replyMessage = createFakeReplyMessage();

  return {
    id: 'int-anime-1',
    commandName: 'anime',
    user: {
      id: userId,
      username,
      globalName: username,
      bot,
    },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => null,
      getString: (name) => (name === 'query' ? query : null),
    },
    async deferReply(payload = {}) {
      this.deferred = true;
      events.push({ type: 'deferReply', payload });
    },
    async reply(payload) {
      this.replied = true;
      events.push({ type: 'reply', payload });
      return payload;
    },
    async editReply(payload) {
      events.push({ type: 'editReply', payload });
      return replyMessage;
    },
    getEvents: () => events,
    getReplyMessage: () => replyMessage,
  };
}

function createMockSelectInteraction({ customId, values = ['0'], userId = 'u-anime-1' }) {
  const events = [];
  return {
    customId,
    values,
    user: { id: userId },
    async reply(payload) {
      events.push({ type: 'reply', payload });
      return payload;
    },
    async update(payload) {
      events.push({ type: 'update', payload });
      return payload;
    },
    getEvents: () => events,
  };
}

function createMockJsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    async json() {
      return body;
    },
  };
}

const SAMPLE_FRIEREN_MEDIA = {
  id: 154587,
  title: {
    romaji: 'Sousou no Frieren',
    english: "Frieren: Beyond Journey's End",
    native: '葬送のフリーレン',
  },
  coverImage: {
    large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx154587.jpg',
  },
  description:
    'The adventure is over but life goes on for an elf mage just beginning to learn what living is all about.<br><br><i>Source: Crunchyroll</i> ~!hidden spoiler!~',
  genres: ['Adventure', 'Drama', 'Fantasy'],
  averageScore: 91,
  seasonYear: 2023,
  episodes: 28,
  status: 'FINISHED',
  format: 'TV',
  duration: 24,
  studios: {
    nodes: [
      { name: 'MADHOUSE', isAnimationStudio: true },
      { name: 'TOHO animation', isAnimationStudio: false },
    ],
  },
  startDate: {
    year: 2023,
    month: 9,
    day: 29,
  },
  trailer: {
    id: 'ZEkwCGJ3o7M',
    site: 'youtube',
  },
  siteUrl: 'https://anilist.co/anime/154587',
};

const SAMPLE_FRIEREN_SEASON_2 = {
  id: 182255,
  title: {
    romaji: 'Sousou no Frieren 2nd Season',
    english: "Frieren: Beyond Journey's End Season 2",
    native: '葬送のフリーレン 第2期',
  },
  coverImage: {
    large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx182255.jpg',
  },
  description: 'Second season of Sousou no Frieren.',
  genres: ['Adventure', 'Drama', 'Fantasy'],
  averageScore: null,
  seasonYear: 2026,
  episodes: null,
  status: 'NOT_YET_RELEASED',
  format: 'TV',
  duration: null,
  studios: {
    nodes: [{ name: 'MADHOUSE', isAnimationStudio: true }],
  },
  startDate: {
    year: 2026,
    month: 1,
    day: null,
  },
  trailer: null,
  siteUrl: 'https://anilist.co/anime/182255',
};

describe('Anime Search (/anime & !anime) via AniList GraphQL', () => {
  it('validates anime query input and cleans/truncates synopsis properly', () => {
    assert.throws(() => validateAnimeQuery(''), (e) => e.code === 'INVALID_QUERY');
    assert.throws(() => validateAnimeQuery('   '), (e) => e.code === 'INVALID_QUERY');
    assert.throws(() => validateAnimeQuery(null), (e) => e.code === 'INVALID_QUERY');
    assert.throws(
      () => validateAnimeQuery('x'.repeat(ANIME_MAX_QUERY_LENGTH + 1)),
      (e) => e.code === 'INVALID_QUERY',
    );
    assert.equal(validateAnimeQuery('  Sousou   no Frieren '), 'Sousou no Frieren');

    const cleaned = cleanAnimeSynopsis('Hello<br>World &amp; Friends ~!secret!~ <i>italic</i>');
    assert.equal(cleaned, 'Hello\nWorld & Friends italic');

    const longSynopsis = 'Word '.repeat(120);
    const truncated = truncateSynopsis(longSynopsis, 120);
    assert.ok(truncated.length <= 120);
    assert.ok(truncated.endsWith('...'));
    assert.equal(truncateSynopsis(''), 'Sinopsis belum tersedia.');
  });

  it('parses all required and optional AniList fields and caches GraphQL search results', async () => {
    const cache = new AnimeCache(60_000, 10);
    const calls = [];

    const mockFetch = async (url, init = {}) => {
      calls.push({ url, init });
      return createMockJsonResponse(200, {
        data: {
          Page: {
            media: [SAMPLE_FRIEREN_MEDIA, SAMPLE_FRIEREN_SEASON_2],
          },
        },
      });
    };

    const first = await searchAnime({ query: 'Frieren' }, { fetchImpl: mockFetch, cache });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ANILIST_GRAPHQL_ENDPOINT);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(first.cached, false);
    assert.equal(first.results.length, 2);

    const top = first.results[0];
    assert.equal(top.id, 154587);
    assert.equal(top.title.romaji, 'Sousou no Frieren');
    assert.equal(top.title.english, "Frieren: Beyond Journey's End");
    assert.equal(top.title.native, '葬送のフリーレン');
    assert.equal(top.coverImage, SAMPLE_FRIEREN_MEDIA.coverImage.large);
    assert.ok(!top.description.includes('<br>'));
    assert.ok(!top.description.includes('hidden spoiler'));
    assert.deepEqual(top.genres, ['Adventure', 'Drama', 'Fantasy']);
    assert.equal(top.averageScore, 91);
    assert.equal(top.seasonYear, 2023);
    assert.equal(top.episodes, 28);
    assert.equal(top.status, 'FINISHED');
    assert.equal(top.format, 'TV');
    assert.equal(top.duration, 24);
    assert.deepEqual(top.studios, ['MADHOUSE']);
    assert.deepEqual(top.startDate, { year: 2023, month: 9, day: 29 });
    assert.deepEqual(top.trailer, {
      id: 'ZEkwCGJ3o7M',
      site: 'youtube',
      url: 'https://www.youtube.com/watch?v=ZEkwCGJ3o7M',
    });
    assert.equal(top.siteUrl, 'https://anilist.co/anime/154587');

    // Second lookup with different casing hits cache without calling fetch
    const second = await searchAnime('frieren', { fetchImpl: mockFetch, cache });
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1);
    assert.equal(second.results[0].id, 154587);

    // Dailymotion trailer helper check
    assert.deepEqual(parseAnimeTrailer({ site: 'dailymotion', id: 'abc123' }), {
      id: 'abc123',
      site: 'dailymotion',
      url: 'https://www.dailymotion.com/video/abc123',
    });
  });

  it('handles anime not found, timeout, rate limit, and API errors cleanly', async () => {
    await assert.rejects(
      () =>
        searchAnime('JudulAnimeTidakAda99999', {
          bypassCache: true,
          fetchImpl: async () =>
            createMockJsonResponse(200, { data: { Page: { media: [] } } }),
        }),
      (err) => err instanceof AnimeServiceError && err.code === 'NOT_FOUND',
    );

    await assert.rejects(
      () =>
        searchAnime('Timeout Anime', {
          bypassCache: true,
          fetchImpl: async () => {
            const err = new Error('Request timed out');
            err.name = 'TimeoutError';
            throw err;
          },
        }),
      (err) => err instanceof AnimeServiceError && err.code === 'TIMEOUT',
    );

    await assert.rejects(
      () =>
        searchAnime('Rate Limit Anime', {
          bypassCache: true,
          fetchImpl: async () => createMockJsonResponse(429, {}, { 'retry-after': '30' }),
        }),
      (err) => err instanceof AnimeServiceError && err.code === 'RATE_LIMITED',
    );

    await assert.rejects(
      () =>
        searchAnime('Server Error Anime', {
          bypassCache: true,
          fetchImpl: async () => createMockJsonResponse(502, {}),
        }),
      (err) => err instanceof AnimeServiceError && err.code === 'API_ERROR',
    );
  });

  it('builds loading embed, full anime embed, and interactive components for ambiguous titles', () => {
    const loading = buildAnimeLoadingEmbed('Naruto').toJSON();
    assert.match(loading.title, /Mencari Informasi Anime/i);
    assert.match(loading.description, /Naruto/);

    const parsed1 = parseAniListMedia(SAMPLE_FRIEREN_MEDIA);
    const parsed2 = parseAniListMedia(SAMPLE_FRIEREN_SEASON_2);
    const embed = buildAnimeEmbed(parsed1, {
      candidates: [parsed1, parsed2],
      selectedIndex: 0,
    }).toJSON();

    assert.equal(embed.title, '🎬 Sousou no Frieren');
    assert.equal(embed.url, 'https://anilist.co/anime/154587');
    assert.equal(embed.thumbnail.url, SAMPLE_FRIEREN_MEDIA.coverImage.large);
    assert.ok(embed.description.includes("Frieren: Beyond Journey's End"));
    assert.ok(embed.description.includes('葬送のフリーレン'));

    const fieldMap = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.equal(fieldMap['🆔 ID Anime'], '`154587`');
    assert.equal(fieldMap['📺 Format'], 'TV Series');
    assert.match(fieldMap['📡 Status'], /Finished/);
    assert.match(fieldMap['⭐ Rating'], /91%/);
    assert.equal(fieldMap['🎞️ Jumlah Episode'], '28 Episode');
    assert.equal(fieldMap['📅 Tahun Rilis'], '2023');
    assert.equal(fieldMap['🏷️ Genre'], 'Adventure, Drama, Fantasy');
    assert.equal(fieldMap['⏱️ Durasi Episode'], '24 menit / eps');
    assert.equal(fieldMap['🏢 Studio'], 'MADHOUSE');
    assert.equal(fieldMap['🗓️ Tanggal Rilis'], '29 Sep 2023');
    assert.equal(fieldMap['🌐 Tautan & Trailer'], undefined);
    assert.equal(
      embed.fields.some((f) => f.name.includes('Hasil Pencarian Terkait')),
      false,
    );

    const rows = buildAnimeComponents({
      anime: parsed1,
      candidates: [parsed1, parsed2],
      selectedIndex: 0,
      customIdPrefix: 'anime:test',
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].toJSON().components[0].custom_id, 'anime:test:select');
    assert.equal(rows[0].toJSON().components[0].options.length, 2);
    assert.equal(rows[1].toJSON().components.length, 2);
    assert.equal(formatAnimeStartDate({ year: 2023, month: 9, day: 29 }), '29 Sep 2023');
  });

  it('executes /anime with loading state, ambiguous title selector, owner guard, and timeout disable', async () => {
    const emptyInt = createMockAnimeInteraction({ query: '   ' });
    await executeAnime(emptyInt);
    assert.equal(emptyInt.getEvents()[0].type, 'reply');
    assert.equal(emptyInt.getEvents()[0].payload.flags, MessageFlags.Ephemeral);

    const parsed1 = parseAniListMedia(SAMPLE_FRIEREN_MEDIA);
    const parsed2 = parseAniListMedia(SAMPLE_FRIEREN_SEASON_2);
    const interaction = createMockAnimeInteraction({ query: 'Frieren', userId: 'u-anime-1' });

    await executeAnime(interaction, {
      searchAnime: async () => ({
        query: 'Frieren',
        results: [parsed1, parsed2],
        cached: false,
      }),
      selectionTimeoutMs: 5_000,
    });

    const events = interaction.getEvents();
    assert.equal(events[0].type, 'deferReply');
    // First editReply is the loading embed
    assert.equal(events[1].type, 'editReply');
    assert.match(events[1].payload.embeds[0].toJSON().title, /Mencari Informasi Anime/i);
    // Second editReply is the final anime embed with selector
    assert.equal(events[2].type, 'editReply');
    assert.equal(events[2].payload.embeds[0].toJSON().title, '🎬 Sousou no Frieren');

    const selectCustomId = events[2].payload.components[0].toJSON().components[0].custom_id;
    const collector = interaction.getReplyMessage().getCollector();

    // Non-owner attempts to change selection -> ephemeral rejection
    const strangerSelect = createMockSelectInteraction({
      customId: selectCustomId,
      values: ['1'],
      userId: 'other-user-99',
    });
    collector.emit('collect', strangerSelect);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(strangerSelect.getEvents()[0].type, 'reply');
    assert.equal(strangerSelect.getEvents()[0].payload.flags, MessageFlags.Ephemeral);

    // Owner selects second candidate -> updates embed to Season 2
    const ownerSelect = createMockSelectInteraction({
      customId: selectCustomId,
      values: ['1'],
      userId: 'u-anime-1',
    });
    collector.emit('collect', ownerSelect);
    await new Promise((r) => setTimeout(r, 10));
    const updatePayload = ownerSelect.getEvents()[0].payload;
    assert.equal(updatePayload.embeds[0].toJSON().title, '🎬 Sousou no Frieren 2nd Season');

    // Collector ends -> disables select menu while keeping link button
    collector.emit('end');
    await new Promise((r) => setTimeout(r, 10));
    const finalEdit = interaction.getEvents().at(-1);
    assert.equal(finalEdit.payload.components[0].toJSON().components[0].disabled, true);
  });

  it('registers /anime and !anime in bot app and enforces shared cooldown', async () => {
    assert.equal(animeData.toJSON().name, 'anime');
    assert.equal(animeCommand.name, 'anime');
    assert.equal(animePrefixCommand.name, 'anime');
    assert.deepEqual(parsePrefixInvocation('!anime Sousou no Frieren'), {
      commandName: 'anime',
      subcommand: null,
      options: { query: 'Sousou no Frieren' },
    });
    assert.ok(parsePrefixInvocation('!anime')?.error);

    let now = 20_000;
    const cooldowns = new CooldownManager(2_000, () => now);
    const app = await createBotApp({ cooldowns });
    assert.ok(app.commandHandler.get('anime'));

    const parsed1 = parseAniListMedia(SAMPLE_FRIEREN_MEDIA);
    const mockSearch = async () => ({
      query: 'Frieren',
      results: [parsed1],
      cached: false,
    });
    app.interactionHandler.context.searchAnime = mockSearch;
    app.prefixCommandHandler.context.searchAnime = mockSearch;

    // 1. Slash /anime succeeds
    const slashInt = createMockAnimeInteraction({ query: 'Frieren', userId: 'u-cd-anime' });
    await app.interactionHandler.handle(slashInt);
    assert.equal(slashInt.getEvents().at(-1).type, 'editReply');
    assert.equal(slashInt.getEvents().at(-1).payload.embeds[0].toJSON().title, '🎬 Sousou no Frieren');

    // 2. Immediate !anime by same user hits 5s cooldown
    now += 2_000;
    const prefixReplies = [];
    const fakeMessage = {
      id: 'msg-pfx-anime-1',
      content: '!anime Frieren',
      author: {
        id: 'u-cd-anime',
        bot: false,
        username: 'kyy',
      },
      guild: {
        id: 'g-1',
        members: { me: { id: 'bot-1' } },
      },
      channel: {
        id: 'ch-1',
        isTextBased: () => true,
        permissionsFor: () =>
          new Set([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
        async sendTyping() {},
      },
      async reply(payload) {
        const msg = createFakeReplyMessage();
        msg.initialPayload = payload;
        prefixReplies.push(msg);
        return msg;
      },
    };

    await app.prefixCommandHandler.handle(fakeMessage);
    assert.equal(prefixReplies.length, 1);
    assert.match(prefixReplies[0].initialPayload.embeds[0].toJSON().description, /Terlalu cepat/i);

    // 3. After cooldown expires -> !anime succeeds (loading embed edited to final embed)
    now += ANIME_COOLDOWN_MS;
    await app.prefixCommandHandler.handle(fakeMessage);
    assert.equal(prefixReplies.length, 2);
    const sentMsg = prefixReplies[1];
    assert.match(sentMsg.initialPayload.embeds[0].toJSON().title, /Mencari Informasi Anime/i);
    assert.equal(sentMsg.edits.at(-1).embeds[0].toJSON().title, '🎬 Sousou no Frieren');

    // Direct raw Message call on prefix/anime.js also works
    const directReplies = [];
    await executePrefixAnime(
      {
        id: 'msg-direct-1',
        content: '!anime Frieren',
        author: { id: 'u-direct', bot: false, username: 'kyy' },
        channel: { sendTyping: async () => {} },
        async reply(payload) {
          const msg = createFakeReplyMessage();
          msg.initialPayload = payload;
          directReplies.push(msg);
          return msg;
        },
      },
      ['Frieren'],
      { searchAnime: mockSearch },
    );
    assert.equal(directReplies.length, 1);
    assert.equal(directReplies[0].edits.at(-1).embeds[0].toJSON().title, '🎬 Sousou no Frieren');

    app.shutdown();
  });
});
