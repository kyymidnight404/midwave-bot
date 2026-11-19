import { spawn, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const YTDLP_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/downloader/download.py');

const MAX_STDIO_BYTES = 1024 * 1024;

let cachedPythonBin = null;
let cachedDenoBin = null;

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
 *   mode?: 'video' | 'audio',
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
    mode = 'video',
    maxDurationSeconds = 900,
    timeoutMs = 60_000,
    config = {},
    onProgress = null,
    spawnFn = spawn,
    scriptPath = YTDLP_SCRIPT_PATH,
  } = params;

  const pythonBin = resolvePythonBinary(config.pythonPath);
  const denoBin = resolveDenoBinary(config.denoPath);

  const args = [
    scriptPath,
    '--url',
    url,
    '--output-dir',
    jobDir,
    '--max-bytes',
    String(Math.max(1024, Math.floor(maxBytes))),
    '--mode',
    mode === 'audio' ? 'audio' : 'video',
    '--max-duration',
    String(Math.max(0, Math.floor(maxDurationSeconds))),
    '--timeout',
    String(Math.max(5, Math.ceil(timeoutMs / 1000))),
  ];

  if (config.ffmpegPath) {
    args.push('--ffmpeg-location', config.ffmpegPath);
  }
  if (denoBin) {
    args.push('--deno-path', denoBin);
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
