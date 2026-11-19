import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from './errors.js';

const JOB_DIR_PREFIX = 'midwave-dl-';

/**
 * Creates a unique, isolated temporary directory for one download job.
 *
 * @param {string} [baseDir]
 * @returns {Promise<string>}
 */
export async function createJobTempDir(baseDir = os.tmpdir()) {
  await fs.mkdir(baseDir, { recursive: true });
  return fs.mkdtemp(path.join(baseDir, JOB_DIR_PREFIX));
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
 * Removes stale `midwave-dl-*` temporary directories left behind by unexpected crashes.
 *
 * @param {string} baseDir
 * @param {number} [maxAgeMs]
 * @returns {Promise<number>}
 */
export async function cleanupStaleTempDirs(baseDir, maxAgeMs = 60 * 60 * 1000) {
  if (!baseDir || typeof baseDir !== 'string') {
    return 0;
  }

  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const now = Date.now();
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(JOB_DIR_PREFIX)) {
      continue;
    }
    const dirPath = path.join(baseDir, entry.name);
    try {
      const stat = await fs.stat(dirPath);
      if (now - stat.mtimeMs >= maxAgeMs) {
        await fs.rm(dirPath, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Best-effort cleanup
    }
  }

  return removed;
}
