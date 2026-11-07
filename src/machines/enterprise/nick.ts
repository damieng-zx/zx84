/**
 * Nick — the Enterprise's video chip.
 *
 * Nick has no fixed screen. It walks a *line parameter table* (LPT) in video
 * RAM: a list of 16-byte line parameter blocks (LPBs), each of which sets the
 * mode, margins, data pointers and an eight-colour palette for a run of
 * lines. A frame is just however many LPBs EXOS (or a game) chains together,
 * including the one that is in VSYNC mode.
 *
 * LPB layout:
 *   +0      256 - number of lines in this block
 *   +1      b7 VINT (interrupt output), b6-5 colour mode (2/4/16/256),
 *           b4 VRES, b3-1 video mode, b0 RELOAD (restart the table after this)
 *   +2      b5-0 left margin (slot), b6 LSBALT, b7 MSBALT
 *   +3      b5-0 right margin (slot), b6 ALTIND1, b7 ALTIND0
 *   +4/5    LD1 — pixel/attribute/character data
 *   +6/7    LD2 — character font base or attribute-mode bitmap
 *   +8..15  palette entries 0-7 (entries 8-15 come from FIXBIAS, port 0x80)
 *
 * A line is 57 slots of 16 Nick clocks. Slots 0-7 fetch the LPB (once per
 * block) and slots 7-54 are the display area, at 16 pixels a slot in the
 * finest resolution — `renderLine` writes those 768 pixels. Slot ordering and
 * the pointer-reload rules follow ep128emu's `nick.cpp`.
 */

import { EP_FRAME_WIDTH, NICK_FIRST_VISIBLE_SLOT } from './constants.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/** Video modes (LPB +1 bits 3-1). */
const MODE_VSYNC = 0;
const MODE_PIXEL = 1;
const MODE_ATTR = 2;
const MODE_CH256 = 3;
const MODE_CH128 = 4;
const MODE_CH64 = 5;
const MODE_LPIXEL = 7;

/**
 * Nick's eight-bit colour, as ABGR. Each byte is G0 R0 B0 G1 R1 B1 G2 R2
 * (bit 7 down to bit 0): red and green get three bits, blue two, each with
 * its most significant bit lowest in the byte.
 */
export const NICK_COLOURS = (() => {
  const out = new Uint32Array(256);
  for (let v = 0; v < 256; v++) {
    const r = ((v << 2) & 4) | ((v >> 2) & 2) | ((v >> 6) & 1);
    const g = ((v << 1) & 4) | ((v >> 3) & 2) | ((v >> 7) & 1);
    const b = ((v >> 1) & 2) | ((v >> 5) & 1);
    out[v] = (0xFF000000
      | (Math.round(b * 255 / 3) << 16)
      | (Math.round(g * 255 / 7) << 8)
      | Math.round(r * 255 / 7)) >>> 0;
  }
  return out;
})();

/** Four-colour pixels: pixel n of a byte is (bit 7-n) | (bit 3-n) << 1. */
const FOUR = (() => {
  const t = new Uint8Array(256 * 4);
  for (let b = 0; b < 256; b++) {
    for (let p = 0; p < 4; p++) {
      t[b * 4 + p] = ((b >> (7 - p)) & 1) | (((b >> (3 - p)) & 1) << 1);
    }
  }
  return t;
})();

/** Sixteen-colour pixels: pixel 0 is bits 7,3,5,1 (as 1,2,4,8), pixel 1 is
 *  bits 6,2,4,0. */
const SIXTEEN = (() => {
  const t = new Uint8Array(256 * 2);
  for (let b = 0; b < 256; b++) {
    t[b * 2] = ((b >> 7) & 1) | (((b >> 3) & 1) << 1) | (((b >> 5) & 1) << 2) | (((b >> 1) & 1) << 3);
    t[b * 2 + 1] = ((b >> 6) & 1) | (((b >> 2) & 1) << 1) | (((b >> 4) & 1) << 2) | ((b & 1) << 3);
  }
  return t;
})();

export class Nick {
  // ── Registers ────────────────────────────────────────────────────────────
  /** Port 0x80: FIXBIAS, the top five bits of palette entries 8-15. */
  fixBias = 0;
  /** Port 0x81: border colour. */
  border = 0;
  /** Ports 0x82/0x83: LPT base address (always 16-byte aligned). */
  lptBase = 0;
  /** Port 0x83 as last written: bit 6 runs the LPT, bit 7 low forces a
   *  restart at the base. */
  port3 = 0xF0;
  /** Bit 7: restart requested by a 0->1 on port 3 bit 6; bit 6: held at the
   *  base while bit 7 is low. ep128emu's `lptFlags`. */
  private lptFlags = 0;

  // ── Current LPB ──────────────────────────────────────────────────────────
  lptAddr = 0;
  /** Lines of this block still to run; at zero the next LPB is fetched. */
  private linesRemaining = 0;
  private nLines = 1;
  /** VINT: the interrupt output, straight from the LPB. */
  interruptFlag = false;
  private vres = false;
  private reload = true;
  private colourMode = 0;
  videoMode = MODE_LPIXEL;
  private leftMargin = 8;
  private rightMargin = 54;
  private lsbAlt = false;
  private msbAlt = false;
  private altInd0 = false;
  private altInd1 = false;
  ld1 = 0;
  ld2 = 0;
  /** Palette entries as Nick colour bytes; 8-15 from FIXBIAS. */
  private readonly palette = new Uint8Array(16);
  /** The last byte Nick put on its bus — what a read of 0x80-0x8F returns. */
  dataBus = 0xFF;

  /** Raised when VINT changes; the machine hands it to Dave's INT1 input. */
  onInterrupt: ((active: boolean) => void) | null = null;

  constructor(private readonly vram: Uint8Array) {
    this.reset();
  }

  reset(): void {
    this.fixBias = 0;
    this.border = 0;
    this.lptBase = 0;
    this.port3 = 0xF0;
    this.lptFlags = 0;
    this.lptAddr = 0;
    this.linesRemaining = 0;
    this.nLines = 1;
    this.interruptFlag = false;
    this.vres = false;
    this.reload = true;
    this.colourMode = 0;
    this.videoMode = MODE_LPIXEL;
    this.leftMargin = 8;
    this.rightMargin = 54;
    this.lsbAlt = this.msbAlt = this.altInd0 = this.altInd1 = false;
    this.ld1 = this.ld2 = 0;
    this.palette.fill(0);
    this.dataBus = 0xFF;
  }

  // ── Ports ────────────────────────────────────────────────────────────────

  writePort(port: number, value: number): void {
    this.dataBus = value;
    switch (port & 3) {
      case 0: {
        this.fixBias = value;
        const bias = (value & 0x1F) << 3;
        for (let i = 0; i < 8; i++) this.palette[8 + i] = bias | i;
        break;
      }
      case 1:
        this.border = value;
        break;
      case 2:
        this.lptBase = (this.lptBase & 0xF000) | (value << 4);
        break;
      case 3: {
        this.lptBase = (this.lptBase & 0x0FF0) | ((value & 0x0F) << 12);
        const changed = (value ^ this.port3) & 0xC0;
        this.port3 = value;
        if (changed !== 0) {
          if (!(value & 0x40)) this.lptFlags = 0;
          else {
            if (changed & 0x40) this.lptFlags |= 0x80;
            if (!(value & 0x80)) this.lptFlags |= 0x40;
          }
        }
        break;
      }
    }
  }

  readPort(): number { return this.dataBus; }

  // ── Snapshot state ───────────────────────────────────────────────────────

  /** Every register and latch, and where Nick is in its line parameter
   *  table. Video RAM is the memory's. */
  saveState(w: StateWriter): void {
    w.u8(this.fixBias); w.u8(this.border); w.u16(this.lptBase); w.u8(this.port3); w.u8(this.lptFlags);
    w.u16(this.lptAddr); w.i32(this.linesRemaining); w.u16(this.nLines);
    w.bool(this.interruptFlag); w.bool(this.vres); w.bool(this.reload);
    w.u8(this.colourMode); w.u8(this.videoMode); w.u8(this.leftMargin); w.u8(this.rightMargin);
    w.bool(this.lsbAlt); w.bool(this.msbAlt); w.bool(this.altInd0); w.bool(this.altInd1);
    w.u16(this.ld1); w.u16(this.ld2);
    w.raw(this.palette);
    w.u8(this.dataBus);
  }

  /** Restore {@link saveState}. The VINT output is set without telling Dave:
   *  Dave's own latches are restored with it. */
  loadState(r: StateReader): void {
    this.fixBias = r.u8(); this.border = r.u8(); this.lptBase = r.u16(); this.port3 = r.u8(); this.lptFlags = r.u8();
    this.lptAddr = r.u16(); this.linesRemaining = r.i32(); this.nLines = r.u16();
    this.interruptFlag = r.bool(); this.vres = r.bool(); this.reload = r.bool();
    this.colourMode = r.u8() & 3; this.videoMode = r.u8() & 7; this.leftMargin = r.u8(); this.rightMargin = r.u8();
    this.lsbAlt = r.bool(); this.msbAlt = r.bool(); this.altInd0 = r.bool(); this.altInd1 = r.bool();
    this.ld1 = r.u16(); this.ld2 = r.u16();
    r.rawInto(this.palette);
    this.dataBus = r.u8();
  }

  // ── Line sequencing ──────────────────────────────────────────────────────

  /** True while the current block is a VSYNC block. */
  get inVsync(): boolean { return this.videoMode === MODE_VSYNC; }

  /**
   * Slots 0-7: fetch the LPB fields that are fetched on every line (mode and
   * margins), reload the data pointers when a new block starts, read the
   * palette. Called at the start of each line, before the CPU runs it.
   */
  beginLine(): void {
    const v = this.vram;
    const a = this.lptAddr;
    this.nLines = 256 - v[a];
    const mode = v[(a + 1) & 0xFFFF];
    const irq = (mode & 0x80) !== 0;
    this.colourMode = (mode >> 5) & 3;
    this.vres = (mode & 0x10) !== 0;
    this.videoMode = (mode >> 1) & 7;
    this.reload = (mode & 0x01) !== 0;
    const lm = v[(a + 2) & 0xFFFF];
    const rm = v[(a + 3) & 0xFFFF];
    this.leftMargin = lm & 0x3F;
    this.lsbAlt = (lm & 0x40) !== 0;
    this.msbAlt = (lm & 0x80) !== 0;
    this.rightMargin = rm & 0x3F;
    this.altInd1 = (rm & 0x40) !== 0;
    this.altInd0 = (rm & 0x80) !== 0;
    // Slot 2: LD1 reloads with each new block, and on every line unless VRES.
    if (this.linesRemaining <= 0 || !this.vres) {
      this.ld1 = v[(a + 4) & 0xFFFF] | (v[(a + 5) & 0xFFFF] << 8);
    }
    // Slot 3: the character modes step LD2 to the next font row each line.
    if (this.videoMode >= MODE_CH256 && this.videoMode <= MODE_CH64) {
      this.ld2 = (this.ld2 + 1) & 0xFFFF;
    }
    if (this.linesRemaining <= 0) {
      this.ld2 = v[(a + 6) & 0xFFFF] | (v[(a + 7) & 0xFFFF] << 8);
      this.linesRemaining = this.nLines;
    }
    for (let i = 0; i < 8; i++) this.palette[i] = v[(a + 8 + i) & 0xFFFF];
    this.dataBus = this.palette[7];

    if (irq !== this.interruptFlag) {
      this.interruptFlag = irq;
      this.onInterrupt?.(irq);
    }
  }

  /**
   * Slots 7-56: draw the display area into `row` (768 pixels, or null when
   * the line is off screen and only the pointers need to advance), then do
   * the end-of-line LPT bookkeeping.
   */
  endLine(row: Uint32Array | null, rowOffset: number): void {
    let on = false;
    // Margins are compared from slot 0; a left margin before the visible area
    // still switches the display on.
    for (let slot = 0; slot < NICK_FIRST_VISIBLE_SLOT; slot++) {
      if (slot === this.rightMargin) on = false;
      else if (slot === this.leftMargin) on = true;
      if (on) this.advanceBlank();
    }
    let x = rowOffset;
    for (let slot = NICK_FIRST_VISIBLE_SLOT; slot < NICK_FIRST_VISIBLE_SLOT + 48; slot++) {
      if (slot === this.rightMargin) on = false;
      else if (slot === this.leftMargin) on = true;
      if (!on) {
        if (row) row.fill(NICK_COLOURS[this.border], x, x + 16);
      } else if (this.videoMode === MODE_VSYNC) {
        if (row) row.fill(NICK_COLOURS[0], x, x + 16);
        this.advanceBlank();
      } else if (slot === NICK_FIRST_VISIBLE_SLOT || slot === 54) {
        // Slots 7 and 54 are still horizontal blanking: a margin set there
        // shows palette colour 0 (black in 256 colours) and fetches nothing,
        // though the pointers move as if it had.
        if (row) row.fill(this.colourMode === 3 ? NICK_COLOURS[0] : NICK_COLOURS[this.palette[0]], x, x + 16);
        this.advanceBlank();
      } else {
        this.renderSlot(row, x);
      }
      x += 16;
    }

    // Slot 56: count the line off and move on to the next block.
    this.linesRemaining--;
    if (this.linesRemaining === 0 || (this.lptFlags & 0x80) !== 0) {
      if (this.port3 & 0x40) {
        if (!this.reload && !(this.lptFlags & 0x40)) this.lptAddr = (this.lptAddr + 16) & 0xFFF0;
        else this.lptAddr = this.lptBase;
      }
    }
    this.lptFlags = (this.port3 & (~this.port3 >> 1)) & 0x40;
  }

  /** A display slot with no pixels to draw: the pointers still step. */
  private advanceBlank(): void {
    this.ld1 = (this.ld1 + (this.videoMode === MODE_PIXEL ? 2 : 1)) & 0xFFFF;
    if (this.videoMode === MODE_ATTR) this.ld2 = (this.ld2 + 1) & 0xFFFF;
  }

  /** Draw one display slot: 16 output pixels at `x` in `row`. */
  private renderSlot(row: Uint32Array | null, x: number): void {
    const v = this.vram;
    switch (this.videoMode) {
      case MODE_PIXEL: {
        const b1 = v[this.ld1];
        const b2 = v[(this.ld1 + 1) & 0xFFFF];
        this.ld1 = (this.ld1 + 2) & 0xFFFF;
        this.dataBus = b2;
        if (row) { this.pixelByte(row, x, b1, 8); this.pixelByte(row, x + 8, b2, 8); }
        break;
      }
      case MODE_LPIXEL: {
        const b = v[this.ld1];
        this.ld1 = (this.ld1 + 1) & 0xFFFF;
        this.dataBus = b;
        if (row) this.pixelByte(row, x, b, 16);
        break;
      }
      case MODE_ATTR: {
        const bits = v[this.ld2];
        const attr = v[this.ld1];
        this.ld1 = (this.ld1 + 1) & 0xFFFF;
        this.ld2 = (this.ld2 + 1) & 0xFFFF;
        this.dataBus = bits;
        if (row) {
          const paper = NICK_COLOURS[this.palette[attr >> 4]];
          const ink = NICK_COLOURS[this.palette[attr & 0x0F]];
          for (let i = 0; i < 8; i++) {
            const c = (bits << i) & 0x80 ? ink : paper;
            row[x + i * 2] = c;
            row[x + i * 2 + 1] = c;
          }
        }
        break;
      }
      case MODE_CH256:
      case MODE_CH128:
      case MODE_CH64: {
        const bits = this.videoMode === MODE_CH256 ? 8 : this.videoMode === MODE_CH128 ? 7 : 6;
        const ch = v[this.ld1];
        this.ld1 = (this.ld1 + 1) & 0xFFFF;
        const b = v[((this.ld2 << bits) & 0xFFFF) | (ch & ((1 << bits) - 1))];
        this.dataBus = b;
        if (row) this.characterByte(row, x, b, ch);
        break;
      }
      default:
        // Mode 6 is not a mode; treat it as blank display.
        this.advanceBlank();
        if (row) row.fill(NICK_COLOURS[0], x, x + 16);
    }
  }

  /**
   * One byte of PIXEL/LPIXEL data across `width` output pixels. In two
   * colours LSBALT and MSBALT turn bits 0 and 7 into palette selects (adding
   * 4 and 2) rather than pixels; in four colours only LSBALT applies.
   */
  private pixelByte(row: Uint32Array, x: number, b: number, width: number): void {
    const pal = this.palette;
    switch (this.colourMode) {
      case 0: {
        let offset = 0;
        if (this.lsbAlt && (b & 0x01)) { offset |= 4; b &= 0xFE; }
        if (this.msbAlt && (b & 0x80)) { offset |= 2; b &= 0x7F; }
        const c0 = NICK_COLOURS[pal[offset]];
        const c1 = NICK_COLOURS[pal[offset | 1]];
        const w = width >> 3;
        for (let i = 0; i < 8; i++) {
          const c = (b << i) & 0x80 ? c1 : c0;
          for (let k = 0; k < w; k++) row[x++] = c;
        }
        break;
      }
      case 1: {
        let offset = 0;
        if (this.lsbAlt && (b & 0x01)) { offset = 4; b &= 0xFE; }
        const w = width >> 2;
        for (let i = 0; i < 4; i++) {
          const c = NICK_COLOURS[pal[FOUR[b * 4 + i] | offset]];
          for (let k = 0; k < w; k++) row[x++] = c;
        }
        break;
      }
      case 2: {
        const w = width >> 1;
        for (let i = 0; i < 2; i++) {
          const c = NICK_COLOURS[pal[SIXTEEN[b * 2 + i]]];
          for (let k = 0; k < w; k++) row[x++] = c;
        }
        break;
      }
      default:
        row.fill(NICK_COLOURS[b], x, x + width);
    }
  }

  /**
   * One character-mode font byte across a slot (16 output pixels). The
   * character code's spare top bits pick an alternative palette: ALTIND1
   * adds 2 for bit 7, ALTIND0 adds 4 for bit 6 (four colours: ALTIND0 only).
   */
  private characterByte(row: Uint32Array, x: number, b: number, ch: number): void {
    const pal = this.palette;
    switch (this.colourMode) {
      case 0: {
        let offset = 0;
        if (this.altInd1 && (ch & 0x80)) offset |= 2;
        if (this.altInd0 && (ch & 0x40)) offset |= 4;
        const c0 = NICK_COLOURS[pal[offset]];
        const c1 = NICK_COLOURS[pal[offset | 1]];
        for (let i = 0; i < 8; i++) {
          const c = (b << i) & 0x80 ? c1 : c0;
          row[x++] = c;
          row[x++] = c;
        }
        break;
      }
      case 1: {
        const offset = this.altInd0 && (ch & 0x40) ? 4 : 0;
        for (let i = 0; i < 4; i++) {
          const c = NICK_COLOURS[pal[FOUR[b * 4 + i] | offset]];
          row[x++] = c; row[x++] = c; row[x++] = c; row[x++] = c;
        }
        break;
      }
      case 2:
        for (let i = 0; i < 2; i++) {
          row.fill(NICK_COLOURS[pal[SIXTEEN[b * 2 + i]]], x, x + 8);
          x += 8;
        }
        break;
      default:
        row.fill(NICK_COLOURS[b], x, x + 16);
    }
  }
}

/** Width of one rendered line, in pixels. */
export const NICK_LINE_WIDTH = EP_FRAME_WIDTH;

/**
 * The text on a character-mode screen, read from the line parameter table.
 *
 * EXOS gives each text row its own LPB in a CH-mode (one block of nine lines
 * per row), so a row's characters are the LD1 bytes between its margins —
 * the codes are ASCII. Blocks in other modes are skipped. Returns the rows
 * top to bottom, or an empty list when the table holds no text.
 */
export function nickScreenText(vram: Uint8Array, lptBase: number): string[] {
  const rows: string[] = [];
  let a = lptBase & 0xFFF0;
  for (let n = 0; n < 128; n++) {
    const mode = vram[(a + 1) & 0xFFFF];
    const videoMode = (mode >> 1) & 7;
    if (videoMode >= MODE_CH256 && videoMode <= MODE_CH64) {
      const lm = vram[(a + 2) & 0xFFFF] & 0x3F;
      const rm = vram[(a + 3) & 0xFFFF] & 0x3F;
      const ld1 = vram[(a + 4) & 0xFFFF] | (vram[(a + 5) & 0xFFFF] << 8);
      let s = '';
      for (let i = 0; i < rm - lm && i < 64; i++) {
        const c = vram[(ld1 + i) & 0xFFFF] & 0x7F;
        s += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : ' ';
      }
      rows.push(s.replace(/\s+$/, ''));
    }
    if (mode & 0x01) break;
    a = (a + 16) & 0xFFFF;
  }
  return rows;
}
