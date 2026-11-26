import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from './errors.js';
import { assertInsideDir, assertRealPathInsideRoot, cleanupTempDir, createJobTempDir } from './cleanup.js';
import {
  detectMediaSignature,
  formatBytes,
  inspectMediaFile,
  sanitizeFileBaseName,
} from './media.js';
import { assertSafeRemoteHost, createPinnedHttpsAgent, isInternalHostname } from './platform.js';

export {
  assertInsideDir,
  assertRealPathInsideRoot,
  cleanupTempDir,
  createJobTempDir,
  createPinnedHttpsAgent,
  detectMediaSignature,
  formatBytes,
  inspectMediaFile,
  sanitizeFileBaseName,
};

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

  if (parsed.port && parsed.port !== '443') {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      'Port kustom pada URL media tidak diizinkan.',
    );
  }

  const cleanHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!cleanHost || net.isIP(cleanHost) !== 0 || isInternalHostname(cleanHost)) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.UNSAFE_TARGET,
      'Alamat IP langsung atau host jaringan internal pada URL media tidak diizinkan.',
    );
  }

  const resolved = await assertSafeRemoteHost(cleanHost, { lookupFn, allowPrivate: false });
  return { parsed, resolved };
}

function pinnedHttpsStreamRequest(targetUrl, resolved, { headers, signal, httpsRequestFn = https.request }) {
  const parsed = new URL(targetUrl);
  const agent = createPinnedHttpsAgent(parsed.hostname, resolved);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) {
        agent.destroy();
        reject(err);
      } else {
        resolve(value);
      }
    };

    const req = httpsRequestFn(
      parsed,
      {
        method: 'GET',
        agent,
        headers,
        servername: parsed.hostname,
        rejectUnauthorized: true,
      },
      (res) => {
        res.once('close', () => agent.destroy());
        res.once('error', () => agent.destroy());
        finish(null, {
          status: res.statusCode ?? 0,
          headers: res.headers ?? {},
          body: res,
        });
      },
    );

    if (signal) {
      if (signal.aborted) {
        req.destroy(signal.reason || new Error('Aborted'));
        return;
      }
      const onAbort = () => req.destroy(signal.reason || new Error('Aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => signal.removeEventListener('abort', onAbort));
    }

    req.on('error', (err) => finish(err));
    req.end();
  });
}

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
 * Streams a remote HTTPS media URL into an isolated temp directory while enforcing byte caps,
 * redirect SSRF safety, timeout controls, and binary magic-byte validation.
 *
 * @param {{
 *   url: string,
 *   jobDir: string,
 *   fileBaseName?: string,
 *   maxBytes: number,
 *   timeoutMs: number,
 *   fetchFn?: typeof fetch,
 *   lookupFn?: typeof dns.lookup,
 *   headers?: Record<string, string>,
 * }} params
 */
export async function downloadMediaToTempFile(params) {
  const {
    url,
    jobDir,
    fileBaseName = 'media',
    maxBytes,
    timeoutMs,
    fetchFn = null,
    httpsRequestFn = https.request,
    lookupFn = dns.lookup,
    headers = {},
  } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('DOWNLOAD_TIMEOUT')), timeoutMs);

  let currentUrl = url;
  let statusCode = 0;
  let resHeaders = null;
  let bodyStream = null;

  const disposeActiveStream = async () => {
    try {
      if (bodyStream?.cancel) {
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
      const { resolved } = await validateMediaStreamTarget(currentUrl, { lookupFn });

      const fRes = fetchFn
        ? await fetchFn(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: requestHeaders,
            signal: controller.signal,
          })
        : await pinnedHttpsStreamRequest(currentUrl, resolved, {
            headers: requestHeaders,
            signal: controller.signal,
            httpsRequestFn,
          });
      statusCode = fRes.status;
      resHeaders = fRes.headers;
      bodyStream = fRes.body;

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

    await assertRealPathInsideRoot(jobDir, partPath);
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
      error?.name === 'AbortError' ||
      error?.name === 'TimeoutError' ||
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
