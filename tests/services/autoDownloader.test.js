import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EMOJIS } from '../../src/config/emojis.js';
import { AutoDownloaderHandler } from '../../src/handlers/AutoDownloaderHandler.js';
import messageCreateEvent from '../../src/events/messageCreate.js';
import { createBotApp } from '../../src/index.js';
import {
  DOWNLOADER_ERROR_CODES,
  DownloaderError,
  cleanupTempDir,
  downloadMediaFromUrl,
  getDownloaderConfig,
} from '../../src/services/downloader.js';
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

  it('ignores non-auto-download domains, homepages, bare profiles, and credential URLs', () => {
    assert.deepEqual(detectMediaUrls('https://www.youtube.com/watch?v=123'), []);
    assert.deepEqual(detectMediaUrls('https://www.tiktok.com/'), []);
    assert.deepEqual(detectMediaUrls('https://www.tiktok.com/@onlyprofile'), []);
    assert.deepEqual(detectMediaUrls('https://user:pass@www.instagram.com/reel/abc/'), []);
  });
});

describe('AutoDownloader — yt-dlp Integration & Discord Handling', () => {
  it('downloads valid TikTok video attachment via yt-dlp runner and cleans temp dir', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-autodl-'));
    try {
      const config = {
        ...getDownloaderConfig({}),
        tempBaseDir: tempRoot,
      };

      const result = await downloadMediaFromUrl({
        url: 'https://www.tiktok.com/@midwave/video/123456',
        config,
        deps: {
          lookupFn: publicLookup,
          ytdlpRunner: async ({ jobDir }) => {
            const p = path.join(jobDir, 'tt.mp4');
            await fs.writeFile(p, FAKE_MP4);
            return {
              ok: true,
              extractor: 'TikTok',
              title: 'Demo TikTok',
              author: 'midwave',
              files: [{ path: p, filename: 'tt.mp4', size_bytes: FAKE_MP4.length, ext: 'mp4' }],
            };
          },
        },
      });

      assert.equal(result.mode, 'attachments');
      assert.equal(result.provider, 'yt-dlp');
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].fileName, 'tiktok_video.mp4');
      await cleanupTempDir(result.jobDir);
      assert.deepEqual(await fs.readdir(tempRoot), []);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('ignores bot messages, prefix commands, and disabled AUTO_DOWNLOAD_ENABLED', async () => {
    const handler = new AutoDownloaderHandler({
      cooldowns: new CooldownManager(0),
      getConfig: () => getDownloaderConfig({ AUTO_DOWNLOAD_ENABLED: 'false' }),
    });

    const botMsg = createMockMessage({
      content: 'https://www.tiktok.com/@a/video/1',
      bot: true,
    });
    assert.equal(await handler.handle(botMsg), false);

    const prefixMsg = createMockMessage({
      content: '!menu https://www.tiktok.com/@a/video/1',
    });
    assert.equal(await handler.handle(prefixMsg), false);

    const disabledMsg = createMockMessage({
      content: 'https://www.tiktok.com/@a/video/1',
    });
    assert.equal(await handler.handle(disabledMsg), false);
    assert.equal(disabledMsg.getEvents().length, 0);
  });

  it('sends typing indicator, attaches downloaded carousel files with compact plain text, and suppresses original embeds', async () => {
    const handler = new AutoDownloaderHandler({
      cooldowns: new CooldownManager(1_000),
      getConfig: () => getDownloaderConfig({}),
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
    assert.equal(events[1].payload.embeds, undefined);
    assert.equal(events[1].payload.files.length, 2);
    assert.equal(
      events[1].payload.content,
      `${EMOJIS.success} @midwave_user · Instagram\n\nCarousel Test · JPG · 32 B`,
    );
    assert.equal(events[2].type, 'suppressEmbeds');
    assert.equal(events[2].value, true);
  });

  it('sends TikTok auto-download video attachment with compact plain text and handles missing metadata gracefully', async () => {
    const handler = new AutoDownloaderHandler({
      cooldowns: new CooldownManager(0),
      getConfig: () => getDownloaderConfig({}),
      downloadFn: async () => ({
        mode: 'attachments',
        platform: 'tiktok',
        platformLabel: 'TikTok',
        title: '#trending #foryou',
        author: '',
        fileFormat: 'MP4',
        formattedSize: '392.2 KB',
        items: [
          { buffer: FAKE_MP4, fileName: 'tiktok_video.mp4', sizeBytes: Math.round(392.2 * 1024), format: 'MP4' },
        ],
      }),
    });

    const msg = createMockMessage({
      content: 'https://vt.tiktok.com/ZS2abcd/',
    });

    const handled = await handler.handle(msg);
    assert.equal(handled, true);

    const reply = msg.getEvents().find((e) => e.type === 'reply').payload;
    assert.equal(reply.embeds, undefined);
    assert.equal(reply.files.length, 1);
    assert.equal(reply.files[0].name, 'tiktok_video.mp4');
    assert.equal(reply.content, `${EMOJIS.success} TikTok\n\n#trending #foryou · MP4 · 392.2 KB`);
  });

  it('informs user cleanly in compact plain text when file exceeds Discord limit instead of posting external links', async () => {
    const handler = new AutoDownloaderHandler({
      cooldowns: new CooldownManager(1_000),
      getConfig: () => getDownloaderConfig({}),
      logger: { error() {} },
      downloadFn: async () => {
        throw new DownloaderError(
          DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE,
          'Ukuran media (32 MB) melebihi batas unggahan 10 MB Discord.',
        );
      },
    });

    const msg = createMockMessage({
      content: 'https://vt.tiktok.com/ZS9huge/',
    });

    const handled = await handler.handle(msg);
    assert.equal(handled, true);

    const reply = msg.getEvents().find((e) => e.type === 'reply').payload;
    assert.equal(reply.files, undefined);
    assert.equal(reply.components, undefined);
    assert.equal(reply.embeds, undefined);
    assert.equal(reply.content, `${EMOJIS.error} Download failed · File exceeds Discord upload limit`);
  });

  it('wires AutoDownloaderHandler into createBotApp and messageCreate event cleanly', async () => {
    const app = await createBotApp({ skipTempCleanup: true });
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
    app.shutdown();
  });
});
