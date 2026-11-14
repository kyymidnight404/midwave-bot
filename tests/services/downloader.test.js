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
  DEFAULT_INSTAGRAM_RAPIDAPI_PATH,
  DEFAULT_TIKTOK_RAPIDAPI_PATH,
  DOWNLOADER_ERROR_CODES,
  PLATFORMS,
  cleanupTempDir,
  downloadMediaFromUrl,
  extractInstagramShortcode,
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

  it('normalizes tracking query params, rejects login walls, and handles object-map / JSON-string RapidAPI schemas', () => {
    const igClean = validateMediaUrl(
      'https://www.instagram.com/reel/AbCdEf123/?igsh=MzRlODBiNWFlZA==&utm_source=ig_web_copy_link',
    );
    assert.equal(igClean.normalizedUrl, 'https://www.instagram.com/reel/AbCdEf123/');

    const ttClean = validateMediaUrl(
      'https://www.tiktok.com/@midwave/video/7400000000000000000?_t=8pABC&_r=1',
    );
    assert.equal(ttClean.normalizedUrl, 'https://www.tiktok.com/@midwave/video/7400000000000000000');

    assert.throws(
      () => validateMediaUrl('https://www.instagram.com/accounts/login/?next=/reel/123/'),
      (err) => err.code === DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
    );

    const fromMap = parseRapidApiResponse(
      JSON.stringify({
        success: true,
        links: {
          hd_no_watermark: 'https://v16.tiktokcdn.com/hd.mp4',
          sd: 'https://v16.tiktokcdn.com/sd.mp4',
          audio: 'https://v16.tiktokcdn.com/audio.mp3',
        },
      }),
    );
    assert.equal(fromMap.mode, 'video');
    assert.equal(fromMap.candidates[0].url, 'https://v16.tiktokcdn.com/hd.mp4');

    assert.throws(
      () => parseRapidApiResponse({ success: false, message: 'Invalid API key' }),
      (err) => err.code === DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
    );

    assert.throws(
      () => parseRapidApiResponse({ success: false, message: 'Unsupported URL' }),
      (err) => err.code === DOWNLOADER_ERROR_CODES.UNSUPPORTED_PLATFORM,
    );
  });

  it('maps missing-route 404 to EXTRACTION_FAILED and never leaks API key or signed CDN tokens in logs', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-test-logging-'));
    const secretKey = 'SUPER_SECRET_RAPIDAPI_KEY_12345';
    const warnLogs = [];
    const safeLogger = {
      warn: (msg) => warnLogs.push(String(msg)),
    };

    try {
      const customConfig = {
        ...getDownloaderConfig({
          RAPIDAPI_KEY: secretKey,
          RAPIDAPI_ENDPOINT: 'https://social-media-video-downloader.p.rapidapi.com/custom/wrong',
        }),
        tempBaseDir: tempRoot,
      };

      await assert.rejects(
        downloadMediaFromUrl({
          url: 'https://www.tiktok.com/@creator/video/123',
          config: customConfig,
          deps: {
            lookupFn: publicLookupStub,
            logger: safeLogger,
            axiosClient: {
              async get() {
                const err = new Error('Not Found https://cdn.tiktokcdn.com/video.mp4?token=SIGNED_SECRET_999');
                err.response = {
                  status: 404,
                  data: { message: "Endpoint '/custom/wrong' does not exist" },
                };
                throw err;
              },
            },
          },
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      );

      assert.equal(warnLogs.length, 1);
      assert.equal(warnLogs[0].includes(secretKey), false);
      assert.equal(warnLogs[0].includes('SIGNED_SECRET_999'), false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses GET /tiktok/v3/post/details for TikTok (4 variants, H.264 priority, non-H.264 fallback, playAddr fallback, metadata, and error/HTML/size/cleanup checks)', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-test-ttv3-'));

    const fourVariantResponse = {
      error: null,
      contents: [
        {
          videos: [
            {
              label: '1080p_hevc',
              url: 'https://v16.tiktokcdn.com/1080_h265.mp4?x-expires=999',
              repId: 'rep-hevc-1080',
              metadata: {
                mime_type: 'video/mp4',
                content_length: 4_000_000,
                width: 1080,
                height: 1920,
                has_audio: true,
                CodecType: 'h265',
                Format: 'mp4',
              },
            },
            {
              label: '720p_h264',
              url: 'https://v16.tiktokcdn.com/720_h264.mp4?x-expires=999',
              repId: 'rep-h264-720',
              metadata: {
                mime_type: 'video/mp4',
                content_length: 2_500_000,
                width: 720,
                height: 1280,
                has_audio: true,
                CodecType: 'h264',
                Format: 'mp4',
              },
            },
            {
              label: '540p_h264',
              url: 'https://v16.tiktokcdn.com/540_h264.mp4?x-expires=999',
              repId: 'rep-h264-540',
              metadata: {
                mime_type: 'video/mp4',
                content_length: 1_500_000,
                width: 540,
                height: 960,
                has_audio: true,
                CodecType: 'h264',
                Format: 'mp4',
              },
            },
            {
              label: '720p_hevc',
              url: 'https://v16.tiktokcdn.com/720_h265.mp4?x-expires=999',
              repId: 'rep-hevc-720',
              metadata: {
                mime_type: 'video/mp4',
                content_length: 2_000_000,
                width: 720,
                height: 1280,
                has_audio: true,
                CodecType: 'hevc',
                Format: 'mp4',
              },
            },
          ],
          renderableAudios: [{ url: 'https://v16.tiktokcdn.com/audio_only.mp3' }],
        },
      ],
      metadata: {
        title: 'TikTok V3 Demo Caption',
        author: { user: { uniqueId: 'midwave_tt', nickname: 'Midwave TT' } },
        thumbnailUrl: 'https://p16.tiktokcdn.com/thumb.jpg',
      },
      additionalData: {
        video: {
          playAddr: 'https://v16.tiktokcdn.com/play_addr_fallback.mp4',
          downloadAddr: 'https://v16.tiktokcdn.com/download_addr_ignored_dup.mp4',
          cover: 'https://p16.tiktokcdn.com/cover.jpg',
          duration: 15,
        },
        stats: { playCount: 1000 },
      },
    };

    try {
      // 1 & 2. 4 variants -> H.264 720p selected first, only 1 attachment sent, no audio/downloadAddr duplication
      const parsed4 = parseRapidApiResponse(fourVariantResponse);
      assert.equal(parsed4.mode, 'video');
      assert.equal(parsed4.title, 'TikTok V3 Demo Caption');
      assert.equal(parsed4.author, 'midwave_tt');
      assert.match(parsed4.candidates[0].url, /720_h264\.mp4/);
      assert.equal(parsed4.candidates.some((c) => c.url.includes('audio_only')), false);
      assert.equal(parsed4.candidates.some((c) => c.url.includes('download_addr_ignored_dup')), false);

      const config = {
        ...getDownloaderConfig({ RAPIDAPI_KEY: 'tt-live-key', DOWNLOAD_MAX_SIZE_MB: '1' }),
        tempBaseDir: tempRoot,
      };

      let capturedRequest = null;
      const ttResult = await downloadMediaFromUrl({
        url: 'https://www.tiktok.com/@midwave_tt/video/7400000000000000000',
        config,
        deps: {
          lookupFn: publicLookupStub,
          axiosClient: {
            async get(targetUrl, opts) {
              if (targetUrl.includes('rapidapi.com')) {
                capturedRequest = { url: targetUrl, params: opts.params, headers: opts.headers };
                return { data: fourVariantResponse };
              }
              return {
                status: 200,
                headers: { 'content-type': 'video/mp4' },
                data: Readable.from(FAKE_MP4_HEADER),
              };
            },
          },
        },
      });

      assert.ok(capturedRequest.url.endsWith(DEFAULT_TIKTOK_RAPIDAPI_PATH));
      assert.equal(
        capturedRequest.params.url,
        'https://www.tiktok.com/@midwave_tt/video/7400000000000000000',
      );
      assert.equal(ttResult.items.length, 1);
      assert.equal(ttResult.author, 'midwave_tt');
      assert.equal(ttResult.title, 'TikTok V3 Demo Caption');
      assert.equal(ttResult.items[0].mime, 'video/mp4');
      await cleanupTempDir(ttResult.jobDir);

      // 3. Fallback when H.264 is unavailable -> selects valid non-H.264 MP4
      const nonH264 = parseRapidApiResponse({
        error: null,
        contents: [
          {
            videos: [
              {
                label: '1080p_hevc',
                url: 'https://v16.tiktokcdn.com/only_hevc.mp4',
                metadata: { mime_type: 'video/mp4', width: 1080, height: 1920, CodecType: 'h265', Format: 'mp4' },
              },
            ],
          },
        ],
      });
      assert.equal(nonH264.candidates[0].url, 'https://v16.tiktokcdn.com/only_hevc.mp4');

      // 4. Fallback to additionalData.video.playAddr when contents[0].videos is empty
      const playAddrOnly = parseRapidApiResponse({
        error: null,
        contents: [{ videos: [] }],
        additionalData: {
          video: {
            playAddr: 'https://v16.tiktokcdn.com/play_addr_only.mp4',
            downloadAddr: 'https://v16.tiktokcdn.com/download_addr_dup.mp4',
          },
        },
      });
      assert.equal(playAddrOnly.candidates.length, 1);
      assert.equal(playAddrOnly.candidates[0].url, 'https://v16.tiktokcdn.com/play_addr_only.mp4');

      // 5. Error NOT_FOUND when no valid video is present
      assert.throws(
        () =>
          parseRapidApiResponse({
            error: null,
            contents: [{ videos: [] }],
            additionalData: { video: {} },
          }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.NOT_FOUND,
      );

      // 6. Reject HTML masquerading as video
      await assert.rejects(
        downloadMediaFromUrl({
          url: 'https://www.tiktok.com/@midwave_tt/video/7400000000000000001',
          config,
          deps: {
            lookupFn: publicLookupStub,
            axiosClient: {
              async get(targetUrl) {
                if (targetUrl.includes('rapidapi.com')) return { data: fourVariantResponse };
                return {
                  status: 200,
                  headers: { 'content-type': 'text/html' },
                  data: Readable.from(Buffer.from('<html>blocked</html>')),
                };
              },
            },
          },
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.UNSUPPORTED_MEDIA,
      );

      // 7. Reject actual streamed file exceeding limit even if metadata.content_length lied
      const oversizedPayload = Buffer.concat([FAKE_MP4_HEADER, Buffer.alloc(1.2 * 1024 * 1024)]);
      await assert.rejects(
        downloadMediaFromUrl({
          url: 'https://www.tiktok.com/@midwave_tt/video/7400000000000000002',
          config,
          deps: {
            lookupFn: publicLookupStub,
            axiosClient: {
              async get(targetUrl) {
                if (targetUrl.includes('rapidapi.com')) return { data: fourVariantResponse };
                return {
                  status: 200,
                  headers: { 'content-type': 'video/mp4' },
                  data: Readable.from(oversizedPayload),
                };
              },
            },
          },
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE,
      );

      // 8. Verify temp dir cleanup
      assert.deepEqual(await fs.readdir(tempRoot), []);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('extracts Instagram shortcodes (/p/, /reel/, /tv/) and uses /instagram/v3/media/post/details for single image DfrczbZiueP, carousel, and video while ignoring polaris timeline edges', async () => {
    assert.equal(extractInstagramShortcode('https://www.instagram.com/p/DfrczbZiueP/?igsh=abc'), 'DfrczbZiueP');
    assert.equal(extractInstagramShortcode('https://www.instagram.com/reel/DfrczbZiueP/'), 'DfrczbZiueP');
    assert.equal(extractInstagramShortcode('https://www.instagram.com/tv/C9tv123/'), 'C9tv123');
    assert.equal(extractInstagramShortcode('https://www.instagram.com/stories/user/123'), null);

    // 1. Single image response matching live Get-Instagram-Media-Post-Details payload (including polaris timeline edges distraction)
    const singleParsed = parseRapidApiResponse({
      error: null,
      contents: [
        {
          images: [
            {
              label: '640x761',
              url: 'https://scontent.cdninstagram.com/thumb_640.jpg',
              metadata: { width: 640, height: 761, mime_type: 'image/jpeg' },
            },
            {
              label: '1184x1408',
              url: 'https://scontent.cdninstagram.com/full_1184.jpg',
              metadata: { width: 1184, height: 1408, mime_type: 'image/jpeg' },
            },
          ],
        },
      ],
      metadata: {
        title: 'Live Shot DfrczbZiueP',
        author: { username: 'midwave_official' },
      },
      additionalData: {
        media_type: 1,
        image_versions2: {
          candidates: [
            { url: 'https://scontent.cdninstagram.com/alt_highres.jpg', width: 1184, height: 1408 },
          ],
        },
        polaris_ordered_timeline_connection: {
          edges: [
            {
              node: {
                url: 'https://scontent.cdninstagram.com/unrelated_feed_post.jpg',
              },
            },
          ],
        },
      },
    });

    assert.equal(singleParsed.mode, 'image');
    assert.equal(singleParsed.title, 'Live Shot DfrczbZiueP');
    assert.equal(singleParsed.author, 'midwave_official');
    assert.equal(singleParsed.candidates[0].url, 'https://scontent.cdninstagram.com/full_1184.jpg');
    assert.equal(
      singleParsed.candidates.some((c) => c.url.includes('unrelated_feed_post')),
      false,
    );

    // 2. End-to-end single image download with shortcode DfrczbZiueP -> 1 .jpg attachment (no duplicate fallback attachment)
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-test-igv3-'));
    try {
      const config = {
        ...getDownloaderConfig({ RAPIDAPI_KEY: 'ig-live-key' }),
        tempBaseDir: tempRoot,
      };
      let capturedRequest = null;

      const igSingleResult = await downloadMediaFromUrl({
        url: 'https://www.instagram.com/p/DfrczbZiueP/?igsh=xyz',
        config,
        deps: {
          lookupFn: publicLookupStub,
          axiosClient: {
            async get(targetUrl, opts) {
              if (targetUrl.includes('rapidapi.com')) {
                capturedRequest = { url: targetUrl, params: opts.params, headers: opts.headers };
                return {
                  data: {
                    error: null,
                    contents: [
                      {
                        images: [
                          {
                            label: '1184x1408',
                            url: 'https://scontent.cdninstagram.com/full_1184.jpg',
                            metadata: { width: 1184, height: 1408, mime_type: 'image/jpeg' },
                          },
                        ],
                      },
                    ],
                    metadata: { title: 'Post DfrczbZiueP', author: { username: 'creator_ig' } },
                    additionalData: {
                      media_type: 1,
                      image_versions2: {
                        candidates: [{ url: 'https://scontent.cdninstagram.com/alt_highres.jpg' }],
                      },
                    },
                  },
                };
              }
              return {
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
                data: Readable.from(FAKE_JPEG_HEADER),
              };
            },
          },
        },
      });

      assert.ok(capturedRequest.url.endsWith(DEFAULT_INSTAGRAM_RAPIDAPI_PATH));
      assert.equal(capturedRequest.url.includes('/smvd/get/'), false);
      assert.equal(capturedRequest.params.shortcode, 'DfrczbZiueP');
      assert.equal(capturedRequest.params.renderableFormats, '720p');
      assert.equal(igSingleResult.items.length, 1);
      assert.equal(igSingleResult.items[0].format, 'JPG');
      assert.equal(igSingleResult.items[0].mime, 'image/jpeg');
      assert.equal(igSingleResult.items[0].fileName.endsWith('.jpg'), true);
      await cleanupTempDir(igSingleResult.jobDir);

      // 3. Instagram Carousel (multiple items in contents) -> multiple .jpg attachments
      const igCarouselResult = await downloadMediaFromUrl({
        url: 'https://www.instagram.com/p/CarouselPost99/',
        config,
        deps: {
          lookupFn: publicLookupStub,
          axiosClient: {
            async get(targetUrl) {
              if (targetUrl.includes('rapidapi.com')) {
                return {
                  data: {
                    error: null,
                    contents: [
                      {
                        images: [
                          { label: '1080x1080', url: 'https://scontent.cdninstagram.com/slide1.jpg', metadata: { width: 1080, height: 1080 } },
                        ],
                      },
                      {
                        images: [
                          { label: '1080x1080', url: 'https://scontent.cdninstagram.com/slide2.jpg', metadata: { width: 1080, height: 1080 } },
                        ],
                      },
                    ],
                    metadata: { title: 'Carousel IG', author: { username: 'carousel_user' } },
                  },
                };
              }
              return {
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
                data: Readable.from(FAKE_JPEG_HEADER),
              };
            },
          },
        },
      });

      assert.equal(igCarouselResult.items.length, 2);
      assert.equal(igCarouselResult.items[0].fileName, 'instagram_slide_1.jpg');
      assert.equal(igCarouselResult.items[1].fileName, 'instagram_slide_2.jpg');
      await cleanupTempDir(igCarouselResult.jobDir);

      // 4. Instagram Video (contents[].videos[] / renderableVideos[]) -> .mp4 attachment
      const igVideoResult = await downloadMediaFromUrl({
        url: 'https://www.instagram.com/reel/ReelVideo99/',
        config,
        deps: {
          lookupFn: publicLookupStub,
          axiosClient: {
            async get(targetUrl) {
              if (targetUrl.includes('rapidapi.com')) {
                return {
                  data: {
                    error: null,
                    contents: [
                      {
                        videos: [
                          { label: '720p', url: 'https://scontent.cdninstagram.com/reel_720.mp4', metadata: { width: 720, height: 1280, mime_type: 'video/mp4' } },
                        ],
                        images: [
                          { label: '720x1280', url: 'https://scontent.cdninstagram.com/reel_cover.jpg' },
                        ],
                      },
                    ],
                    metadata: { title: 'Reel Video', author: { username: 'reel_creator' } },
                  },
                };
              }
              return {
                status: 200,
                headers: { 'content-type': 'video/mp4' },
                data: Readable.from(FAKE_MP4_HEADER),
              };
            },
          },
        },
      });

      assert.equal(igVideoResult.items.length, 1);
      assert.equal(igVideoResult.items[0].format, 'MP4');
      assert.equal(igVideoResult.items[0].mime, 'video/mp4');
      assert.equal(igVideoResult.items[0].fileName.endsWith('.mp4'), true);
      await cleanupTempDir(igVideoResult.jobDir);
    } finally {
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
