import { spawn, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const YTDLP_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/downloader/download.py');
export const YTDLP_OFFICIAL_ZIPAPP_URL =
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
const YTDLP_ZIPAPP_MIN_BYTES = 500_000;

const MAX_STDIO_BYTES = 1024 * 1024;

let cachedPythonBin = null;
let cachedDenoBin = null;
const pythonHasYtDlpCache = new Map();
let pendingZipappDownload = null;

/**
 * Redacts sensitive tokens, credentials, URLs, and paths from log output.
 *
 * @param {unknown} value
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeLogText(value, maxLen = 180) {
  return String(value ?? '')
    .replace(/AIza[0-9A-Za-z_-]{10,}|tvly-[A-Za-z0-9_-]{6,}/gi, '[REDACTED_KEY]')
    .replace(/(x-api-key|api[_-]?key|token|authorization|cookie)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Checks whether a Python candidate binary exists and can execute `--version` cleanly
 * (ignoring broken Windows Store `WindowsApps` app-execution-alias stubs).
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isWorkingPythonBinary(candidate) {
  if (!candidate) return false;
  try {
    const res = spawnSync(candidate, ['--version'], {
      stdio: 'pipe',
      timeout: 3_000,
      windowsHide: true,
    });
    if (res.error || res.status !== 0) {
      return false;
    }
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    return /Python\s+3\./i.test(output);
  } catch {
    return false;
  }
}

/**
 * Resolves a working Python 3 executable across Linux, macOS, and Windows environments.
 *
 * @param {string | null | undefined} configuredPath
 * @returns {string}
 */
export function resolvePythonBinary(configuredPath) {
  const explicit = typeof configuredPath === 'string' ? configuredPath.trim() : '';
  if (explicit && isWorkingPythonBinary(explicit)) {
    return explicit;
  }

  if (cachedPythonBin && isWorkingPythonBinary(cachedPythonBin)) {
    return cachedPythonBin;
  }

  const candidates = process.platform === 'win32'
    ? [
        'python',
        'python3',
        'C:\\Python314\\python.exe',
        'C:\\Python313\\python.exe',
        'C:\\Python312\\python.exe',
        'C:\\Python311\\python.exe',
        ...(process.env.LOCALAPPDATA
          ? [
              path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python314', 'python.exe'),
              path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'),
              path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe'),
              path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe'),
            ]
          : []),
      ]
    : ['python3', 'python', '/usr/bin/python3', '/usr/local/bin/python3'];

  for (const candidate of candidates) {
    if (isWorkingPythonBinary(candidate)) {
      cachedPythonBin = candidate;
      return candidate;
    }
  }

  return explicit || (process.platform === 'win32' ? 'python' : 'python3');
}

/**
 * Discovers a Deno executable for yt-dlp YouTube EJS JavaScript challenge solving.
 *
 * @param {string | null | undefined} configuredPath
 * @returns {string | null}
 */
export function resolveDenoBinary(configuredPath) {
  const explicit = typeof configuredPath === 'string' ? configuredPath.trim() : '';
  if (explicit) return explicit;
  if (cachedDenoBin && fsSync.existsSync(cachedDenoBin)) return cachedDenoBin;

  const candidates = [];
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, '.deno', 'bin', 'deno'));
  }
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, '.deno', 'bin', 'deno.exe'));
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const wingetPkgRoot = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    try {
      const dirs = fsSync.readdirSync(wingetPkgRoot);
      for (const d of dirs) {
        if (d.startsWith('DenoLand.Deno')) {
          const candidate = path.join(wingetPkgRoot, d, 'deno.exe');
          candidates.push(candidate);
        }
      }
    } catch {
      // Ignore missing winget dir
    }
  }

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      cachedDenoBin = candidate;
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves an optional local FFmpeg binary/directory override.
 *
 * @param {string | null | undefined} configuredPath
 * @returns {string | null}
 */
export function resolveFfmpegLocation(configuredPath) {
  const explicit = typeof configuredPath === 'string' ? configuredPath.trim() : '';
  if (explicit) return explicit;

  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const localCandidates = [
    path.resolve(process.cwd(), 'bin', binName),
    path.resolve(process.cwd(), 'temp', 'bin', binName),
  ];

  for (const candidate of localCandidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Checks whether a Python interpreter already has the `yt_dlp` package installed.
 * Cached per binary path for the lifetime of the process.
 *
 * @param {string} pythonBin
 * @returns {boolean}
 */
export function hasPythonYtDlpModule(pythonBin) {
  if (!pythonBin) return false;
  if (pythonHasYtDlpCache.has(pythonBin)) {
    return pythonHasYtDlpCache.get(pythonBin);
  }
  try {
    const res = spawnSync(pythonBin, ['-c', 'import yt_dlp'], {
      stdio: 'pipe',
      timeout: 5_000,
      windowsHide: true,
    });
    const ok = !res.error && res.status === 0;
    pythonHasYtDlpCache.set(pythonBin, ok);
    return ok;
  } catch {
    pythonHasYtDlpCache.set(pythonBin, false);
    return false;
  }
}

/**
 * Resolves the target storage path for the standalone `yt-dlp` zipapp when no
 * system/pip installation is present (e.g. managed Node.js containers like Wispbyte).
 *
 * @param {object} [config]
 * @returns {string}
 */
export function getDefaultYtDlpZipappPath(config = {}) {
  const explicit = typeof config.ytdlpPath === 'string' ? config.ytdlpPath.trim() : '';
  if (explicit && (explicit.includes('/') || explicit.includes('\\') || explicit.endsWith('.pyz'))) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
  }
  const tempBase = config.tempBaseDir
    ? path.resolve(config.tempBaseDir)
    : path.resolve(process.cwd(), 'temp', 'downloads');
  const tempParent = path.basename(tempBase) === 'downloads' ? path.dirname(tempBase) : tempBase;
  return path.join(tempParent, 'bin', 'yt-dlp');
}

function isValidYtDlpZipappHeader(buf) {
  if (!buf || buf.length < YTDLP_ZIPAPP_MIN_BYTES) return false;
  const isShebang = buf[0] === 0x23 && buf[1] === 0x21; // #!
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // PK
  return isShebang || isZip;
}

/**
 * Ensures a standalone `yt-dlp` zipapp is available when Python lacks `pip install yt-dlp`.
 * Downloads the official zipapp once (~3 MB, includes `yt-dlp-ejs`) and caches it locally.
 *
 * @param {object} [config]
 * @param {{ fetchImpl?: typeof fetch, hasModuleFn?: (bin: string) => boolean }} [options]
 * @returns {Promise<string | null>}
 */
export async function ensureYtDlpZipapp(config = {}, options = {}) {
  const pythonBin = resolvePythonBinary(config.pythonPath);
  const checkModule = options.hasModuleFn || hasPythonYtDlpModule;

  const explicit = typeof config.ytdlpPath === 'string' ? config.ytdlpPath.trim() : '';
  if (explicit && fsSync.existsSync(explicit) && fsSync.statSync(explicit).isFile()) {
    return path.resolve(explicit);
  }

  const localCandidates = [
    path.resolve(process.cwd(), 'bin', 'yt-dlp'),
    getDefaultYtDlpZipappPath(config),
  ];

  for (const candidate of localCandidates) {
    if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).size >= YTDLP_ZIPAPP_MIN_BYTES) {
      return candidate;
    }
  }

  if (checkModule(pythonBin)) {
    return null;
  }

  if (config.autoInstallYtDlp === false) {
    return null;
  }

  if (pendingZipappDownload) {
    return pendingZipappDownload;
  }

  const targetPath = getDefaultYtDlpZipappPath(config);
  const fetchImpl = options.fetchImpl || fetch;

  pendingZipappDownload = (async () => {
    const targetDir = path.dirname(targetPath);
    await fs.mkdir(targetDir, { recursive: true });
    const partPath = `${targetPath}.${process.pid}.part`;

    try {
      const response = await fetchImpl(YTDLP_OFFICIAL_ZIPAPP_URL, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'MidwaveBot/1.0.0',
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = Buffer.from(await response.arrayBuffer());
      if (!isValidYtDlpZipappHeader(data)) {
        throw new Error('Downloaded yt-dlp zipapp failed integrity header/size check');
      }

      await fs.writeFile(partPath, data);
      if (process.platform !== 'win32') {
        await fs.chmod(partPath, 0o755).catch(() => {});
      }
      await fs.rename(partPath, targetPath);
      return targetPath;
    } catch (error) {
      await fs.rm(partPath, { force: true }).catch(() => {});
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.MISSING_DEPENDENCY,
        'Engine downloader (`yt-dlp`) belum terpasang dan gagal diunduh otomatis. Periksa koneksi internet server atau pasang `yt-dlp` secara manual.',
        { cause: error, details: sanitizeLogText(error?.message) },
      );
    } finally {
      pendingZipappDownload = null;
    }
  })();

  return pendingZipappDownload;
}

/**
 * Terminates a child process and its descendant tree safely across Windows and POSIX.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
export function terminateChildProcess(child) {
  if (!child || child.killed) return;
  const pid = child.pid;

  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore kill error if already exited
  }

  const forceTimer = setTimeout(() => {
    try {
      if (process.platform === 'win32' && pid) {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // Ignore force kill error
    }
  }, 1500);

  forceTimer.unref?.();
}

/**
 * Maps a non-zero worker failure result or stderr message to a typed `DownloaderError`.
 *
 * @param {{ code?: string, message?: string, details?: string } | null} result
 * @param {string} stderrText
 * @returns {DownloaderError}
 */
export function mapWorkerFailureToError(result, stderrText = '') {
  const codeKey = result?.code;
  const validCode = codeKey && Object.hasOwn(DOWNLOADER_ERROR_CODES, codeKey)
    ? DOWNLOADER_ERROR_CODES[codeKey]
    : null;

  if (validCode) {
    const retryable =
      validCode === DOWNLOADER_ERROR_CODES.TIMEOUT ||
      validCode === DOWNLOADER_ERROR_CODES.NETWORK_ERROR;
    return new DownloaderError(
      validCode,
      result.message || 'Gagal mengunduh media.',
      {
        retryable,
        details: sanitizeLogText(result.details || stderrText),
      },
    );
  }

  const lower = String(stderrText || '').toLowerCase();
  if (lower.includes('no module named') && lower.includes('yt_dlp')) {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.MISSING_DEPENDENCY,
      'Engine downloader (`yt-dlp`) belum terpasang di lingkungan Python server.',
      { details: sanitizeLogText(stderrText) },
    );
  }
  if (lower.includes('ffmpeg') && lower.includes('not found')) {
    return new DownloaderError(
      DOWNLOADER_ERROR_CODES.MISSING_DEPENDENCY,
      'Dependensi `FFmpeg` tidak ditemukan untuk memproses media.',
      { details: sanitizeLogText(stderrText) },
    );
  }

  return new DownloaderError(
    DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
    'Gagal mengekstrak atau mengunduh media dari tautan tersebut.',
    { details: sanitizeLogText(stderrText) },
  );
}

/**
 * Executes the Python `download.py` yt-dlp worker cleanly using `child_process.spawn`
 * with an argument array (no shell execution), live progress parsing, and timeout enforcement.
 *
 * @param {{
 *   url: string,
 *   jobDir: string,
 *   maxBytes: number,
 *   maxDurationSeconds?: number,
 *   timeoutMs?: number,
 *   config?: object,
 *   onProgress?: (progress: { status?: string, percent?: number | null, title?: string }) => void,
 *   spawnFn?: typeof spawn,
 *   scriptPath?: string,
 * }} params
 */
export async function runYtDlpDownload(params) {
  const {
    url,
    jobDir,
    maxBytes,
    maxDurationSeconds = 900,
    timeoutMs = 60_000,
    config = {},
    onProgress = null,
    spawnFn = spawn,
    scriptPath = YTDLP_SCRIPT_PATH,
  } = params;

  const pythonBin = resolvePythonBinary(config.pythonPath);
  const denoBin = resolveDenoBinary(config.denoPath);
  const ffmpegLocation = resolveFfmpegLocation(config.ffmpegPath);
  const isMockedSpawn = Boolean(params.spawnFn && params.spawnFn !== spawn);
  const ytdlpZipapp = isMockedSpawn
    ? (typeof config.ytdlpZipappPath === 'string' && config.ytdlpZipappPath ? config.ytdlpZipappPath : null)
    : await ensureYtDlpZipapp(config);

  const args = [
    scriptPath,
    '--url',
    url,
    '--output-dir',
    jobDir,
    '--max-bytes',
    String(Math.max(1024, Math.floor(maxBytes))),
    '--max-duration',
    String(Math.max(0, Math.floor(maxDurationSeconds))),
    '--timeout',
    String(Math.max(5, Math.ceil(timeoutMs / 1000))),
  ];

  if (ffmpegLocation) {
    args.push('--ffmpeg-location', ffmpegLocation);
  }
  if (denoBin) {
    args.push('--deno-path', denoBin);
  } else if (process.execPath) {
    args.push('--node-path', process.execPath);
  }
  if (ytdlpZipapp) {
    args.push('--ytdlp-path', ytdlpZipapp);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stdoutBuffer = '';
    let stderrText = '';
    let lastResultPayload = null;

    let child;
    try {
      child = spawnFn(pythonBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      });
    } catch (spawnErr) {
      reject(
        new DownloaderError(
          DOWNLOADER_ERROR_CODES.MISSING_DEPENDENCY,
          'Runtime Python 3 tidak ditemukan atau gagal dijalankan untuk downloader yt-dlp.',
          { cause: spawnErr, details: sanitizeLogText(spawnErr?.message) },
        ),
      );
      return;
    }

    const finishError = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const finishSuccess = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child);
      finishError(
        new DownloaderError(
          DOWNLOADER_ERROR_CODES.TIMEOUT,
          'Proses unduhan melewati batas waktu (timeout). Silakan coba lagi atau pilih media lebih pendek.',
          { retryable: true },
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('PROGRESS:')) {
        try {
          const event = JSON.parse(trimmed.slice('PROGRESS:'.length));
          if (typeof onProgress === 'function') {
            onProgress(event);
          }
        } catch {
          // Ignore malformed progress line
        }
        return;
      }
      if (trimmed.startsWith('RESULT:')) {
        try {
          lastResultPayload = JSON.parse(trimmed.slice('RESULT:'.length));
        } catch {
          // Handled on exit
        }
      }
    };

    child.stdout?.on('data', (chunk) => {
      if (stdoutBuffer.length < MAX_STDIO_BYTES) {
        stdoutBuffer += chunk.toString('utf8');
      }
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr?.on('data', (chunk) => {
      if (stderrText.length < MAX_STDIO_BYTES) {
        stderrText += chunk.toString('utf8');
      }
    });

    child.on('error', (err) => {
      if (err?.code === 'ENOENT') {
        finishError(
          new DownloaderError(
            DOWNLOADER_ERROR_CODES.MISSING_DEPENDENCY,
            'Python 3 (`python3` / `python`) tidak ditemukan di sistem untuk menjalankan yt-dlp.',
            { cause: err, details: sanitizeLogText(err.message) },
          ),
        );
        return;
      }
      finishError(
        new DownloaderError(
          DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
          'Gagal menjalankan proses downloader yt-dlp.',
          { cause: err, details: sanitizeLogText(err.message) },
        ),
      );
    });

    child.on('close', (exitCode) => {
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer);
        stdoutBuffer = '';
      }

      if (timedOut) {
        return;
      }

      if (lastResultPayload) {
        if (lastResultPayload.ok) {
          finishSuccess(lastResultPayload);
        } else {
          finishError(mapWorkerFailureToError(lastResultPayload, stderrText));
        }
        return;
      }

      if (exitCode === 0) {
        finishError(
          new DownloaderError(
            DOWNLOADER_ERROR_CODES.EXTRACTION_FAILED,
            'Downloader selesai tanpa menghasilkan output media yang valid.',
            { details: sanitizeLogText(stderrText) },
          ),
        );
        return;
      }

      finishError(mapWorkerFailureToError(null, stderrText));
    });
  });
}
