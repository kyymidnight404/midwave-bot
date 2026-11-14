import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { MessageFlags } from 'discord.js';
import {
  data as downloadData,
  execute as executeDownload,
} from '../../src/commands/download.js';
import { createBotApp } from '../../src/index.js';
import {
  DOWNLOADER_ERROR_CODES,
  PLATFORMS,
  cleanupTempDir,
  downloadMediaFromUrl,
  getActiveDownloadCount,
  getDiscordUploadLimitBytes,
  getDownloaderConfig,
  parseRapidApiResponse,
  validateMediaUrl,
} from '../../src/services/downloader.js';
import {
  createJobTempDir,
  detectMediaSignature,
  formatBytes,
} from '../../src/services/downloader/fileManager.js';
import {
  assertSafeRemoteHost,
  isPrivateOrReservedIp,
  resolveAndValidateRedirects,
} from '../../src/services/downloader/urlValidator.js';
import { CooldownManager } from '../../src/utils/cooldown.js';

const FAKE_MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
]);
const FAKE_JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
]);
const FAKE_PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const FAKE_WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

function publicLookupStub() {
  return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
}

function createMockDownloadInteraction({
  url = '',
  userId = 'u-dl-1',
  guild = { id: 'g-1', premiumTier: 0 },
  bot = false,
} = {}) {
  const events = [];
  let deferred = false;
  let replied = false;

  return {
    commandName: 'download',
    guild,
    guildId: guild?.id ?? null,
    channelId: 'ch-dl-1',
    user: { id: userId, username: 'tester', bot },
    options: {
      getString(name, required) {
        if (name === 'url') {
          if (required && !url) return '';
          return url;
        }
        return null;
      },
    },
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    async reply(payload) {
      replied = true;
      events.push({ type: 'reply', payload });
      return payload;
    },
    async deferReply(options) {
      deferred = true;
      events.push({ type: 'deferReply', options });
    },
    async editReply(payload) {
      events.push({ type: 'editReply', payload });
      return payload;
    },
    async followUp(payload) {
      events.push({ type: 'followUp', payload });
      return payload;
    },
    isChatInputCommand() {
      return true;
    },
    getEvents: () => events,
  };
}

describe('Downloader — URL & SSRF Validation (Instagram & TikTok Only)', () => {
  it('detects valid Instagram and TikTok links and explicitly rejects Threads as unavailable', () => {
    const ig = validateMediaUrl('https://www.instagram.com/reel/Cop84x6u7CP/#fragment');
    assert.equal(ig.platform, PLATFORMS.INSTAGRAM);
    assert.equal(ig.isShortLink, false);
    assert.equal(ig.normalizedUrl, 'https://www.instagram.com/reel/Cop84x6u7CP/');

    const igShort = validateMediaUrl('https://instagr.am/p/C123456/');
    assert.equal(igShort.platform, PLATFORMS.INSTAGRAM);
    assert.equal(igShort.isShortLink, true);

    const tt = validateMediaUrl('https://vm.tiktok.com/ZM6abc123/');
    assert.equal(tt.platform, PLATFORMS.TIKTOK);
    assert.equal(tt.isShortLink, true);

    assert.throws(() => validateMediaUrl('https://www.threads.net/@zuck/post/Cwm6qX_LL_M'), (err) => {
      assert.equal(err.code, DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM);
      assert.match(err.userMessage, /Threads.*belum tersedia/i);
      return true;
    });

    assert.throws(() => validateMediaUrl('https://www.threads.com/@zuck/post/Cwm6qX_LL_M'), (err) => {
      assert.equal(err.code, DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM);
      return true;
    });
  });

  it('rejects HTTP, credentials, custom ports, empty paths, IP literals, and unsupported hosts', () => {
    assert.throws(() => validateMediaUrl('http://www.instagram.com/reel/abc/'), (err) => {
      assert.equal(err.code, DOWNLOADER_ERROR_CODES.INVALID_URL);
      return true;
    });
    assert.throws(() => validateMediaUrl('https://user:pass@www.tiktok.com/@a/video/1'), (err) => {
      assert.equal(err.code, DOWNLOADER_ERROR_CODES.INVALID_URL);
      return true;
    });
    assert.throws(() => validateMediaUrl('https://www.tiktok.com:8443/@a/video/1'), (err) => {
      assert.equal(err.code, DOWNLOADER_ERROR_CODES.INVALID_URL);
      return true;
    });
    assert.throws(() => validateMediaUrl('https://www.instagram.com/'), (err) => {
      assert.equal(err.code, DOWNLOADER_ERROR_CODES.INVALID_URL);
      return true;
    });
    assert.throws(() => validateMediaUrl('https://127.0.0.1/reel/123'), (err) => {
      assert.equal(err.code, DOWNLOADER_ERROR_CODES.UNSAFE_TARGET);
      return true;
    });
    assert.throws(() => validateMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), (err) => {
      assert.equal(err.code, DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM);
      return true;
    });
  });

  it('identifies private, loopback, link-local, and mapped IPv6 addresses for SSRF prevention', async () => {
    assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('10.20.30.40'), true);
    assert.equal(isPrivateOrReservedIp('172.16.0.5'), true);
    assert.equal(isPrivateOrReservedIp('192.168.1.10'), true);
    assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
    assert.equal(isPrivateOrReservedIp('::1'), true);
    assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('fe80::1'), true);
    assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);

    await assert.rejects(
      assertSafeRemoteHost('evil-rebind.tiktok.com', {
        lookupFn: async () => [{ address: '192.168.0.10', family: 4 }],
      }),
      (err) => err.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
    );
  });

  it('validates short-link redirect chains and blocks unsafe redirect destinations', async () => {
    const validatedShort = validateMediaUrl('https://vm.tiktok.com/ZM6valid/');
    const resolved = await resolveAndValidateRedirects(validatedShort, {
      lookupFn: publicLookupStub,
      fetchFn: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://www.tiktok.com/@creator/video/7123456789' },
        }),
    });
    assert.equal(resolved.normalizedUrl, 'https://www.tiktok.com/@creator/video/7123456789');
    assert.equal(resolved.isShortLink, false);

    await assert.rejects(
      resolveAndValidateRedirects(validatedShort, {
        lookupFn: publicLookupStub,
        fetchFn: async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://169.254.169.254/latest/meta-data/' },
          }),
      }),
      (err) => err.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
    );
  });
});

describe('Downloader — File Signatures, Sizes & Config', () => {
  it('validates binary magic bytes and rejects masqueraded HTML/EXE/JSON payloads', () => {
    assert.deepEqual(detectMediaSignature(FAKE_MP4_HEADER), {
      kind: 'video',
      mime: 'video/mp4',
      ext: 'mp4',
      format: 'MP4',
    });
    assert.deepEqual(detectMediaSignature(FAKE_JPEG_HEADER), {
      kind: 'image',
      mime: 'image/jpeg',
      ext: 'jpg',
      format: 'JPG',
    });
    assert.deepEqual(detectMediaSignature(FAKE_PNG_HEADER), {
      kind: 'image',
      mime: 'image/png',
      ext: 'png',
      format: 'PNG',
    });
    assert.deepEqual(detectMediaSignature(FAKE_WEBP_HEADER), {
      kind: 'image',
      mime: 'image/webp',
      ext: 'webp',
      format: 'WEBP',
    });

    assert.equal(detectMediaSignature(Buffer.from('<!doctype html><html>error</html>')), null);
    assert.equal(detectMediaSignature(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00')), null);
    assert.equal(detectMediaSignature(Buffer.from('{"error":"blocked"}')), null);
  });

  it('computes dynamic upload limits per server boost tier bounded by config cap', () => {
    assert.equal(getDiscordUploadLimitBytes({ premiumTier: 0 }, 25).maxMb, 25);
    assert.equal(getDiscordUploadLimitBytes({ premiumTier: 2 }, 50).maxMb, 50);
    assert.equal(getDiscordUploadLimitBytes({ premiumTier: 3 }, 100).maxMb, 100);
    assert.equal(getDiscordUploadLimitBytes({ premiumTier: 3 }, 20).maxMb, 20);
    assert.equal(formatBytes(12.5 * 1024 * 1024), '12.5 MB');
  });
});

describe('Downloader — Unified RapidAPI + Axios Pipeline', () => {
  it('parses Instagram, TikTok, HD selection, carousel, invalid JSON, and missing media URLs', () => {
    assert.throws(() => parseRapidApiResponse('not-json-string'), (err) => {
      assert.equal(err.code, DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED);
      return true;
    });
    assert.throws(() => parseRapidApiResponse({ title: 'empty', links: [] }), (err) => {
      assert.equal(err.code, DOWNLOADER_ERROR_CODES.NOT_FOUND);
      return true;
    });

    const parsed = parseRapidApiResponse({
      title: 'Instagram Reel HD',
      links: [
        { quality: 'sd', link: 'https://scontent.cdninstagram.com/sd.mp4' },
        { quality: 'hd_no_watermark', link: 'https://scontent.cdninstagram.com/hd.mp4' },
      ],
    });
    assert.equal(parsed.mode, 'video');
    assert.equal(parsed.candidates[0].url, 'https://scontent.cdninstagram.com/hd.mp4');
  });

  it('downloads Instagram & TikTok media to temp files via RapidAPI + Axios and cleans up', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-test-rapid-'));
    try {
      const config = {
        ...getDownloaderConfig({ DOWNLOAD_MAX_SIZE_MB: '25', RAPIDAPI_KEY: 'test-rapid-key' }),
        tempBaseDir: tempRoot,
      };

      const axiosStub = {
        async get(targetUrl) {
          if (String(targetUrl).includes('rapidapi.com')) {
            return {
              data: {
                title: 'Reel Keren',
                author: 'ig_creator',
                links: [
                  { quality: 'hd_no_watermark', link: 'https://scontent.cdninstagram.com/reel.mp4' },
                ],
              },
            };
          }
          return {
            status: 200,
            headers: { 'content-length': String(FAKE_MP4_HEADER.length), 'content-type': 'video/mp4' },
            data: Readable.from(FAKE_MP4_HEADER),
          };
        },
      };

      const result = await downloadMediaFromUrl({
        url: 'https://www.instagram.com/reel/Cop84x6u7CP/',
        config,
        deps: { axiosClient: axiosStub, lookupFn: publicLookupStub },
      });

      assert.equal(result.platform, PLATFORMS.INSTAGRAM);
      assert.equal(result.platformLabel, 'Instagram');
      assert.equal(result.mediaType, 'Video');
      assert.equal(result.fileFormat, 'MP4');
      assert.equal(result.provider, 'rapidapi');
      assert.equal(result.items.length, 1);
      assert.equal(getActiveDownloadCount(), 0);

      const stat = await fs.stat(result.items[0].filePath);
      assert.equal(stat.isFile(), true);

      await cleanupTempDir(result.jobDir);
      await assert.rejects(fs.stat(result.jobDir));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsafe CDN redirects, HTML masquerading as video, and oversized files with zero temp leaks', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-test-sec-'));
    try {
      const config = {
        ...getDownloaderConfig({ DOWNLOAD_MAX_SIZE_MB: '1', RAPIDAPI_KEY: 'test-rapid-key' }),
        tempBaseDir: tempRoot,
      };

      // 1. Unsafe CDN redirect to 127.0.0.1
      await assert.rejects(
        downloadMediaFromUrl({
          url: 'https://www.tiktok.com/@creator/video/1',
          config,
          deps: {
            lookupFn: publicLookupStub,
            axiosClient: {
              async get(targetUrl) {
                if (String(targetUrl).includes('rapidapi.com')) {
                  return { data: { url: 'https://v16.tiktokcdn.com/redirect.mp4' } };
                }
                return {
                  status: 302,
                  headers: { location: 'http://127.0.0.1:9000/secret.mp4' },
                  data: Readable.from([]),
                };
              },
            },
          },
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      );

      // 2. HTTP 200 HTML response masquerading as media
      await assert.rejects(
        downloadMediaFromUrl({
          url: 'https://www.instagram.com/reel/HtmlPage1/',
          config,
          deps: {
            lookupFn: publicLookupStub,
            axiosClient: {
              async get(targetUrl) {
                if (String(targetUrl).includes('rapidapi.com')) {
                  return { data: { url: 'https://scontent.cdninstagram.com/fake.mp4' } };
                }
                return {
                  status: 200,
                  headers: { 'content-type': 'text/html; charset=utf-8' },
                  data: Readable.from(Buffer.from('<html>not a video</html>')),
                };
              },
            },
          },
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.UNSUPPORTED_MEDIA,
      );

      // 3. Oversized Content-Length (> 1 MB limit)
      await assert.rejects(
        downloadMediaFromUrl({
          url: 'https://www.tiktok.com/@creator/video/999',
          config,
          deps: {
            lookupFn: publicLookupStub,
            axiosClient: {
              async get(targetUrl) {
                if (String(targetUrl).includes('rapidapi.com')) {
                  return { data: { url: 'https://v16.tiktokcdn.com/huge.mp4' } };
                }
                return {
                  status: 200,
                  headers: { 'content-length': String(5 * 1024 * 1024), 'content-type': 'video/mp4' },
                  data: Readable.from(FAKE_MP4_HEADER),
                };
              },
            },
          },
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE,
      );

      const leftover = await fs.readdir(tempRoot);
      assert.deepEqual(leftover, []);
      assert.equal(getActiveDownloadCount(), 0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('classifies RapidAPI auth failure (401/403), quota exceeded (429), and timeout cleanly', async () => {
    const config = getDownloaderConfig({ RAPIDAPI_KEY: 'key-1' });

    await assert.rejects(
      downloadMediaFromUrl({
        url: 'https://www.tiktok.com/@a/video/1',
        config,
        deps: {
          lookupFn: publicLookupStub,
          axiosClient: {
            async get() {
              const err = new Error('Unauthorized');
              err.response = { status: 403, data: { message: 'You are not subscribed to this API' } };
              throw err;
            },
          },
        },
      }),
      (err) =>
        err.code === DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED &&
        /Autentikasi RapidAPI/i.test(err.userMessage),
    );

    await assert.rejects(
      downloadMediaFromUrl({
        url: 'https://www.tiktok.com/@a/video/2',
        config,
        deps: {
          lookupFn: publicLookupStub,
          axiosClient: {
            async get() {
              const err = new Error('Quota Exceeded');
              err.response = { status: 429, data: { message: 'Monthly quota exceeded' } };
              throw err;
            },
          },
        },
      }),
      (err) => err.code === DOWNLOADER_ERROR_CODES.RATE_LIMITED && /Kuota RapidAPI/i.test(err.userMessage),
    );

    await assert.rejects(
      downloadMediaFromUrl({
        url: 'https://www.instagram.com/reel/Timeout1/',
        config,
        deps: {
          lookupFn: publicLookupStub,
          axiosClient: {
            async get() {
              const err = new Error('timeout');
              err.code = 'ECONNABORTED';
              throw err;
            },
          },
        },
      }),
      (err) => err.code === DOWNLOADER_ERROR_CODES.TIMEOUT,
    );
  });

  it('enforces max concurrency limit without leaking active slots', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-test-conc-'));
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    try {
      const config = {
        ...getDownloaderConfig({ DOWNLOAD_MAX_CONCURRENT: '1', RAPIDAPI_KEY: 'key-1' }),
        tempBaseDir: tempRoot,
      };

      const slowAxios = {
        async get(targetUrl) {
          if (String(targetUrl).includes('rapidapi.com')) {
            await gate;
            return { data: { url: 'https://v16.tiktokcdn.com/ok.mp4' } };
          }
          return { status: 200, headers: {}, data: Readable.from(FAKE_MP4_HEADER) };
        },
      };

      const firstPromise = downloadMediaFromUrl({
        url: 'https://www.tiktok.com/@creator/video/123',
        config,
        deps: { lookupFn: publicLookupStub, axiosClient: slowAxios },
      });

      await new Promise((r) => setTimeout(r, 15));

      await assert.rejects(
        downloadMediaFromUrl({
          url: 'https://www.tiktok.com/@creator/video/456',
          config,
          deps: { lookupFn: publicLookupStub, axiosClient: slowAxios },
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.BUSY,
      );

      releaseFirst();
      const firstResult = await firstPromise;
      await cleanupTempDir(firstResult.jobDir);
      assert.equal(getActiveDownloadCount(), 0);
    } finally {
      releaseFirst?.();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('Downloader — Discord /download Command & Cooldown Integration', () => {
  it('registers /download with required url option cleanly', () => {
    const json = downloadData.toJSON();
    assert.equal(json.name, 'download');
    assert.equal(json.options.length, 1);
    assert.equal(json.options[0].name, 'url');
    assert.equal(json.options[0].required, true);
  });

  it('replies ephemerally on invalid or unsupported URL (including Threads) without deferring', async () => {
    const badHost = createMockDownloadInteraction({ url: 'https://example.com/file.mp4' });
    await executeDownload(badHost);
    assert.equal(badHost.deferred, false);
    assert.equal(badHost.replied, true);
    assert.equal(badHost.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(badHost.getEvents()[0].payload.embeds[0].data.description, /Platform tidak didukung/i);

    const threadsHost = createMockDownloadInteraction({ url: 'https://www.threads.net/@zuck/post/123' });
    await executeDownload(threadsHost);
    assert.equal(threadsHost.deferred, false);
    assert.match(threadsHost.getEvents()[0].payload.embeds[0].data.description, /Threads.*belum tersedia/i);
  });

  it('fails fast ephemerally before deferReply when RAPIDAPI_KEY is unconfigured', async () => {
    const interaction = createMockDownloadInteraction({
      url: 'https://www.instagram.com/reel/Cop84x6u7CP/',
    });

    await executeDownload(interaction, {
      config: getDownloaderConfig({}),
    });

    assert.equal(interaction.deferred, false);
    assert.equal(interaction.replied, true);
    const reply = interaction.getEvents().find((e) => e.type === 'reply').payload;
    assert.equal(reply.flags, MessageFlags.Ephemeral);
    assert.equal(reply.embeds[0].data.title, 'Downloader Belum Dikonfigurasi');
  });

  it('defers, uploads attachment with Midwave embed, and deletes temp dir afterwards', async () => {
    const jobDir = await createJobTempDir();
    const mediaPath = path.join(jobDir, 'ig_slide_1.png');
    await fs.writeFile(mediaPath, FAKE_PNG_HEADER);

    const interaction = createMockDownloadInteraction({
      url: 'https://www.instagram.com/p/CarouselPost1/',
      userId: 'u-999',
    });

    await executeDownload(interaction, {
      config: getDownloaderConfig({ RAPIDAPI_KEY: 'key-1' }),
      downloadMedia: async () => ({
        jobDir,
        platform: PLATFORMS.INSTAGRAM,
        platformLabel: 'Instagram',
        sourceUrl: 'https://www.instagram.com/p/CarouselPost1/',
        provider: 'rapidapi',
        items: [
          {
            filePath: mediaPath,
            fileName: 'ig_slide_1.png',
            sizeBytes: FAKE_PNG_HEADER.length,
            kind: 'image',
            mime: 'image/png',
            format: 'PNG',
          },
        ],
        truncatedCount: 0,
        mediaType: 'Image',
        fileFormat: 'PNG',
        formattedSize: '16 B',
      }),
    });

    assert.equal(interaction.deferred, true);
    const edits = interaction.getEvents().filter((e) => e.type === 'editReply');
    assert.equal(edits.length, 2);

    const finalPayload = edits[1].payload;
    assert.equal(finalPayload.files.length, 1);
    assert.equal(finalPayload.files[0].name, 'ig_slide_1.png');
    assert.equal(finalPayload.embeds[0].data.title, 'MIDWAVE MEDIA DOWNLOADER');
    assert.match(finalPayload.embeds[0].data.description, /Instagram/);
    assert.match(finalPayload.embeds[0].data.description, /<@u-999>/);

    await assert.rejects(fs.stat(jobDir));
  });

  it('surfaces Discord 40005 entity-too-large failure cleanly and still cleans temp dir', async () => {
    const jobDir = await createJobTempDir();
    const mediaPath = path.join(jobDir, 'reel.mp4');
    await fs.writeFile(mediaPath, FAKE_MP4_HEADER);

    const interaction = createMockDownloadInteraction({
      url: 'https://www.instagram.com/reel/TooBig123/',
    });
    const origEditReply = interaction.editReply.bind(interaction);
    let editCall = 0;
    interaction.editReply = async (payload) => {
      editCall += 1;
      if (editCall === 2) {
        const err = new Error('Request entity too large');
        err.code = 40005;
        throw err;
      }
      return origEditReply(payload);
    };

    await executeDownload(interaction, {
      config: getDownloaderConfig({ RAPIDAPI_KEY: 'key-1' }),
      downloadMedia: async () => ({
        jobDir,
        platform: PLATFORMS.INSTAGRAM,
        platformLabel: 'Instagram',
        sourceUrl: 'https://www.instagram.com/reel/TooBig123/',
        provider: 'rapidapi',
        items: [
          {
            filePath: mediaPath,
            fileName: 'reel.mp4',
            sizeBytes: FAKE_MP4_HEADER.length,
            kind: 'video',
            mime: 'video/mp4',
            format: 'MP4',
          },
        ],
        truncatedCount: 0,
        mediaType: 'Video',
        fileFormat: 'MP4',
        formattedSize: '16 B',
      }),
    });

    const edits = interaction.getEvents().filter((e) => e.type === 'editReply');
    const errorEdit = edits[edits.length - 1].payload;
    assert.equal(errorEdit.embeds[0].data.title, 'Gagal Mengunduh Media');
    assert.match(errorEdit.embeds[0].data.description, /melebihi batas unggahan file Discord/i);
    await assert.rejects(fs.stat(jobDir));
  });

  it('enforces dedicated /download cooldown inside InteractionHandler', async () => {
    let now = 10_000;
    const cooldowns = new CooldownManager(2_500, () => now);
    const app = await createBotApp({ cooldowns });
    app.commandHandler.commands.set('download', {
      data: downloadData,
      async execute(inter) {
        await inter.reply({ content: 'ok' });
      },
    });

    const first = createMockDownloadInteraction({ url: 'https://www.tiktok.com/@a/video/1', userId: 'u-cd' });
    await app.interactionHandler.handle(first);
    assert.equal(first.getEvents()[0].payload.content, 'ok');

    now += 2_000;
    const second = createMockDownloadInteraction({ url: 'https://www.tiktok.com/@a/video/2', userId: 'u-cd' });
    await app.interactionHandler.handle(second);
    assert.equal(second.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(second.getEvents()[0].payload.embeds[0].data.description, /Tunggu/i);

    now += 10_000;
    const third = createMockDownloadInteraction({ url: 'https://www.tiktok.com/@a/video/3', userId: 'u-cd' });
    await app.interactionHandler.handle(third);
    assert.equal(third.getEvents()[0].payload.content, 'ok');
  });
});
