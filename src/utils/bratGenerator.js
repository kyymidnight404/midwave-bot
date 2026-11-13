import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import {
  buildLineRenderSegments,
  resolveBratEmojiAssets,
  tokenizeBratUnits,
} from './bratEmoji.js';

const require = createRequire(import.meta.url);

export const BRAT_SIZE = 1024;
export const BRAT_BG_COLOR = '#FFFFFF';
export const BRAT_TEXT_COLOR = '#000000';
export const BRAT_MAX_LENGTH = 100;
export const BRAT_PADDING = 48;
export const BRAT_ATTACHMENT_NAME = 'midwave-brat.png';

const FONT_FAMILY = 'DejaVu Sans Condensed';
const FONT_PATH = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSansCondensed.ttf');
const FONT_WEIGHT = '400';
const SOFT_RASTER_SIZE = 384;
const MAX_CONTENT_WIDTH = BRAT_SIZE - BRAT_PADDING * 2;
const MAX_CONTENT_HEIGHT = BRAT_SIZE - BRAT_PADDING * 2;
const MAX_FONT_SIZE = 260;
const MIN_FONT_SIZE = 24;
const LINE_HEIGHT_RATIO = 1.08;
const EMOJI_SIZE_RATIO = 0.88;
const EMOJI_ADVANCE_RATIO = 0.94;
const EMOJI_TOP_OFFSET_RATIO = 0.76;

const NARROW_CHARS = new Set(['i', 'l', 'j', '!', '.', ',', ':', ';', '\'', '|']);
const MEDIUM_NARROW_CHARS = new Set(['f', 'r', 't', '(', ')', '[', ']', '-', '/']);
const WIDE_CHARS = new Set(['m', 'w', '@', '%', '&', '#', '+', '=']);

/**
 * Validates and normalizes user text for Brat generation.
 * @param {string} rawText
 * @returns {string}
 */
export function validateBratText(rawText) {
  if (typeof rawText !== 'string') {
    throw new Error('Teks wajib diisi.');
  }

  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('Teks tidak boleh kosong atau hanya berisi spasi.');
  }

  if (trimmed.length > BRAT_MAX_LENGTH) {
    throw new Error(`Teks maksimal ${BRAT_MAX_LENGTH} karakter.`);
  }

  return trimmed.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Escapes XML/SVG reserved characters and strips control characters to prevent SVG injection.
 * @param {string} text
 * @returns {string}
 */
export function escapeSvgText(text) {
  return String(text)
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Estimates rendered width of a string (including emoji tokens) at a given font size.
 * @param {string} text
 * @param {number} fontSize
 * @returns {number}
 */
function estimateTextWidth(text, fontSize) {
  let textUnits = 0;
  let emojiCount = 0;

  for (const unit of tokenizeBratUnits(text)) {
    if (unit.type !== 'text') {
      emojiCount++;
      continue;
    }

    const ch = unit.raw[0];
    if (ch === ' ') {
      textUnits += 0.285;
    } else if (NARROW_CHARS.has(ch)) {
      textUnits += 0.28;
    } else if (MEDIUM_NARROW_CHARS.has(ch)) {
      textUnits += 0.36;
    } else if (WIDE_CHARS.has(ch)) {
      textUnits += 0.78;
    } else {
      textUnits += 0.54;
    }
  }

  // Conservative safety margin for text kerning/blur plus fixed advance per inline emoji.
  return (textUnits * 1.04 + emojiCount * EMOJI_ADVANCE_RATIO) * fontSize;
}

/**
 * Splits a single long token that exceeds maxLineWidth into fitted chunks without breaking emojis.
 * @param {string} word
 * @param {number} fontSize
 * @param {number} maxLineWidth
 * @returns {string[]}
 */
function splitLongWord(word, fontSize, maxLineWidth) {
  const chunks = [];
  let current = '';

  for (const unit of tokenizeBratUnits(word)) {
    const candidate = current + unit.raw;
    if (current && estimateTextWidth(candidate, fontSize) > maxLineWidth) {
      chunks.push(current);
      current = unit.raw;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Wraps normalized text across lines within maxLineWidth at a specific font size.
 * Returns null when allowWordBreak is false and a single word exceeds maxLineWidth.
 * @param {string} text
 * @param {number} fontSize
 * @param {number} maxLineWidth
 * @param {boolean} allowWordBreak
 * @returns {string[] | null}
 */
function wrapLines(text, fontSize, maxLineWidth, allowWordBreak) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (estimateTextWidth(candidate, fontSize) <= maxLineWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
      currentLine = '';
    }

    if (estimateTextWidth(word, fontSize) <= maxLineWidth) {
      currentLine = word;
    } else {
      if (!allowWordBreak) {
        return null;
      }
      const broken = splitLongWord(word, fontSize, maxLineWidth);
      lines.push(...broken.slice(0, -1));
      currentLine = broken[broken.length - 1] ?? '';
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Computes optimal font size and wrapped lines so text stays centered with safe padding.
 * @param {string} normalizedText
 * @returns {{ fontSize: number, lineHeight: number, lines: string[] }}
 */
export function layoutBratText(normalizedText) {
  for (const allowWordBreak of [false, true]) {
    for (let fontSize = MAX_FONT_SIZE; fontSize >= MIN_FONT_SIZE; fontSize -= 2) {
      const lines = wrapLines(normalizedText, fontSize, MAX_CONTENT_WIDTH, allowWordBreak);
      if (!lines) {
        continue;
      }

      const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
      const totalHeight = (lines.length - 1) * lineHeight + Math.round(fontSize * 1.06);
      const fitsWidth = lines.every((line) => estimateTextWidth(line, fontSize) <= MAX_CONTENT_WIDTH);

      if (fitsWidth && totalHeight <= MAX_CONTENT_HEIGHT) {
        return { fontSize, lineHeight, lines };
      }
    }
  }

  const fallbackFontSize = MIN_FONT_SIZE;
  const lineHeight = Math.round(fallbackFontSize * LINE_HEIGHT_RATIO);
  return {
    fontSize: fallbackFontSize,
    lineHeight,
    lines: wrapLines(normalizedText, fallbackFontSize, MAX_CONTENT_WIDTH, true) ?? [normalizedText],
  };
}

/**
 * Creates a cached advance-width measurer for inline text + emoji alignment using Resvg.
 * @param {number} fontSize
 * @param {string} fontPath
 * @param {typeof Resvg} ResvgImpl
 * @returns {(text: string) => number}
 */
function createTextAdvanceMeasurer(fontSize, fontPath, ResvgImpl) {
  const fontOpts = {
    loadSystemFonts: false,
    fontFiles: [fontPath],
    defaultFontFamily: FONT_FAMILY,
  };
  let pipesRightEdge = null;

  const measureRightEdge = (content) => {
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="${Math.ceil(fontSize * 3)}">`,
      `<text x="0" y="${Math.ceil(fontSize * 1.5)}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="${FONT_WEIGHT}" xml:space="preserve">${content}</text>`,
      '</svg>',
    ].join('');
    const bbox = new ResvgImpl(svg, { font: fontOpts }).getBBox();
    return bbox ? bbox.x + bbox.width : 0;
  };

  return (text) => {
    if (!text) return 0;
    try {
      if (pipesRightEdge === null) {
        pipesRightEdge = measureRightEdge('||');
      }
      const fullRightEdge = measureRightEdge(`|${escapeSvgText(text)}|`);
      return Math.max(0, fullRightEdge - pipesRightEdge);
    } catch {
      return estimateTextWidth(text, fontSize);
    }
  };
}

/**
 * Builds the 1024x1024 top-left aligned Brat-style SVG markup for validated text.
 * @param {string} rawText
 * @param {{ emojiAssets?: Map<string, string>, fontPath?: string, resvgClass?: typeof Resvg }} [options]
 * @returns {string}
 */
export function buildBratSvg(rawText, options = {}) {
  const normalized = validateBratText(rawText);
  const { fontSize, lineHeight, lines } = layoutBratText(normalized);
  const blurDeviation = Math.min(2.6, Math.max(1.2, Number((fontSize * 0.012).toFixed(2))));

  const startX = BRAT_PADDING;
  const firstBaselineY = BRAT_PADDING + fontSize * 0.82;
  const emojiAssets = options.emojiAssets ?? new Map();
  const lineSegments = lines.map((line) => buildLineRenderSegments(line, emojiAssets));
  const hasImages = lineSegments.some((segs) => segs.some((seg) => seg.type === 'image'));

  let contentMarkup;
  if (!hasImages) {
    const tspans = lineSegments
      .map((segs, index) => {
        const y = (firstBaselineY + index * lineHeight).toFixed(1);
        const lineText = segs.map((seg) => seg.value).join('');
        return `<tspan x="${startX}" y="${y}">${escapeSvgText(lineText)}</tspan>`;
      })
      .join('');
    contentMarkup = `<text fill="${BRAT_TEXT_COLOR}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="${FONT_WEIGHT}" text-anchor="start" filter="url(#brat-blur)">${tspans}</text>`;
  } else {
    const measureAdvance = createTextAdvanceMeasurer(
      fontSize,
      options.fontPath ?? FONT_PATH,
      options.resvgClass ?? Resvg,
    );
    const emojiSize = fontSize * EMOJI_SIZE_RATIO;
    const emojiAdvance = fontSize * EMOJI_ADVANCE_RATIO;
    const emojiXOffset = (emojiAdvance - emojiSize) / 2;
    const emojiYOffset = fontSize * EMOJI_TOP_OFFSET_RATIO;

    const tspans = [];
    const emojiImages = [];

    lineSegments.forEach((segs, index) => {
      const baselineY = firstBaselineY + index * lineHeight;
      const yStr = baselineY.toFixed(1);
      let cursorX = startX;

      for (const seg of segs) {
        if (seg.type === 'text') {
          tspans.push(`<tspan x="${cursorX.toFixed(1)}" y="${yStr}">${escapeSvgText(seg.value)}</tspan>`);
          cursorX += measureAdvance(seg.value);
        } else {
          const emojiX = (cursorX + emojiXOffset).toFixed(1);
          const emojiY = (baselineY - emojiYOffset).toFixed(1);
          emojiImages.push(
            `<image x="${emojiX}" y="${emojiY}" width="${emojiSize.toFixed(1)}" height="${emojiSize.toFixed(1)}" href="${escapeSvgText(seg.href)}" />`,
          );
          cursorX += emojiAdvance;
        }
      }
    });

    contentMarkup = [
      '<g filter="url(#brat-blur)">',
      `<text fill="${BRAT_TEXT_COLOR}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="${FONT_WEIGHT}" text-anchor="start" xml:space="preserve">${tspans.join('')}</text>`,
      emojiImages.join(''),
      '</g>',
    ].join('');
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BRAT_SIZE}" height="${BRAT_SIZE}" viewBox="0 0 ${BRAT_SIZE} ${BRAT_SIZE}">`,
    '<defs>',
    '<filter id="brat-blur" x="-10%" y="-10%" width="120%" height="120%">',
    `<feGaussianBlur stdDeviation="${blurDeviation}" />`,
    '</filter>',
    '</defs>',
    `<rect width="${BRAT_SIZE}" height="${BRAT_SIZE}" fill="${BRAT_BG_COLOR}" />`,
    contentMarkup,
    '</svg>',
  ].join('');
}

/**
 * Renders a 1024x1024 soft lo-fi Brat-style PNG buffer in memory.
 * @param {string} rawText
 * @param {{ resvgClass?: typeof Resvg, fontPath?: string, emojiAssets?: Map<string, string> }} [options]
 * @returns {Buffer}
 */
export function renderBratPng(rawText, options = {}) {
  const svg = buildBratSvg(rawText, options);
  const ResvgImpl = options.resvgClass ?? Resvg;
  const fontPath = options.fontPath ?? FONT_PATH;

  try {
    // Rasterize first at lower resolution to reproduce authentic soft/lo-fi Brat edges,
    // then upscale cleanly back to 1024x1024 on solid white canvas.
    const softPass = new ResvgImpl(svg, {
      fitTo: { mode: 'width', value: SOFT_RASTER_SIZE },
      font: {
        loadSystemFonts: false,
        fontFiles: [fontPath],
        defaultFontFamily: FONT_FAMILY,
      },
    });
    const softPng = softPass.render().asPng();

    const upscaleSvg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${BRAT_SIZE}" height="${BRAT_SIZE}" viewBox="0 0 ${BRAT_SIZE} ${BRAT_SIZE}">`,
      `<rect width="${BRAT_SIZE}" height="${BRAT_SIZE}" fill="${BRAT_BG_COLOR}" />`,
      `<image width="${BRAT_SIZE}" height="${BRAT_SIZE}" href="data:image/png;base64,${softPng.toString('base64')}" />`,
      '</svg>',
    ].join('');

    const finalPass = new ResvgImpl(upscaleSvg, {
      fitTo: { mode: 'width', value: BRAT_SIZE },
    });
    const pngBuffer = finalPass.render().asPng();
    if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
      throw new Error('Hasil buffer PNG kosong.');
    }
    return pngBuffer;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'kesalahan tidak dikenal';
    throw new Error(`Gagal merender gambar Brat: ${detail}`);
  }
}

/**
 * Resolves Unicode and Discord custom emojis before rendering a 1024x1024 Brat PNG buffer.
 * @param {string} rawText
 * @param {{ resvgClass?: typeof Resvg, fontPath?: string, emojiAssets?: Map<string, string>, fetchFn?: typeof fetch, timeoutMs?: number, cache?: Map<string, string> }} [options]
 * @returns {Promise<Buffer>}
 */
export async function renderBratPngAsync(rawText, options = {}) {
  const normalized = validateBratText(rawText);
  const emojiAssets = options.emojiAssets ?? (await resolveBratEmojiAssets(normalized, options));
  return renderBratPng(rawText, { ...options, emojiAssets });
}
