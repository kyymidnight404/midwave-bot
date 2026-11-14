import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import mediaCommand, { data as mediaData } from '../../src/commands/media.js';
import lyricsCommand, { execute as executeLyrics } from '../../src/prefixCommands/lyrics.js';
import { createBotApp } from '../../src/index.js';
import {
  LYRICS_COOLDOWN_MS,
  LYRICS_MAX_QUERY_LENGTH,
  LyricsCache,
  LyricsServiceError,
  pickBestLrclibMatch,
  searchLyrics,
  stripLrcTimestamps,
  validateLyricsInput,
} from '../../src/services/lyricsService.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';
import {
  LYRICS_EMBED_MAX_PAGE_CHARS,
  buildLyricsEmbed,
  buildLyricsPaginationRow,
  paginateLyrics,
} from '../../src/utils/lyricsFormatter.js';

function createFakeReplyMessage() {
  const collector = new EventEmitter();
  return {
    id: 'msg-lyrics-1',
    createMessageComponentCollector(options) {
      collector.options = options;
      return collector;
    },
    getCollector: () => collector,
  };
}

function createMockLyricsInteraction({
  query = '',
  artist = null,
  action = 'lyrics',
  userId = 'u-lyrics-1',
  username = 'kyy',
  bot = false,
} = {}) {
  const events = [];
  const replyMessage = createFakeReplyMessage();

  return {
    id: 'int-lyrics-1',
    commandName: 'media',
    user: {
      id: userId,
      username,
      globalName: username,
      bot,
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/abc.png',
    },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => null,
      getString: (name) => {
        if (name === 'action') return action;
        if (name === 'query') return query;
        if (name === 'artist') return artist;
        return null;
      },
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

function createMockButtonInteraction({ customId, userId = 'u-lyrics-1' }) {
  const events = [];
  return {
    customId,
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

describe('Lyrics Finder service, formatter, and /lyrics command', () => {
  it('validates query and artist inputs cleanly', () => {
    assert.throws(() => validateLyricsInput(''), (e) => e.code === 'INVALID_QUERY');
    assert.throws(() => validateLyricsInput('   \n '), (e) => e.code === 'INVALID_QUERY');
    assert.throws(() => validateLyricsInput(null), (e) => e.code === 'INVALID_QUERY');
    assert.throws(
      () => validateLyricsInput('a'.repeat(LYRICS_MAX_QUERY_LENGTH + 1)),
      (e) => e.code === 'INVALID_QUERY',
    );

    assert.deepEqual(validateLyricsInput('  Love  ', '  wave to earth  '), {
      query: 'Love',
      artist: 'wave to earth',
    });
  });

  it('searches by title only, enriches metadata, and serves subsequent identical queries from TTL cache', async () => {
    const requestedUrls = [];
    const cache = new LyricsCache(60_000, 10);

    const mockFetch = async (url) => {
      requestedUrls.push(url);
      if (url.startsWith('https://lrclib.net/api/search')) {
        return createMockJsonResponse(200, [
          {
            id: 101,
            trackName: 'APT.',
            artistName: 'ROSÉ & Bruno Mars',
            albumName: '',
            instrumental: false,
            plainLyrics: 'Chaeyoung\'s favorite random game\nRandom game',
          },
        ]);
      }
      if (url.startsWith('https://itunes.apple.com/search')) {
        return createMockJsonResponse(200, {
          results: [
            {
              artistName: 'ROSÉ & Bruno Mars',
              collectionName: 'rosie',
              artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/100x100bb.jpg',
              trackViewUrl: 'https://music.apple.com/us/album/apt/123',
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const first = await searchLyrics({ query: 'APT' }, { fetchImpl: mockFetch, cache });
    assert.equal(first.title, 'APT.');
    assert.equal(first.artist, 'ROSÉ & Bruno Mars');
    assert.equal(first.album, 'rosie');
    assert.equal(first.thumbnailUrl, 'https://is1-ssl.mzstatic.com/image/thumb/600x600bb.jpg');
    assert.equal(first.sourceUrl, 'https://music.apple.com/us/album/apt/123');
    assert.match(first.lyrics, /Chaeyoung's favorite random game/);
    assert.equal(first.cached, false);

    const callCountAfterFirst = requestedUrls.length;
    const second = await searchLyrics({ query: 'apt' }, { fetchImpl: mockFetch, cache });
    assert.equal(second.cached, true);
    assert.equal(requestedUrls.length, callCountAfterFirst);
  });

  it('searches by title + artist, strips synced LRC timestamps, and handles optional Genius API metadata without leaking token', async () => {
    const seenHeaders = [];
    const secretToken = 'GENIUS_SECRET_TOKEN_XYZ';

    const mockFetch = async (url, init = {}) => {
      seenHeaders.push(init.headers);
      if (url.includes('track_name=Love') && url.includes('artist_name=wave%20to%20earth')) {
        return createMockJsonResponse(200, [
          {
            id: 33098168,
            trackName: 'wave to earth - love.',
            artistName: 'wave to earth',
            albumName: '0.1 flaws and all.',
            instrumental: false,
            plainLyrics: null,
            syncedLyrics: '[00:12.34] Between people and people\n[00:18.50] Between wind and wind',
          },
        ]);
      }
      if (url.startsWith('https://api.genius.com/search')) {
        return createMockJsonResponse(200, {
          response: {
            hits: [
              {
                type: 'song',
                result: {
                  song_art_image_thumbnail_url: 'https://images.genius.com/cover.jpg',
                  url: 'https://genius.com/Wave-to-earth-love-lyrics',
                },
              },
            ],
          },
        });
      }
      return createMockJsonResponse(200, { results: [] });
    };

    const result = await searchLyrics(
      { query: 'Love', artist: 'wave to earth' },
      { fetchImpl: mockFetch, geniusApiKey: secretToken, bypassCache: true },
    );

    assert.equal(result.title, 'love.');
    assert.equal(result.artist, 'wave to earth');
    assert.equal(result.album, '0.1 flaws and all.');
    assert.equal(result.lyrics, 'Between people and people\nBetween wind and wind');
    assert.equal(result.thumbnailUrl, 'https://images.genius.com/cover.jpg');
    assert.equal(result.sourceUrl, 'https://genius.com/Wave-to-earth-love-lyrics');
    assert.ok(seenHeaders.some((h) => h?.Authorization === `Bearer ${secretToken}`));
  });

  it('handles song not found, instrumental/unavailable lyrics, timeout, rate limit, and API errors cleanly', async () => {
    await assert.rejects(
      () =>
        searchLyrics(
          { query: 'LaguTidakAdaSamaSekali123' },
          {
            bypassCache: true,
            fetchImpl: async () => createMockJsonResponse(200, []),
          },
        ),
      (err) => err instanceof LyricsServiceError && err.code === 'NOT_FOUND',
    );

    await assert.rejects(
      () =>
        searchLyrics(
          { query: 'Instrumental Track' },
          {
            bypassCache: true,
            fetchImpl: async () =>
              createMockJsonResponse(200, [
                {
                  id: 9,
                  trackName: 'Instrumental Track',
                  artistName: 'Artist',
                  instrumental: true,
                  plainLyrics: null,
                  syncedLyrics: null,
                },
              ]),
          },
        ),
      (err) => err instanceof LyricsServiceError && err.code === 'LYRICS_UNAVAILABLE',
    );

    await assert.rejects(
      () =>
        searchLyrics(
          { query: 'Timeout Song' },
          {
            bypassCache: true,
            fetchImpl: async () => {
              const err = new Error('The operation was aborted due to timeout');
              err.name = 'TimeoutError';
              throw err;
            },
          },
        ),
      (err) => err.code === 'TIMEOUT',
    );

    await assert.rejects(
      () =>
        searchLyrics(
          { query: 'Rate Limited Song' },
          {
            bypassCache: true,
            fetchImpl: async () => createMockJsonResponse(429, {}, { 'retry-after': '15' }),
          },
        ),
      (err) => err.code === 'RATE_LIMITED',
    );

    await assert.rejects(
      () =>
        searchLyrics(
          { query: 'Broken Server Song' },
          {
            bypassCache: true,
            fetchImpl: async () => createMockJsonResponse(503, {}),
          },
        ),
      (err) => err.code === 'API_ERROR',
    );
  });

  it('paginates long lyrics cleanly within 4000 chars without splitting words mid-word and builds Midwave embed', () => {
    const verse = 'Line with multiple clear words that should never break in half\n';
    const longLyrics = verse.repeat(90); // ~5,310 chars
    const pages = paginateLyrics(longLyrics, 1500);

    assert.ok(pages.length >= 4);
    for (const page of pages) {
      assert.ok(page.length <= 1500);
      assert.ok(page.length <= LYRICS_EMBED_MAX_PAGE_CHARS);
    }

    // Also test hard word-boundary wrap on a single 120-char line with small limit
    const singleLongLine = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau';
    const wrappedPages = paginateLyrics(singleLongLine, 100);
    assert.ok(wrappedPages.length >= 1);
    assert.ok(!wrappedPages[0].endsWith('epsi'));

    const embedJson = buildLyricsEmbed(
      {
        title: 'Love',
        artist: 'wave to earth',
        album: '0.1 flaws and all.',
        thumbnailUrl: 'https://example.com/cover.jpg',
        sourceName: 'LRCLIB (Info: Apple Music)',
        sourceUrl: 'https://music.apple.com/us/album/love/123',
      },
      {
        pages,
        pageIndex: 0,
        requesterName: 'kyy',
      },
    ).toJSON();

    assert.equal(embedJson.title, '🎵 Lyrics Finder');
    assert.ok(embedJson.description.includes('**Love — wave to earth**'));
    assert.ok(embedJson.description.includes('Album: 0.1 flaws and all.'));
    assert.ok(embedJson.description.includes('Source: [LRCLIB (Info: Apple Music)]'));
    assert.ok(embedJson.description.length <= 4096);
    assert.equal(embedJson.thumbnail.url, 'https://example.com/cover.jpg');
    assert.match(embedJson.footer.text, new RegExp(`Page 1/${pages.length} • Requested by @kyy`));

    const firstRow = buildLyricsPaginationRow({ currentPage: 0, totalPages: pages.length }).toJSON();
    assert.equal(firstRow.components[0].disabled, true);
    assert.equal(firstRow.components[1].label, `Page 1/${pages.length}`);
    assert.equal(firstRow.components[2].disabled, false);

    const lastRow = buildLyricsPaginationRow({
      currentPage: pages.length - 1,
      totalPages: pages.length,
    }).toJSON();
    assert.equal(lastRow.components[0].disabled, false);
    assert.equal(lastRow.components[2].disabled, true);
  });

  it('executes /lyrics with pagination buttons, owner lock, and timeout disable', async () => {
    // 1. Empty query -> ephemeral reply without defer
    const emptyInt = createMockLyricsInteraction({ query: '   ' });
    await executeLyrics(emptyInt);
    const emptyEvents = emptyInt.getEvents();
    assert.equal(emptyEvents[0].type, 'reply');
    assert.equal(emptyEvents[0].payload.flags, MessageFlags.Ephemeral);

    // 2. Valid long lyrics -> deferReply + editReply + Previous/Next + non-owner guard + timeout disable
    const longTrack = {
      title: 'Long Ballad',
      artist: 'Midwave Band',
      album: 'Ocean',
      thumbnailUrl: 'https://example.com/ocean.jpg',
      lyrics: Array.from({ length: 60 }, (_, i) => `Verse line number ${i + 1} with clean words`).join('\n'),
      sourceName: 'LRCLIB',
      sourceUrl: 'https://lrclib.net/api/get/1',
      cached: false,
    };

    const interaction = createMockLyricsInteraction({ query: 'Long Ballad', artist: 'Midwave Band' });
    await executeLyrics(interaction, {
      searchLyrics: async () => longTrack,
      maxCharsPerPage: 600,
      paginationTimeoutMs: 5_000,
    });

    const events = interaction.getEvents();
    assert.equal(events[0].type, 'deferReply');
    assert.equal(events[1].type, 'editReply');
    const initialRow = events[1].payload.components[0].toJSON();
    const prevId = initialRow.components[0].custom_id;
    const nextId = initialRow.components[2].custom_id;
    assert.equal(initialRow.components[0].disabled, true);
    assert.equal(initialRow.components[2].disabled, false);

    const collector = interaction.getReplyMessage().getCollector();

    // Non-owner clicks Next -> ephemeral rejection
    const intruderBtn = createMockButtonInteraction({ customId: nextId, userId: 'stranger-999' });
    collector.emit('collect', intruderBtn);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(intruderBtn.getEvents()[0].type, 'reply');
    assert.equal(intruderBtn.getEvents()[0].payload.flags, MessageFlags.Ephemeral);

    // Owner clicks Next -> advances to Page 2
    const nextBtn = createMockButtonInteraction({ customId: nextId, userId: 'u-lyrics-1' });
    collector.emit('collect', nextBtn);
    await new Promise((r) => setTimeout(r, 10));
    const nextUpdate = nextBtn.getEvents()[0].payload;
    assert.match(nextUpdate.embeds[0].toJSON().footer.text, /^Page 2\//);
    assert.equal(nextUpdate.components[0].toJSON().components[0].disabled, false);

    // Owner clicks Previous -> returns to Page 1
    const prevBtn = createMockButtonInteraction({ customId: prevId, userId: 'u-lyrics-1' });
    collector.emit('collect', prevBtn);
    await new Promise((r) => setTimeout(r, 10));
    const prevUpdate = prevBtn.getEvents()[0].payload;
    assert.match(prevUpdate.embeds[0].toJSON().footer.text, /^Page 1\//);

    // Timeout ends collector -> disables all buttons
    collector.emit('end');
    await new Promise((r) => setTimeout(r, 10));
    const latestEdit = interaction.getEvents().at(-1);
    const disabledRow = latestEdit.payload.components[0].toJSON();
    assert.equal(disabledRow.components[0].disabled, true);
    assert.equal(disabledRow.components[1].disabled, true);
    assert.equal(disabledRow.components[2].disabled, true);
  });

  it('registers /media command with lyrics action, optional query/artist, and enforces dedicated cooldown', async () => {
    const json = mediaData.toJSON();
    assert.equal(json.name, 'media');
    assert.equal(json.options[0].name, 'action');
    assert.equal(json.options[0].required, true);
    assert.ok(json.options[0].choices.some((c) => c.value === 'lyrics'));
    const queryOpt = json.options.find((o) => o.name === 'query');
    const artistOpt = json.options.find((o) => o.name === 'artist');
    assert.equal(queryOpt.required, false);
    assert.equal(artistOpt.required, false);
    assert.equal(lyricsCommand.name, 'lyrics');
    assert.equal(typeof mediaCommand.execute, 'function');

    let now = 10_000;
    const cooldowns = new CooldownManager(2_000, () => now);
    const app = await createBotApp({ cooldowns });
    assert.equal(app.commandHandler.get('lyrics'), undefined);
    assert.ok(app.commandHandler.get('media'));

    app.commandHandler.commands.set('media', {
      data: mediaData,
      execute: async (int) => executeLyrics(int, {
        searchLyrics: async () => ({
          title: 'Blue',
          artist: 'yung kai',
          album: 'blue',
          thumbnailUrl: null,
          lyrics: 'Your morning eyes, I could stare like watching stars',
          sourceName: 'LRCLIB',
          sourceUrl: 'https://lrclib.net/api/get/2',
          cached: false,
        }),
      }),
    });

    const first = createMockLyricsInteraction({ query: 'Blue', userId: 'u-cd-1' });
    await app.interactionHandler.handle(first);
    assert.equal(first.getEvents().at(-1).type, 'editReply');

    // Within 5s LYRICS_COOLDOWN_MS -> blocked cleanly
    now += 3_000;
    const blocked = createMockLyricsInteraction({ query: 'Blue', userId: 'u-cd-1' });
    await app.interactionHandler.handle(blocked);
    assert.equal(blocked.getEvents()[0].type, 'reply');
    assert.equal(blocked.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(blocked.getEvents()[0].payload.embeds[0].toJSON().description, /Terlalu cepat/i);

    // After LYRICS_COOLDOWN_MS -> allowed again
    now += LYRICS_COOLDOWN_MS;
    const allowed = createMockLyricsInteraction({ query: 'Blue', userId: 'u-cd-1' });
    await app.interactionHandler.handle(allowed);
    assert.equal(allowed.getEvents().at(-1).type, 'editReply');

    // Helper coverage sanity check
    assert.equal(stripLrcTimestamps('[00:01.00] Hello\n[00:02.50] World'), 'Hello\nWorld');
    assert.equal(pickBestLrclibMatch([], 'x'), null);

    app.shutdown();
  });

  it('parses !lyrics / !lyric / !lirik prefix commands and executes via PrefixCommandHandler with shared cooldown', async () => {
    assert.deepEqual(parsePrefixInvocation('!lyrics APT'), {
      commandName: 'lyrics',
      subcommand: null,
      options: { query: 'APT' },
    });
    assert.deepEqual(parsePrefixInvocation('!lyrics Love | wave to earth'), {
      commandName: 'lyrics',
      subcommand: null,
      options: { query: 'Love', artist: 'wave to earth' },
    });
    assert.deepEqual(parsePrefixInvocation('!lirik Blue'), {
      commandName: 'lyrics',
      subcommand: null,
      options: { query: 'Blue' },
    });
    const missing = parsePrefixInvocation('!lyric');
    assert.equal(missing.commandName, 'lyrics');
    assert.match(missing.error, /Judul lagu wajib diisi/i);

    let now = 50_000;
    const cooldowns = new CooldownManager(2_000, () => now);
    const app = await createBotApp({ cooldowns });
    app.prefixCommandHandler.context.searchLyrics = async ({ query, artist }) => ({
      title: query,
      artist: artist || 'wave to earth',
      album: '0.1 flaws and all.',
      thumbnailUrl: 'https://example.com/cover.jpg',
      lyrics: 'Between people and people\nBetween wind and wind',
      sourceName: 'LRCLIB (Info: Apple Music)',
      sourceUrl: 'https://music.apple.com/us/album/love/123',
      cached: false,
    });

    const sentReplies = [];
    let typingCalls = 0;
    const fakeMessage = {
      id: 'msg-prefix-lyrics-1',
      content: '!lyrics Love | wave to earth',
      author: {
        id: 'u-prefix-lyrics',
        bot: false,
        username: 'kyy',
        globalName: 'kyy',
      },
      guild: {
        id: 'guild-1',
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
        async sendTyping() {
          typingCalls += 1;
        },
      },
      async reply(payload) {
        sentReplies.push(payload);
        return createFakeReplyMessage();
      },
    };

    await app.prefixCommandHandler.handle(fakeMessage);
    assert.equal(typingCalls, 1);
    assert.equal(sentReplies.length, 1);
    const embedJson = sentReplies[0].embeds[0].toJSON();
    assert.equal(embedJson.title, '🎵 Lyrics Finder');
    assert.ok(embedJson.description.includes('**Love — wave to earth**'));

    // Within 5s cooldown -> enforced for !lyrics prefix command
    now += 2_500;
    await app.prefixCommandHandler.handle(fakeMessage);
    assert.equal(sentReplies.length, 2);
    assert.match(sentReplies[1].embeds[0].toJSON().description, /Terlalu cepat/i);

    app.shutdown();
  });
});
