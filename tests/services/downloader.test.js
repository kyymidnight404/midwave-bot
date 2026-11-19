import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MessageFlags } from 'discord.js';
import mediaCommand, { data as mediaData } from '../../src/commands/media.js';
import downloadCommand, { execute as executeDownload } from '../../src/commands/download.js';
import { createBotApp } from '../../src/index.js';
import {
  DOWNLOADER_ERROR_CODES,
  DownloadQueue,
  PLATFORMS,
  assertInsideDir,
  cleanupStaleTempDirs,
  cleanupTempDir,
  downloadMediaFromUrl,
  ensureYtDlpZipapp,
  getActiveDownloadCount,
  getDiscordUploadLimitBytes,
  getDownloaderConfig,
  runYtDlpDownload,
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
  resolvePlatformLabel,
} from '../../src/services/downloader/platform.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

const FAKE_MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
]);
const FAKE_MP3_HEADER = Buffer.from([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
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
  mode = null,
  action = 'download',
  userId = 'u-dl-1',
  guild = { id: 'g-1', premiumTier: 0 },
  bot = false,
} = {}) {
  const events = [];
  let deferred = false;
  let replied = false;

  return {
    commandName: 'media',
    guild,
    guildId: guild?.id ?? null,
    channelId: 'ch-dl-1',
    user: { id: userId, username: 'tester', bot },
    isChatInputCommand: () => true,
    options: {
      getString(name, required) {
        if (name === 'action') return action;
        if (name === 'mode') return mode;
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
    getEvents: () => events,
  };
}

function createFakeSpawn({
  exitCode = 0,
  stdoutLines = [],
  stderrLines = [],
  emitError = null,
  delayMs = 5,
  onSpawn = null,
} = {}) {
  return (bin, args, opts) => {
    onSpawn?.({ bin, args, opts });
    const child = new EventEmitter();
    child.pid = 42424;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
      return true;
    };

    setTimeout(() => {
      if (emitError) {
        child.emit('error', emitError);
        return;
      }
      for (const line of stdoutLines) {
        child.stdout.emit('data', Buffer.from(`${line}\n`));
      }
      for (const line of stderrLines) {
        child.stderr.emit('data', Buffer.from(`${line}\n`));
      }
      if (!child.killed) {
        child.emit('close', exitCode);
      }
    }, delayMs);

    return child;
  };
}

describe('Downloader — Multi-Platform URL & SSRF Validation', () => {
  it('detects all major yt-dlp platforms and allows valid public HTTP/HTTPS URLs', () => {
    const cases = [
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', PLATFORMS.YOUTUBE, 'YouTube', false],
      ['https://youtu.be/dQw4w9WgXcQ', PLATFORMS.YOUTUBE, 'YouTube', true],
      ['https://www.tiktok.com/@creator/video/123456', PLATFORMS.TIKTOK, 'TikTok', false],
      ['https://vm.tiktok.com/ZM6abc123/', PLATFORMS.TIKTOK, 'TikTok', true],
      ['https://www.instagram.com/reel/Cop84x6u7CP/?igsh=abc#frag', PLATFORMS.INSTAGRAM, 'Instagram', false],
      ['https://www.facebook.com/watch/?v=123456789', PLATFORMS.FACEBOOK, 'Facebook', false],
      ['https://x.com/midwave/status/1234567890', PLATFORMS.TWITTER, 'X / Twitter', false],
      ['https://www.reddit.com/r/videos/comments/abc123/clip/', PLATFORMS.REDDIT, 'Reddit', false],
      ['https://clips.twitch.tv/FunClipSlug', PLATFORMS.TWITCH, 'Twitch', false],
      ['https://soundcloud.com/artist/track-name', PLATFORMS.SOUNDCLOUD, 'SoundCloud', false],
      ['https://vimeo.com/123456789', PLATFORMS.VIMEO, 'Vimeo', false],
      ['https://www.dailymotion.com/video/x8abcde', PLATFORMS.DAILYMOTION, 'Dailymotion', false],
      ['https://www.bilibili.com/video/BV1xx411c7mD', PLATFORMS.BILIBILI, 'Bilibili', false],
      ['http://example.com/media/video.mp4', PLATFORMS.WEB, 'example.com', false],
    ];

    for (const [input, expectedPlatform, expectedLabel, expectedShort] of cases) {
      const res = validateMediaUrl(input);
      assert.equal(res.platform, expectedPlatform, `platform mismatch for ${input}`);
      assert.equal(res.platformLabel, expectedLabel, `label mismatch for ${input}`);
      assert.equal(res.isShortLink, expectedShort, `shortLink mismatch for ${input}`);
    }

    assert.equal(resolvePlatformLabel('Youtube', PLATFORMS.WEB, ''), 'YouTube');
    assert.equal(resolvePlatformLabel('twitter:amplify', PLATFORMS.WEB, ''), 'X / Twitter');
  });

  it('rejects invalid schemes, credentials, custom ports, bare platform roots, IP literals, and internal hosts', () => {
    assert.throws(() => validateMediaUrl(''), (e) => e.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('not a url'), (e) => e.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('file:///etc/passwd'), (e) => e.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('ftp://example.com/v.mp4'), (e) => e.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('https://user:pass@www.youtube.com/watch?v=1'), (e) => e.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('https://www.tiktok.com:8443/@a/video/1'), (e) => e.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('https://www.youtube.com/'), (e) => e.code === DOWNLOADER_ERROR_CODES.INVALID_URL);
    assert.throws(() => validateMediaUrl('https://127.0.0.1/video.mp4'), (e) => e.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET);
    assert.throws(() => validateMediaUrl('http://localhost/video.mp4'), (e) => e.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET);
    assert.throws(() => validateMediaUrl('https://internal.local/video.mp4'), (e) => e.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET);
    assert.throws(() => validateMediaUrl('https://redis/secret'), (e) => e.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET);
    assert.throws(() => validateMediaUrl('https://www.instagram.com/accounts/login/'), (e) => e.code === DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED);
  });

  it('identifies private/reserved IPs and blocks unsafe short-link redirect chains', async () => {
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
      assertSafeRemoteHost('evil-rebind.example.com', {
        lookupFn: async () => [{ address: '192.168.0.10', family: 4 }],
      }),
      (err) => err.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
    );

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

describe('Downloader — File Signatures, Sizes, Config & Path Safety', () => {
  it('validates video, audio, and image magic bytes and rejects masqueraded HTML/EXE/JSON', () => {
    assert.deepEqual(detectMediaSignature(FAKE_MP4_HEADER), {
      kind: 'video',
      mime: 'video/mp4',
      ext: 'mp4',
      format: 'MP4',
    });
    assert.deepEqual(detectMediaSignature(FAKE_MP3_HEADER), {
      kind: 'audio',
      mime: 'audio/mpeg',
      ext: 'mp3',
      format: 'MP3',
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

  it('computes dynamic Discord upload limits and resolves yt-dlp configuration', () => {
    assert.equal(getDiscordUploadLimitBytes({ premiumTier: 0 }, 25).maxMb, 25);
    assert.equal(getDiscordUploadLimitBytes({ premiumTier: 2 }, 50).maxMb, 50);
    assert.equal(getDiscordUploadLimitBytes({ premiumTier: 3 }, 100).maxMb, 100);
    assert.equal(getDiscordUploadLimitBytes({ premiumTier: 3 }, 20).maxMb, 20);
    assert.equal(formatBytes(12.5 * 1024 * 1024), '12.5 MB');

    const cfg = getDownloaderConfig({
      PYTHON_PATH: '/usr/bin/python3',
      DOWNLOAD_MAX_SIZE_MB: '50',
      DOWNLOAD_TIMEOUT_SECONDS: '90',
      DOWNLOAD_MAX_CONCURRENT: '2',
      DOWNLOAD_TEMP_DIR: './temp/custom',
    });
    assert.equal(cfg.pythonPath, '/usr/bin/python3');
    assert.equal(cfg.maxSizeMb, 50);
    assert.equal(cfg.timeoutMs, 90_000);
    assert.equal(cfg.maxConcurrent, 2);
    assert.equal(cfg.tempBaseDir.endsWith(path.join('temp', 'custom')), true);
  });

  it('blocks path traversal and sweeps stale temporary directories', async () => {
    assert.throws(
      () => assertInsideDir('/tmp/midwave-dl-123', '/tmp/midwave-dl-123/../evil.mp4'),
      (e) => e.code === DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
    );

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-stale-'));
    try {
      const staleDir = await createJobTempDir(tempRoot);
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(staleDir, oldTime, oldTime);

      const removed = await cleanupStaleTempDirs(tempRoot, 60 * 60 * 1000);
      assert.equal(removed, 1);
      await assert.rejects(fs.stat(staleDir));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('Downloader — yt-dlp Subprocess, Queue, Error Handling & Cleanup', () => {
  it('spawns Python yt-dlp worker with safe argument array (never shell) and parses progress + result', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-ytdlp-sub-'));
    try {
      const mediaFile = path.join(tempRoot, 'raw_video.mp4');
      await fs.writeFile(mediaFile, FAKE_MP4_HEADER);

      let capturedSpawn = null;
      const progressEvents = [];
      const mockSpawn = createFakeSpawn({
        stdoutLines: [
          'PROGRESS:{"type":"progress","status":"downloading","percent":45.5}',
          `RESULT:${JSON.stringify({
            ok: true,
            extractor: 'Youtube',
            title: 'Midwave Demo Video',
            author: 'MidwaveChannel',
            duration: 30,
            is_audio: false,
            files: [{ path: mediaFile, filename: 'raw_video.mp4', size_bytes: FAKE_MP4_HEADER.length, ext: 'mp4' }],
            truncated_count: 0,
          })}`,
        ],
        onSpawn: (info) => {
          capturedSpawn = info;
        },
      });

      const res = await runYtDlpDownload({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        jobDir: tempRoot,
        maxBytes: 25 * 1024 * 1024,
        timeoutMs: 10_000,
        config: { pythonPath: 'python3' },
        spawnFn: mockSpawn,
        onProgress: (ev) => progressEvents.push(ev),
      });

      assert.equal(capturedSpawn.opts.shell, undefined);
      assert.ok(Array.isArray(capturedSpawn.args));
      assert.ok(capturedSpawn.args.includes('--url'));
      assert.ok(capturedSpawn.args.includes('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
      assert.equal(progressEvents.length, 1);
      assert.equal(progressEvents[0].percent, 45.5);
      assert.equal(res.ok, true);
      assert.equal(res.extractor, 'Youtube');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('executes full downloadMediaFromUrl pipeline for video & carousel and enforces file validation', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-dl-e2e-'));
    try {
      const config = {
        ...getDownloaderConfig({ DOWNLOAD_MAX_SIZE_MB: '25' }),
        tempBaseDir: tempRoot,
      };

      const videoResult = await downloadMediaFromUrl({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        config,
        deps: {
          lookupFn: publicLookupStub,
          ytdlpRunner: async ({ jobDir }) => {
            const filePath = path.join(jobDir, 'yt_raw.mp4');
            await fs.writeFile(filePath, FAKE_MP4_HEADER);
            return {
              ok: true,
              extractor: 'Youtube',
              title: 'Sample Video',
              author: 'Creator',
              duration: 42,
              is_audio: false,
              files: [{ path: filePath, filename: 'yt_raw.mp4', size_bytes: FAKE_MP4_HEADER.length, ext: 'mp4' }],
              truncated_count: 0,
            };
          },
        },
      });

      assert.equal(videoResult.provider, 'yt-dlp');
      assert.equal(videoResult.platform, PLATFORMS.YOUTUBE);
      assert.equal(videoResult.platformLabel, 'YouTube');
      assert.equal(videoResult.mediaType, 'Video');
      assert.equal(videoResult.fileFormat, 'MP4');
      assert.equal(videoResult.items.length, 1);
      assert.equal(videoResult.items[0].fileName, 'youtube_video.mp4');
      await cleanupTempDir(videoResult.jobDir);

      // Rejects masqueraded HTML file even if named .mp4
      await assert.rejects(
        downloadMediaFromUrl({
          url: 'https://vimeo.com/123456',
          config,
          deps: {
            lookupFn: publicLookupStub,
            ytdlpRunner: async ({ jobDir }) => {
              const fakePath = path.join(jobDir, 'bad.mp4');
              await fs.writeFile(fakePath, Buffer.from('<html>not a video</html>'));
              return {
                ok: true,
                extractor: 'Vimeo',
                files: [{ path: fakePath, filename: 'bad.mp4', size_bytes: 24, ext: 'mp4' }],
              };
            },
          },
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.UNSUPPORTED_MEDIA,
      );

      // Rejects files exceeding guild upload limit and cleans up temp dir
      await assert.rejects(
        downloadMediaFromUrl({
          url: 'https://www.tiktok.com/@user/video/999',
          config: { ...config, maxSizeMb: 1 },
          deps: {
            lookupFn: publicLookupStub,
            ytdlpRunner: async ({ jobDir }) => {
              const bigPath = path.join(jobDir, 'huge.mp4');
              await fs.writeFile(bigPath, Buffer.concat([FAKE_MP4_HEADER, Buffer.alloc(1.2 * 1024 * 1024)]));
              return {
                ok: true,
                extractor: 'TikTok',
                files: [{ path: bigPath }],
              };
            },
          },
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE,
      );

      assert.deepEqual(await fs.readdir(tempRoot), []);
      assert.equal(getActiveDownloadCount(), 0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('handles missing dependencies, private/age/geo errors, unsupported websites, and subprocess timeout', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-dl-err-'));
    try {
      const config = {
        ...getDownloaderConfig({ DOWNLOAD_TIMEOUT_SECONDS: '5' }),
        tempBaseDir: tempRoot,
      };

      // Missing Python binary (ENOENT)
      await assert.rejects(
        runYtDlpDownload({
          url: 'https://www.youtube.com/watch?v=123',
          jobDir: tempRoot,
          maxBytes: 1024 * 1024,
          spawnFn: createFakeSpawn({ emitError: Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' }) }),
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.MISSING_DEPENDENCY,
      );

      // Missing yt-dlp / FFmpeg reported by worker JSON
      await assert.rejects(
        runYtDlpDownload({
          url: 'https://www.youtube.com/watch?v=123',
          jobDir: tempRoot,
          maxBytes: 1024 * 1024,
          spawnFn: createFakeSpawn({
            exitCode: 1,
            stdoutLines: ['RESULT:{"ok":false,"code":"MISSING_DEPENDENCY","message":"FFmpeg tidak ditemukan"}'],
          }),
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.MISSING_DEPENDENCY,
      );

      // Private / unsupported / not found worker errors
      for (const code of ['PRIVATE_OR_RESTRICTED', 'UNSUPPORTED_PLATFORM', 'NOT_FOUND', 'RATE_LIMITED', 'NETWORK_ERROR']) {
        await assert.rejects(
          runYtDlpDownload({
            url: 'https://www.youtube.com/watch?v=123',
            jobDir: tempRoot,
            maxBytes: 1024 * 1024,
            spawnFn: createFakeSpawn({
              exitCode: 1,
              stdoutLines: [`RESULT:${JSON.stringify({ ok: false, code, message: `Err ${code}` })}`],
            }),
          }),
          (err) => err.code === DOWNLOADER_ERROR_CODES[code],
        );
      }

      // Timeout terminates child process and cleans temp directory
      let killedChild = false;
      const hangingSpawn = () => {
        const child = new EventEmitter();
        child.pid = 99999;
        child.killed = false;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {
          child.killed = true;
          killedChild = true;
          return true;
        };
        return child;
      };

      await assert.rejects(
        downloadMediaFromUrl({
          url: 'https://www.youtube.com/watch?v=timeout',
          config: { ...config, timeoutMs: 40 },
          deps: {
            lookupFn: publicLookupStub,
            spawnFn: hangingSpawn,
          },
        }),
        (err) => err.code === DOWNLOADER_ERROR_CODES.TIMEOUT,
      );

      assert.equal(killedChild, true);
      assert.deepEqual(await fs.readdir(tempRoot), []);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('auto-bootstraps standalone yt-dlp zipapp when Python module is missing and rejects corrupt payloads', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'midwave-zipapp-'));
    try {
      const dlDir = path.join(tempRoot, 'downloads');
      await fs.mkdir(dlDir, { recursive: true });

      const fakeZipapp = Buffer.concat([
        Buffer.from('#!/usr/bin/env python3\nPK\x03\x04'),
        Buffer.alloc(600_000, 0x41),
      ]);

      let fetchCalls = 0;
      const resolvedPath = await ensureYtDlpZipapp(
        {
          tempBaseDir: dlDir,
          autoInstallYtDlp: true,
        },
        {
          hasModuleFn: () => false,
          fetchImpl: async () => {
            fetchCalls += 1;
            return {
              ok: true,
              status: 200,
              async arrayBuffer() {
                return fakeZipapp;
              },
            };
          },
        },
      );

      assert.equal(fetchCalls, 1);
      assert.equal(resolvedPath, path.join(tempRoot, 'bin', 'yt-dlp'));
      const saved = await fs.readFile(resolvedPath);
      assert.equal(saved.length, fakeZipapp.length);

      // Subsequent call reuses cached zipapp on disk without re-fetching
      const secondPath = await ensureYtDlpZipapp(
        {
          tempBaseDir: dlDir,
          autoInstallYtDlp: true,
        },
        {
          hasModuleFn: () => false,
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error('should not fetch again');
          },
        },
      );
      assert.equal(secondPath, resolvedPath);
      assert.equal(fetchCalls, 1);

      // Corrupt small HTML payload is rejected cleanly
      const dlDir2 = path.join(tempRoot, 'downloads2');
      await fs.mkdir(dlDir2, { recursive: true });
      await assert.rejects(
        ensureYtDlpZipapp(
          { tempBaseDir: dlDir2, autoInstallYtDlp: true },
          {
            hasModuleFn: () => false,
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              async arrayBuffer() {
                return Buffer.from('<html>bad</html>');
              },
            }),
          },
        ),
        (err) => err.code === DOWNLOADER_ERROR_CODES.MISSING_DEPENDENCY,
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('queues concurrent jobs cleanly and rejects overflow with BUSY without leaking slots', async () => {
    const queue = new DownloadQueue({ maxConcurrent: 1, maxQueueSize: 1 });
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const order = [];
    const queuedPositions = [];

    const first = queue.enqueue(async () => {
      order.push('start-1');
      await gate;
      order.push('end-1');
      return 'res-1';
    });

    const second = queue.enqueue(
      async () => {
        order.push('start-2');
        return 'res-2';
      },
      {
        onQueued: (pos) => queuedPositions.push(pos),
      },
    );

    // 3rd request exceeds maxQueueSize=1 -> BUSY immediately
    await assert.rejects(
      queue.enqueue(async () => 'res-3'),
      (err) => err.code === DOWNLOADER_ERROR_CODES.BUSY,
    );

    assert.equal(queue.getActiveCount(), 1);
    assert.equal(queue.getPendingCount(), 1);
    assert.deepEqual(queuedPositions, [1]);

    releaseFirst();
    assert.equal(await first, 'res-1');
    assert.equal(await second, 'res-2');
    assert.deepEqual(order, ['start-1', 'end-1', 'start-2']);
    assert.equal(queue.getActiveCount(), 0);
    assert.equal(queue.getPendingCount(), 0);
  });
});

describe('Downloader — Discord Commands (/media action:download & !download) & Cooldown', () => {
  it('registers /media with action:download and parses !download / !dl directly as video URL', () => {
    const json = mediaData.toJSON();
    assert.equal(json.name, 'media');
    assert.ok(json.options[0].choices.some((c) => c.value === 'download'));
    assert.equal(typeof mediaCommand.execute, 'function');
    assert.equal(typeof downloadCommand.execute, 'function');

    assert.deepEqual(parsePrefixInvocation('!download https://www.youtube.com/watch?v=123'), {
      commandName: 'download',
      subcommand: null,
      options: { url: 'https://www.youtube.com/watch?v=123' },
    });
    assert.deepEqual(parsePrefixInvocation('!dl https://vt.tiktok.com/ZS2abcd/'), {
      commandName: 'download',
      subcommand: null,
      options: { url: 'https://vt.tiktok.com/ZS2abcd/' },
    });
    assert.ok(parsePrefixInvocation('!download')?.error);
  });

  it('replies ephemerally on missing or unsafe URL without deferring', async () => {
    const missingUrl = createMockDownloadInteraction({ url: null });
    await executeDownload(missingUrl);
    assert.equal(missingUrl.deferred, false);
    assert.equal(missingUrl.replied, true);
    assert.equal(missingUrl.getEvents()[0].payload.flags, MessageFlags.Ephemeral);

    const unsafeHost = createMockDownloadInteraction({ url: 'https://127.0.0.1/video.mp4' });
    await executeDownload(unsafeHost);
    assert.equal(unsafeHost.deferred, false);
    assert.equal(unsafeHost.replied, true);
    assert.equal(unsafeHost.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(unsafeHost.getEvents()[0].payload.embeds[0].data.description, /tidak diizinkan/i);
  });

  it('defers, uploads attachment with Midwave embed, and deletes temp dir afterwards', async () => {
    const jobDir = await createJobTempDir();
    const mediaPath = path.join(jobDir, 'youtube_video.mp4');
    await fs.writeFile(mediaPath, FAKE_MP4_HEADER);

    const interaction = createMockDownloadInteraction({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      userId: 'u-999',
    });

    await executeDownload(interaction, {
      config: getDownloaderConfig({}),
      downloadMedia: async () => ({
        jobDir,
        platform: PLATFORMS.YOUTUBE,
        platformLabel: 'YouTube',
        sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        provider: 'yt-dlp',
        title: 'Demo Video',
        author: 'Midwave',
        items: [
          {
            filePath: mediaPath,
            fileName: 'youtube_video.mp4',
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

    assert.equal(interaction.deferred, true);
    const edits = interaction.getEvents().filter((e) => e.type === 'editReply');
    assert.equal(edits.length, 2);

    const finalPayload = edits[1].payload;
    assert.equal(finalPayload.files.length, 1);
    assert.equal(finalPayload.files[0].name, 'youtube_video.mp4');
    assert.equal(finalPayload.embeds[0].data.title, 'MIDWAVE MEDIA DOWNLOADER');
    assert.equal(
      finalPayload.embeds[0].data.description,
      [
        '✅ **Download Selesai**',
        '',
        '**Judul:** Demo Video',
        '**Kreator:** Midwave',
        '📺 YouTube • MP4 • 16 B',
        '',
        'Diminta oleh: <@u-999>',
      ].join('\n'),
    );

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
      config: getDownloaderConfig({}),
      downloadMedia: async () => ({
        jobDir,
        platform: PLATFORMS.INSTAGRAM,
        platformLabel: 'Instagram',
        sourceUrl: 'https://www.instagram.com/reel/TooBig123/',
        provider: 'yt-dlp',
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

  it('enforces dedicated /media action:download cooldown inside InteractionHandler', async () => {
    let now = 10_000;
    const cooldowns = new CooldownManager(2_500, () => now);
    const app = await createBotApp({ cooldowns, skipTempCleanup: true });
    app.commandHandler.commands.set('media', {
      data: mediaData,
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
    app.shutdown();
  });
});
