/**
 * Videx Videoterm 80-column card.
 *
 * A text-only video board for the ][ and ][+: a 6845 CRTC scanning 2K of its own
 * RAM through its own 2K character ROM, giving 80 columns by 24 rows at nine
 * scan lines per character on a separate video output. The card is operated
 * entirely through three windows:
 *
 *  - `$C0B0-$C0BF` (slot 3's device I/O): even addresses write the CRTC's
 *    address register, odd ones its data register, and bits 2-3 of the address
 *    pick which 512-byte quarter of the card RAM the window below shows;
 *  - `$CC00-$CDFF`: that 512-byte RAM window;
 *  - `$C800-$CBFF`: the card's 1K firmware ROM (selected, like any expansion ROM,
 *    by touching the card's `$C3xx` page, which is the last 256 bytes of that ROM).
 *
 * The firmware (`PR#3`) programs the CRTC for 80 columns; until it has, the
 * Apple's own video is what the monitor shows, which is how the card is treated
 * here.
 */

import type { Apple2Card } from '../cards.ts';

export const VIDEX_SLOT = 3;
export const VIDEX_COLS = 80;
export const VIDEX_ROWS = 24;
/** Scan lines per character row. */
export const VIDEX_CELL_HEIGHT = 9;
/** The card RAM holds 2K of characters; the CRTC's start address wraps within it. */
const RAM_SIZE = 0x800;
const WINDOW = 0x200;

/** What the renderer needs to draw the card's output. */
export interface VidexView {
  active: boolean;
  ram: Uint8Array;
  font: Uint8Array;
  /** First character displayed (CRTC R12/R13). */
  start: number;
  /** Cursor position (R14/R15) and its scan-line range and blink mode (R10/R11). */
  cursor: number;
  cursorStart: number;
  cursorEnd: number;
  /** 0 steady, 1 hidden, 2 and 3 blinking. */
  cursorMode: number;
}

export class Videx implements Apple2Card {
  readonly slot = VIDEX_SLOT;
  readonly hasExpansion = true;

  /** 1K firmware ROM ($C800-$CBFF; its last page also serves $C3xx). */
  readonly rom = new Uint8Array(0x400).fill(0xFF);
  /** 2K character ROM: 128 glyphs of 16 rows, leftmost dot in bit 7. */
  readonly font = new Uint8Array(0x800);
  readonly ram = new Uint8Array(RAM_SIZE);

  private readonly regs = new Uint8Array(32);
  private addressReg = 0;
  private bank = 0;

  readonly view: VidexView = {
    active: false, ram: this.ram, font: this.font,
    start: 0, cursor: 0, cursorStart: 0, cursorEnd: 0, cursorMode: 0,
  };

  loadRom(data: Uint8Array): void { this.rom.fill(0xFF); this.rom.set(data.subarray(0, 0x400)); }
  loadFont(data: Uint8Array): void { this.font.fill(0); this.font.set(data.subarray(0, 0x800)); }

  // ── Device I/O ($C0B0-$C0BF) ─────────────────────────────────────────────

  private select(reg: number): void { this.bank = (reg >> 2) & 3; }

  ioRead(reg: number): number {
    this.select(reg);
    if ((reg & 1) === 0) return 0xFF;
    // Only the cursor and light-pen registers of a 6845 can be read back.
    const a = this.addressReg & 0x1F;
    return a >= 14 && a <= 17 ? this.regs[a] : 0;
  }

  ioWrite(reg: number, val: number): void {
    this.select(reg);
    if ((reg & 1) === 0) { this.addressReg = val & 0x1F; return; }
    this.regs[this.addressReg & 0x1F] = val;
    this.refresh();
  }

  private refresh(): void {
    const v = this.view;
    const r = this.regs;
    v.active = r[1] === VIDEX_COLS;
    v.start = (((r[12] & 0x3F) << 8) | r[13]) & (RAM_SIZE - 1);
    v.cursor = (((r[14] & 0x3F) << 8) | r[15]) & (RAM_SIZE - 1);
    v.cursorStart = r[10] & 0x1F;
    v.cursorEnd = r[11] & 0x1F;
    v.cursorMode = (r[10] >> 5) & 3;
  }

  // ── $Cn00 page and the expansion area ───────────────────────────────────

  /** The card's `$CNxx` page is the last 256 bytes of its ROM (which also appear at `$CB00`). */
  pageRead(offset: number): number { return this.rom[0x300 + (offset & 0xFF)]; }

  expansionRead(offset: number): number {
    if (offset < 0x400) return this.rom[offset];
    if (offset < 0x400 + WINDOW) return this.ram[this.bank * WINDOW + (offset - 0x400)];
    return -1;
  }

  expansionWrite(offset: number, val: number): void {
    if (offset >= 0x400 && offset < 0x400 + WINDOW) this.ram[this.bank * WINDOW + (offset - 0x400)] = val;
  }

  reset(): void {
    this.regs.fill(0);
    this.addressReg = 0;
    this.bank = 0;
    this.refresh();
  }
}
