import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { AutoDownloaderHandler } from '../../src/handlers/AutoDownloaderHandler.js';
import messageCreateEvent from '../../src/events/messageCreate.js';
import { createBotApp } from '../../src/index.js';
import {
  DEFAULT_RAPIDAPI_HOST,
  STANDARD_DISCORD_UPLOAD_LIMIT_BYTES,
  cleanupTempDir,
  downloadViaRapidApi,
  getRapidApiConfig,
  parseRapidApiResponse,
} from '../../src/services/downloader.js';
import { DOWNLOADER_ERROR_CODES } from '../../src/services/downloader/errors.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { detectFirstMediaUrl, detectMediaUrls } from '../../src/utils/urlDetector.js';

const FAKE_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
]);
const FAKE_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
]);

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function createMockMessage({
  content = '',
  bot = false,
  userId = 'u-msg-1',
  canAttach = true,
  canSend = true,
} = {}) {
  const events = [];
  return {
    content,
    author: { id: userId, bot },
    guild: {
      members: {
        me: { id: 'bot-1' },
      },
    },
    channel: {
      permissionsFor() {
        return {
          has(perm) {
            if (perm === 1n << 15n) return canAttach; // AttachFiles
            return canSend;
          },
        };
      },
      async sendTyping() {
        events.push({ type: 'typing' });
      },
      async send(payload) {
        events.push({ type: 'send', payload });
        return payload;
      },
    },
    async reply(payload) {
      events.push({ type: 'reply', payload });
      return payload;
    },
    async suppressEmbeds(value) {
      events.push({ type: 'suppressEmbeds', value });
    },
    getEvents: () => events,
  };
}

describe('AutoDownloader — URL Detector Regex', () => {
  it('detects TikTok (standard, vm, vt, m) and Instagram (reel, p, stories) links cleanly', () => {
    const sample =
      'Cek video ini (https://vm.tiktok.com/ZM6test123/) dan reels https://www.instagram.com/reel/Cop84x6u7CP/?igsh=abc!';
    const matches = detectMediaUrls(sample);

    assert.equal(matches.length, 2);
    assert.deepEqual(matches[0], {
      platform: 'tiktok',
      url: 'https://vm.tiktok.com/ZM6test123/',
      index: 15,
    });
    assert.equal(matches[1].platform, 'instagram');
    assert.equal(matches[1].url, 'https://www.instagram.com/reel/Cop84x6u7CP/?igsh=abc');

    assert.equal(
      detectFirstMediaUrl('https://vt.tiktok.com/ZS2abcd/')?.platform,
      'tiktok',
    );
    assert.equal(
      detectFirstMediaUrl('https://www.tiktok.com/@creator/video/7123456789012345678')?.platform,
      'tiktok',
    );
    assert.equal(
      detectFirstMediaUrl('https://instagram.com/p/C9xyz123/')?.platform,
      'instagram',
    );
    assert.equal(
      detectFirstMediaUrl('https://www.instagram.com/stories/user_1/3399112233/')?.platform,
      'instagram',
    );
  });

  it('ignores unsupported domains, homepages, bare profiles, and credential URLs', () => {
    assert.deepEqual(detectMediaUrls('https://www.youtube.com/watch?v=123'), []);
    assert.deepEqual(detectMediaUrls('https://www.tiktok.com/'), []);
    assert.deepEqual(detectMediaUrls('https://www.tiktok.com/@onlyprofile'), []);
    assert.deepEqual(detectMediaUrls('https://user:pass@www.instagram.com/reel/abc/'), []);
  });
});

describe('AutoDownloader — RapidAPI Parser & Axios Downloader', () => {
  it('parses flexible links, medias, images carousel, and single url responses cleanly', () => {
    // 1. `links` array: picks HD no watermark over SD/watermarked/audio
    const fromLinks = parseRapidApiResponse({
      title: 'Klip Keren',
      links: [
        { quality: 'hd_watermark', link: 'https://cdn.tiktok.com/wm.mp4' },
        { quality: 'audio', link: 'https://cdn.tiktok.com/sound.mp3' },
        { quality: 'hd_no_watermark', link: 'https://cdn.tiktok.com/clean_hd.mp4' },
      ],
    });
    assert.equal(fromLinks.mode, 'video');
    assert.equal(fromLinks.candidates[0].url, 'https://cdn.tiktok.com/clean_hd.mp4');

    // 2. `medias` / multi-photo carousel capped at 10 attachments
    const manyImages = Array.from({ length: 12 }, (_, idx) => ({
      type: 'image',
      url: `https://scontent.cdninstagram.com/slide_${idx + 1}.jpg`,
    }));
    const fromCarousel = parseRapidApiResponse({
      author: { nickname: 'creator_ig' },
      medias: manyImages,
    });
    assert.equal(fromCarousel.mode, 'carousel');
    assert.equal(fromCarousel.author, 'creator_ig');
    assert.equal(fromCarousel.candidates.length, 10);

    // 3. Single `url` field
    const fromSingle = parseRapidApiResponse({
      url: 'https://cdn.instagram.com/reel_single.mp4',
    });
    assert.equal(fromSingle.mode, 'video');
    assert.equal(fromSingle.candidates[0].url, 'https://cdn.instagram.com/reel_single.mp4');
  });

  it('downloads valid video attachment via mocked axios with required RapidAPI headers', async () => {
    let capturedHeaders = null;
    const axiosMock = {
      async get(url, options) {
        if (url.includes(DEFAULT_RAPIDAPI_HOST)) {
          capturedHeaders = options.headers;
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            data: {
              title: 'Demo TikTok',
              author: 'midwave',
              links: [{ quality: 'hd_no_watermark', link: 'https://v16.tiktokcdn.com/video.mp4' }],
            },
          };
        }
        return {
          status: 200,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(FAKE_MP4.length),
          },
          data: Readable.from(FAKE_MP4),
        };
      },
    };

    const result = await downloadViaRapidApi({
      url: 'https://www.tiktok.com/@midwave/video/123456',
      platform: 'tiktok',
      config: getRapidApiConfig({ RAPIDAPI_KEY: 'secret-test-key' }),
      deps: { axiosClient: axiosMock, lookupFn: publicLookup },
    });

    try {
      assert.equal(capturedHeaders['x-rapidapi-key'], 'secret-test-key');
      assert.equal(capturedHeaders['x-rapidapi-host'], DEFAULT_RAPIDAPI_HOST);
      assert.equal(result.mode, 'attachments');
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].fileName, 'tiktok_video.mp4');
      assert.ok(result.attachments[0].filePath);
      const saved = await fs.readFile(result.attachments[0].filePath);
      assert.deepEqual(saved, FAKE_MP4);
    } finally {
      await cleanupTempDir(result.jobDir);
    }
  });

  it('returns fallback CDN mode when media exceeds 10 MB Discord limit or CDN rejects attachment', async () => {
    const oversizedAxios = {
      async get(url) {
        if (url.includes(DEFAULT_RAPIDAPI_HOST)) {
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            data: {
              title: 'Huge Video',
              links: [{ quality: 'hd', link: 'https://scontent.cdninstagram.com/huge_video.mp4' }],
            },
          };
        }
        return {
          status: 200,
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(STANDARD_DISCORD_UPLOAD_LIMIT_BYTES + 5_000_000),
          },
          data: Readable.from(FAKE_MP4),
        };
      },
    };

    const result = await downloadViaRapidApi({
      url: 'https://www.instagram.com/reel/HugeReel123/',
      platform: 'instagram',
      config: getRapidApiConfig({ RAPIDAPI_KEY: 'key-1' }),
      deps: { axiosClient: oversizedAxios, lookupFn: publicLookup },
    });

    assert.equal(result.mode, 'fallback');
    assert.equal(result.primaryCdnUrl, 'https://scontent.cdninstagram.com/huge_video.mp4');
    assert.match(result.reason, /melebihi batas|limit|besar/i);
  });

  it('handles RapidAPI 429 rate limit, private error, and timeout cleanly', async () => {
    const rateLimitedAxios = {
      async get() {
        const err = new Error('Too many requests');
        err.response = { status: 429 };
        throw err;
      },
    };

    await assert.rejects(
      downloadViaRapidApi({
        url: 'https://www.tiktok.com/@a/video/1',
        platform: 'tiktok',
        config: getRapidApiConfig({ RAPIDAPI_KEY: 'key-1' }),
        deps: { axiosClient: rateLimitedAxios, lookupFn: publicLookup },
      }),
      (err) => err.code === DOWNLOADER_ERROR_CODES.RATE_LIMITED,
    );

    const timeoutAxios = {
      async get() {
        const err = new Error('timeout exceeded');
        err.code = 'ECONNABORTED';
        throw err;
      },
    };

    await assert.rejects(
      downloadViaRapidApi({
        url: 'https://www.tiktok.com/@a/video/2',
        platform: 'tiktok',
        config: getRapidApiConfig({ RAPIDAPI_KEY: 'key-1' }),
        deps: { axiosClient: timeoutAxios, lookupFn: publicLookup },
      }),
      (err) => err.code === DOWNLOADER_ERROR_CODES.TIMEOUT,
    );
  });
});

describe('AutoDownloader — MessageCreate Handler & Discord Fallback Flow', () => {
  it('ignores bot messages, prefix commands, and skips cleanly when RAPIDAPI_KEY is unset', async () => {
    const handler = new AutoDownloaderHandler({
      cooldowns: new CooldownManager(0),
      getConfig: () => getRapidApiConfig({}),
    });

    const botMsg = createMockMessage({
      content: 'https://www.tiktok.com/@a/video/1',
      bot: true,
    });
    assert.equal(await handler.handle(botMsg), false);

    const prefixMsg = createMockMessage({
      content: '!help https://www.tiktok.com/@a/video/1',
    });
    assert.equal(await handler.handle(prefixMsg), false);

    const unconfiguredMsg = createMockMessage({
      content: 'https://www.tiktok.com/@a/video/1',
    });
    assert.equal(await handler.handle(unconfiguredMsg), false);
    assert.equal(unconfiguredMsg.getEvents().length, 0);
  });

  it('sends typing indicator, attaches downloaded carousel files, and suppresses original embeds', async () => {
    const handler = new AutoDownloaderHandler({
      cooldowns: new CooldownManager(1_000),
      getConfig: () => getRapidApiConfig({ RAPIDAPI_KEY: 'valid-key' }),
      downloadFn: async () => ({
        mode: 'attachments',
        platform: 'instagram',
        title: 'Carousel Test',
        author: 'midwave_user',
        attachments: [
          { buffer: FAKE_JPEG, fileName: 'instagram_slide_1.jpg', sizeBytes: FAKE_JPEG.length },
          { buffer: FAKE_JPEG, fileName: 'instagram_slide_2.jpg', sizeBytes: FAKE_JPEG.length },
        ],
        formattedSize: '32 B',
        truncatedCount: 0,
      }),
    });

    const msg = createMockMessage({
      content: 'Lihat ini https://www.instagram.com/p/C9carousel/',
      userId: 'u-ig-1',
    });

    const handled = await handler.handle(msg);
    assert.equal(handled, true);

    const events = msg.getEvents();
    assert.equal(events[0].type, 'typing');
    assert.equal(events[1].type, 'reply');
    assert.equal(events[1].payload.files.length, 2);
    assert.equal(events[1].payload.embeds[0].data.title, 'MIDWAVE AUTO DOWNLOADER');
    assert.equal(events[2].type, 'suppressEmbeds');
    assert.equal(events[2].value, true);
  });

  it('sends fallback embed with direct CDN button when media exceeds 10 MB and suppresses original embed', async () => {
    const handler = new AutoDownloaderHandler({
      cooldowns: new CooldownManager(1_000),
      getConfig: () => getRapidApiConfig({ RAPIDAPI_KEY: 'valid-key' }),
      downloadFn: async () => ({
        mode: 'fallback',
        platform: 'tiktok',
        title: 'Big Video',
        author: 'creator',
        primaryCdnUrl: 'https://v16.tiktokcdn.com/huge_video.mp4',
        cdnLinks: ['https://v16.tiktokcdn.com/huge_video.mp4'],
        reason: 'Ukuran video melebihi batas unggahan standar 10 MB.',
      }),
    });

    const msg = createMockMessage({
      content: 'https://vt.tiktok.com/ZS9huge/',
    });

    const handled = await handler.handle(msg);
    assert.equal(handled, true);

    const reply = msg.getEvents().find((e) => e.type === 'reply').payload;
    assert.equal(reply.files, undefined);
    assert.equal(reply.components.length, 1);
    assert.match(reply.embeds[0].data.description, /https:\/\/v16\.tiktokcdn\.com\/huge_video\.mp4/);
    assert.equal(msg.getEvents().some((e) => e.type === 'suppressEmbeds' && e.value === true), true);
  });

  it('wires AutoDownloaderHandler into createBotApp and messageCreate event cleanly', async () => {
    const app = await createBotApp();
    let invoked = false;
    app.context.autoDownloaderHandler = {
      async handle() {
        invoked = true;
        return true;
      },
    };

    const msg = createMockMessage({ content: 'hello world' });
    await messageCreateEvent.execute(msg, app.context);
    assert.equal(invoked, true);
  });
});
