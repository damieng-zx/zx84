/**
 * Screen OCR — bitmap-level character recognition for the ZX Spectrum display.
 *
 * The engine extracts each character cell from the displayed screen bank and
 * compares it against a prioritised font list. Cell layout is configurable
 * (8×8 standard, 5×8 CP/M Plus 51-column, 4×8 Tasword 64-column…) and the
 * engine reads from the bank the ULA actually displays — not the paged Z80
 * view — so it stays correct under +3 special paging.
 *
 * Font sources, in order of preference:
 *   1. CHARS sysvar font (8-wide only — pointer at BASIC sysvar 0x5C36)
 *   2. 48K ROM font (8-wide only — checked against the screen first)
 *   3. Heuristic scan across all RAM banks AND ROM pages, locating a 768-byte
 *      window whose glyphs explain the screen. Cached per grid (positive and
 *      negative). Falls back here for the 8-wide path too — covers the +3
 *      boot menu's editor font, which lives in ROM.
 *   4. Extra fonts from the fonts pane
 */

/** Cell-grid configuration for OCR. */
export interface OcrConfig {
  /** Pixels per cell column (4, 5, 6, 8…). */
  cellWidth: number;
  /** Pixels per cell row (8 in practice). */
  cellHeight: number;
  cols: number;
  rows: number;
  /** Pixel x-offset of grid origin (default 0). */
  xOffset?: number;
  /** Pixel y-offset of grid origin (default 0). */
  yOffset?: number;
}

/** Built-in cell-grid presets. */
export type OcrGridName = '32x24' | '51x24' | '64x24';

export const OCR_GRIDS: Record<OcrGridName, OcrConfig> = {
  '32x24': { cellWidth: 8, cellHeight: 8, cols: 32, rows: 24 },
  '51x24': { cellWidth: 5, cellHeight: 8, cols: 51, rows: 24 },
  '64x24': { cellWidth: 4, cellHeight: 8, cols: 64, rows: 24 },
};

/** A font source for OCR matching.
 *  `data` is always 768 bytes (96 chars × 8 bytes). For non-8-wide cells only
 *  `cellWidth` bits of each byte are significant.
 *
 *  `bitOffset` is the number of zero bits to the LEFT of the glyph in each
 *  font byte: 0 means glyph is MSB-aligned (top of byte); a value of N means
 *  the font byte must be left-shifted by N before comparing with a screen
 *  glyph (e.g. Tasword 64 stores 4-pixel glyphs in bits 3-0, so bitOffset=4). */
export interface FontSource {
  label: string;
  data: Uint8Array;
  /** Cell width the font was authored for (defaults to 8). */
  cellWidth?: number;
  /** Glyph left-shift inside each font byte (defaults to 0 = MSB-aligned). */
  bitOffset?: number;
}

/** OCR result. */
export interface OcrResult {
  /** Plain text with newlines between rows. */
  text: string;
  /** HTML with per-cell coloured spans. */
  html: string;
  /** `cols×rows` bitmask: true = cell was matched (used to blank the framebuffer). */
  mask: boolean[];
  /** Grid the result was produced with. */
  grid: OcrGridName;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
}

/** Map character code (33-127) to display character. */
function charForCode(c: number): string {
  return c === 0x5E ? '↑' : c === 0x60 ? '£' : c === 0x7F ? '©'
       : String.fromCharCode(c);
}

/** Convert ABGR uint32 palette entry to CSS hex colour. */
function abgrToHex(abgr: number): string {
  const r = (abgr >>> 0) & 0xFF;
  const g = (abgr >>> 8) & 0xFF;
  const b = (abgr >>> 16) & 0xFF;
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/** Escape a character for safe HTML insertion. */
function escapeHtml(ch: string): string {
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '&') return '&amp;';
  return ch;
}

/** Bitmap mask covering the upper `cellWidth` bits of an 8-bit byte. */
function bitMaskFor(cellWidth: number): number {
  return cellWidth >= 8 ? 0xFF : (0xFF << (8 - cellWidth)) & 0xFF;
}

/** Cached `Object.keys(OCR_GRIDS)` — used in tight per-frame loops. */
const OCR_GRID_KEYS: readonly OcrGridName[] = Object.keys(OCR_GRIDS) as OcrGridName[];

/** Shared scratch buffer for a single 8-byte glyph. Reused across all OCR
 *  helpers — calls aren't concurrent (single-threaded JS, synchronous calls). */
const scratchGlyph = new Uint8Array(8);

/** 32-bit FNV-1a hash over `len` bytes of `g`. Used as a fast Set/Map key in
 *  hot paths instead of stringifying the bytes. Collisions just mean two
 *  unequal glyphs share a bucket — for OCR's tile-uniqueness counting that
 *  rounds the unique count down by ≤1 per collision, which doesn't change
 *  grid selection. */
function hashGlyph(g: Uint8Array, len: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < len; i++) {
    h ^= g[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Compare two 768-byte fonts. */
function fontsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < 768 || b.length < 768) return false;
  for (let i = 0; i < 768; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Spectrum screen byte offset within a 16KB display bank for pixel row `y`
 * and byte column `byteCol` (0–31). Bank-relative — the 0x4000 base is implicit.
 */
function screenByteOffset(y: number, byteCol: number): number {
  return ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | (byteCol & 0x1F);
}

/**
 * Extract one character cell into `out` (8 bytes, MSB-first).
 * For sub-byte cell widths the bits are aligned to the top of each byte so that
 * fonts of any width share the same `(c-32)*8 + p` index → byte layout.
 */
export function extractCellGlyph(
  screenBank: Uint8Array, col: number, row: number, config: OcrConfig, out: Uint8Array,
): void {
  const cellW = config.cellWidth;
  const cellH = config.cellHeight;
  const startPx = col * cellW + (config.xOffset ?? 0);
  const startY = row * cellH + (config.yOffset ?? 0);
  const byteCol = startPx >> 3;
  const bitOff = startPx & 7;
  const bitsFromLo = 8 - bitOff;
  const mask = bitMaskFor(cellW);

  for (let p = 0; p < cellH; p++) {
    const y = startY + p;
    if (y < 0 || y >= 192 || byteCol > 31) { out[p] = 0; continue; }
    const off = screenByteOffset(y, byteCol);
    let bits = (screenBank[off] << bitOff) & 0xFF;
    if (cellW > bitsFromLo && byteCol < 31) {
      const next = screenBank[screenByteOffset(y, byteCol + 1)];
      bits |= (next >>> bitsFromLo) & 0xFF;
    }
    out[p] = bits & mask;
  }
  // Zero unused rows for hashing stability
  for (let p = cellH; p < 8; p++) out[p] = 0;
}

/**
 * Try to match an extracted glyph against all printable codes in a font.
 * Tries the normal glyph first, then inverted (paper-on-ink).
 * `bitOffset` left-shifts each font byte before masking — used when the font
 * stores its glyphs right-aligned in the byte (e.g. Tasword 4-pixel chars in
 * bits 3-0 need bitOffset=4 to bring them up to bits 7-4).
 */
function matchGlyph(
  glyph: Uint8Array, font: Uint8Array, cellH: number, mask: number, bitOffset: number,
): string {
  for (let invertPass = 0; invertPass < 2; invertPass++) {
    const invert = invertPass === 1;
    for (let c = 33; c < 128; c++) {
      if (c === 0x5F) continue; // skip '_' — too easily matched as a line
      const fb = (c - 32) << 3;
      let match = true;
      for (let p = 0; p < cellH; p++) {
        const shifted = (font[fb + p] << bitOffset) & 0xFF;
        const expect = invert ? (shifted ^ mask) & mask : shifted & mask;
        if (glyph[p] !== expect) { match = false; break; }
      }
      if (match) return charForCode(c);
    }
  }
  return '';
}

/** True if the glyph is entirely zero. */
function isBlankGlyph(glyph: Uint8Array, cellH: number): boolean {
  for (let p = 0; p < cellH; p++) if (glyph[p] !== 0) return false;
  return true;
}

/**
 * Quick validation pass: count how many non-blank screen cells the candidate
 * font can match. Used to decide whether CHARS sysvar / extracted RAM fonts
 * are real before committing to them.
 */
function validateFontAgainstScreen(
  screenBank: Uint8Array, fontData: Uint8Array, config: OcrConfig, threshold: number,
  bitOffset = 0,
): boolean {
  const cellH = config.cellHeight;
  const mask = bitMaskFor(config.cellWidth);
  let matchCount = 0;
  for (let r = 0; r < config.rows; r++) {
    for (let c = 0; c < config.cols; c++) {
      extractCellGlyph(screenBank, c, r, config, scratchGlyph);
      if (isBlankGlyph(scratchGlyph, cellH)) continue;
      if (matchGlyph(scratchGlyph, fontData, cellH, mask, bitOffset)) {
        if (++matchCount >= threshold) return true;
      }
    }
  }
  return false;
}

/** Debounce key — only emits a `[OCR] grid` log when the picked grid changes. */
let lastGridLogKey = '';
/** Force the next detectGrid call to emit its log line. Reset on activate(). */
let forceGridLog = false;
function resetGridLog(): void { lastGridLogKey = ''; forceGridLog = true; }

/** Inject a log sink. Default null = silent. Set to console.log (or a buffer
 *  sink) to enable OCR diagnostics. Shared module-wide so module-level
 *  functions (detectGrid, detectFontFromRam) and ScreenText methods share it. */
let ocrLogFn: ((...args: any[]) => void) | null = null;
export function setOcrLogger(fn: ((...args: any[]) => void) | null): void {
  ocrLogFn = fn;
}
function log(...args: any[]): void { ocrLogFn?.('[OCR]', ...args); }

/**
 * Pick the cell grid that explains the screen with the fewest distinct tiles.
 *
 * For each candidate grid, slice the screen and count unique non-blank tiles.
 * The grid whose cells align with how the program rendered text reuses the
 * same glyph bitmap for every occurrence of each character → low unique
 * count. Misaligned grids slice characters into mishmash chunks that mostly
 * differ → high unique count. Ratios were considered first but biased toward
 * narrow grids (4-pixel halves of unrelated 8-pixel chars often coincide);
 * absolute counts dodge that bias.
 *
 * Tie-break (within ±1 unique tile) prefers the wider cellWidth — stricter
 * alignment is more informative. Returns '32x24' if all grids have <4
 * non-blank cells (effectively blank screen).
 */
export function detectGrid(screenBank: Uint8Array, bankLabel = ''): OcrGridName {
  const tag = bankLabel ? ` [${bankLabel}]` : '';

  const uniques: number[] = new Array(OCR_GRID_KEYS.length);
  const nonBlanks: number[] = new Array(OCR_GRID_KEYS.length);
  let maxNonBlank = 0;

  for (let gi = 0; gi < OCR_GRID_KEYS.length; gi++) {
    const config = OCR_GRIDS[OCR_GRID_KEYS[gi]];
    const cellH = config.cellHeight;
    const seen = new Set<number>();
    let nonBlank = 0;
    for (let r = 0; r < config.rows; r++) {
      for (let c = 0; c < config.cols; c++) {
        extractCellGlyph(screenBank, c, r, config, scratchGlyph);
        if (isBlankGlyph(scratchGlyph, cellH)) continue;
        nonBlank++;
        seen.add(hashGlyph(scratchGlyph, cellH));
      }
    }
    uniques[gi] = seen.size;
    nonBlanks[gi] = nonBlank;
    if (nonBlank > maxNonBlank) maxNonBlank = nonBlank;
  }

  if (maxNonBlank < 4) {
    if (forceGridLog) {
      log(`detect grid${tag} → 32x24 (screen blank — ${maxNonBlank} non-blank cells)`);
      forceGridLog = false;
      lastGridLogKey = '32x24:sparse';
    }
    return '32x24';
  }

  let bestIdx = 0;
  let bestUnique = Infinity;
  for (let gi = 0; gi < OCR_GRID_KEYS.length; gi++) {
    if (nonBlanks[gi] < 4) continue;
    const u = uniques[gi];
    const wider = OCR_GRIDS[OCR_GRID_KEYS[gi]].cellWidth
                > OCR_GRIDS[OCR_GRID_KEYS[bestIdx]].cellWidth;
    if (u < bestUnique - 1 || (Math.abs(u - bestUnique) <= 1 && wider)) {
      bestUnique = u;
      bestIdx = gi;
    }
  }
  const best = OCR_GRID_KEYS[bestIdx];

  const logKey = `${best}:${bestUnique}`;
  if (forceGridLog || logKey !== lastGridLogKey) {
    forceGridLog = false;
    lastGridLogKey = logKey;
    const breakdown = OCR_GRID_KEYS.map((g, gi) =>
      `${g}: ${uniques[gi]} unique / ${nonBlanks[gi]} nonblank`,
    ).join('  ·  ');
    log(`detect grid${tag} → ${best} (fewest unique tiles wins) — ${breakdown}`);
  }
  return best;
}

/**
 * Search every RAM bank and ROM page for a 768-byte font that explains the
 * on-screen glyphs.
 *
 * Strategy:
 *   1. Build a set of unique non-blank on-screen glyphs (capped at 128).
 *   2. For each candidate bitOffset (0..8-cellWidth — the font may store
 *      glyphs MSB-aligned or right-shifted in the byte; Tasword 64 uses 4),
 *      walk every byte-aligned 768-byte window across all banks. Prefilter:
 *      first 8 bytes zero (space at code 0x20) AND at least one capital-letter
 *      slot non-zero.
 *   3. Score each window by the fraction of unique on-screen glyphs that
 *      match any printable code (normal or inverted) at that bitOffset.
 *      Abort early at score ≥ 0.95.
 *   4. Return the best-scoring window if score ≥ 0.3, else null.
 *
 * Cost is dominated by the prefilter sweep; only a tiny fraction of windows
 * pass and need scoring.
 */
/** One pass of the bank scan at a fixed `bitOffset`. */
interface ScanResult {
  bestScore: number;
  bestBankIndex: number;
  bestOffset: number;
  windowsScanned: number;
  windowsScored: number;
  earlyExit: boolean;
}

function scanBanksAtOffset(
  banks: readonly Uint8Array[],
  uniqueGlyphs: Uint8Array[],
  cellH: number,
  mask: number,
  bitOffset: number,
): ScanResult {
  let bestScore = 0;
  let bestBankIndex = -1;
  let bestOffset = -1;
  let windowsScanned = 0;
  let windowsScored = 0;
  let earlyExit = false;

  const bangSlot = (0x21 - 0x20) * 8;     // '!' offset (8)
  const aSlot = (0x41 - 0x20) * 8;        // 'A' offset within a 768-byte font
  const zSlotEnd = (0x5A - 0x20) * 8 + 8; // end of 'Z'

  outerScan: for (let bi = 0; bi < banks.length; bi++) {
    const bank = banks[bi];
    const limit = bank.length - 768;
    for (let off = 0; off <= limit; off++) {
      windowsScanned++;
      // Prefilter: 8 zero bytes for the space glyph at code 0x20.
      if (bank[off] | bank[off + 1] | bank[off + 2] | bank[off + 3]
        | bank[off + 4] | bank[off + 5] | bank[off + 6] | bank[off + 7]) continue;
      // Prefilter: slot '!' (code 0x21, window bytes 8..15) must be non-empty.
      // Real fonts (ROM, CHARS, +3 editor) all populate '!' as a real glyph.
      // Without this check the scan happily picks any window aligned k×8 bytes
      // BEFORE the real font when there's zero padding ahead of it — that window
      // inherits the zero space-slot from padding, its capital-letter range
      // overlaps the real font's content, and it scores 100% against every
      // screen glyph with every glyph landing on the wrong character slot
      // (screen 'A' → window slot 'B', etc.). The early-exit at 0.95 then
      // returns that shifted twin and downstream OCR produces silently-wrong
      // text. Requiring slot '!' non-empty rejects every shifted-down twin
      // (it pushes the real font's space — or pre-font padding — into '!').
      if (!(bank[off + bangSlot] | bank[off + bangSlot + 1] | bank[off + bangSlot + 2]
          | bank[off + bangSlot + 3] | bank[off + bangSlot + 4] | bank[off + bangSlot + 5]
          | bank[off + bangSlot + 6] | bank[off + bangSlot + 7])) continue;
      // Prefilter: any non-zero byte in the capital-letter slots A..Z.
      let hasLetter = false;
      for (let i = aSlot; i < zSlotEnd; i++) {
        if (bank[off + i]) { hasLetter = true; break; }
      }
      if (!hasLetter) continue;

      windowsScored++;
      let matches = 0;
      for (const g of uniqueGlyphs) {
        let found = false;
        for (let c = 33; c < 128 && !found; c++) {
          if (c === 0x5F) continue;
          const fb = off + ((c - 32) << 3);
          // Try normal then inverted within the same character slot — early
          // out as soon as one orientation matches.
          let m = true;
          for (let p = 0; p < cellH; p++) {
            const shifted = (bank[fb + p] << bitOffset) & 0xFF;
            if ((shifted & mask) !== g[p]) { m = false; break; }
          }
          if (m) { found = true; break; }
          m = true;
          for (let p = 0; p < cellH; p++) {
            const shifted = (bank[fb + p] << bitOffset) & 0xFF;
            if (((shifted ^ mask) & mask) !== g[p]) { m = false; break; }
          }
          if (m) found = true;
        }
        if (found) matches++;
      }
      const score = matches / uniqueGlyphs.length;
      if (score > bestScore) {
        bestScore = score;
        bestBankIndex = bi;
        bestOffset = off;
        if (score >= 0.95) { earlyExit = true; break outerScan; }
      }
    }
  }
  return { bestScore, bestBankIndex, bestOffset, windowsScanned, windowsScored, earlyExit };
}

export function detectFontFromRam(
  banks: readonly Uint8Array[], screenBank: Uint8Array, config: OcrConfig,
): FontSource | null {
  const cellH = config.cellHeight;
  const cellW = config.cellWidth;
  const mask = bitMaskFor(cellW);

  // Build a histogram of unique non-blank on-screen glyphs.
  const glyphMap = new Map<string, Uint8Array>();
  let totalCells = 0;
  let blankCells = 0;
  outer: for (let r = 0; r < config.rows; r++) {
    for (let c = 0; c < config.cols; c++) {
      totalCells++;
      extractCellGlyph(screenBank, c, r, config, scratchGlyph);
      if (isBlankGlyph(scratchGlyph, cellH)) { blankCells++; continue; }
      const key = scratchGlyph.subarray(0, cellH).join(',');
      if (!glyphMap.has(key)) glyphMap.set(key, scratchGlyph.slice(0, cellH));
      if (glyphMap.size >= 128) break outer;
    }
  }
  log(
    `font scan ${cellW}×${cellH}: ${blankCells}/${totalCells} blank cells (space anchor), `
    + `${glyphMap.size} unique non-blank glyphs to anchor on`,
  );
  if (glyphMap.size < 4) {
    log(`font scan: aborting — need ≥4 unique glyphs, got ${glyphMap.size}`);
    return null;
  }
  const uniqueGlyphs = Array.from(glyphMap.values());

  // Try bit offsets 0..(8-cellWidth). The font may pack glyphs left-aligned
  // (offset 0) or right-aligned (e.g. Tasword 64's 4-pixel glyphs in bits
  // 3-0 → offset 4). 8-wide grids have only one alignment to try.
  const maxOffset = Math.max(0, 8 - cellW);
  let bestScore = 0;
  let bestBankIndex = -1;
  let bestOffset = -1;
  let bestBitOffset = 0;
  let totalScanned = 0;
  let totalScored = 0;

  for (let bitOffset = 0; bitOffset <= maxOffset; bitOffset++) {
    const r = scanBanksAtOffset(banks, uniqueGlyphs, cellH, mask, bitOffset);
    totalScanned += r.windowsScanned;
    totalScored += r.windowsScored;
    const lbl = r.bestBankIndex < 0 ? '(none)'
      : `bank ${r.bestBankIndex} @${r.bestOffset.toString(16).padStart(4, '0')}`;
    log(
      `font scan: bitOffset=${bitOffset} ⇒ best ${lbl} `
      + `${(r.bestScore * 100).toFixed(0)}% (${r.windowsScored} windows scored)`,
    );
    if (r.bestScore > bestScore) {
      bestScore = r.bestScore;
      bestBankIndex = r.bestBankIndex;
      bestOffset = r.bestOffset;
      bestBitOffset = bitOffset;
    }
    if (r.earlyExit) break;
  }

  const bestLabel = bestBankIndex < 0 ? '(none)'
    : `bank ${bestBankIndex} @${bestOffset.toString(16).padStart(4, '0')}`;
  log(
    `font scan summary: ${totalScanned} windows total, ${totalScored} passed prefilter, `
    + `best ${bestLabel} bitOffset=${bestBitOffset} ${(bestScore * 100).toFixed(0)}%`,
  );

  if (bestScore >= 0.3 && bestBankIndex >= 0) {
    const data = banks[bestBankIndex].slice(bestOffset, bestOffset + 768);
    return {
      label: `${bestLabel} bitOffset=${bestBitOffset} (${(bestScore * 100).toFixed(0)}%)`,
      data,
      cellWidth: cellW,
      bitOffset: bestBitOffset,
    };
  }
  log(`font scan: rejected — best score ${(bestScore * 100).toFixed(0)}% < 30% threshold`);
  return null;
}

/**
 * The OCR engine. Holds an `active` flag used by the UI overlay to decide
 * whether to render transcribed text on top of the canvas; the OCR engine
 * itself always runs when called (so MCP / debug callers don't need to flip
 * the UI on first).
 */
export class ScreenText {
  active = false;
  private lastLogKey = '';

  /** Cached scanned font per grid cellWidth. A `null` entry is a NEGATIVE
   *  cache: "we already scanned and found nothing", so don't re-scan. Cleared
   *  on activate() / grid change / explicit invalidate. */
  private cachedRamFont: Map<number, FontSource | null> = new Map();

  /** Cached grid choice. Re-validated cheaply each call against the current
   *  screen; full 3-grid detection only runs when validation fails. */
  private cachedGrid: OcrGridName | null = null;

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.lastLogKey = '';
    this.cachedRamFont.clear();
    this.cachedGrid = null;
    resetGridLog();
    log('activated');
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.lastLogKey = '';
    this.cachedRamFont.clear();
    this.cachedGrid = null;
    log('deactivated');
  }

  /** Drop the cached scanned font for the given grid (or all grids). */
  invalidateFontCache(cellWidth?: number): void {
    if (cellWidth === undefined) this.cachedRamFont.clear();
    else this.cachedRamFont.delete(cellWidth);
  }

  /**
   * Pick the cell grid for `screenBank`. `detectGrid` is cheap enough (~3500
   * cell extracts) to run per call; we cache the choice mainly so we know
   * when the grid changes and can drop the per-grid font cache.
   */
  detectAndCacheGrid(screenBank: Uint8Array, bankLabel = ''): OcrGridName {
    const grid = detectGrid(screenBank, bankLabel);
    if (grid !== this.cachedGrid) {
      this.cachedRamFont.clear();
      this.cachedGrid = grid;
    }
    return grid;
  }

  /**
   * Build the prioritised font list for a given grid configuration.
   *
   * Strategy:
   *  1. CHARS sysvar (8-wide only — pointer at 0x5C36 in BASIC sysvars)
   *  2. 48K ROM font (8-wide only — always available)
   *  3. Heuristic scan across ALL banks (RAM + ROM pages), cached per grid.
   *     Negative result is also cached so repeated calls don't re-scan.
   */
  private buildFonts(
    screenBank: Uint8Array,
    cpuMem: Uint8Array | null,
    memBanks: readonly Uint8Array[] | null,
    romFont: Uint8Array,
    config: OcrConfig,
    extraFonts?: FontSource[],
  ): FontSource[] {
    const fonts: FontSource[] = [];

    if (config.cellWidth === 8) {
      // 1. CHARS sysvar
      if (cpuMem) {
        const charsAddr = cpuMem[0x5C36] | (cpuMem[0x5C37] << 8);
        const charsFontStart = charsAddr + 256;
        if (charsFontStart + 768 <= 65536) {
          const charsData = cpuMem.slice(charsFontStart, charsFontStart + 768);
          let spaceBlank = true;
          for (let i = 0; i < 8; i++) if (charsData[i]) { spaceBlank = false; break; }
          if (spaceBlank && validateFontAgainstScreen(screenBank, charsData, config, 10)) {
            fonts.push({ label: `CHARS @${charsFontStart.toString(16)}`, data: charsData });
          }
        }
      }
      // 2. 48K ROM font (only if it actually has matches on screen)
      if (validateFontAgainstScreen(screenBank, romFont, config, 10)) {
        if (fonts.length === 0 || !fontsEqual(fonts[0].data, romFont)) {
          fonts.push({ label: 'ROM font', data: romFont });
        }
      }
    }

    // 3. Heuristic memory scan as fallback (or primary for non-8 grids).
    //    Cached per cellWidth — both positive (FontSource) and negative
    //    (null = "already scanned, found nothing") so we don't churn.
    if (memBanks && fonts.length === 0) {
      const cellW = config.cellWidth;
      let entry = this.cachedRamFont.get(cellW);

      // Drop a stale positive cache if it no longer matches the screen.
      if (entry && !validateFontAgainstScreen(
        screenBank, entry.data, config, 4, entry.bitOffset ?? 0,
      )) {
        log(`cached font for ${cellW}×${config.cellHeight} no longer matches — re-scanning`);
        this.cachedRamFont.delete(cellW);
        entry = undefined;
      }

      // No cache entry at all → run a scan; cache the result (positive or null).
      if (!this.cachedRamFont.has(cellW)) {
        entry = detectFontFromRam(memBanks, screenBank, config);
        this.cachedRamFont.set(cellW, entry);
        if (entry) log(`using font: ${entry.label}`);
      }

      if (entry) fonts.push(entry);
    }

    if (extraFonts) for (const ef of extraFonts) fonts.push(ef);
    return fonts;
  }

  /**
   * Match a single screen cell against the font list.
   * Returns the matched character, or null if blank / unrecognised.
   * (Blank cells return ' ' so they're treated as matched space.)
   */
  private matchCellFromFonts(
    glyph: Uint8Array, fonts: FontSource[], cellH: number, mask: number, hits: Uint32Array,
  ): string | null {
    if (isBlankGlyph(glyph, cellH)) return ' ';
    for (let fi = 0; fi < fonts.length; fi++) {
      const ch = matchGlyph(glyph, fonts[fi].data, cellH, mask, fonts[fi].bitOffset ?? 0);
      if (ch) { hits[fi]++; return ch; }
    }
    return null;
  }

  /** Log font hit summary (only when it changes). */
  private logHits(fonts: FontSource[], hits: Uint32Array): void {
    const parts: string[] = [];
    for (let fi = 0; fi < fonts.length; fi++) {
      if (hits[fi] > 0) parts.push(`${fonts[fi].label}: ${hits[fi]}`);
    }
    const logKey = parts.join(', ');
    if (logKey !== this.lastLogKey) {
      this.lastLogKey = logKey;
      if (logKey) log(logKey);
    }
  }

  /**
   * OCR a screen — plain text only. Always runs (independent of the UI
   * `active` flag).
   *
   * @param screenBank 16KB displayed bank (bitmap @0x0000, attrs @0x1800)
   * @param cpuMem     Paged 64K view — only used for CHARS-sysvar font detection
   * @param memBanks   All RAM banks + ROM pages — used by the heuristic font scan
   * @param romFont    768-byte font from the 48K BASIC ROM
   * @param config     Cell-grid configuration
   * @param extraFonts Additional fonts from the fonts pane
   */
  ocr(
    screenBank: Uint8Array,
    cpuMem: Uint8Array | null,
    memBanks: readonly Uint8Array[] | null,
    romFont: Uint8Array,
    config: OcrConfig,
    extraFonts?: FontSource[],
  ): string {
    const fonts = this.buildFonts(screenBank, cpuMem, memBanks, romFont, config, extraFonts);
    if (fonts.length === 0) return '';
    const hits = new Uint32Array(fonts.length);
    const cellH = config.cellHeight;
    const mask = bitMaskFor(config.cellWidth);
    let text = '';

    for (let row = 0; row < config.rows; row++) {
      for (let col = 0; col < config.cols; col++) {
        extractCellGlyph(screenBank, col, row, config, scratchGlyph);
        text += this.matchCellFromFonts(scratchGlyph, fonts, cellH, mask, hits) ?? ' ';
      }
      if (row < config.rows - 1) text += '\n';
    }

    this.logHits(fonts, hits);
    return text;
  }

  /**
   * OCR a screen — returns plain text + coloured HTML + per-cell match mask.
   *
   * Per-cell ink colour is sampled from the Spectrum attribute file at offset
   * 0x1800 within the screen bank, indexed by the byte-column the cell starts
   * in (`floor(col*cellWidth / 8)`). Attributes are byte-aligned regardless of
   * the OCR grid, so for non-8-wide grids several cells share an attribute.
   */
  ocrStyled(
    screenBank: Uint8Array,
    cpuMem: Uint8Array | null,
    memBanks: readonly Uint8Array[] | null,
    romFont: Uint8Array,
    palette: Uint32Array,
    flash: boolean,
    grid: OcrGridName = '32x24',
    extraFonts?: FontSource[],
  ): OcrResult {
    const config = OCR_GRIDS[grid];
    const cellW = config.cellWidth;
    const cellH = config.cellHeight;
    const fonts = this.buildFonts(screenBank, cpuMem, memBanks, romFont, config, extraFonts);
    if (fonts.length === 0) {
      return {
        text: '', html: '', mask: [],
        grid, cellWidth: cellW, cellHeight: cellH,
        cols: config.cols, rows: config.rows,
      };
    }

    const hits = new Uint32Array(fonts.length);
    const css: string[] = new Array(16);
    for (let i = 0; i < 16; i++) css[i] = abgrToHex(palette[i]);

    const mask = bitMaskFor(cellW);
    const xOffset = config.xOffset ?? 0;
    const yOffset = config.yOffset ?? 0;
    const cellMask: boolean[] = new Array(config.cols * config.rows);
    let text = '';
    let html = '';
    let spanOpen = false;
    let curInk = -1;

    for (let row = 0; row < config.rows; row++) {
      // Attributes are byte-aligned (8x8); for non-8 grids several cells share one.
      const attrRow = Math.min(23, Math.max(0, (row * cellH + yOffset) >> 3));
      const attrBase = 0x1800 + attrRow * 32;

      for (let col = 0; col < config.cols; col++) {
        const idx = row * config.cols + col;
        extractCellGlyph(screenBank, col, row, config, scratchGlyph);
        const ch = this.matchCellFromFonts(scratchGlyph, fonts, cellH, mask, hits);
        text += ch ?? ' ';
        cellMask[idx] = ch !== null;

        if (ch === null) {
          if (spanOpen) { html += '</span>'; spanOpen = false; curInk = -1; }
          html += ' ';
        } else {
          const attrByteCol = Math.min(31, (col * cellW + xOffset) >> 3);
          const attr = screenBank[attrBase + attrByteCol];
          const bright = (attr & 0x40) ? 8 : 0;
          let ink = (attr & 0x07) + bright;
          let paper = ((attr >> 3) & 0x07) + bright;
          if ((attr & 0x80) && flash) { const t = ink; ink = paper; paper = t; }

          if (ink !== curInk) {
            if (spanOpen) html += '</span>';
            html += `<span style="color:${css[ink]}">`;
            curInk = ink;
            spanOpen = true;
          }
          html += escapeHtml(ch);
        }
      }
      if (spanOpen) { html += '</span>'; spanOpen = false; curInk = -1; }
      if (row < config.rows - 1) { text += '\n'; html += '\n'; }
    }

    this.logHits(fonts, hits);
    return {
      text, html, mask: cellMask,
      grid, cellWidth: cellW, cellHeight: cellH,
      cols: config.cols, rows: config.rows,
    };
  }
}
