import { createRequire } from 'node:module';
import { createCanvas, GlobalFonts, loadImage, Path2D } from '@napi-rs/canvas';

const require = createRequire(import.meta.url);

export const IGF_SIZE = 1080;
export const IGF_ATTACHMENT_NAME = 'midwave-igf.png';
export const IGF_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IGF_MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const IGF_MAX_DIMENSION = 8192;

export const IGF_DEFAULT_LIKES = '9,311 likes';
export const IGF_DEFAULT_COMMENTS = 'View all 987 comments';
export const IGF_DEFAULT_TIMESTAMP = '5 DAYS AGO';

const SUPPORTED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

const CARD = Object.freeze({
  x: 224,
  y: 70,
  width: 632,
  height: 940,
  radius: 24,
  padX: 20,
  headerHeight: 100,
  photoSize: 592,
});

const COLORS = Object.freeze({
  cardBg: '#FFFFFF',
  cardBorder: 'rgba(0, 0, 0, 0.06)',
  cardShadow: 'rgba(0, 0, 0, 0.14)',
  photoBorder: 'rgba(0, 0, 0, 0.08)',
  textPrimary: '#111111',
  textMuted: '#8E8E93',
  hashtagBlue: '#2B7DE9',
  heartRed: '#ED4956',
  dotBlue: '#3897F0',
  dotGray: '#C7C7CC',
  avatarFallbackBg: '#D1D1D6',
});

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
let fontsRegistered = false;

function ensureFontsRegistered() {
  if (fontsRegistered) return;
  try {
    GlobalFonts.registerFromPath(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'), 'DejaVu Sans');
    GlobalFonts.registerFromPath(
      require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'),
      'DejaVu Sans Bold',
    );
  } catch {
    // System fallback fonts remain available if bundled font path cannot be resolved.
  }
  fontsRegistered = true;
}

function getRegularFont(size) {
  return `${size}px "DejaVu Sans", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
}

function getBoldFont(size) {
  return `700 ${size}px "DejaVu Sans Bold", "DejaVu Sans", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
}

/**
 * Detects supported static raster image format via magic bytes.
 * @param {Buffer} buffer
 * @returns {'png' | 'jpeg' | 'webp' | 'gif' | null}
 */
export function detectSupportedImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  // GIF: GIF87a / GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return 'gif';
  }

  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp';
  }

  return null;
}

/**
 * Validates Discord attachment metadata before downloading.
 * @param {{ url?: string, name?: string | null, contentType?: string | null, size?: number | null }} attachment
 */
export function validateImageAttachmentMetadata(attachment) {
  if (!attachment || typeof attachment.url !== 'string' || !attachment.url) {
    throw new Error('Attachment gambar tidak valid.');
  }

  if (typeof attachment.size === 'number' && attachment.size > IGF_MAX_IMAGE_BYTES) {
    throw new Error('Ukuran gambar terlalu besar (maksimal 10 MB).');
  }

  const contentType = attachment.contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (contentType) {
    if (!contentType.startsWith('image/')) {
      throw new Error('File yang dikirim bukan gambar. Kirim file PNG, JPG, WebP, atau GIF.');
    }
    if (!SUPPORTED_CONTENT_TYPES.has(contentType)) {
      throw new Error(`Format gambar \`${contentType}\` tidak didukung. Gunakan PNG, JPG, WebP, atau GIF.`);
    }
    return;
  }

  const rawName = (attachment.name ?? attachment.url.split('?')[0] ?? '').toLowerCase();
  const dotIdx = rawName.lastIndexOf('.');
  const ext = dotIdx >= 0 ? rawName.slice(dotIdx) : '';
  if (ext && !SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error('Format file tidak didukung. Gunakan gambar PNG, JPG, WebP, atau GIF.');
  }
}

/**
 * Downloads an image URL into a memory Buffer with timeout, size limit, and magic-byte validation.
 * @param {string} url
 * @param {{ fetchFn?: typeof fetch, maxBytes?: number, timeoutMs?: number, kind?: 'photo' | 'avatar' }} [options]
 * @returns {Promise<Buffer>}
 */
export async function fetchValidatedImageBuffer(url, options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? IGF_MAX_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? 6000;
  const kind = options.kind ?? 'photo';

  if (typeof fetchFn !== 'function') {
    throw new Error('Fetch API tidak tersedia.');
  }

  let response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error(
      kind === 'avatar'
        ? 'Gagal mengambil avatar Discord. Silakan coba lagi.'
        : 'Gagal mengunduh gambar. Silakan coba lagi.',
    );
  }

  if (!response?.ok) {
    throw new Error(
      kind === 'avatar'
        ? 'Gagal mengambil avatar Discord. Silakan coba lagi.'
        : 'Gagal mengunduh gambar dari Discord.',
    );
  }

  const contentLength = Number(response.headers?.get?.('content-length') ?? 0);
  if (contentLength > maxBytes) {
    throw new Error(
      kind === 'avatar'
        ? 'Ukuran avatar melebihi batas yang diizinkan.'
        : 'Ukuran gambar terlalu besar (maksimal 10 MB).',
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error(
      kind === 'avatar' ? 'Gagal mengambil avatar Discord.' : 'File gambar kosong atau rusak.',
    );
  }
  if (buffer.length > maxBytes) {
    throw new Error(
      kind === 'avatar'
        ? 'Ukuran avatar melebihi batas yang diizinkan.'
        : 'Ukuran gambar terlalu besar (maksimal 10 MB).',
    );
  }

  const format = detectSupportedImageFormat(buffer);
  if (!format) {
    throw new Error(
      kind === 'avatar'
        ? 'Format avatar Discord tidak didukung.'
        : 'File bukan gambar atau format gambar tidak didukung. Gunakan PNG, JPG, WebP, atau GIF.',
    );
  }

  return buffer;
}

/**
 * Truncates text grapheme-by-grapheme with ellipsis to stay within `maxWidth`.
 * @param {import('@napi-rs/canvas').SKRSContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string}
 */
export function truncateTextToWidth(ctx, text, maxWidth) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }

  const ellipsis = '…';
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  if (ellipsisWidth >= maxWidth) {
    return ellipsis;
  }

  const graphemes = [...graphemeSegmenter.segment(text)].map((s) => s.segment);
  let acc = '';
  for (const g of graphemes) {
    const candidate = acc + g;
    if (ctx.measureText(candidate).width + ellipsisWidth > maxWidth) {
      break;
    }
    acc = candidate;
  }

  return `${acc.trimEnd()}${ellipsis}`;
}

/**
 * Computes source crop rectangle for `object-fit: cover` inside a target box.
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} dstWidth
 * @param {number} dstHeight
 * @returns {{ sx: number, sy: number, sw: number, sh: number }}
 */
export function computeCoverCrop(srcWidth, srcHeight, dstWidth, dstHeight) {
  const srcAspect = srcWidth / srcHeight;
  const dstAspect = dstWidth / dstHeight;

  if (srcAspect > dstAspect) {
    const sw = srcHeight * dstAspect;
    return {
      sx: (srcWidth - sw) / 2,
      sy: 0,
      sw,
      sh: srcHeight,
    };
  }

  const sh = srcWidth / dstAspect;
  return {
    sx: 0,
    sy: (srcHeight - sh) / 2,
    sw: srcWidth,
    sh,
  };
}

function drawCoverImage(ctx, image, dx, dy, dWidth, dHeight) {
  const { sx, sy, sw, sh } = computeCoverCrop(image.width, image.height, dWidth, dHeight);
  ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dWidth, dHeight);
}

function drawVectorIcons(ctx, innerLeft, innerRight, rowCenterY) {
  const iconHalf = 13;
  const iconTop = rowCenterY - iconHalf;

  // Heart (filled red)
  ctx.save();
  ctx.translate(innerLeft, iconTop);
  ctx.scale(26 / 24, 26 / 24);
  ctx.fillStyle = COLORS.heartRed;
  ctx.fill(
    new Path2D(
      'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    ),
  );
  ctx.restore();

  // Comment speech bubble (outline, bottom-right tail)
  ctx.save();
  ctx.translate(innerLeft + 44, iconTop);
  ctx.scale(26 / 24, 26 / 24);
  ctx.strokeStyle = COLORS.textPrimary;
  ctx.lineWidth = 2.0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const startAngle = 0.28 * Math.PI;
  const endAngle = 0.08 * Math.PI;
  ctx.beginPath();
  ctx.arc(12, 12, 9.2, startAngle, endAngle, false);
  ctx.lineTo(21.2, 21.2);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  // Share paper plane (outline)
  ctx.save();
  ctx.translate(innerLeft + 88, iconTop);
  ctx.scale(26 / 24, 26 / 24);
  ctx.strokeStyle = COLORS.textPrimary;
  ctx.lineWidth = 2.0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D('M21.5 3.5L2.5 9.8l7.3 3.7L13.5 21 21.5 3.5z'));
  ctx.stroke(new Path2D('M21.5 3.5L9.8 13.5'));
  ctx.restore();

  // Center pagination dots (3 dots, middle blue)
  const centerX = CARD.x + CARD.width / 2;
  const dotOffsets = [-14, 0, 14];
  dotOffsets.forEach((dx, idx) => {
    ctx.beginPath();
    ctx.arc(centerX + dx, rowCenterY, 4.3, 0, Math.PI * 2);
    ctx.fillStyle = idx === 1 ? COLORS.dotBlue : COLORS.dotGray;
    ctx.fill();
  });

  // Bookmark (outline, right aligned)
  ctx.save();
  ctx.translate(innerRight - 26, iconTop);
  ctx.scale(26 / 24, 26 / 24);
  ctx.strokeStyle = COLORS.textPrimary;
  ctx.lineWidth = 2.0;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D('M19 21l-7-5-7 5V4.5a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 19 4.5V21z'));
  ctx.restore();
}

function drawCustomCaption(ctx, caption, inlineStartX, leftX, topY, remainingInlineWidth, maxWidth, lineHeight) {
  const words = caption.split(' ');
  let line1 = '';
  let line2Words = [];

  for (let i = 0; i < words.length; i++) {
    const candidate = line1 ? `${line1} ${words[i]}` : words[i];
    if (ctx.measureText(candidate).width <= remainingInlineWidth) {
      line1 = candidate;
    } else {
      line2Words = words.slice(i);
      break;
    }
  }

  ctx.fillStyle = COLORS.textPrimary;
  if (line1) {
    ctx.fillText(line1, inlineStartX, topY);
  }

  if (line2Words.length === 0) {
    return 1;
  }

  const line2Text = truncateTextToWidth(ctx, line2Words.join(' '), maxWidth);
  ctx.fillText(line2Text, leftX, topY + lineHeight);
  return 2;
}

function normalizeCaptionText(caption) {
  return typeof caption === 'string' ? caption.trim().replace(/\s+/g, ' ') : '';
}

function drawCaptionBlock(ctx, username, captionText, leftX, topY, maxWidth) {
  const fontSize = 19;
  const lineHeight = 25;
  const gapAfterUsername = 8;

  ctx.font = getBoldFont(fontSize);
  const maxSingleLineUserWidth = Math.max(120, maxWidth * 0.56);
  const displayUsername = truncateTextToWidth(ctx, username, maxSingleLineUserWidth);
  const usernameWidth = ctx.measureText(displayUsername).width;

  ctx.fillStyle = COLORS.textPrimary;
  ctx.fillText(displayUsername, leftX, topY);

  const inlineStartX = leftX + usernameWidth + gapAfterUsername;
  const remainingInlineWidth = leftX + maxWidth - inlineStartX;

  ctx.font = getRegularFont(fontSize);
  return drawCustomCaption(
    ctx,
    captionText,
    inlineStartX,
    leftX,
    topY,
    remainingInlineWidth,
    maxWidth,
    lineHeight,
  );
}

/**
 * Decodes and validates a photo or avatar Buffer with `@napi-rs/canvas`.
 * @param {Buffer} buffer
 * @param {'photo' | 'avatar'} kind
 * @returns {Promise<import('@napi-rs/canvas').Image>}
 */
async function decodeSafeImage(buffer, kind) {
  if (!detectSupportedImageFormat(buffer)) {
    throw new Error(
      kind === 'avatar'
        ? 'Format avatar Discord tidak didukung.'
        : 'File bukan gambar atau format gambar tidak didukung. Gunakan PNG, JPG, WebP, atau GIF.',
    );
  }

  let img;
  try {
    img = await loadImage(buffer);
  } catch {
    throw new Error(
      kind === 'avatar'
        ? 'Gagal memuat gambar avatar Discord.'
        : 'Gambar rusak atau tidak dapat didekode. Silakan kirim gambar lain.',
    );
  }

  if (!img || img.width <= 0 || img.height <= 0) {
    throw new Error(
      kind === 'avatar'
        ? 'Gambar avatar Discord tidak valid.'
        : 'Gambar rusak atau berdimensi tidak valid.',
    );
  }

  if (img.width > IGF_MAX_DIMENSION || img.height > IGF_MAX_DIMENSION) {
    throw new Error('Resolusi gambar terlalu besar (maksimal 8192×8192 piksel).');
  }

  return img;
}

/**
 * Renders the 1080x1080 transparent-background minimalist Instagram Post Frame PNG.
 * Stateless: operates purely on in-memory Buffers and releases canvas resources afterwards.
 *
 * @param {{ photoBuffer: Buffer, avatarBuffer: Buffer, username: string, caption?: string | null }} input
 * @returns {Promise<Buffer>}
 */
export async function renderInstagramFrame({ photoBuffer, avatarBuffer, username, caption = null }) {
  ensureFontsRegistered();

  const cleanUsername =
    typeof username === 'string' && username.trim().length > 0 ? username.trim() : 'Midwave User';

  let photoImg = await decodeSafeImage(photoBuffer, 'photo');
  let avatarImg = await decodeSafeImage(avatarBuffer, 'avatar');

  const canvas = createCanvas(IGF_SIZE, IGF_SIZE);
  const ctx = canvas.getContext('2d');

  try {
    // 1. Card base with rounded corners and soft subtle drop shadow on transparent canvas
    ctx.save();
    ctx.shadowColor = COLORS.cardShadow;
    ctx.shadowBlur = 32;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = COLORS.cardBg;
    ctx.beginPath();
    ctx.roundRect(CARD.x, CARD.y, CARD.width, CARD.height, CARD.radius);
    ctx.fill();
    ctx.restore();

    // Subtle hairline border so card stays defined on bright backgrounds
    ctx.save();
    ctx.strokeStyle = COLORS.cardBorder;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(CARD.x, CARD.y, CARD.width, CARD.height, CARD.radius);
    ctx.stroke();
    ctx.restore();

    // Clip all inner elements cleanly inside the rounded card
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(CARD.x, CARD.y, CARD.width, CARD.height, CARD.radius);
    ctx.clip();

    const innerLeft = CARD.x + CARD.padX;
    const innerRight = CARD.x + CARD.width - CARD.padX;
    const innerWidth = innerRight - innerLeft;

    // 2. Card Header: circular avatar (left), username, three-dot menu (right)
    const headerCenterY = CARD.y + CARD.headerHeight / 2;
    const avatarRadius = 26;
    const avatarCenterX = innerLeft + avatarRadius + 8;

    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarCenterX, headerCenterY, avatarRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = COLORS.avatarFallbackBg;
    ctx.fillRect(
      avatarCenterX - avatarRadius,
      headerCenterY - avatarRadius,
      avatarRadius * 2,
      avatarRadius * 2,
    );
    drawCoverImage(
      ctx,
      avatarImg,
      avatarCenterX - avatarRadius,
      headerCenterY - avatarRadius,
      avatarRadius * 2,
      avatarRadius * 2,
    );
    ctx.restore();

    const headerTextX = avatarCenterX + avatarRadius + 16;
    const dotsRightX = innerRight - 14;
    const maxHeaderUsernameWidth = dotsRightX - 40 - headerTextX;

    ctx.font = getBoldFont(20);
    ctx.fillStyle = COLORS.textPrimary;
    ctx.textBaseline = 'middle';
    const headerUsername = truncateTextToWidth(ctx, cleanUsername, maxHeaderUsernameWidth);
    ctx.fillText(headerUsername, headerTextX, headerCenterY);

    // Three-dot menu icon on top-right
    [-10, 0, 10].forEach((dx) => {
      ctx.beginPath();
      ctx.arc(dotsRightX + dx, headerCenterY, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.textPrimary;
      ctx.fill();
    });

    // 3. Main 1:1 Photo directly below header with object-fit: cover crop
    const photoX = innerLeft;
    const photoY = CARD.y + CARD.headerHeight;
    ctx.save();
    ctx.beginPath();
    ctx.rect(photoX, photoY, CARD.photoSize, CARD.photoSize);
    ctx.clip();
    drawCoverImage(ctx, photoImg, photoX, photoY, CARD.photoSize, CARD.photoSize);
    ctx.restore();

    ctx.strokeStyle = COLORS.photoBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(photoX + 0.5, photoY + 0.5, CARD.photoSize - 1, CARD.photoSize - 1);

    // 4. Action Bar (Heart, Comment, Share, 3 dots, Bookmark)
    const contentLeft = innerLeft + 8;
    const contentRight = innerRight - 8;
    const contentWidth = contentRight - contentLeft;
    const actionBarCenterY = photoY + CARD.photoSize + 36;
    drawVectorIcons(ctx, contentLeft, contentRight, actionBarCenterY);

    // 5. Engagement, Caption, Comments, Timestamp
    ctx.textBaseline = 'alphabetic';

    const likesY = actionBarCenterY + 46;
    ctx.font = getBoldFont(19);
    ctx.fillStyle = COLORS.textPrimary;
    ctx.fillText(IGF_DEFAULT_LIKES, contentLeft, likesY);

    const cleanCaption = normalizeCaptionText(caption);
    let commentsY = likesY + 34;
    if (cleanCaption) {
      const captionY = likesY + 34;
      const captionLines = drawCaptionBlock(
        ctx,
        cleanUsername,
        cleanCaption,
        contentLeft,
        captionY,
        contentWidth,
      );
      commentsY = captionY + (captionLines > 1 ? 56 : 36);
    }
    ctx.font = getRegularFont(18);
    ctx.fillStyle = COLORS.textMuted;
    ctx.fillText(IGF_DEFAULT_COMMENTS, contentLeft, commentsY);

    const timestampY = commentsY + 32;
    ctx.font = getRegularFont(14);
    ctx.fillStyle = COLORS.textMuted;
    ctx.fillText(IGF_DEFAULT_TIMESTAMP, contentLeft, timestampY);

    ctx.restore();

    const pngBuffer = canvas.toBuffer('image/png');
    if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
      throw new Error('Hasil buffer PNG kosong.');
    }
    return pngBuffer;
  } catch (error) {
    if (error instanceof Error && /rusak|didukung|resolusi|bukan gambar/i.test(error.message)) {
      throw error;
    }
    throw new Error('Gagal merender kartu Instagram frame. Silakan coba lagi.');
  } finally {
    // Release decoded image and canvas allocations promptly.
    photoImg = null;
    avatarImg = null;
    canvas.width = 0;
    canvas.height = 0;
  }
}
