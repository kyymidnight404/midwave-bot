import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';

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
 * Estimates rendered width of a string in DejaVu Sans Condensed Regular at a given font size.
 * @param {string} text
 * @param {number} fontSize
 * @returns {number}
 */
function estimateTextWidth(text, fontSize) {
  let units = 0;
  for (const ch of text) {
    if (ch === ' ') {
      units += 0.28;
    } else if (NARROW_CHARS.has(ch)) {
      units += 0.28;
    } else if (MEDIUM_NARROW_CHARS.has(ch)) {
      units += 0.36;
    } else if (WIDE_CHARS.has(ch)) {
      units += 0.78;
    } else {
      units += 0.54;
    }
  }
  // Conservative safety margin for kerning and soft Gaussian blur spread.
  return units * fontSize * 1.04;
}

/**
 * Splits a single long token that exceeds maxLineWidth into fitted chunks.
 * @param {string} word
 * @param {number} fontSize
 * @param {number} maxLineWidth
 * @returns {string[]}
 */
function splitLongWord(word, fontSize, maxLineWidth) {
  const chunks = [];
  let current = '';

  for (const ch of word) {
    const candidate = current + ch;
    if (current && estimateTextWidth(candidate, fontSize) > maxLineWidth) {
      chunks.push(current);
      current = ch;
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
 * Builds the 1024x1024 top-left aligned Brat-style SVG markup for validated text.
 * @param {string} rawText
 * @returns {string}
 */
export function buildBratSvg(rawText) {
  const normalized = validateBratText(rawText);
  const { fontSize, lineHeight, lines } = layoutBratText(normalized);
  const blurDeviation = Math.min(2.6, Math.max(1.2, Number((fontSize * 0.012).toFixed(2))));

  const startX = BRAT_PADDING;
  const firstBaselineY = BRAT_PADDING + fontSize * 0.82;

  const tspans = lines
    .map((line, index) => {
      const y = (firstBaselineY + index * lineHeight).toFixed(1);
      return `<tspan x="${startX}" y="${y}">${escapeSvgText(line)}</tspan>`;
    })
    .join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BRAT_SIZE}" height="${BRAT_SIZE}" viewBox="0 0 ${BRAT_SIZE} ${BRAT_SIZE}">`,
    '<defs>',
    '<filter id="brat-blur" x="-10%" y="-10%" width="120%" height="120%">',
    `<feGaussianBlur stdDeviation="${blurDeviation}" />`,
    '</filter>',
    '</defs>',
    `<rect width="${BRAT_SIZE}" height="${BRAT_SIZE}" fill="${BRAT_BG_COLOR}" />`,
    `<text fill="${BRAT_TEXT_COLOR}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="${FONT_WEIGHT}" text-anchor="start" filter="url(#brat-blur)">`,
    tspans,
    '</text>',
    '</svg>',
  ].join('');
}

/**
 * Renders a 1024x1024 soft lo-fi Brat-style PNG buffer in memory.
 * @param {string} rawText
 * @param {{ resvgClass?: typeof Resvg, fontPath?: string }} [options]
 * @returns {Buffer}
 */
export function renderBratPng(rawText, options = {}) {
  const svg = buildBratSvg(rawText);
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
