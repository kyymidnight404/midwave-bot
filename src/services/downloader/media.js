import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DISCORD_MAX_ATTACHMENTS } from './config.js';
import { assertInsideDir } from './cleanup.js';
import { DOWNLOADER_ERROR_CODES, DownloaderError } from './errors.js';

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
 * Detects genuine image, video, or audio formats strictly from file header magic bytes.
 * Rejects masqueraded HTML, JSON, archives, or executable binaries.
 *
 * @param {Uint8Array | Buffer} bytes
 * @param {{ hintExt?: string }} [options]
 * @returns {{ kind: 'video' | 'image' | 'audio', mime: string, ext: string, format: string } | null}
 */
export function detectMediaSignature(bytes, options = {}) {
  if (!bytes || bytes.length < 4) {
    return null;
  }

  const hintExt = String(options.hintExt || '').toLowerCase().replace(/^\./, '');

  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'image', mime: 'image/jpeg', ext: 'jpg', format: 'JPG' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
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
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { kind: 'image', mime: 'image/gif', ext: 'gif', format: 'GIF' };
  }

  // RIFF containers: WebP, WAV, AVI
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    const fourcc = Buffer.from(bytes.subarray(8, 12)).toString('ascii');
    if (fourcc === 'WEBP') {
      return { kind: 'image', mime: 'image/webp', ext: 'webp', format: 'WEBP' };
    }
    if (fourcc === 'WAVE') {
      return { kind: 'audio', mime: 'audio/wav', ext: 'wav', format: 'WAV' };
    }
    if (fourcc === 'AVI ') {
      return { kind: 'video', mime: 'video/x-msvideo', ext: 'avi', format: 'AVI' };
    }
  }

  // WebM / Matroska (EBML): 1A 45 DF A3
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    if (hintExt === 'mkv') {
      return { kind: 'video', mime: 'video/x-matroska', ext: 'mkv', format: 'MKV' };
    }
    return { kind: 'video', mime: 'video/webm', ext: 'webm', format: 'WEBM' };
  }

  // ISO Base Media File Format (MP4 / MOV / M4A): offset 4..7 == 'ftyp'
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = Buffer.from(bytes.subarray(8, 12)).toString('ascii');
    if (brand === 'qt  ') {
      return { kind: 'video', mime: 'video/quicktime', ext: 'mov', format: 'MOV' };
    }
    if (brand === 'M4A ' || brand === 'M4B ' || hintExt === 'm4a') {
      return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a', format: 'M4A' };
    }
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4', format: 'MP4' };
  }

  // MP3 (ID3 tag or MPEG frame sync)
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0)
  ) {
    return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3', format: 'MP3' };
  }

  // Ogg / Opus / Vorbis: 'OggS'
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    if (hintExt === 'opus') {
      return { kind: 'audio', mime: 'audio/opus', ext: 'opus', format: 'OPUS' };
    }
    return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg', format: 'OGG' };
  }

  // FLAC: 'fLaC'
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
    return { kind: 'audio', mime: 'audio/flac', ext: 'flac', format: 'FLAC' };
  }

  return null;
}

/**
 * Reads the header of an on-disk file and verifies it is a supported video, image, or audio binary.
 *
 * @param {string} filePath
 * @returns {Promise<{ kind: 'video' | 'image' | 'audio', mime: string, ext: string, format: string }>}
 */
export async function inspectMediaFile(filePath) {
  const hintExt = path.extname(filePath).slice(1).toLowerCase();
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const signature = detectMediaSignature(header.subarray(0, bytesRead), { hintExt });
    if (!signature) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.UNSUPPORTED_MEDIA,
        'File yang diunduh bukan format video, gambar, atau audio yang valid dan didukung Discord.',
      );
    }
    return signature;
  } finally {
    await handle.close();
  }
}

/**
 * Derives human-readable summary metadata for Discord embed responses.
 *
 * @param {Array<{ kind: 'video' | 'image' | 'audio', format: string, sizeBytes: number }>} items
 */
export function summarizeDownloadedMedia(items) {
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  const formats = [...new Set(items.map((item) => item.format))];
  const hasVideo = items.some((item) => item.kind === 'video');
  const hasImage = items.some((item) => item.kind === 'image');
  const hasAudio = items.some((item) => item.kind === 'audio');

  let mediaType = 'Media';
  if (items.length === 1) {
    if (items[0].kind === 'video') mediaType = 'Video';
    else if (items[0].kind === 'audio') mediaType = 'Audio';
    else mediaType = 'Image';
  } else if (hasImage && !hasVideo && !hasAudio) {
    mediaType = `Slideshow / Carousel (${items.length} gambar)`;
  } else if (hasVideo && !hasImage && !hasAudio) {
    mediaType = `Carousel Video (${items.length} video)`;
  } else if (hasAudio && !hasVideo && !hasImage) {
    mediaType = `Audio (${items.length} file)`;
  } else {
    mediaType = `Carousel Media (${items.length} file)`;
  }

  return {
    mediaType,
    fileFormat: formats.join(' / '),
    totalBytes,
    formattedSize: formatBytes(totalBytes),
  };
}

/**
 * Validates downloaded files inside `jobDir`, verifies magic bytes & Discord upload limits,
 * and renames files safely to clean attachment names.
 *
 * @param {Array<{ path: string, filename?: string, size_bytes?: number }>} rawFiles
 * @param {{
 *   jobDir: string,
 *   maxBytes: number,
 *   platform: string,
 *   isAudio?: boolean,
 * }} options
 */
export async function validateAndPrepareMediaItems(rawFiles, options) {
  const { jobDir, maxBytes, platform, isAudio = false } = options;

  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      'Tidak ada file media valid yang berhasil diunduh dari tautan tersebut.',
    );
  }

  const items = [];
  let remainingBytes = maxBytes;
  let skippedForBudget = 0;

  for (let i = 0; i < rawFiles.length && items.length < DISCORD_MAX_ATTACHMENTS; i += 1) {
    const rawEntry = rawFiles[i];
    const rawPath = typeof rawEntry === 'string' ? rawEntry : rawEntry?.path;
    if (!rawPath) continue;

    assertInsideDir(jobDir, rawPath);

    let stat;
    try {
      stat = await fs.stat(rawPath);
    } catch {
      continue;
    }

    if (!stat.isFile() || stat.size <= 0) {
      continue;
    }

    if (stat.size > maxBytes) {
      if (rawFiles.length === 1) {
        throw new DownloaderError(
          DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE,
          `Ukuran media (${formatBytes(stat.size)}) melebihi batas unggahan ${formatBytes(maxBytes)} Discord.`,
        );
      }
      skippedForBudget += 1;
      continue;
    }

    if (stat.size > remainingBytes) {
      skippedForBudget += 1;
      continue;
    }

    const signature = await inspectMediaFile(rawPath);
    const kindTag = isAudio || signature.kind === 'audio' ? 'audio' : signature.kind;
    const basePrefix = rawFiles.length > 1
      ? `${sanitizeFileBaseName(platform, 'media')}_${i + 1}`
      : `${sanitizeFileBaseName(platform, 'media')}_${kindTag}`;

    let finalPath = path.join(jobDir, `${basePrefix}.${signature.ext}`);
    if (path.resolve(rawPath) !== path.resolve(finalPath)) {
      if (fsSync.existsSync(finalPath)) {
        finalPath = path.join(jobDir, `${basePrefix}_${crypto.randomUUID().slice(0, 6)}.${signature.ext}`);
      }
      assertInsideDir(jobDir, finalPath);
      await fs.rename(rawPath, finalPath);
    }

    items.push({
      filePath: finalPath,
      fileName: path.basename(finalPath),
      sizeBytes: stat.size,
      kind: signature.kind,
      mime: signature.mime,
      format: signature.format,
    });

    remainingBytes -= stat.size;
  }

  if (items.length === 0) {
    if (skippedForBudget > 0) {
      throw new DownloaderError(
        DOWNLOADER_ERROR_CODES.FILE_TOO_LARGE,
        `Ukuran media melebihi batas unggahan ${formatBytes(maxBytes)} Discord.`,
      );
    }
    throw new DownloaderError(
      DOWNLOADER_ERROR_CODES.NOT_FOUND,
      'Tidak ada file media valid yang berhasil diunduh.',
    );
  }

  const truncatedCount = Math.max(0, rawFiles.length - items.length);
  return {
    items,
    truncatedCount,
    summary: summarizeDownloadedMedia(items),
  };
}
