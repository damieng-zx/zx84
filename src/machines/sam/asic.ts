/**
 * The MGT ASIC — the SAM Coupé's custom silicon.
 *
 * Responsibilities:
 *   - The 16-entry CLUT and the border, both indexes into the 128-colour palette.
 *   - The four screen modes, decoded one scanline at a time.
 *   - The frame and line interrupts, and the active-low STATUS register.
 *
 * Structurally this is the SAM's answer to `cpc/gate-array.ts`: the machine
 * drives it per scanline and hands it a memory accessor; the ASIC owns no
 * paging state of its own beyond what it samples from VMPR.
 *
 * ── Per-line latching and mid-line writes ──
 *
 * State is latched once at the start of each scanline (`beginLine`), so a
 * mid-frame VMPR or mode change takes effect on the next line — the same model
 * the CPC uses. Palette and border writes need finer granularity than that,
 * because per-cell colour changes are the SAM's stock raster effect, so those
 * are recorded in a **per-line journal** with the character cell they landed on
 * and replayed by `renderScanline` as it walks the line. The journal is a
 * preallocated ring: recording a write allocates nothing, and an implausible
 * flood of writes on one line drops the excess rather than growing.
 *
 * The CPU loop is never broken mid-line to do this.
 */

import type { SamMemory } from './sam-memory.ts';
import {
  SAM_CELLS_PER_LINE, SAM_CELL_PX, SAM_DISPLAY_CELLS, SAM_DISPLAY_FIRST_CELL,
  SAM_DISPLAY_FIRST_LINE, SAM_DISPLAY_LAST_LINE, SAM_FRAME_INT_LINE,
  SAM_INT_ACTIVE_T, SAM_PAGE_SIZE, SAM_PALETTE, SAM_SCREEN_HEIGHT,
  SAM_SCREEN_WIDTH, SAM_T_PER_CELL,
  HMPR_MD3COL_MASK, HMPR_MD3COL_SHIFT,
  STATUS_IDLE, STATUS_INT_FRAME, STATUS_INT_LINE,
} from './constants.ts';

/** Journal slot count. A line is 48 cells, so even the most write-happy raster
 *  effect cannot legitimately need more than a handful per cell. */
const JOURNAL_CAP = 96;
/** Journal target meaning "the border" rather than a CLUT entry. */
const TARGET_BORDER = 16;

/** Frames per FLASH half-period in modes 1 and 2 (as the Spectrum). */
const FLASH_FRAMES = 16;

export class SamAsic {
  /** The 16 CLUT entries; each holds a 7-bit palette code. */
  readonly clut = new Uint8Array(16);
  /** Active 128-colour palette (packed ABGR), swapped by the display settings. */
  palette: Uint32Array = SAM_PALETTE;
  /** CLUT index driving the border, from port 0xFE. */
  borderIndex = 0;
  /** Screen-off latch (port 0xFE bit 7): blanks the display to the border. */
  screenOff = false;

  /** Active-low interrupt status (port 0xF9). A CLEAR bit means pending. */
  status = STATUS_IDLE;
  /** Line the line interrupt is programmed for, or -1 when never armed. */
  lineReg = -1;

  /** T-state at which each source's /INT assertion expires (-1 = inactive). */
  private frameIntUntil = -1;
  private lineIntUntil = -1;

  /** Frame counter driving the mode-1/2 FLASH attribute. */
  private frames = 0;

  // ── Per-line latched state ────────────────────────────────────────────────
  private lineMode: 1 | 2 | 3 | 4 = 1;
  private linePageA: Uint8Array;
  private linePageB: Uint8Array;
  private lineBorder = 0;
  private lineMd3Border = 0;
  private lineScreenOff = false;
  private lineStartT = 0;
  private lineFlash = false;
  /** CLUT index -> packed ABGR, rebuilt each line and patched by the journal. */
  private readonly clutLut = new Uint32Array(16);

  // ── Mid-line write journal ────────────────────────────────────────────────
  /** Triples of (cell, target, value); `target` is a CLUT index or TARGET_BORDER. */
  private readonly journal = new Int32Array(JOURNAL_CAP * 3);
  private journalCount = 0;
  /** Journal entries recorded this frame — drives the "rainbow" activity LED. */
  midLineWrites = 0;

  constructor(private readonly memory: SamMemory) {
    this.linePageA = memory.videoPage(0);
    this.linePageB = memory.videoPage(1);
  }

  reset(): void {
    this.clut.fill(0);
    this.borderIndex = 0;
    this.screenOff = false;
    this.status = STATUS_IDLE;
    this.lineReg = -1;
    this.frameIntUntil = -1;
    this.lineIntUntil = -1;
    this.frames = 0;
    this.journalCount = 0;
    this.midLineWrites = 0;
  }

  // ── Register writes (called from the port decode) ─────────────────────────

  /**
   * Write one CLUT entry. The index comes from the port's HIGH byte, so
   * `OUT (&03F8), A` writes entry 3 — the caller has already extracted it.
   * The register is updated immediately (so a CPU read-back is correct) and
   * journalled so the change lands at the right cell of the current line.
   */
  writeClut(index: number, value: number, tStates: number): void {
    const i = index & 0x0F;
    const v = value & 0x7F;
    this.clut[i] = v;
    this.note(i, v, tStates);
  }

  /** Latch the border colour index and the screen-off bit (port 0xFE). */
  writeBorder(index: number, screenOff: boolean, tStates: number): void {
    this.borderIndex = index & 0x0F;
    this.screenOff = screenOff;
    this.note(TARGET_BORDER, this.borderIndex, tStates);
  }

  /**
   * Program the line-interrupt line (a write to port 0xF9). Real hardware also
   * drops a line interrupt that is currently asserted, so the write doubles as
   * an acknowledge.
   */
  setLineInterrupt(line: number): void {
    this.lineReg = line & 0xFF;
    this.status |= STATUS_INT_LINE;
    this.lineIntUntil = -1;
  }

  /** Record a mid-line register change at the cell it lands on. */
  private note(target: number, value: number, tStates: number): void {
    this.midLineWrites++;
    if (this.journalCount >= JOURNAL_CAP) return;
    let cell = ((tStates - this.lineStartT) / SAM_T_PER_CELL) | 0;
    if (cell < 0) cell = 0;
    else if (cell >= SAM_CELLS_PER_LINE) cell = SAM_CELLS_PER_LINE - 1;
    const p = this.journalCount * 3;
    this.journal[p] = cell;
    this.journal[p + 1] = target;
    this.journal[p + 2] = value;
    this.journalCount++;
  }

  // ── Interrupts ────────────────────────────────────────────────────────────

  /** True while any source is asserting /INT (status bits are active low). */
  get intPending(): boolean { return (this.status & 0x1F) !== 0x1F; }

  /**
   * Drop any /INT assertion whose hold time has expired. The ASIC releases the
   * line on a timer rather than waiting for a CPU acknowledge, so an interrupt
   * masked behind a DI for the whole window is missed outright.
   */
  releaseExpired(tStates: number): void {
    if (this.frameIntUntil >= 0 && tStates >= this.frameIntUntil) {
      this.status |= STATUS_INT_FRAME;
      this.frameIntUntil = -1;
    }
    if (this.lineIntUntil >= 0 && tStates >= this.lineIntUntil) {
      this.status |= STATUS_INT_LINE;
      this.lineIntUntil = -1;
    }
  }

  /**
   * Raise this boundary's interrupt sources.
   *
   * `endLine(n)` runs once the CPU has reached the end of raster line n, which
   * is the same instant as the start of line n+1 — so a source that fires "at
   * the start of line L" is raised here when `line + 1 === L`.
   */
  endLine(line: number, tStates: number): void {
    const next = line + 1;
    if (next === SAM_FRAME_INT_LINE) {
      this.status &= ~STATUS_INT_FRAME;
      this.frameIntUntil = tStates + SAM_INT_ACTIVE_T;
    }
    if (this.lineReg >= 0 && next === this.lineInterruptRaster) {
      this.status &= ~STATUS_INT_LINE;
      this.lineIntUntil = tStates + SAM_INT_ACTIVE_T;
    }
  }

  /**
   * Raster line the programmed line interrupt fires on.
   *
   * The LINE register is treated as a *display* line (0..191 from the top of
   * the visible area). That is corroborated by the SAM's own ROM: its boot
   * screen chains line interrupts at LINE = 11, 22, 33 … 165, repainting CLUT
   * entry 0 in each handler, and the resulting colour bands land on exactly
   * those display lines.
   *
   * TODO(verify): what values >= 192 address is still unconfirmed. The ROM
   * writes 255 to mean "no more this field" and relies on the frame handler
   * re-arming before 48 + 255 = 303 is reached, so the distinction has not
   * mattered yet — but a program that deliberately interrupts in the bottom
   * border would tell us whether the register is display- or raster-based.
   */
  private get lineInterruptRaster(): number {
    return SAM_DISPLAY_FIRST_LINE + this.lineReg;
  }

  // ── Frame / line rendering ────────────────────────────────────────────────

  beginFrame(): void {
    this.frames++;
    this.midLineWrites = 0;
  }

  /**
   * Latch everything this scanline will be drawn with, and open a fresh
   * journal. Called before the CPU runs the line, so the journal's cell
   * positions are measured from here.
   */
  beginLine(_line: number, tStates: number): void {
    this.lineStartT = tStates;
    this.journalCount = 0;

    const mem = this.memory;
    this.lineMode = mem.videoMode;
    const base = mem.videoBasePage;
    this.linePageA = mem.videoPage(base);
    this.linePageB = mem.videoPage(base + 1);
    this.lineBorder = this.borderIndex;
    this.lineScreenOff = this.screenOff;
    this.lineMd3Border = (mem.hmpr & HMPR_MD3COL_MASK) >> HMPR_MD3COL_SHIFT;
    this.lineFlash = (this.frames & FLASH_FRAMES) !== 0;

    const pal = this.palette;
    const clut = this.clut;
    for (let i = 0; i < 16; i++) this.clutLut[i] = pal[clut[i] & 0x7F];
  }

  /** One byte of display memory, from the latched 24K page pair. */
  private fetch(offset: number): number {
    return offset < SAM_PAGE_SIZE
      ? this.linePageA[offset]
      : this.linePageB[offset - SAM_PAGE_SIZE];
  }

  /**
   * Draw one raster line into the frame buffer, replaying any mid-line palette
   * or border writes as the character cells go by.
   */
  renderScanline(px: Uint32Array, line: number): void {
    if (line < 0 || line >= SAM_SCREEN_HEIGHT) return;

    const rowStart = line * SAM_SCREEN_WIDTH;
    const active = !this.lineScreenOff
      && line >= SAM_DISPLAY_FIRST_LINE && line < SAM_DISPLAY_LAST_LINE;
    const y = line - SAM_DISPLAY_FIRST_LINE;
    const mode = this.lineMode;

    // In mode 3 the border colour comes from HMPR's MD3COL field rather than
    // the port 0xFE latch. TODO(verify) against the Technical Manual — the
    // three other modes certainly use the port.
    let borderIdx = mode === 3 ? this.lineMd3Border : this.lineBorder;
    let borderRgba = this.clutLut[borderIdx];

    let j = 0;
    let x = rowStart;

    for (let cell = 0; cell < SAM_CELLS_PER_LINE; cell++) {
      // Apply every journalled write that lands at or before this cell.
      while (j < this.journalCount && this.journal[j * 3] <= cell) {
        const target = this.journal[j * 3 + 1];
        const value = this.journal[j * 3 + 2];
        if (target === TARGET_BORDER) {
          borderIdx = mode === 3 ? this.lineMd3Border : value;
        } else {
          this.clutLut[target] = this.palette[value & 0x7F];
        }
        borderRgba = this.clutLut[borderIdx];
        j++;
      }

      const col = cell - SAM_DISPLAY_FIRST_CELL;
      if (!active || col < 0 || col >= SAM_DISPLAY_CELLS) {
        px.fill(borderRgba, x, x + SAM_CELL_PX);
        x += SAM_CELL_PX;
        continue;
      }

      switch (mode) {
        case 1: this.cellMode1(px, x, y, col); break;
        case 2: this.cellMode2(px, x, y, col); break;
        case 3: this.cellMode3(px, x, y, col); break;
        default: this.cellMode4(px, x, y, col); break;
      }
      x += SAM_CELL_PX;
    }
  }

  /** Plot 8 bitmap pixels through an ink/paper attribute, 2 buffer px each. */
  private plotAttrCell(px: Uint32Array, x: number, bits: number, attr: number): void {
    const lut = this.clutLut;
    // The attribute's BRIGHT bit supplies bit 3 of the CLUT index, so a mode
    // 1/2 screen reaches all 16 palette entries exactly as the Spectrum's
    // ink/paper/bright does — but through the SAM's CLUT, not a fixed palette.
    const bright = (attr & 0x40) >> 3;
    let ink = (attr & 0x07) | bright;
    let paper = ((attr >> 3) & 0x07) | bright;
    if (this.lineFlash && (attr & 0x80) !== 0) { const t = ink; ink = paper; paper = t; }
    const inkRgba = lut[ink];
    const paperRgba = lut[paper];

    for (let b = 0; b < 8; b++) {
      const c = (bits & (0x80 >> b)) !== 0 ? inkRgba : paperRgba;
      px[x] = c;
      px[x + 1] = c;
      x += 2;
    }
  }

  /** Mode 1 — 256x192, Spectrum bitmap interleave plus 768 attributes. */
  private cellMode1(px: Uint32Array, x: number, y: number, col: number): void {
    const bmp = ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | col;
    const attr = 6144 + ((y >> 3) << 5) + col;
    this.plotAttrCell(px, x, this.fetch(bmp), this.fetch(attr));
  }

  /** Mode 2 — 256x192, linear bitmap with one attribute per cell PER LINE
   *  (6144 attribute bytes at +0x2000, giving 192 attribute rows). */
  private cellMode2(px: Uint32Array, x: number, y: number, col: number): void {
    const bmp = (y << 5) + col;
    const attr = 0x2000 + (y << 5) + col;
    this.plotAttrCell(px, x, this.fetch(bmp), this.fetch(attr));
  }

  /** Mode 3 — 512x192, 2 bits per pixel, 128 bytes per line. Each byte is four
   *  pixels, most-significant pair leftmost. Only CLUT entries 0-3 are used. */
  private cellMode3(px: Uint32Array, x: number, y: number, col: number): void {
    const lut = this.clutLut;
    const off = (y << 7) + (col << 2);
    for (let i = 0; i < 4; i++) {
      const b = this.fetch(off + i);
      px[x] = lut[(b >> 6) & 3];
      px[x + 1] = lut[(b >> 4) & 3];
      px[x + 2] = lut[(b >> 2) & 3];
      px[x + 3] = lut[b & 3];
      x += 4;
    }
  }

  /** Mode 4 — 256x192, 4 bits per pixel, 128 bytes per line. Each byte is two
   *  pixels, high nibble leftmost; every CLUT entry is reachable. */
  private cellMode4(px: Uint32Array, x: number, y: number, col: number): void {
    const lut = this.clutLut;
    const off = (y << 7) + (col << 2);
    for (let i = 0; i < 4; i++) {
      const b = this.fetch(off + i);
      const hi = lut[b >> 4];
      const lo = lut[b & 0x0F];
      px[x] = hi;
      px[x + 1] = hi;
      px[x + 2] = lo;
      px[x + 3] = lo;
      x += 4;
    }
  }
}
