/**
 * Official Midwave global embed color palette.
 * Primary (#70B1FC Sky Blue) is the default color for all embeds.
 */
export const EMBED_COLOR_HEX = Object.freeze({
  PRIMARY: '#70B1FC',
  SECONDARY: '#477FDC',
  SUCCESS: '#57F287',
  ERROR: '#ED4245',
  WARNING: '#FEE75C',
  INFO: '#70B1FC',
});

export const COLORS = Object.freeze({
  PRIMARY: 0x70b1fc,
  SECONDARY: 0x477fdc,
  SUCCESS: 0x57f287,
  ERROR: 0xed4245,
  WARNING: 0xfee75c,
  INFO: 0x70b1fc,
  // Backward-compatible aliases for existing Midwave modules
  DANGER: 0xed4245,
  ACCENT: 0x70b1fc,
  MUTED: 0x477fdc,
});

export const DEFAULT_EMBED_COLOR = COLORS.PRIMARY;
