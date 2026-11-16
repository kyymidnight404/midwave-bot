import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { Readable } from 'node:stream';
import axios from 'axios';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from './errors.js';
import { assertSafeRemoteHost, createPinnedHttpsAgent } from './urlValidator.js';

export { createPinnedHttpsAgent };

/**
 * Creates a unique, isolated temporary directory for one download job.
 *
 * @param {string} [baseDir]
 * @returns {Promise<string>}
 */
export async function createJobTempDir(baseDir = os.tmpdir()) {
  await fs.mkdir(baseDir, { recursive: true });
  return fs.mkdtemp(path.join(baseDir, 'midwave-dl-'));
}

/**
 * Safely deletes a job temporary directory and all files inside it.
 *
 * @param {string | null | undefined} jobDir
 * @returns {Promise<void>}
 */
export async function cleanupTempDir(jobDir) {
  if (!jobDir || typeof jobDir !== 'string') {
    return;
  }
  try {
    await fs.rm(jobDir, { recursive: true, force: true });
  } catch {
    // Cleanup failures must not mask primary command errors
  }
}

/**
 * Produces a safe basename without path traversal or unsafe characters.
 *
 * @param {string} rawName
 * @param {string} [fallbackBase]
 * @returns {string}
 */
export function sanitizeFileBaseName(rawName, fallbackBase = 'midwave_media') {
  const base = path
    .basename(String(rawName || ''))
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);

  return base || fallbackBase;
}

/**
 * Formats byte sizes for Discord embed display.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(2).replace(/\.?0+$/, '')} MB`;
}

/**
 * Detects genuine image or video formats strictly from file header magic bytes.
 * Rejects masqueraded HTML, JSON, archives, or executable binaries.
 *
 * @param {Uint8Array | Buffer} bytes
 * @returns {{ kind: 'video' | 'image', mime: string, ext: string, format: string } | null}
 */
export function detectMediaSignature(bytes) {
  if (!bytes || bytes.length < 12) {
    return null;
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'image', mime: 'image/jpeg', ext: 'jpg', format: 'JPG' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { kind: 'image', mime: 'image/png', ext: 'png', format: 'PNG' };
  }

  // GIF: GIF87a or GIF89a
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { kind: 'image', mime: 'image/gif', ext: 'gif', format: 'GIF' };
  }

  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { kind: 'image', mime: 'image/webp', ext: 'webp', format: 'WEBP' };
  }

  // WebM / Matroska: 1A 45 DF A3
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { kind: 'video', mime: 'video/webm', ext: 'webm', format: 'WEBM' };
  }

  // ISO Base Media File Format (MP4 / MOV): offset 4..7 == 'ftyp'
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = Buffer.from(bytes.subarray(8, 12)).toString('ascii');
    if (brand === 'qt  ') {
      return { kind: 'video', mime: 'video/quicktime', ext: 'mov', format: 'MOV' };
    }
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4', format: 'MP4' };
  }

  return null;
}

/**
 * Reads the header of an on-disk file and verifies it is a supported image/video binary.
 *
 * @param {string} filePath
 * @returns {Promise<{ kind: 'video' | 'image', mime: string, ext: string, format: string }>}
 */
export async function inspectMediaFile(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const signature = detectMediaSignature(header.subarray(0, bytesRead));
    if (!signature) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSUPPORTED_MEDIA,
        'File yang diunduh bukan format video atau gambar yang valid dan didukung Discord.',
      );
    }
    return signature;
  } finally {
    await handle.close();
  }
}

/**
 * Ensures a resolved file path remains strictly inside the designated temp job directory.
 *
 * @param {string} jobDir
 * @param {string} targetPath
 */
export function assertInsideDir(jobDir, targetPath) {
  const resolvedRoot = path.resolve(jobDir);
  const resolvedTarget = path.resolve(targetPath);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (!resolvedTarget.startsWith(rootPrefix)) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      'Path file tidak valid terdeteksi di luar direktori sementara.',
    );
  }
}

/**
 * Validates a direct media CDN URL before issuing an HTTP download.
 *
 * @param {string} rawUrl
 * @param {{ lookupFn?: typeof dns.lookup }} [options]
 * @returns {Promise<URL>}
 */
async function validateMediaStreamTarget(rawUrl, options = {}) {
  const { lookupFn = dns.lookup } = options;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      'URL media hasil ekstraksi tidak valid.',
    );
  }

  if (parsed.username || parsed.password) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      'URL media hasil ekstraksi mengandung kredensial yang dilarang.',
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      'URL media hasil ekstraksi wajib menggunakan HTTPS.',
    );
  }

  const resolved = await assertSafeRemoteHost(parsed.hostname, { lookupFn, allowPrivate: false });
  return { parsed, resolved };
}

/**
 * Normalizes a header lookup across Fetch Headers and Axios plain header objects.
 *
 * @param {Headers | Record<string, string | string[] | undefined>} headers
 * @param {string} name
 * @returns {string}
 */
function readHeaderValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return String(value[0] || '');
  return value ? String(value) : '';
}

/**
 * Streams a remote media URL into an isolated temp directory while enforcing byte caps,
 * redirect safety, timeout controls, and binary magic-byte validation.
 *
 * @param {{
 *   url: string,
 *   jobDir: string,
 *   fileBaseName?: string,
 *   maxBytes: number,
 *   timeoutMs: number,
 *   fetchFn?: typeof fetch,
 *   axiosClient?: import('axios').AxiosInstance | typeof import('axios').default,
 *   lookupFn?: typeof dns.lookup,
 *   headers?: Record<string, string>,
 * }} params
 * @returns {Promise<{
 *   filePath: string,
 *   fileName: string,
 *   sizeBytes: number,
 *   kind: 'video' | 'image',
 *   mime: string,
 *   format: string,
 * }>}
 */
export async function downloadMediaToTempFile(params) {
  const {
    url,
    jobDir,
    fileBaseName = 'media',
    maxBytes,
    timeoutMs,
    fetchFn = null,
    axiosClient = null,
    lookupFn = dns.lookup,
    headers = {},
  } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('DOWNLOAD_TIMEOUT')), timeoutMs);

  let currentUrl = url;
  let statusCode = 0;
  let resHeaders = null;
  let bodyStream = null;
  let isWebStream = false;

  const disposeActiveStream = async () => {
    try {
      if (isWebStream && bodyStream?.cancel) {
        await bodyStream.cancel();
      } else if (bodyStream && typeof bodyStream.destroy === 'function') {
        bodyStream.destroy();
      }
    } catch {
      // Ignore stream cleanup failures
    }
  };

  try {
    const requestHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...headers,
    };

    for (let hop = 0; hop < 6; hop += 1) {
      const { parsed, resolved } = await validateMediaStreamTarget(currentUrl, { lookupFn });

      if (axiosClient || !fetchFn) {
        const effectiveAxios = axiosClient || axios;
        const pinnedAgent = resolved ? createPinnedHttpsAgent(parsed.hostname, resolved) : undefined;
        const axRes = await effectiveAxios.get(currentUrl, {
          responseType: 'stream',
          maxRedirects: 0,
          validateStatus: () => true,
          timeout: timeoutMs,
          headers: requestHeaders,
          signal: controller.signal,
          ...(pinnedAgent ? { httpsAgent: pinnedAgent } : {}),
        });
        statusCode = axRes.status ?? 200;
        resHeaders = axRes.headers ?? {};
        bodyStream = Buffer.isBuffer(axRes.data) ? Readable.from(axRes.data) : axRes.data;
        isWebStream = false;
      } else {
        const fRes = await fetchFn(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: requestHeaders,
          signal: controller.signal,
        });
        statusCode = fRes.status;
        resHeaders = fRes.headers;
        bodyStream = fRes.body;
        isWebStream = true;
      }

      if (statusCode >= 300 && statusCode < 400) {
        const location = readHeaderValue(resHeaders, 'location');
        await disposeActiveStream();
        if (!location) {
          break;
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      break;
    }

    if (!statusCode) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
        'Gagal mengunduh media dari server sumber.',
        { retryable: true },
      );
    }

    if (statusCode >= 300 && statusCode < 400) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
        'Terlalu banyak pengalihan (redirect) saat mengunduh media.',
      );
    }

    if (statusCode === 429) {
      await disposeActiveStream();
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.RATE_LIMITED,
        'Server sumber membatasi permintaan sementara (rate limit). Silakan coba lagi nanti.',
      );
    }
    if (statusCode === 401 || statusCode === 403) {
      await disposeActiveStream();
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.PRIVATE_OR_RESTRICTED,
        'Media bersifat privat, dibatasi aksesnya, atau memerlukan autentikasi.',
      );
    }
    if (statusCode === 404 || statusCode === 410) {
      await disposeActiveStream();
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.NOT_FOUND,
        'Media tidak ditemukan atau tautan unduhan sudah kedaluwarsa.',
      );
    }
    if (statusCode < 200 || statusCode >= 300 || !bodyStream) {
      await disposeActiveStream();
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
        `Gagal mengunduh file media (HTTP ${statusCode}).`,
        { retryable: statusCode >= 500 },
      );
    }

    const contentType = readHeaderValue(resHeaders, 'content-type').toLowerCase();
    if (
      contentType.startsWith('text/html') ||
      contentType.startsWith('application/xhtml+xml') ||
      contentType.startsWith('application/json') ||
      contentType.startsWith('text/plain')
    ) {
      await disposeActiveStream();
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSUPPORTED_MEDIA,
        'Server sumber mengembalikan halaman HTML/teks alih-alih file media.',
      );
    }

    const contentLengthHeader = readHeaderValue(resHeaders, 'content-length');
    if (contentLengthHeader) {
      const expectedBytes = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(expectedBytes) && expectedBytes > maxBytes) {
        await disposeActiveStream();
        throw new DownloaderError(
          DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE,
          `Ukuran media (${formatBytes(expectedBytes)}) melebihi batas unggahan ${formatBytes(maxBytes)}.`,
        );
      }
    }

    const safeBase = sanitizeFileBaseName(fileBaseName, 'media');
    const partPath = path.join(jobDir, `${safeBase}_${crypto.randomUUID().slice(0, 8)}.part`);
    assertInsideDir(jobDir, partPath);

    let receivedBytes = 0;
    const nodeStream =
      typeof bodyStream.pipe === 'function' ? bodyStream : Readable.fromWeb(bodyStream);
    const writeStream = fsSync.createWriteStream(partPath, { flags: 'wx' });

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          nodeStream.destroy();
          writeStream.destroy();
          reject(err);
        };

        nodeStream.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxBytes) {
            controller.abort(new Error('SIZE_LIMIT_EXCEEDED'));
            fail(
              new DownloaderError(
                DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE,
                `Ukuran media melebihi batas unggahan ${formatBytes(maxBytes)}.`,
              ),
            );
          }
        });

        nodeStream.on('error', (err) => fail(err));
        writeStream.on('error', (err) => fail(err));
        writeStream.on('finish', () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });

        nodeStream.pipe(writeStream);
      });
    } catch (streamErr) {
      await fs.rm(partPath, { force: true }).catch(() => {});
      throw streamErr;
    }

    if (receivedBytes === 0) {
      await fs.rm(partPath, { force: true }).catch(() => {});
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.NOT_FOUND,
        'File media yang diterima kosong (0 byte).',
      );
    }

    const signature = await inspectMediaFile(partPath);
    const finalFileName = `${safeBase}.${signature.ext}`;
    let finalPath = path.join(jobDir, finalFileName);
    if (fsSync.existsSync(finalPath)) {
      finalPath = path.join(jobDir, `${safeBase}_${crypto.randomUUID().slice(0, 6)}.${signature.ext}`);
    }
    assertInsideDir(jobDir, finalPath);
    await fs.rename(partPath, finalPath);

    const stat = await fs.stat(finalPath);
    return {
      filePath: finalPath,
      fileName: path.basename(finalPath),
      sizeBytes: stat.size,
      kind: signature.kind,
      mime: signature.mime,
      format: signature.format,
    };
  } catch (error) {
    if (error instanceof DownloaderError) {
      throw error;
    }
    if (
      error?.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' ||
      String(error?.message || '').toLowerCase().includes('maxcontentlength')
    ) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE,
        `Ukuran media melebihi batas unggahan ${formatBytes(maxBytes)}.`,
      );
    }
    if (
      error?.code === 'ECONNABORTED' ||
      error?.code === 'ETIMEDOUT' ||
      error?.name === 'AbortError' ||
      controller.signal.aborted
    ) {
      const reasonMsg = String(controller.signal.reason?.message || '');
      if (reasonMsg === 'SIZE_LIMIT_EXCEEDED') {
        throw new DownloaderError(
          DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE,
          `Ukuran media melebihi batas unggahan ${formatBytes(maxBytes)}.`,
        );
      }
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.TIMEOUT,
        'Waktu habis saat mengunduh file media. Silakan coba lagi.',
        { retryable: true, cause: error },
      );
    }
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
      'Terjadi kesalahan saat mengunduh stream media.',
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
