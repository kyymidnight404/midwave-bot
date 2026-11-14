import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCanvas, GlobalFonts, Image } from '@napi-rs/canvas';
import { PROJECT_ROOT } from './constants.js';

const require = createRequire(import.meta.url);

export const QC_WIDTH = 1080;
export const QC_MIN_HEIGHT = 1080;
export const QC_MAX_HEIGHT = 4096;
export const QC_MAX_LENGTH = 2000;
export const QC_DEFAULT_TIMEZONE = 'Asia/Jakarta';
export const QC_ATTACHMENT_NAME = 'midwave-qc.png';

const QC_ASSETS_DIR = path.join(PROJECT_ROOT, 'assets', 'qc');

export const QC_EMOJI_ASSETS = Object.freeze([
  { name: 'heart', path: path.join(QC_ASSETS_DIR, 'emojis', 'heart.png'), chars: ['❤️', '❤'] },
  { name: 'handshake', path: path.join(QC_ASSETS_DIR, 'emojis', 'handshake.png'), chars: ['🤝'] },
  { name: 'thumbs-up', path: path.join(QC_ASSETS_DIR, 'emojis', 'thumbs-up.png'), chars: ['👍'] },
  { name: 'thumbs-down', path: path.join(QC_ASSETS_DIR, 'emojis', 'thumbs-down.png'), chars: ['👎'] },
  { name: 'fire', path: path.join(QC_ASSETS_DIR, 'emojis', 'fire.png'), chars: ['🔥'] },
  { name: 'smiling-hearts', path: path.join(QC_ASSETS_DIR, 'emojis', 'smiling-hearts.png'), chars: ['🥰'] },
  { name: 'clapping', path: path.join(QC_ASSETS_DIR, 'emojis', 'clapping.png'), chars: ['👏'] },
]);

export const QC_ICON_ASSETS = Object.freeze({
  dropdown: path.join(QC_ASSETS_DIR, 'icons', 'dropdown.png'),
  reply: path.join(QC_ASSETS_DIR, 'icons', 'reply.png'),
  copy: path.join(QC_ASSETS_DIR, 'icons', 'copy.png'),
  pin: path.join(QC_ASSETS_DIR, 'icons', 'pin.png'),
  forward: path.join(QC_ASSETS_DIR, 'icons', 'forward.png'),
  delete: path.join(QC_ASSETS_DIR, 'icons', 'delete.png'),
  select: path.join(QC_ASSETS_DIR, 'icons', 'select.png'),
});

const UNICODE_EMOJI_REGEX =
  /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Extended_Pictographic}(?=[\u200D\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]))(?:\uFE0F|\u200D|\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}])*)$/u;

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
let fontsRegistered = false;
let cachedAssets = null;

function ensureFontsRegistered() {
  if (fontsRegistered) return;
  try {
    GlobalFonts.registerFromPath(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'), 'DejaVu Sans');
  } catch {
    // System sans-serif fallback remains available if bundled font cannot be resolved.
  }
  fontsRegistered = true;
}

function getTextFont(size) {
  return `${size}px "DejaVu Sans", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
}

function getEmojiFont(size) {
  return `${size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "DejaVu Sans", sans-serif`;
}

function loadPngImageSync(filePath) {
  const buffer = readFileSync(filePath);
  const img = new Image();
  img.src = buffer;
  if (!img.complete || img.width <= 0 || img.height <= 0) {
    throw new Error(`Invalid PNG asset: ${filePath}`);
  }
  return img;
}

/**
 * Loads and caches all local PNG emoji and icon assets from `assets/qc/`.
 * Throws if any required PNG asset is missing or unreadable.
 * @returns {{
 *   reactionEmojis: Image[],
 *   inlineEmojiMap: Map<string, Image>,
 *   icons: Record<string, Image>,
 * }}
 */
export function loadQcAssets() {
  if (cachedAssets) {
    return cachedAssets;
  }

  const reactionEmojis = [];
  const inlineEmojiMap = new Map();

  for (const spec of QC_EMOJI_ASSETS) {
    const img = loadPngImageSync(spec.path);
    reactionEmojis.push(img);
    for (const ch of spec.chars) {
      inlineEmojiMap.set(ch, img);
    }
  }

  const icons = {};
  for (const [key, iconPath] of Object.entries(QC_ICON_ASSETS)) {
    icons[key] = loadPngImageSync(iconPath);
  }

  cachedAssets = { reactionEmojis, inlineEmojiMap, icons };
  return cachedAssets;
}

/**
 * Resolves the configured bot timezone, defaulting to Asia/Jakarta.
 * Ignores OS/host `TZ` so overseas hosting servers still render WIB by default.
 * @param {string} [preferredTimeZone]
 * @returns {string}
 */
export function resolveQcTimeZone(preferredTimeZone) {
  const candidate =
    (typeof preferredTimeZone === 'string' && preferredTimeZone.trim()) ||
    process.env.BOT_TIMEZONE?.trim() ||
    QC_DEFAULT_TIMEZONE;

  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return QC_DEFAULT_TIMEZONE;
  }
}

/**
 * Formats a Date or timestamp into 24-hour `HH:mm` in the configured timezone.
 * @param {Date | number | string} [timestamp]
 * @param {string} [timeZone]
 * @returns {string}
 */
export function formatQcTimestamp(timestamp = new Date(), timeZone) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp ?? Date.now());
  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const tz = resolveQcTimeZone(timeZone);

  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(validDate);

    // Guard against engines that format midnight as 24:xx.
    return formatted.startsWith('24:') ? `00:${formatted.slice(3)}` : formatted;
  } catch {
    // Explicit UTC+7 fallback for Asia/Jakarta (WIB) if host ICU tzdata is unavailable.
    const wib = new Date(validDate.getTime() + 7 * 60 * 60 * 1000);
    const hh = String(wib.getUTCHours()).padStart(2, '0');
    const mm = String(wib.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
}

/**
 * Validates and normalizes text for WhatsApp-style QC screenshot generation.
 * Preserves line breaks while trimming outer whitespace and enforcing length bounds.
 * @param {string} rawText
 * @returns {string}
 */
export function validateQcText(rawText) {
  if (typeof rawText !== 'string') {
    throw new Error('Teks pesan wajib diisi.');
  }

  const normalized = rawText
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
    .trim();

  if (!normalized) {
    throw new Error('Teks pesan tidak boleh kosong.');
  }

  if (normalized.length > QC_MAX_LENGTH) {
    throw new Error(`Teks pesan maksimal ${QC_MAX_LENGTH} karakter.`);
  }

  return normalized;
}

/**
 * Splits a string into plain-text, bundled-PNG-emoji, and fallback-emoji runs.
 * @param {string} text
 * @param {Map<string, Image>} inlineEmojiMap
 * @returns {Array<{ kind: 'text' | 'png' | 'emoji', text: string, image?: Image }>}
 */
function segmentTextRuns(text, inlineEmojiMap) {
  const runs = [];
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const pngImg = inlineEmojiMap.get(segment);
    if (pngImg) {
      runs.push({ kind: 'png', text: segment, image: pngImg });
      continue;
    }

    const kind = UNICODE_EMOJI_REGEX.test(segment) ? 'emoji' : 'text';
    const prev = runs[runs.length - 1];
    if (prev && prev.kind === kind) {
      prev.text += segment;
    } else {
      runs.push({ kind, text: segment });
    }
  }
  return runs;
}

/**
 * Measures the width of text containing mixed sans-serif characters and emojis.
 * @param {import('@napi-rs/canvas').CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} fontSize
 * @param {Map<string, Image>} inlineEmojiMap
 * @returns {number}
 */
function measureMixedTextWidth(ctx, text, fontSize, inlineEmojiMap) {
  if (!text) return 0;
  let total = 0;
  const inlineEmojiAdvance = fontSize * 1.05;
  for (const run of segmentTextRuns(text, inlineEmojiMap)) {
    if (run.kind === 'png') {
      total += inlineEmojiAdvance;
    } else {
      ctx.font = run.kind === 'emoji' ? getEmojiFont(fontSize) : getTextFont(fontSize);
      total += ctx.measureText(run.text).width;
    }
  }
  return total;
}

/**
 * Draws an Image centered within a square bounding box using high-quality smoothing and preserving aspect ratio.
 * @param {import('@napi-rs/canvas').CanvasRenderingContext2D} ctx
 * @param {Image} img
 * @param {number} centerX
 * @param {number} centerY
 * @param {number} maxSize
 */
function drawImageFitCentered(ctx, img, centerX, centerY, maxSize) {
  const scale = Math.min(maxSize / img.width, maxSize / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, centerX - drawW / 2, centerY - drawH / 2, drawW, drawH);
  ctx.restore();
}

/**
 * Draws text containing mixed sans-serif characters and PNG/color emojis from (x, baselineY).
 * @param {import('@napi-rs/canvas').CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} fontSize
 * @param {Map<string, Image>} inlineEmojiMap
 */
function drawMixedText(ctx, text, x, y, fontSize, inlineEmojiMap) {
  let cursorX = x;
  const inlineEmojiSize = fontSize * 0.96;
  const inlineEmojiAdvance = fontSize * 1.05;

  for (const run of segmentTextRuns(text, inlineEmojiMap)) {
    if (run.kind === 'png' && run.image) {
      const centerX = cursorX + inlineEmojiSize / 2;
      const centerY = y - fontSize * 0.82 + inlineEmojiSize / 2;
      drawImageFitCentered(ctx, run.image, centerX, centerY, inlineEmojiSize);
      cursorX += inlineEmojiAdvance;
    } else {
      ctx.font = run.kind === 'emoji' ? getEmojiFont(fontSize) : getTextFont(fontSize);
      ctx.fillText(run.text, cursorX, y);
      cursorX += ctx.measureText(run.text).width;
    }
  }
}

/**
 * Wraps multiline message text to fit within maxWidth without clipping long words or emojis.
 * @param {import('@napi-rs/canvas').CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} fontSize
 * @param {number} maxWidth
 * @param {Map<string, Image>} inlineEmojiMap
 * @returns {Array<{ text: string, width: number }>}
 */
function wrapMessageLines(ctx, text, fontSize, maxWidth, inlineEmojiMap) {
  const lines = [];

  for (const paragraph of text.split('\n')) {
    const cleanPara = paragraph.replace(/[^\S\n]+/g, ' ').trim();
    if (!cleanPara) {
      lines.push({ text: '', width: 0 });
      continue;
    }

    const words = cleanPara.split(' ');
    let currentLine = '';

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (measureMixedTextWidth(ctx, candidate, fontSize, inlineEmojiMap) <= maxWidth) {
        currentLine = candidate;
        continue;
      }

      if (currentLine) {
        lines.push({
          text: currentLine,
          width: measureMixedTextWidth(ctx, currentLine, fontSize, inlineEmojiMap),
        });
        currentLine = '';
      }

      if (measureMixedTextWidth(ctx, word, fontSize, inlineEmojiMap) <= maxWidth) {
        currentLine = word;
      } else {
        // Split unspaced long token by grapheme to preserve emojis intact.
        let chunk = '';
        for (const { segment } of graphemeSegmenter.segment(word)) {
          const nextChunk = chunk + segment;
          if (chunk && measureMixedTextWidth(ctx, nextChunk, fontSize, inlineEmojiMap) > maxWidth) {
            lines.push({
              text: chunk,
              width: measureMixedTextWidth(ctx, chunk, fontSize, inlineEmojiMap),
            });
            chunk = segment;
          } else {
            chunk = nextChunk;
          }
        }
        currentLine = chunk;
      }
    }

    if (currentLine) {
      lines.push({
        text: currentLine,
        width: measureMixedTextWidth(ctx, currentLine, fontSize, inlineEmojiMap),
      });
    }
  }

  return lines.length > 0 ? lines : [{ text: '', width: 0 }];
}

function drawRoundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawWallpaper(ctx, width, height) {
  const baseGrad = ctx.createLinearGradient(0, 0, width, height);
  baseGrad.addColorStop(0, '#D4D6DC');
  baseGrad.addColorStop(0.5, '#C7CCD5');
  baseGrad.addColorStop(0.8, '#8FB0E8');
  baseGrad.addColorStop(1, '#4C93F5');
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, width, height);

  const blueGlow = ctx.createRadialGradient(
    width * 0.88,
    height * 0.9,
    width * 0.04,
    width * 0.88,
    height * 0.9,
    width * 0.68,
  );
  blueGlow.addColorStop(0, 'rgba(36, 118, 246, 0.88)');
  blueGlow.addColorStop(0.45, 'rgba(84, 149, 248, 0.44)');
  blueGlow.addColorStop(1, 'rgba(84, 149, 248, 0)');
  ctx.fillStyle = blueGlow;
  ctx.fillRect(0, 0, width, height);

  const topHighlight = ctx.createRadialGradient(
    width * 0.14,
    height * 0.16,
    10,
    width * 0.14,
    height * 0.16,
    width * 0.58,
  );
  topHighlight.addColorStop(0, 'rgba(244, 246, 250, 0.44)');
  topHighlight.addColorStop(1, 'rgba(244, 246, 250, 0)');
  ctx.fillStyle = topHighlight;
  ctx.fillRect(0, 0, width, height);
}

function drawReactionBar(ctx, x, y, width, height, assets) {
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.14)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = 'rgba(241, 245, 253, 0.90)';
  drawRoundedRectPath(ctx, x, y, width, height, height / 2);
  ctx.fill();
  ctx.restore();

  // Subtle thought-bubble dots below the right end of the reaction bar (matches reference).
  ctx.save();
  ctx.fillStyle = 'rgba(241, 245, 253, 0.90)';
  ctx.beginPath();
  ctx.arc(x + width - 82, y + height - 1, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + width - 52, y + height + 19, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Render all 7 Apple-iOS-style reaction PNG assets evenly spaced with uniform scale & aspect ratio.
  const emojiSize = 68;
  const emojiAreaStart = x + 44;
  const emojiAreaEnd = x + width - 134;
  const slotWidth = (emojiAreaEnd - emojiAreaStart) / assets.reactionEmojis.length;
  const centerY = y + height / 2;

  assets.reactionEmojis.forEach((img, idx) => {
    const cx = emojiAreaStart + slotWidth * (idx + 0.5);
    drawImageFitCentered(ctx, img, cx, centerY, emojiSize);
  });

  // Circular dropdown chevron button on the right using local PNG icon.
  const btnCenterX = x + width - 64;
  const btnCenterY = y + height / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(154, 198, 252, 0.62)';
  ctx.beginPath();
  ctx.arc(btnCenterX, btnCenterY, 39, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  drawImageFitCentered(ctx, assets.icons.dropdown, btnCenterX, btnCenterY, 42);
}

const CONTEXT_MENU_ITEMS = Object.freeze([
  { label: 'Reply', icon: 'reply', color: '#111111', gapBefore: 0 },
  { label: 'Copy', icon: 'copy', color: '#111111', gapBefore: 1.5 },
  { label: 'Pin', icon: 'pin', color: '#111111', gapBefore: 1.5 },
  { label: 'Forward', icon: 'forward', color: '#111111', gapBefore: 1.5 },
  { label: 'Delete', icon: 'delete', color: '#E5484D', gapBefore: 1.5 },
  { label: 'Select', icon: 'select', color: '#111111', gapBefore: 12 },
]);

function drawContextMenu(ctx, x, y, width, assets) {
  const rowHeight = 82;
  const totalDividers = CONTEXT_MENU_ITEMS.reduce((sum, item) => sum + item.gapBefore, 0);
  const menuHeight = CONTEXT_MENU_ITEMS.length * rowHeight + totalDividers;
  const iconSize = 40;

  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.13)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = 'rgba(244, 246, 250, 0.90)';
  drawRoundedRectPath(ctx, x, y, width, menuHeight, 30);
  ctx.fill();
  ctx.restore();

  let cursorY = y;
  CONTEXT_MENU_ITEMS.forEach((item) => {
    if (item.gapBefore > 0) {
      ctx.fillStyle = item.gapBefore >= 10 ? 'rgba(0, 0, 0, 0.06)' : 'rgba(0, 0, 0, 0.08)';
      ctx.fillRect(x, cursorY, width, item.gapBefore);
      cursorY += item.gapBefore;
    }

    const rowCenterY = cursorY + rowHeight / 2;
    ctx.save();
    ctx.fillStyle = item.color;
    ctx.font = getTextFont(35);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.label, x + 36, rowCenterY + 1);
    ctx.restore();

    const iconImg = assets.icons[item.icon];
    const iconCenterX = x + width - 58;
    drawImageFitCentered(ctx, iconImg, iconCenterX, rowCenterY, iconSize);
    cursorY += rowHeight;
  });

  return menuHeight;
}

/**
 * Computes layout metrics for the bubble, menu, and canvas dimensions.
 * Ensures text never overflows and canvas height adapts cleanly.
 * @param {import('@napi-rs/canvas').CanvasRenderingContext2D} measureCtx
 * @param {string} normalizedText
 * @param {string} timestampText
 * @param {Map<string, Image>} inlineEmojiMap
 */
function computeQcLayout(measureCtx, normalizedText, timestampText, inlineEmojiMap) {
  const bubbleX = 24;
  const barX = 24;
  const barY = 26;
  const barW = 1004;
  const barH = 128;
  const bubbleY = barY + barH + 30;
  const bubbleMaxWidth = 900;
  const bubbleMinWidth = 340;
  const padX = 34;
  const padTop = 26;
  const padBottom = 24;
  const maxTextWidth = bubbleMaxWidth - padX * 2;
  const menuW = 580;
  const menuGap = 22;
  const menuHeight =
    CONTEXT_MENU_ITEMS.length * 82 +
    CONTEXT_MENU_ITEMS.reduce((sum, item) => sum + item.gapBefore, 0);
  const bottomMargin = 36;

  // Adapt font size down only if ultra-long text would exceed QC_MAX_HEIGHT.
  for (let fontSize = 42; fontSize >= 26; fontSize -= 2) {
    const lineHeight = Math.round(fontSize * 1.33);
    const tsFontSize = Math.max(20, Math.round(fontSize * 0.62));
    measureCtx.font = getTextFont(tsFontSize);
    const tsWidth = measureCtx.measureText(timestampText).width;
    const inlineTsGap = 26;

    const lines = wrapMessageLines(measureCtx, normalizedText, fontSize, maxTextWidth, inlineEmojiMap);
    const maxLineWidth = lines.reduce((max, line) => Math.max(max, line.width), 0);
    const lastLine = lines[lines.length - 1];
    const timestampInline =
      lastLine.width > 0 && lastLine.width + inlineTsGap + tsWidth <= maxTextWidth;

    const requiredContentWidth = timestampInline
      ? Math.max(maxLineWidth, lastLine.width + inlineTsGap + tsWidth)
      : Math.max(maxLineWidth, tsWidth);
    const bubbleW = Math.min(bubbleMaxWidth, Math.max(bubbleMinWidth, Math.ceil(requiredContentWidth + padX * 2)));

    const textBlockHeight = lines.length * lineHeight;
    const extraTsRow = timestampInline ? 0 : Math.round(tsFontSize * 1.35);
    const bubbleH = padTop + textBlockHeight + extraTsRow + padBottom;
    const menuY = bubbleY + bubbleH + menuGap;
    const totalHeight = menuY + menuHeight + bottomMargin;

    if (totalHeight <= QC_MAX_HEIGHT || fontSize === 26) {
      return {
        canvasWidth: QC_WIDTH,
        canvasHeight: Math.min(QC_MAX_HEIGHT, Math.max(QC_MIN_HEIGHT, totalHeight)),
        barX,
        barY,
        barW,
        barH,
        bubbleX,
        bubbleY,
        bubbleW,
        bubbleH,
        padX,
        padTop,
        padBottom,
        fontSize,
        lineHeight,
        tsFontSize,
        lines,
        timestampInline,
        menuX: 34,
        menuY,
        menuW,
      };
    }
  }
}

/**
 * Renders a WhatsApp-style chat screenshot PNG (no username, no avatar, no profile info)
 * using local PNG assets for reaction emojis and context menu icons.
 * @param {string} rawText
 * @param {{ timestamp?: Date | number | string, timeZone?: string }} [options]
 * @returns {Buffer}
 */
export function renderQcPng(rawText, options = {}) {
  ensureFontsRegistered();
  const assets = loadQcAssets();
  const normalizedText = validateQcText(rawText);
  const timestampText = formatQcTimestamp(options.timestamp, options.timeZone);

  const probeCanvas = createCanvas(QC_WIDTH, 100);
  const probeCtx = probeCanvas.getContext('2d');
  const layout = computeQcLayout(probeCtx, normalizedText, timestampText, assets.inlineEmojiMap);

  const canvas = createCanvas(layout.canvasWidth, layout.canvasHeight);
  const ctx = canvas.getContext('2d');

  // 1. Soft gradient wallpaper
  drawWallpaper(ctx, layout.canvasWidth, layout.canvasHeight);

  // 2. Reaction bar + thought-bubble dots (using local PNG assets)
  drawReactionBar(ctx, layout.barX, layout.barY, layout.barW, layout.barH, assets);

  // 3. Message bubble (no username, no avatar)
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.10)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = 'rgba(246, 247, 249, 0.96)';
  drawRoundedRectPath(ctx, layout.bubbleX, layout.bubbleY, layout.bubbleW, layout.bubbleH, 34);
  ctx.fill();
  ctx.restore();

  // Message text
  ctx.save();
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const firstBaselineY = layout.bubbleY + layout.padTop + Math.round(layout.fontSize * 0.92);
  layout.lines.forEach((line, index) => {
    if (!line.text) return;
    const y = firstBaselineY + index * layout.lineHeight;
    drawMixedText(ctx, line.text, layout.bubbleX + layout.padX, y, layout.fontSize, assets.inlineEmojiMap);
  });
  ctx.restore();

  // Timestamp at bottom-right inside bubble
  ctx.save();
  ctx.fillStyle = '#7E828A';
  ctx.font = getTextFont(layout.tsFontSize);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  const tsX = layout.bubbleX + layout.bubbleW - layout.padX;
  const tsY = layout.bubbleY + layout.bubbleH - layout.padBottom;
  ctx.fillText(timestampText, tsX, tsY);
  ctx.restore();

  // 4. Visual context menu below bubble (using local PNG icons)
  drawContextMenu(ctx, layout.menuX, layout.menuY, layout.menuW, assets);

  return canvas.toBuffer('image/png');
}
