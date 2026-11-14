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
export const BRAT_MAX_LENGTH = 1000;
export const BRAT_PADDING = 48;
export const BRAT_ATTACHMENT_NAME = 'midwave-brat.png';

const FONT_FAMILY = 'DejaVu Sans Condensed';
const FONT_PATH = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSansCondensed.ttf');
const FONT_WEIGHT = '400';
const SOFT_RASTER_SIZE = 384;
const MAX_CONTENT_WIDTH = BRAT_SIZE - BRAT_PADDING * 2;
const MAX_CONTENT_HEIGHT = BRAT_SIZE - BRAT_PADDING * 2;
const MAX_FONT_SIZE = 260;
const MIN_UNBROKEN_FONT_SIZE = 24;
const MIN_FONT_SIZE = 10;
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

  return trimmed
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .toLowerCase();
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

const SPACE_BASE_WIDTH = 0.285 * 1.04;

/**
 * Returns the normalized unit width (per 1px font size) for a single Brat token.
 * @param {{ type: string, raw: string }} unit
 * @returns {number}
 */
function getUnitBaseWidth(unit) {
  if (unit.type !== 'text') {
    return EMOJI_ADVANCE_RATIO;
  }

  const ch = unit.raw[0];
  if (ch === ' ') return SPACE_BASE_WIDTH;
  if (NARROW_CHARS.has(ch)) return 0.28 * 1.04;
  if (MEDIUM_NARROW_CHARS.has(ch)) return 0.36 * 1.04;
  if (WIDE_CHARS.has(ch)) return 0.78 * 1.04;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x1100) return 1.0 * 1.04;
  return 0.54 * 1.04;
}

/**
 * Estimates rendered width of a string (including emoji tokens) at a given font size.
 * @param {string} text
 * @param {number} fontSize
 * @returns {number}
 */
function estimateTextWidth(text, fontSize) {
  let baseWidth = 0;
  for (const unit of tokenizeBratUnits(text)) {
    baseWidth += getUnitBaseWidth(unit);
  }
  return baseWidth * fontSize;
}

/**
 * Pre-tokenizes normalized multiline text into paragraphs and measured words once
 * so font-size search does not re-run Intl.Segmenter on every candidate size.
 * @param {string} text
 * @returns {Array<{ isBlank: boolean, words: Array<{ raw: string, baseWidth: number, units: Array<{ raw: string, baseWidth: number }> }> }>}
 */
function prepareParagraphs(text) {
  return text.split('\n').map((paragraph) => {
    if (!paragraph) {
      return { isBlank: true, words: [] };
    }
    const words = paragraph.split(' ').map((word) => {
      const units = tokenizeBratUnits(word).map((unit) => ({
        raw: unit.raw,
        baseWidth: getUnitBaseWidth(unit),
      }));
      const baseWidth = units.reduce((sum, u) => sum + u.baseWidth, 0);
      return { raw: word, baseWidth, units };
    });
    return { isBlank: false, words };
  });
}

/**
 * Splits a pre-tokenized long word that exceeds maxLineWidth into fitted chunks without breaking emojis.
 * @param {{ units: Array<{ raw: string, baseWidth: number }> }} word
 * @param {number} fontSize
 * @param {number} maxLineWidth
 * @returns {Array<{ text: string, width: number }>}
 */
function splitLongWord(word, fontSize, maxLineWidth) {
  const chunks = [];
  let currentText = '';
  let currentWidth = 0;

  for (const unit of word.units) {
    const unitWidth = unit.baseWidth * fontSize;
    if (currentText && currentWidth + unitWidth > maxLineWidth) {
      chunks.push({ text: currentText, width: currentWidth });
      currentText = unit.raw;
      currentWidth = unitWidth;
    } else {
      currentText += unit.raw;
      currentWidth += unitWidth;
    }
  }

  if (currentText) {
    chunks.push({ text: currentText, width: currentWidth });
  }

  return chunks;
}

/**
 * Wraps pre-tokenized paragraphs across lines within maxLineWidth at a specific font size.
 * Returns null when allowWordBreak is false and a single word exceeds maxLineWidth.
 * @param {ReturnType<typeof prepareParagraphs>} paragraphs
 * @param {number} fontSize
 * @param {number} maxLineWidth
 * @param {boolean} allowWordBreak
 * @returns {{ lines: string[], maxLineUsedWidth: number } | null}
 */
function wrapParagraphs(paragraphs, fontSize, maxLineWidth, allowWordBreak) {
  const lines = [];
  const spaceWidth = SPACE_BASE_WIDTH * fontSize;
  let maxLineUsedWidth = 0;

  for (const paragraph of paragraphs) {
    if (paragraph.isBlank) {
      lines.push('');
      continue;
    }

    let currentLine = '';
    let currentWidth = 0;

    for (const word of paragraph.words) {
      const wordWidth = word.baseWidth * fontSize;
      const candidateWidth = currentLine ? currentWidth + spaceWidth + wordWidth : wordWidth;

      if (candidateWidth <= maxLineWidth) {
        currentLine = currentLine ? `${currentLine} ${word.raw}` : word.raw;
        currentWidth = candidateWidth;
        continue;
      }

      if (currentLine) {
        lines.push(currentLine);
        if (currentWidth > maxLineUsedWidth) maxLineUsedWidth = currentWidth;
        currentLine = '';
        currentWidth = 0;
      }

      if (wordWidth <= maxLineWidth) {
        currentLine = word.raw;
        currentWidth = wordWidth;
      } else {
        if (!allowWordBreak) {
          return null;
        }
        const broken = splitLongWord(word, fontSize, maxLineWidth);
        for (let i = 0; i < broken.length - 1; i++) {
          lines.push(broken[i].text);
          if (broken[i].width > maxLineUsedWidth) maxLineUsedWidth = broken[i].width;
        }
        const last = broken[broken.length - 1];
        currentLine = last?.text ?? '';
        currentWidth = last?.width ?? 0;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
      if (currentWidth > maxLineUsedWidth) maxLineUsedWidth = currentWidth;
    }
  }

  return { lines, maxLineUsedWidth };
}

/**
 * Computes optimal font size and wrapped lines so text stays centered with safe padding.
 * @param {string} normalizedText
 * @returns {{ fontSize: number, lineHeight: number, lines: string[] }}
 */
export function layoutBratText(normalizedText) {
  const paragraphs = prepareParagraphs(normalizedText);

  for (const allowWordBreak of [false, true]) {
    const minSize = allowWordBreak ? MIN_FONT_SIZE : MIN_UNBROKEN_FONT_SIZE;
    for (let fontSize = MAX_FONT_SIZE; fontSize >= minSize; fontSize -= 2) {
      const wrapped = wrapParagraphs(paragraphs, fontSize, MAX_CONTENT_WIDTH, allowWordBreak);
      if (!wrapped) {
        continue;
      }

      const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
      const totalHeight = (wrapped.lines.length - 1) * lineHeight + Math.round(fontSize * 1.06);

      if (wrapped.maxLineUsedWidth <= MAX_CONTENT_WIDTH && totalHeight <= MAX_CONTENT_HEIGHT) {
        return { fontSize, lineHeight, lines: wrapped.lines };
      }
    }
  }

  const fallbackFontSize = MIN_FONT_SIZE;
  const lineHeight = Math.round(fallbackFontSize * LINE_HEIGHT_RATIO);
  const fallbackWrapped = wrapParagraphs(paragraphs, fallbackFontSize, MAX_CONTENT_WIDTH, true);
  return {
    fontSize: fallbackFontSize,
    lineHeight,
    lines: fallbackWrapped?.lines ?? [normalizedText],
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
  const advanceCache = new Map();

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
    if (advanceCache.has(text)) {
      return advanceCache.get(text);
    }
    let advance;
    try {
      if (pipesRightEdge === null) {
        pipesRightEdge = measureRightEdge('||');
      }
      const fullRightEdge = measureRightEdge(`|${escapeSvgText(text)}|`);
      advance = Math.max(0, fullRightEdge - pipesRightEdge);
    } catch {
      advance = estimateTextWidth(text, fontSize);
    }
    advanceCache.set(text, advance);
    return advance;
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
  const minBlur = fontSize < 24 ? Math.max(0.6, Number((fontSize * 0.05).toFixed(2))) : 1.2;
  const blurDeviation = Math.min(2.6, Math.max(minBlur, Number((fontSize * 0.012).toFixed(2))));

  const startX = BRAT_PADDING;
  const firstBaselineY = BRAT_PADDING + fontSize * 0.82;
  const emojiAssets = options.emojiAssets ?? new Map();
  const lineSegments = lines.map((line) => buildLineRenderSegments(line, emojiAssets));
  const hasImages = lineSegments.some((segs) => segs.some((seg) => seg.type === 'image'));

  let contentMarkup;
  if (!hasImages) {
    const tspans = lineSegments
      .map((segs, index) => {
        const lineText = segs.map((seg) => seg.value).join('');
        if (!lineText) return '';
        const y = (firstBaselineY + index * lineHeight).toFixed(1);
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
