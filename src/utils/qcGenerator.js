import { createRequire } from 'node:module';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const require = createRequire(import.meta.url);

export const QC_WIDTH = 1080;
export const QC_MIN_HEIGHT = 1080;
export const QC_MAX_HEIGHT = 4096;
export const QC_MAX_LENGTH = 2000;
export const QC_DEFAULT_TIMEZONE = 'Asia/Jakarta';
export const QC_ATTACHMENT_NAME = 'midwave-qc.png';
export const QC_REACTION_EMOJIS = Object.freeze(['❤️', '🤝', '👍', '👎', '🔥', '🥰', '👏']);

const UNICODE_EMOJI_REGEX =
  /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Extended_Pictographic}(?=[\u200D\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]))(?:\uFE0F|\u200D|\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}])*)$/u;

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
let fontsRegistered = false;

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

/**
 * Resolves the configured bot timezone, defaulting to Asia/Jakarta.
 * @param {string} [preferredTimeZone]
 * @returns {string}
 */
export function resolveQcTimeZone(preferredTimeZone) {
  const candidate =
    (typeof preferredTimeZone === 'string' && preferredTimeZone.trim()) ||
    process.env.BOT_TIMEZONE?.trim() ||
    process.env.TZ?.trim() ||
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

  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(validDate);

  // Guard against engines that format midnight as 24:xx.
  return formatted.startsWith('24:') ? `00:${formatted.slice(3)}` : formatted;
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
 * Splits a string into plain-text and color-emoji runs using grapheme segmentation.
 * @param {string} text
 * @returns {Array<{ isEmoji: boolean, text: string }>}
 */
function segmentTextRuns(text) {
  const runs = [];
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const isEmoji = UNICODE_EMOJI_REGEX.test(segment);
    const prev = runs[runs.length - 1];
    if (prev && prev.isEmoji === isEmoji) {
      prev.text += segment;
    } else {
      runs.push({ isEmoji, text: segment });
    }
  }
  return runs;
}

/**
 * Measures the width of text containing mixed sans-serif characters and emojis.
 * @param {import('@napi-rs/canvas').CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} fontSize
 * @returns {number}
 */
function measureMixedTextWidth(ctx, text, fontSize) {
  if (!text) return 0;
  let total = 0;
  for (const run of segmentTextRuns(text)) {
    ctx.font = run.isEmoji ? getEmojiFont(fontSize) : getTextFont(fontSize);
    total += ctx.measureText(run.text).width;
  }
  return total;
}

/**
 * Draws text containing mixed sans-serif characters and color emojis from (x, y).
 * @param {import('@napi-rs/canvas').CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} fontSize
 */
function drawMixedText(ctx, text, x, y, fontSize) {
  let cursorX = x;
  for (const run of segmentTextRuns(text)) {
    ctx.font = run.isEmoji ? getEmojiFont(fontSize) : getTextFont(fontSize);
    ctx.fillText(run.text, cursorX, y);
    cursorX += ctx.measureText(run.text).width;
  }
}

/**
 * Wraps multiline message text to fit within maxWidth without clipping long words or emojis.
 * @param {import('@napi-rs/canvas').CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} fontSize
 * @param {number} maxWidth
 * @returns {Array<{ text: string, width: number }>}
 */
function wrapMessageLines(ctx, text, fontSize, maxWidth) {
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
      if (measureMixedTextWidth(ctx, candidate, fontSize) <= maxWidth) {
        currentLine = candidate;
        continue;
      }

      if (currentLine) {
        lines.push({
          text: currentLine,
          width: measureMixedTextWidth(ctx, currentLine, fontSize),
        });
        currentLine = '';
      }

      if (measureMixedTextWidth(ctx, word, fontSize) <= maxWidth) {
        currentLine = word;
      } else {
        // Split unspaced long token by grapheme to preserve emojis intact.
        let chunk = '';
        for (const { segment } of graphemeSegmenter.segment(word)) {
          const nextChunk = chunk + segment;
          if (chunk && measureMixedTextWidth(ctx, nextChunk, fontSize) > maxWidth) {
            lines.push({
              text: chunk,
              width: measureMixedTextWidth(ctx, chunk, fontSize),
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
        width: measureMixedTextWidth(ctx, currentLine, fontSize),
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

function drawReactionBar(ctx, x, y, width, height) {
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

  // Render 7 reaction emojis evenly spaced.
  const emojiAreaStart = x + 46;
  const emojiAreaEnd = x + width - 134;
  const slotWidth = (emojiAreaEnd - emojiAreaStart) / QC_REACTION_EMOJIS.length;
  const centerY = y + height / 2;

  ctx.save();
  ctx.font = getEmojiFont(60);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#111111';
  QC_REACTION_EMOJIS.forEach((emoji, idx) => {
    const cx = emojiAreaStart + slotWidth * (idx + 0.5);
    ctx.fillText(emoji, cx, centerY + 2);
  });
  ctx.restore();

  // Circular dropdown chevron button on the right.
  const btnCenterX = x + width - 64;
  const btnCenterY = y + height / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(154, 198, 252, 0.62)';
  ctx.beginPath();
  ctx.arc(btnCenterX, btnCenterY, 39, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(btnCenterX - 13, btnCenterY - 5);
  ctx.lineTo(btnCenterX, btnCenterY + 8);
  ctx.lineTo(btnCenterX + 13, btnCenterY - 5);
  ctx.stroke();
  ctx.restore();
}

function drawMenuIcon(ctx, type, cx, cy, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (type === 'reply') {
    ctx.beginPath();
    ctx.moveTo(cx - 2, cy - 13);
    ctx.lineTo(cx - 15, cy - 2);
    ctx.lineTo(cx - 2, cy + 9);
    ctx.lineTo(cx - 2, cy + 3);
    ctx.quadraticCurveTo(cx + 12, cy + 3, cx + 16, cy + 13);
    ctx.quadraticCurveTo(cx + 16, cy - 7, cx - 2, cy - 7);
    ctx.closePath();
    ctx.stroke();
  } else if (type === 'copy') {
    drawRoundedRectPath(ctx, cx - 12, cy - 13, 18, 22, 3);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 6, cy - 7);
    ctx.lineTo(cx + 12, cy - 7);
    ctx.quadraticCurveTo(cx + 14, cy - 7, cx + 14, cy - 5);
    ctx.lineTo(cx + 14, cy + 13);
    ctx.quadraticCurveTo(cx + 14, cy + 15, cx + 12, cy + 15);
    ctx.lineTo(cx - 4, cy + 15);
    ctx.quadraticCurveTo(cx - 6, cy + 15, cx - 6, cy + 13);
    ctx.lineTo(cx - 6, cy + 9);
    ctx.stroke();
  } else if (type === 'pin') {
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy - 13);
    ctx.lineTo(cx + 10, cy - 13);
    ctx.lineTo(cx + 7, cy - 3);
    ctx.lineTo(cx + 12, cy + 4);
    ctx.lineTo(cx - 12, cy + 4);
    ctx.lineTo(cx - 7, cy - 3);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy + 4);
    ctx.lineTo(cx, cy + 16);
    ctx.stroke();
  } else if (type === 'forward') {
    ctx.beginPath();
    ctx.moveTo(cx + 2, cy - 13);
    ctx.lineTo(cx + 15, cy - 2);
    ctx.lineTo(cx + 2, cy + 9);
    ctx.lineTo(cx + 2, cy + 3);
    ctx.quadraticCurveTo(cx - 12, cy + 3, cx - 16, cy + 13);
    ctx.quadraticCurveTo(cx - 16, cy - 7, cx + 2, cy - 7);
    ctx.closePath();
    ctx.stroke();
  } else if (type === 'delete') {
    // Lid + handle
    ctx.beginPath();
    ctx.moveTo(cx - 13, cy - 9);
    ctx.lineTo(cx + 13, cy - 9);
    ctx.moveTo(cx - 5, cy - 9);
    ctx.lineTo(cx - 5, cy - 14);
    ctx.lineTo(cx + 5, cy - 14);
    ctx.lineTo(cx + 5, cy - 9);
    ctx.stroke();
    // Bin body
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy - 9);
    ctx.lineTo(cx - 8, cy + 13);
    ctx.quadraticCurveTo(cx - 8, cy + 15, cx - 6, cy + 15);
    ctx.lineTo(cx + 6, cy + 15);
    ctx.quadraticCurveTo(cx + 8, cy + 15, cx + 8, cy + 13);
    ctx.lineTo(cx + 10, cy - 9);
    ctx.stroke();
    // Vertical slats
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy - 4);
    ctx.lineTo(cx - 3.5, cy + 10);
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 10);
    ctx.moveTo(cx + 4, cy - 4);
    ctx.lineTo(cx + 3.5, cy + 10);
    ctx.stroke();
  } else if (type === 'select') {
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy + 0.5);
    ctx.lineTo(cx - 1.5, cy + 5);
    ctx.lineTo(cx + 7, cy - 4.5);
    ctx.stroke();
  }

  ctx.restore();
}

const CONTEXT_MENU_ITEMS = Object.freeze([
  { label: 'Reply', icon: 'reply', color: '#111111', gapBefore: 0 },
  { label: 'Copy', icon: 'copy', color: '#111111', gapBefore: 1.5 },
  { label: 'Pin', icon: 'pin', color: '#111111', gapBefore: 1.5 },
  { label: 'Forward', icon: 'forward', color: '#111111', gapBefore: 1.5 },
  { label: 'Delete', icon: 'delete', color: '#E5484D', gapBefore: 1.5 },
  { label: 'Select', icon: 'select', color: '#111111', gapBefore: 12 },
]);

function drawContextMenu(ctx, x, y, width) {
  const rowHeight = 82;
  const totalDividers = CONTEXT_MENU_ITEMS.reduce((sum, item) => sum + item.gapBefore, 0);
  const menuHeight = CONTEXT_MENU_ITEMS.length * rowHeight + totalDividers;

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

    drawMenuIcon(ctx, item.icon, x + width - 58, rowCenterY, item.color);
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
 */
function computeQcLayout(measureCtx, normalizedText, timestampText) {
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

    const lines = wrapMessageLines(measureCtx, normalizedText, fontSize, maxTextWidth);
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
 * Renders a WhatsApp-style chat screenshot PNG (no username, no avatar, no profile info).
 * @param {string} rawText
 * @param {{ timestamp?: Date | number | string, timeZone?: string }} [options]
 * @returns {Buffer}
 */
export function renderQcPng(rawText, options = {}) {
  ensureFontsRegistered();
  const normalizedText = validateQcText(rawText);
  const timestampText = formatQcTimestamp(options.timestamp, options.timeZone);

  const probeCanvas = createCanvas(QC_WIDTH, 100);
  const probeCtx = probeCanvas.getContext('2d');
  const layout = computeQcLayout(probeCtx, normalizedText, timestampText);

  const canvas = createCanvas(layout.canvasWidth, layout.canvasHeight);
  const ctx = canvas.getContext('2d');

  // 1. Soft gradient wallpaper
  drawWallpaper(ctx, layout.canvasWidth, layout.canvasHeight);

  // 2. Reaction bar + thought-bubble dots
  drawReactionBar(ctx, layout.barX, layout.barY, layout.barW, layout.barH);

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
    drawMixedText(ctx, line.text, layout.bubbleX + layout.padX, y, layout.fontSize);
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

  // 4. Visual context menu below bubble
  drawContextMenu(ctx, layout.menuX, layout.menuY, layout.menuW);

  return canvas.toBuffer('image/png');
}
