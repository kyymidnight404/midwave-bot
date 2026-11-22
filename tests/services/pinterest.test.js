import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createBotApp } from '../../src/index.js';
import {
  DOWNLOADER_ERROR_CODES,
  DownloaderError,
  PLATFORMS,
  validateMediaUrl,
} from '../../src/services/downloader.js';
import {
  PIN_COOLDOWN_MS,
  PIN_MAX_QUERY_LENGTH,
  PIN_SESSION_TTL_MS,
  PinterestSessionStore,
  extractPinFromUrl,
  extractPinMetadata,
  extractPinterestResults,
  isPinRelevantToQuery,
  searchPinterest,
  validatePinterestPinUrl,
  validatePinterestQuery,
} from '../../src/services/pinterest/index.js';
import {
  PIN_CUSTOM_ID_PREFIX,
  buildPinterestActionRow,
  buildPinterestEmbed,
  buildPinterestView,
  parsePinterestCustomId,
} from '../../src/utils/pinterestEmbed.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';
import { CooldownManager } from '../../src/utils/cooldown.js';

function createSampleRawPin(index, overrides = {}) {
  const num = index + 1;
  return {
    id: `pin_id_${num}`,
    type: 'pin',
    title: `Anime Aesthetic Wallpaper ${num}`,
    pinner: {
      username: `creator_${num}`,
      full_name: `Creator Name ${num}`,
    },
    images: {
      orig: { url: `https://i.pinimg.com/originals/aa/bb/${num}.jpg` },
      '736x': { url: `https://i.pinimg.com/736x/aa/bb/${num}.jpg` },
    },
    ...overrides,
  };
}

function createSamplePins(count = 10) {
  return Array.from({ length: count }, (_, i) => extractPinMetadata(createSampleRawPin(i)));
}

function createMockJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function createFakeButtonInteraction({ customId, userId }) {
  const events = [];
  return {
    customId,
    user: { id: userId },
    isButton: () => true,
    isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => false,
    async update(payload) {
      events.push({ type: 'update', payload });
      return payload;
    },
    async reply(payload) {
      events.push({ type: 'reply', payload });
      return payload;
    },
    async followUp(payload) {
      events.push({ type: 'followUp', payload });
      return payload;
    },
    getEvents: () => events,
  };
}

function createFakePrefixMessage({ content, userId = 'user-1', channelId = 'ch-pin-1' }) {
  const sentMessages = [];
  const channelMessages = [];

  const trackSent = (payload) => {
    const msg = {
      id: `msg-${sentMessages.length + 1}`,
      channelId,
      payload,
      edits: [],
      async edit(newPayload) {
        this.payload = newPayload;
        this.edits.push(newPayload);
        return this;
      },
    };
    sentMessages.push(msg);
    return msg;
  };

  return {
    id: `trigger-${Math.random().toString(36).slice(2, 8)}`,
    content,
    author: {
      id: userId,
      bot: false,
      username: `user-${userId}`,
    },
    guild: {
      id: 'guild-1',
      members: { me: { id: 'bot-1' } },
    },
    channel: {
      id: channelId,
      isTextBased: () => true,
      permissionsFor: () =>
        new Set([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]),
      async sendTyping() {},
      async send(payload) {
        channelMessages.push(payload);
        return trackSent(payload);
      },
    },
    async reply(payload) {
      return trackSent(payload);
    },
    getSentMessages: () => sentMessages,
    getChannelSendCount: () => channelMessages.length,
  };
}

describe('Pinterest Search — Extractor, Search, Session, UI & Command Integration', () => {
  it('integrates Pinterest into MIDWAVE downloader platform validator without breaking other platforms', () => {
    const pinUrl = validateMediaUrl('https://www.pinterest.com/pin/1234567890/');
    assert.equal(pinUrl.platform, PLATFORMS.PINTEREST);
    assert.equal(pinUrl.platformLabel, 'Pinterest');
    assert.equal(pinUrl.isShortLink, false);

    const shortPin = validateMediaUrl('https://pin.it/abc123XYZ');
    assert.equal(shortPin.platform, PLATFORMS.PINTEREST);
    assert.equal(shortPin.platformLabel, 'Pinterest');
    assert.equal(shortPin.isShortLink, true);

    assert.throws(
      () => validatePinterestPinUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.INVALID_URL,
    );
    assert.throws(
      () => validatePinterestPinUrl('https://www.pinterest.com/'),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.INVALID_URL,
    );
    assert.throws(
      () => validatePinterestPinUrl('https://127.0.0.1/pin/123/'),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
    );
    assert.throws(
      () => validatePinterestPinUrl('https://www.pinterest.com/login/'),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
    );
  });

  it('extracts image & video thumbnail Pin metadata and handles extraction failures cleanly', async () => {
    const imagePin = extractPinMetadata(createSampleRawPin(0));
    assert.equal(imagePin.title, 'Anime Aesthetic Wallpaper 1');
    assert.equal(imagePin.creator, 'Creator Name 1 (@creator_1)');
    assert.equal(imagePin.thumbnailUrl, 'https://i.pinimg.com/originals/aa/bb/1.jpg');
    assert.equal(imagePin.pinUrl, 'https://www.pinterest.com/pin/pin_id_1/');
    assert.equal(imagePin.mediaType, 'image');

    const descPreferredPin = extractPinMetadata({
      id: 'desc_pin_1',
      type: 'pin',
      title: '',
      grid_title: '',
      description: 'Kawai Mako Hibimeshi Icon',
      seo_alt_text: 'an anime character eating a donut',
      images: { orig: { url: 'https://i.pinimg.com/originals/aa/bb/99.jpg' } },
    });
    assert.equal(descPreferredPin.title, 'Kawai Mako Hibimeshi Icon');

    const videoPin = extractPinMetadata({
      id: 'vid_pin_99',
      title: '   ',
      seo_alt_text: 'Cyberpunk rain loop',
      pinner: { username: 'motion_art', full_name: '' },
      story_pin_data: {
        pages: [
          {
            blocks: [
              {
                video: {
                  video_list: {
                    V_HLSV3_MOBILE: {
                      url: 'https://v1.pinimg.com/videos/iht/hls/video.m3u8',
                      thumbnail: 'https://i.pinimg.com/videos/thumbnails/originals/video.jpg',
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    });
    assert.equal(videoPin.title, 'Cyberpunk rain loop');
    assert.equal(videoPin.creator, '@motion_art');
    assert.equal(videoPin.thumbnailUrl, 'https://i.pinimg.com/videos/thumbnails/originals/video.jpg');
    assert.equal(videoPin.mediaType, 'video');
    assert.equal(videoPin.videoUrl, 'https://v1.pinimg.com/videos/iht/hls/video.m3u8');

    // Filters promoted pins, non-pin widgets, and throws EXTRACTION_FAILED if all relevant pins lack valid media
    const filtered = extractPinterestResults([
      createSampleRawPin(0, { is_promoted: true }),
      { id: 'board_widget_1', type: 'story', story_type: 'featured_boards' },
      createSampleRawPin(1),
    ]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'pin_id_2');

    assert.throws(
      () => extractPinterestResults([{ id: 'bad_1', type: 'pin', images: { orig: { url: 'http://localhost/evil.jpg' } } }]),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
    );

    // URL-based extraction via HTML OpenGraph fallback + redirect SSRF check
    const htmlPin = await extractPinFromUrl('https://www.pinterest.com/pin/555444/', {
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async text() {
          return `
            <html>
              <meta property="og:title" content="Minimalist Desk Setup" />
              <meta property="og:image" content="https://i.pinimg.com/originals/11/22/33.jpg" />
              <meta name="pinterestapp:pinner" content="desk_creator" />
            </html>
          `;
        },
      }),
    });
    assert.equal(htmlPin.title, 'Minimalist Desk Setup');
    assert.equal(htmlPin.creator, 'desk_creator');
    assert.equal(htmlPin.thumbnailUrl, 'https://i.pinimg.com/originals/11/22/33.jpg');
    assert.equal(htmlPin.pinUrl, 'https://www.pinterest.com/pin/555444/');

    // Missing HTML metadata -> EXTRACTION_FAILED
    await assert.rejects(
      () =>
        extractPinFromUrl('https://www.pinterest.com/pin/999/', {
          lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
          fetchFn: async () => ({ ok: true, status: 200, async text() { return '<html></html>'; } }),
        }),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
    );
  });

  it('validates search queries and handles empty results, timeout, rate limit, and API errors', async () => {
    assert.throws(() => validatePinterestQuery(''), (e) => e.code === 'INVALID_QUERY');
    assert.throws(() => validatePinterestQuery('   \n '), (e) => e.code === 'INVALID_QUERY');
    assert.throws(() => validatePinterestQuery(null), (e) => e.code === 'INVALID_QUERY');
    assert.throws(
      () => validatePinterestQuery('a'.repeat(PIN_MAX_QUERY_LENGTH + 1)),
      (e) => e.code === 'INVALID_QUERY',
    );

    assert.equal(validatePinterestQuery('  dark   academia  '), 'dark academia');

    const raw12 = Array.from({ length: 12 }, (_, i) => createSampleRawPin(i));
    const searchRes = await searchPinterest('anime aesthetic', {
      maxResults: 10,
      fetchImpl: async (url) => {
        assert.match(url, /BaseSearchResource\/get/);
        const parsed = new URL(url);
        const data = JSON.parse(parsed.searchParams.get('data'));
        assert.equal(data.options.query, 'anime aesthetic');
        assert.equal(data.options.rs, 'typed');
        return createMockJsonResponse(200, {
          resource_response: { data: { results: raw12 } },
        });
      },
    });
    assert.equal(searchRes.query, 'anime aesthetic');
    assert.equal(searchRes.results.length, 10);

    // Relevance filtering: drops unrelated horse-head spam / noise for `kawaii mako` & preserves order
    const mixedKawaiiMako = [
      createSampleRawPin(0, {
        id: 'noise_toy',
        title: '',
        description: '',
        seo_alt_text: 'a close up of a toy with a person kissing its face',
        board: { name: 'Quick Saves' },
      }),
      createSampleRawPin(1, {
        id: 'real_mako_1',
        title: 'Makocchi - Kawai Mako',
        description: 'Food for the Soul',
      }),
      createSampleRawPin(2, {
        id: 'horse_head_spam',
        title: '',
        description: 'Mako Mankanshoku Sticker',
        seo_alt_text: "a brown and white horse's head with pink cheeks sticker on a white background",
        domain: 'redbubble.com',
      }),
      createSampleRawPin(3, {
        id: 'real_mako_2',
        title: 'Kawai Mako - Hibi wa Sugiredo Meshi Umashi',
      }),
    ];
    assert.equal(isPinRelevantToQuery(mixedKawaiiMako[0], 'kawaii mako'), false);
    assert.equal(isPinRelevantToQuery(mixedKawaiiMako[1], 'kawaii mako'), true);
    assert.equal(isPinRelevantToQuery(mixedKawaiiMako[2], 'kawaii mako'), false);
    assert.equal(isPinRelevantToQuery(mixedKawaiiMako[3], 'kawaii mako'), true);

    const relevantRes = await searchPinterest('kawaii mako', {
      fetchImpl: async () =>
        createMockJsonResponse(200, { resource_response: { data: { results: mixedKawaiiMako } } }),
    });
    assert.deepEqual(
      relevantRes.results.map((r) => r.id),
      ['real_mako_1', 'real_mako_2'],
    );

    // Unrelated-only fallback pins -> NOT_FOUND empty state (never return random pins)
    await assert.rejects(
      () =>
        searchPinterest('kawaii mako', {
          fetchImpl: async () =>
            createMockJsonResponse(200, {
              resource_response: { data: { results: [mixedKawaiiMako[0], mixedKawaiiMako[2]] } },
            }),
        }),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.NOT_FOUND,
    );

    // Empty results -> NOT_FOUND
    await assert.rejects(
      () =>
        searchPinterest('zzzznonexistentpinxyz', {
          fetchImpl: async () =>
            createMockJsonResponse(200, { resource_response: { data: { results: [] } } }),
        }),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.NOT_FOUND,
    );

    // Timeout -> TIMEOUT
    await assert.rejects(
      () =>
        searchPinterest('cat', {
          fetchImpl: async () => {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            throw err;
          },
        }),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.TIMEOUT,
    );

    // Rate limited -> RATE_LIMITED
    await assert.rejects(
      () =>
        searchPinterest('cat', {
          fetchImpl: async () => createMockJsonResponse(429, {}),
        }),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.RATE_LIMITED,
    );

    // Broken JSON -> EXTRACTION_FAILED
    await assert.rejects(
      () =>
        searchPinterest('cat', {
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            async json() {
              throw new SyntaxError('Unexpected token');
            },
          }),
        }),
      (err) => err instanceof DownloaderError && err.code === DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
    );
  });

  it('builds minimalist single-result embed and exact 3-button ActionRow with accurate button states', () => {
    const pins = createSamplePins(10);

    // First result (1/10): Prev disabled, Next enabled, Link points to Pin 1
    const firstEmbed = buildPinterestEmbed(pins[0], {
      currentIndex: 0,
      total: pins.length,
      query: 'kawaii mako',
    }).toJSON();
    assert.equal(firstEmbed.author.name, 'Pinterest');
    assert.equal(firstEmbed.title, 'Anime Aesthetic Wallpaper 1');
    assert.equal(firstEmbed.url, pins[0].pinUrl);
    assert.equal(firstEmbed.image.url, pins[0].thumbnailUrl);
    assert.equal(firstEmbed.footer.text, '1/10 • kawaii mako');
    assert.equal(firstEmbed.description, undefined);
    assert.equal(firstEmbed.fields, undefined);

    const firstRow = buildPinterestActionRow({
      currentIndex: 0,
      total: 10,
      pinUrl: pins[0].pinUrl,
      sessionId: 'sess1',
      ownerId: 'u1',
    }).toJSON();

    assert.equal(firstRow.components.length, 3);
    assert.equal(firstRow.components[0].label, 'Prev');
    assert.equal(firstRow.components[0].style, ButtonStyle.Secondary);
    assert.equal(firstRow.components[0].disabled, true);

    assert.equal(firstRow.components[1].label, 'Link');
    assert.equal(firstRow.components[1].style, ButtonStyle.Link);
    assert.equal(firstRow.components[1].url, pins[0].pinUrl);

    assert.equal(firstRow.components[2].label, 'Next');
    assert.equal(firstRow.components[2].style, ButtonStyle.Secondary);
    assert.equal(firstRow.components[2].disabled, false);

    // Middle result (5/10): both Prev and Next enabled
    const midRow = buildPinterestActionRow({
      currentIndex: 4,
      total: 10,
      pinUrl: pins[4].pinUrl,
      sessionId: 'sess1',
      ownerId: 'u1',
    }).toJSON();
    assert.equal(midRow.components[0].disabled, false);
    assert.equal(midRow.components[1].url, pins[4].pinUrl);
    assert.equal(midRow.components[2].disabled, false);

    // Last result (10/10): Prev enabled, Next disabled
    const lastRow = buildPinterestActionRow({
      currentIndex: 9,
      total: 10,
      pinUrl: pins[9].pinUrl,
      sessionId: 'sess1',
      ownerId: 'u1',
    }).toJSON();
    assert.equal(lastRow.components[0].disabled, false);
    assert.equal(lastRow.components[1].url, pins[9].pinUrl);
    assert.equal(lastRow.components[2].disabled, true);

    // Single result (1/1): both Prev and Next disabled
    const singleRow = buildPinterestActionRow({
      currentIndex: 0,
      total: 1,
      pinUrl: pins[0].pinUrl,
      sessionId: 'sess1',
      ownerId: 'u1',
    }).toJSON();
    assert.equal(singleRow.components[0].disabled, true);
    assert.equal(singleRow.components[2].disabled, true);

    // View helper with disabled=true (expired) disables Prev and Next
    const expiredView = buildPinterestView({
      session: { sessionId: 'sess1', userId: 'u1', query: 'cat', results: pins, currentIndex: 3 },
      disabled: true,
    });
    const expiredRow = expiredView.components[0].toJSON();
    assert.equal(expiredRow.components[0].disabled, true);
    assert.equal(expiredRow.components[2].disabled, true);
  });

  it('enforces per-user session isolation, pagination bounds, authorization, and 5-minute expiration', async () => {
    assert.equal(PIN_SESSION_TTL_MS, 5 * 60 * 1000);

    let now = 1_000_000;
    const store = new PinterestSessionStore({
      ttlMs: PIN_SESSION_TTL_MS,
      nowFn: () => now,
    });

    const pinsA = createSamplePins(3);
    const pinsB = createSamplePins(2);

    const sessionA1 = store.createSession({ userId: 'user-a', query: 'cat', results: pinsA });
    assert.equal(sessionA1.currentIndex, 0);
    assert.equal(sessionA1.expiresAt, now + 5 * 60 * 1000);

    // Replacing user-a session invalidates previous session
    const sessionA2 = store.createSession({ userId: 'user-a', query: 'dog', results: pinsA });
    assert.equal(store.getSession(sessionA1.sessionId), null);
    assert.equal(store.getUserSession('user-a').sessionId, sessionA2.sessionId);

    // User-b has independent session
    const sessionB = store.createSession({ userId: 'user-b', query: 'sky', results: pinsB });
    assert.equal(store.getStats().activeSessionsCount, 2);

    // Unauthorized user cannot paginate user-a's session
    const unauth = store.paginate({
      sessionId: sessionA2.sessionId,
      userId: 'user-b',
      direction: 'next',
    });
    assert.equal(unauth.ok, false);
    assert.equal(unauth.reason, 'UNAUTHORIZED');
    assert.equal(sessionA2.currentIndex, 0);

    // Valid pagination forward & backward
    const step1 = store.paginate({ sessionId: sessionA2.sessionId, userId: 'user-a', direction: 'next' });
    assert.equal(step1.ok, true);
    assert.equal(step1.session.currentIndex, 1);

    const step2 = store.paginate({ sessionId: sessionA2.sessionId, userId: 'user-a', direction: 'next' });
    assert.equal(step2.session.currentIndex, 2);

    // Clamp at last index
    const clampMax = store.paginate({ sessionId: sessionA2.sessionId, userId: 'user-a', direction: 'next' });
    assert.equal(clampMax.session.currentIndex, 2);

    const back1 = store.paginate({ sessionId: sessionA2.sessionId, userId: 'user-a', direction: 'prev' });
    assert.equal(back1.session.currentIndex, 1);

    // Advance clock to exactly 5 minutes -> expired
    now += PIN_SESSION_TTL_MS;
    const expiredResult = store.paginate({
      sessionId: sessionA2.sessionId,
      userId: 'user-a',
      direction: 'next',
    });
    assert.equal(expiredResult.ok, false);
    assert.equal(expiredResult.reason, 'EXPIRED');
    assert.equal(store.getSession(sessionA2.sessionId), null);
    assert.equal(store.getUserSession('user-a'), null);

    // User-b also expired after 5m
    assert.equal(store.getSession(sessionB.sessionId), null);
    store.clearAll();
  });

  it('handles !pin <keyword> pagination via interaction.update(), authorization, and expired sessions end-to-end', async () => {
    let now = 50_000;
    let fakeClock = 100_000;
    const sessionStore = new PinterestSessionStore({
      ttlMs: PIN_SESSION_TTL_MS,
      nowFn: () => fakeClock,
    });
    const cooldowns = new CooldownManager(0, () => now);
    const app = await createBotApp({
      cooldowns,
      pinterestSessionStore: sessionStore,
      skipTempCleanup: true,
    });

    const samplePins = createSamplePins(10);
    app.prefixCommandHandler.context.searchPinterest = async ({ query }) => ({
      query,
      results: samplePins,
    });

    // 1. Prefix parsing validation
    assert.deepEqual(parsePrefixInvocation('!pin cyberpunk city'), {
      commandName: 'pin',
      subcommand: null,
      options: { query: 'cyberpunk city' },
    });
    const missingKeyword = parsePrefixInvocation('!pin');
    assert.equal(missingKeyword.commandName, 'pin');
    assert.match(missingKeyword.error, /Kata kunci/i);

    // 2. Run `!pin cyberpunk city`
    const msg = createFakePrefixMessage({ content: '!pin cyberpunk city', userId: 'owner-1' });
    await app.prefixCommandHandler.handle(msg);

    const sent = msg.getSentMessages();
    assert.equal(sent.length, 1);

    const initialPayload = sent[0].payload;
    assert.equal(initialPayload.embeds.length, 1);
    assert.equal(initialPayload.components.length, 1);

    const initialEmbed = initialPayload.embeds[0].toJSON();
    assert.equal(initialEmbed.author.name, 'Pinterest');
    assert.equal(initialEmbed.title, samplePins[0].title);
    assert.equal(initialEmbed.image.url, samplePins[0].thumbnailUrl);
    assert.equal(initialEmbed.footer.text, '1/10 • cyberpunk city');
    assert.equal(initialEmbed.fields, undefined);
    assert.equal(initialEmbed.description, undefined);

    const initialRow = initialPayload.components[0].toJSON();
    assert.equal(initialRow.components.length, 3);
    assert.equal(initialRow.components[0].disabled, true);
    assert.equal(initialRow.components[1].url, samplePins[0].pinUrl);
    assert.equal(initialRow.components[2].disabled, false);

    const prevCustomId = initialRow.components[0].custom_id;
    const nextCustomId = initialRow.components[2].custom_id;
    assert.ok(prevCustomId.startsWith(`${PIN_CUSTOM_ID_PREFIX}:prev:`));
    assert.ok(parsePinterestCustomId(nextCustomId).valid);

    // 3. Non-owner clicks Next -> ephemeral authorization error, no interaction.update, no new message
    const intruderBtn = createFakeButtonInteraction({ customId: nextCustomId, userId: 'intruder-99' });
    await app.interactionHandler.handle(intruderBtn);
    const intruderEvents = intruderBtn.getEvents();
    assert.equal(intruderEvents.length, 1);
    assert.equal(intruderEvents[0].type, 'reply');
    assert.equal(intruderEvents[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(intruderEvents[0].payload.embeds[0].toJSON().description, /Hanya pengguna/i);
    assert.equal(msg.getSentMessages().length, 1);

    // 4. Owner clicks Next -> uses interaction.update(), updates Embed to 2/10, updates Link URL, enables Prev
    const nextBtn = createFakeButtonInteraction({ customId: nextCustomId, userId: 'owner-1' });
    await app.interactionHandler.handle(nextBtn);
    const nextEvents = nextBtn.getEvents();
    assert.equal(nextEvents.length, 1);
    assert.equal(nextEvents[0].type, 'update');
    assert.equal(msg.getSentMessages().length, 1); // No new message sent!

    const page2Embed = nextEvents[0].payload.embeds[0].toJSON();
    const page2Row = nextEvents[0].payload.components[0].toJSON();
    assert.equal(page2Embed.author.name, 'Pinterest');
    assert.equal(page2Embed.title, samplePins[1].title);
    assert.equal(page2Embed.image.url, samplePins[1].thumbnailUrl);
    assert.equal(page2Embed.footer.text, '2/10 • cyberpunk city');
    assert.equal(page2Embed.fields, undefined);
    assert.equal(page2Row.components[0].disabled, false);
    assert.equal(page2Row.components[1].url, samplePins[1].pinUrl);
    assert.equal(page2Row.components[2].disabled, false);

    // 5. Owner clicks Prev -> returns to 1/10 via interaction.update()
    const prevBtn = createFakeButtonInteraction({ customId: prevCustomId, userId: 'owner-1' });
    await app.interactionHandler.handle(prevBtn);
    const prevEvents = prevBtn.getEvents();
    assert.equal(prevEvents.length, 1);
    assert.equal(prevEvents[0].type, 'update');
    assert.equal(msg.getSentMessages().length, 1);

    const page1AgainRow = prevEvents[0].payload.components[0].toJSON();
    assert.equal(page1AgainRow.components[0].disabled, true);
    assert.equal(page1AgainRow.components[1].url, samplePins[0].pinUrl);
    assert.equal(page1AgainRow.components[2].disabled, false);

    // 6. Navigate to last page (10/10) -> Next disabled
    for (let step = 0; step < 9; step += 1) {
      const btn = createFakeButtonInteraction({ customId: nextCustomId, userId: 'owner-1' });
      await app.interactionHandler.handle(btn);
      if (step === 8) {
        const lastRow = btn.getEvents()[0].payload.components[0].toJSON();
        const lastEmbed = btn.getEvents()[0].payload.embeds[0].toJSON();
        assert.equal(lastEmbed.footer.text, '10/10 • cyberpunk city');
        assert.equal(lastRow.components[0].disabled, false);
        assert.equal(lastRow.components[1].url, samplePins[9].pinUrl);
        assert.equal(lastRow.components[2].disabled, true);
      }
    }

    // 7. Advance clock past 5 minutes -> session expired, Next rejected ephemerally
    fakeClock += PIN_SESSION_TTL_MS + 1;
    const expiredBtn = createFakeButtonInteraction({ customId: prevCustomId, userId: 'owner-1' });
    await app.interactionHandler.handle(expiredBtn);
    const expiredEvents = expiredBtn.getEvents();
    assert.equal(expiredEvents.length, 1);
    assert.equal(expiredEvents[0].type, 'reply');
    assert.equal(expiredEvents[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(expiredEvents[0].payload.embeds[0].toJSON().description, /kedaluwarsa/i);

    app.shutdown();
  });

  it('disables Prev and Next buttons automatically when the 5-minute session timer fires', async () => {
    const shortStore = new PinterestSessionStore({ ttlMs: 30 });
    const app = await createBotApp({
      cooldowns: new CooldownManager(0),
      pinterestSessionStore: shortStore,
      skipTempCleanup: true,
    });

    app.prefixCommandHandler.context.searchPinterest = async ({ query }) => ({
      query,
      results: createSamplePins(3),
    });

    const msg = createFakePrefixMessage({ content: '!pin nature', userId: 'timer-user' });
    await app.prefixCommandHandler.handle(msg);

    const sentMsg = msg.getSentMessages()[0];
    assert.equal(sentMsg.edits.length, 0);

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(sentMsg.edits.length, 1);
    const disabledRow = sentMsg.edits[0].components[0].toJSON();
    assert.equal(disabledRow.components[0].disabled, true);
    assert.equal(disabledRow.components[2].disabled, true);
    assert.equal(PIN_COOLDOWN_MS, 5_000);

    app.shutdown();
  });

  it('registers /pin slash command, executes via InteractionHandler, paginates, and enforces cooldown', async () => {
    let now = 20_000;
    const sessionStore = new PinterestSessionStore({ ttlMs: PIN_SESSION_TTL_MS });
    const cooldowns = new CooldownManager(2_000, () => now);
    const app = await createBotApp({
      cooldowns,
      pinterestSessionStore: sessionStore,
      skipTempCleanup: true,
    });

    const pinCmd = app.commandHandler.get('pin');
    assert.ok(pinCmd, '/pin command must be registered');
    const pinJson = pinCmd.data.toJSON();
    assert.equal(pinJson.name, 'pin');
    assert.equal(pinJson.options[0].name, 'query');
    assert.equal(pinJson.options[0].required, true);

    const samplePins = createSamplePins(4);
    app.interactionHandler.context.searchPinterest = async ({ query }) => ({
      query,
      results: samplePins,
    });

    const createSlashPinInteraction = (userId, query) => {
      const events = [];
      const replyMessage = {
        id: 'slash-pin-msg-1',
        edits: [],
        async edit(payload) {
          this.edits.push(payload);
          return this;
        },
      };
      return {
        commandName: 'pin',
        user: { id: userId },
        deferred: false,
        replied: false,
        isChatInputCommand: () => true,
        isMessageContextMenuCommand: () => false,
        options: {
          getSubcommand: () => null,
          getSubcommandGroup: () => null,
          getString: (name) => (name === 'query' ? query : null),
        },
        async deferReply(opts = {}) {
          this.deferred = true;
          events.push({ type: 'deferReply', payload: opts });
        },
        async reply(payload) {
          this.replied = true;
          events.push({ type: 'reply', payload });
          return replyMessage;
        },
        async editReply(payload) {
          events.push({ type: 'editReply', payload });
          return replyMessage;
        },
        async followUp(payload) {
          events.push({ type: 'followUp', payload });
        },
        getEvents: () => events,
      };
    };

    const slashInt = createSlashPinInteraction('slash-user-1', 'minimalist desk');
    await app.interactionHandler.handle(slashInt);

    const events = slashInt.getEvents();
    assert.equal(events[0].type, 'deferReply');
    assert.equal(events[1].type, 'editReply');

    const initialPayload = events[1].payload;
    const initialJson = initialPayload.embeds[0].toJSON();
    assert.equal(initialJson.author.name, 'Pinterest');
    assert.equal(initialJson.title, samplePins[0].title);
    assert.equal(initialJson.footer.text, '1/4 • minimalist desk');
    assert.equal(initialJson.fields, undefined);

    const row = initialPayload.components[0].toJSON();
    assert.equal(row.components.length, 3);
    assert.equal(row.components[0].disabled, true);
    assert.equal(row.components[1].url, samplePins[0].pinUrl);
    assert.equal(row.components[2].disabled, false);

    // Paginate via interaction.update()
    const nextBtn = createFakeButtonInteraction({
      customId: row.components[2].custom_id,
      userId: 'slash-user-1',
    });
    await app.interactionHandler.handle(nextBtn);
    assert.equal(nextBtn.getEvents()[0].type, 'update');
    assert.equal(nextBtn.getEvents()[0].payload.components[0].toJSON().components[1].url, samplePins[1].pinUrl);

    // Cooldown enforced within PIN_COOLDOWN_MS (5s)
    now += 2_500;
    const blockedInt = createSlashPinInteraction('slash-user-1', 'another query');
    await app.interactionHandler.handle(blockedInt);
    assert.equal(blockedInt.getEvents()[0].type, 'reply');
    assert.equal(blockedInt.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(blockedInt.getEvents()[0].payload.embeds[0].toJSON().description, /Terlalu cepat/i);

    app.shutdown();
  });
});
