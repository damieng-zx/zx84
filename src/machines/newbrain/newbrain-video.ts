/**
 * The NewBrain's video circuit.
 *
 * Discrete logic reads the picture straight out of main RAM, one byte per
 * character cell, twice per cell (character, then the row of the glyph from a
 * 4K character ROM), and shifts it out as 8 dots — doubled to 16 in the
 * 40-column mode, so both modes are 640 dots wide. 250 lines are drawn.
 *
 * Two registers set it up, both written by the OS every frame:
 *
 *   TVL   (ports 8-11)  the start address, on a 64-byte boundary. A7-A14 come
 *                       from a write to port 9; a write to port 8 sets A6.
 *   TVCTL (ports 12-15) bit 0 reverse video, bit 1 full 256-character set
 *                       (else bit 7 of a character code is ignored), bit 2
 *                       32/40 (blank a border of columns/10 cells either side
 *                       of graphics), bit 3 upper character ROM — 8 scan lines
 *                       a row instead of 10 — and bit 6 80 columns.
 *
 * A row of text is `columns` bytes at a 64-byte (40 column) or 128-byte (80
 * column) pitch. What marks the end of the text and the start of a graphics
 * area is a run of zero bytes: the circuit keeps three flip-flops that shift
 * once for every byte read, taking "this byte is non-zero". Once the third
 * flip-flop falls the rest of the picture is graphics — the bytes are shown
 * raw, 8 dots each, least significant bit first — until the frame ends.
 */

import { NB_ACTIVE_LINES, NB_INK, NB_PAPER, NB_SCREEN_WIDTH } from './constants.ts';

/** TVCTL bits. */
export const TVCTL_RV = 0x01;
export const TVCTL_FS = 0x02;
export const TVCTL_3240 = 0x04;
export const TVCTL_UCR = 0x08;
export const TVCTL_80 = 0x40;

/**
 * Draw one frame into `out` (640×250, one Uint32 per dot).
 *
 * @param ram     main RAM (32K)
 * @param tvl     the start address as loaded by ports 8/9 (A6-A14)
 * @param tvctl   the TV control register
 * @param chars   the 4K character ROM
 */
export function renderNewBrainFrame(
  out: Uint32Array, ram: Uint8Array, tvl: number, tvctl: number, chars: Uint8Array,
): void {
  const columns = (tvctl & TVCTL_80) ? 80 : 40;
  const rv = (tvctl & TVCTL_RV) ? 1 : 0;
  const fs = (tvctl & TVCTL_FS) !== 0;
  const ucr = (tvctl & TVCTL_UCR) !== 0;
  const rowLines = ucr ? 8 : 10;
  const rowPitch = columns === 80 ? 128 : 64;
  const border = (tvctl & TVCTL_3240) ? columns / 10 : 0;
  const dotsPerCell = NB_SCREEN_WIDTH / columns;
  const wide = dotsPerCell === 16;

  // The address counter's low bits load with a marker, not zero: the first
  // character of a row is the third (40 column) or fifth (80 column) byte.
  let row = (tvl & 0x7FC0) | (columns === 80 ? 4 : 2);
  let addr = row;
  let rc = 0;
  let qa = true, qb = true, qc = true;

  for (let y = 0; y < NB_ACTIVE_LINES; y++) {
    if (!qc) qc = qb;
    const graphicsLine = !qa && !qc;
    if (!graphicsLine) addr = row;
    let o = y * NB_SCREEN_WIDTH;
    let shift = 0;
    for (let x = 0; x < columns; x++) {
      const inWindow = x >= border && x < columns - border;
      const counted = graphicsLine ? inWindow : (x < border || inWindow || qa || qc);
      let rd = 0;
      if (counted) { rd = ram[addr & 0x7FFF]; addr++; }
      if (qc) { qc = qb; qb = qa; qa = rd !== 0; }
      const gr = !qa && !qc;
      let bits = 0;
      let lit = false;
      let lsbFirst = false;
      if (gr) {
        if (inWindow) { bits = rd; lit = true; lsbFirst = true; }
      } else if (qc) {
        const textQ = (rd & 0x60) === 0;
        let rcm = rc & 7;
        if ((rc & 8) && textQ) rcm = 7;
        const rom = chars[(ucr ? 0x800 : 0) | (rcm << 8) | (fs ? (rd & 0x80) : 0) | (rd & 0x7F)];
        const bit0 = rom & 1;
        const load = ucr || textQ || (((rc >> 3) & 1) === bit0);
        shift = load ? ((rom & 0xFE) | ((ucr || textQ) ? bit0 : 0)) : 0;
        bits = shift;
        lit = true;
      }
      for (let d = 0; d < 8; d++) {
        const on = lit ? (lsbFirst ? (bits >> d) & 1 : (bits >> (7 - d)) & 1) : 0;
        const v = lit ? ((on ^ rv) ? NB_INK : NB_PAPER) : NB_PAPER;
        out[o++] = v;
        if (wide) out[o++] = v;
      }
    }
    if (!graphicsLine) {
      if (++rc === rowLines) { rc = 0; row = (row + rowPitch) & 0x7FFF; }
    }
  }
}

/** The text screen as a grid of cells, read straight out of RAM. */
export interface NewBrainScreenCells {
  cols: number;
  rows: number;
  /** Scan lines a character row takes: 10, or 8 with the upper character ROM. */
  cellHeight: number;
  /** One entry per cell, row-major: the character, or a space. */
  chars: string[];
  /** Cells that held a printable character, so the overlay may blank them;
   *  graphics, control codes and everything past the end of the text are
   *  left as picture. */
  mask: boolean[];
  reverse: boolean;
}

/**
 * Read the text on screen following the video circuit's own row rules: rows
 * start two (40 column) or four (80 column) bytes into their 64- or 128-byte
 * pitch, and the third zero byte in a run ends the text (everything after it
 * is graphics). Codes 32-126 are ASCII and 0xE4 is the pound sign; the rest
 * are control codes and mosaics and read as blanks.
 */
export function newBrainScreenCells(ram: Uint8Array, tvl: number, tvctl: number): NewBrainScreenCells {
  const cols = (tvctl & TVCTL_80) ? 80 : 40;
  const rowPitch = cols === 80 ? 128 : 64;
  const ucr = (tvctl & TVCTL_UCR) !== 0;
  const rows = ucr ? 31 : 25;
  const chars: string[] = new Array(cols * rows).fill(' ');
  const mask: boolean[] = new Array(cols * rows).fill(false);
  let row = (tvl & 0x7FC0) | (cols === 80 ? 4 : 2);
  let zeros = 0;
  outer:
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < cols; x++) {
      const c = ram[(row + x) & 0x7FFF];
      zeros = c === 0 ? zeros + 1 : 0;
      if (zeros >= 3) break outer;
      const i = r * cols + x;
      if (c >= 32 && c < 127) { chars[i] = String.fromCharCode(c); mask[i] = true; }
      else if (c === 0xE4) { chars[i] = '£'; mask[i] = true; }
    }
    row = (row + rowPitch) & 0x7FFF;
  }
  return { cols, rows, cellHeight: ucr ? 8 : 10, chars, mask, reverse: (tvctl & TVCTL_RV) !== 0 };
}

/** The text rows, trailing blanks trimmed and trailing empty rows dropped. */
export function newBrainScreenRows(ram: Uint8Array, tvl: number, tvctl: number): string[] {
  const cells = newBrainScreenCells(ram, tvl, tvctl);
  const out: string[] = [];
  for (let r = 0; r < cells.rows; r++) {
    out.push(cells.chars.slice(r * cells.cols, (r + 1) * cells.cols).join('').replace(/\s+$/, ''));
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}
