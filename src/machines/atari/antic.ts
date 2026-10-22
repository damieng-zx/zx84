/**
 * ANTIC — the Atari 8-bit display-list processor.
 *
 * ANTIC is the chip that replaced a video ULA: instead of a fixed character
 * matrix it walks a small program in RAM (the display list) and, for each
 * instruction, fetches a horizontal band of screen bytes and hands them to
 * GTIA. It also owns the player/missile DMA, the refresh DMA, and the display
 * list / vertical blank interrupts.
 *
 * Display-list instruction (one byte, plus two optional address bytes):
 *
 *   bits 0-3  mode: 0 = blank line(s), 1 = JVB (jump and wait for VBI),
 *                   2-F = a mode line
 *   bit 4    HSCROL applies to this line
 *   bit 5    VSCROL applies to this line (and the mode line becomes 16 rows)
 *   bit 6    LMS: the next two bytes are a new screen-memory address
 *   bit 7    DLI: raise a display-list interrupt at the start of this line
 *
 * For mode 0 the high nibble is a repeat count: `$00` is one blank line,
 * `$10` two, ... `$70` eight. That is why the OS's top border is three `$70`
 * instructions rather than twenty-four `$00`s.
 *
 * The display list starts at scanline 8 of the frame and the picture occupies
 * scanlines 8-247 (240 lines). JVB loads the display-list counter with its
 * operand and idles until the vertical blank; ANTIC resumes from that counter
 * at the next frame's line 8. DLISTL/DLISTH write the same counter, so a list
 * without a JVB simply carries on from where the vertical blank cut it off.
 *
 * Display-list addresses wrap inside the current 1K page, and the screen
 * memory counter wraps inside its 4K block, as the hardware does.
 *
 * The memory scan counter advances once per *mode line*, not per scanline:
 * every scanline of an eight-line GRAPHICS 0 row shows the same 40
 * characters, each from its own glyph row.
 *
 * Cycle stealing is modelled in aggregate rather than at the exact cycle:
 * each line reports the DMA cycles it uses (refresh, display list, screen
 * data, character glyphs, players/missiles) and the machine takes those away
 * from the CPU's 114 cycles for the line. That gets the effective CPU clock
 * right and keeps WSYNC raster code aligned to line starts, but a program
 * counting individual stolen cycles will notice.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

export interface AnticModeInfo {
  /** Screen bytes fetched per line at the normal (320-pixel) playfield. */
  readonly bytes: number;
  /** Scanlines the mode line displays. */
  readonly lines: number;
  /** Colour pixels produced per line at the normal playfield. */
  readonly pixels: number;
  /** Bits per playfield pixel (graphics modes) or per glyph pixel (text). */
  readonly bpp: 1 | 2;
  readonly text: boolean;
  /** Text mode whose colour pixels come from glyph bit pairs (ANTIC 4/5). */
  readonly multicolor: boolean;
}

/**
 * The canonical ANTIC mode table.
 *
 * `pixels` is the number of *colour* pixels the line produces at the normal
 * playfield; all modes are drawn across the same 320-pixel window, so the
 * renderer expands each colour pixel by 320/pixels screen pixels. Modes 4/5
 * are multicolour text: the glyph's bit pairs select the playfield colours,
 * so a character is four colour pixels wide. Modes 6/7 are 20-column text
 * whose character code's top two bits choose the colour. Modes 5 and 7 are
 * double-height (16-scanline) character rows.
 */
export const ANTIC_MODES: readonly (AnticModeInfo | null)[] = [
  null, null, // 0 = blank line, 1 = JVB
  { bytes: 40, lines: 8, pixels: 320, bpp: 1, text: true, multicolor: false },   // 2
  { bytes: 40, lines: 10, pixels: 320, bpp: 1, text: true, multicolor: false },  // 3
  { bytes: 40, lines: 8, pixels: 160, bpp: 2, text: true, multicolor: true },    // 4
  { bytes: 40, lines: 16, pixels: 160, bpp: 2, text: true, multicolor: true },   // 5
  { bytes: 20, lines: 8, pixels: 160, bpp: 1, text: true, multicolor: false },   // 6
  { bytes: 20, lines: 16, pixels: 160, bpp: 1, text: true, multicolor: false },  // 7
  { bytes: 10, lines: 8, pixels: 40, bpp: 2, text: false, multicolor: false },   // 8
  { bytes: 10, lines: 4, pixels: 80, bpp: 1, text: false, multicolor: false },   // 9
  { bytes: 20, lines: 4, pixels: 80, bpp: 2, text: false, multicolor: false },   // A
  { bytes: 20, lines: 2, pixels: 160, bpp: 1, text: false, multicolor: false },  // B
  { bytes: 20, lines: 1, pixels: 160, bpp: 1, text: false, multicolor: false },  // C
  { bytes: 40, lines: 2, pixels: 160, bpp: 2, text: false, multicolor: false },  // D
  { bytes: 40, lines: 1, pixels: 160, bpp: 2, text: false, multicolor: false },  // E
  { bytes: 40, lines: 1, pixels: 320, bpp: 1, text: false, multicolor: false },  // F
];

/** Scanline at which the display list starts (and the picture begins). */
export const ANTIC_FIRST_LINE = 8;
/** Last picture scanline (exclusive): 8 + 240. */
export const ANTIC_LAST_LINE = 248;
/** VBI is asserted at the start of this scanline, regardless of DMACTL or
 *  where the display list ended. Both regions display 240 lines, so the
 *  vertical blank starts at the same line on NTSC and PAL. */
export const ANTIC_VBI_LINE = 248;
/** The cycle of a line from which VCOUNT shows the next line's value. */
const VCOUNT_ADVANCE_CYCLE = 111;

/** Playfield widths in display pixels, by DMACTL bits 0-1. */
const PLAYFIELD_WIDTHS = [0, 256, 320, 384] as const;
/** DRAM refresh cycles ANTIC takes on every scanline. */
const REFRESH_CYCLES = 9;

/** One scanline's worth of ANTIC output, reused by the machine every line. */
export interface AnticLine {
  /** 0 = nothing displayed (blank line / DMA off). */
  mode: number;
  /** Address of the first screen byte for this line. */
  screenAddr: number;
  /** Screen bytes the mode line fetches at the current width (one size
   *  wider when horizontal scrolling is on). */
  bytes: number;
  /** Scanline inside the mode line (already adjusted by VSCROL), 0-15. */
  row: number;
  /** HSCROL applies to this line: ANTIC fetches the next wider playfield. */
  hscrollOn: boolean;
  /** Colour clocks to delay (shift right) the playfield. */
  hscrol: number;
  /** DLI is requested at the start of this line. */
  dli: boolean;
  /** Nothing to draw: blank line, vertical blank, or DMA off. */
  blank: boolean;
  /** This is the mode line's first scanline, which fetches its screen bytes;
   *  later ones replay ANTIC's line buffer. Absent means it does. */
  fetch?: boolean;
  /** Playfield width in pixels as ANTIC sampled it for this line (see
   *  `sampleFetch`). Absent means the register as it stands. */
  width?: number;
  /** Player/missile DMA state as ANTIC sampled it as the line began (cycle 0),
   *  so a DMACTL store later in the line does not change it. Absent means the
   *  register as it stands. */
  playerDma?: boolean;
  missileDma?: boolean;
  pmSingle?: boolean;
}

const REG_DMACTL = 0x00;
const REG_CHACTL = 0x01;
const REG_DLISTL = 0x02;
const REG_DLISTH = 0x03;
const REG_HSCROL = 0x04;
const REG_VSCROL = 0x05;
const REG_PMBASE = 0x07;
const REG_CHBASE = 0x09;
const REG_WSYNC = 0x0a;
const REG_VCOUNT = 0x0b;
const REG_PENH = 0x0c;
const REG_PENV = 0x0d;
const REG_NMIEN = 0x0e;
const REG_NMIST = 0x0f;

export class Antic {
  dmactl = 0;
  /** Character control: bit 0 blank-if-bit7, bit 1 invert-if-bit7, bit 2
   *  vertical reflect. */
  chactl = 0;
  hscrol = 0;
  vscrol = 0;
  pmbase = 0;
  chbase = 0;
  /** NMI enable: bit 7 = DLI, bit 6 = VBI. */
  nmien = 0;
  /** NMI status: bit 7 = DLI, bit 6 = VBI, bit 5 = reset. Cleared by NMIST. */
  nmist = 0;

  /** Screen/display-list memory reader, installed by the machine. */
  read: (addr: number) => number = () => 0xff;
  /** WSYNC write hook: halt the CPU until the end of the current line. */
  onWsyc: (() => void) | null = null;

  /** Current scanline within the frame, for VCOUNT and the renderer. */
  line = 0;

  /** The display-list counter. DLISTL/H write it and JVB reloads it. */
  private dlistPc = 0;
  private mode = 0;
  private bytesPerLine = 0;
  private rowInMode = 0;
  private linesLeft = 0;
  private screenAddr = 0;
  private vscrollOn = false;
  /** The previous mode line had VSCROL on (for the region's start/end). */
  private prevVscroll = false;
  /** Row-counter value of the current instruction's first scanline. */
  private startRow = 0;
  /** A JVB with its DLI bit set fires a DLI on every line it replays. */
  private jvbDli = false;
  private hscrollOn = false;
  private dliEnabled = false;
  private waiting = false;
  private vbiPending = false;
  /** DMA cycles this line used beyond refresh: display-list bytes, and the
   *  mode line's screen fetch (which only its first scanline makes). */
  private lineDlCycles = 0;
  private lineScreenCycles = 0;

  private readonly lineOut: AnticLine = {
    mode: 0, screenAddr: 0, bytes: 0, row: 0, hscrollOn: false, hscrol: 0, dli: false, blank: true,
  };

  /** Power-on state, or with `warm` the SYSTEM RESET one: only DMACTL and NMIEN
   *  are cleared, and the scroll, character and player registers, the
   *  display-list counter and NMIST keep what they held. */
  reset(warm = false): void {
    this.dmactl = 0;
    this.nmien = 0;
    if (!warm) {
      this.chactl = 0;
      this.hscrol = 0;
      this.vscrol = 0;
      this.pmbase = 0;
      this.chbase = 0;
      this.nmist = 0;
      this.dlistPc = 0;
    }
    this.line = 0;
    this.mode = 0;
    this.bytesPerLine = 0;
    this.rowInMode = 0;
    this.linesLeft = 0;
    this.screenAddr = 0;
    this.waiting = false;
    this.jvbDli = false;
    this.prevVscroll = false;
    this.startRow = 0;
    this.vbiPending = false;
    this.lineDlCycles = 0;
    this.lineScreenCycles = 0;
    this.blankOut();
  }

  /** Snapshot: the registers and the display-list walker's position. */
  saveState(w: StateWriter): void {
    w.u8(this.dmactl); w.u8(this.chactl); w.u8(this.hscrol); w.u8(this.vscrol);
    w.u8(this.pmbase); w.u8(this.chbase); w.u8(this.nmien); w.u8(this.nmist);
    w.u16(this.line);
    w.u16(this.dlistPc);
    w.u8(this.mode);
    w.u16(this.bytesPerLine);
    w.u8(this.rowInMode);
    w.u8(this.linesLeft);
    w.u16(this.screenAddr);
    w.u8(this.startRow);
    w.u16(this.lineDlCycles);
    w.u16(this.lineScreenCycles);
    w.u8(
      (this.vscrollOn ? 0x01 : 0) | (this.prevVscroll ? 0x02 : 0) | (this.jvbDli ? 0x04 : 0)
      | (this.hscrollOn ? 0x08 : 0) | (this.dliEnabled ? 0x10 : 0) | (this.waiting ? 0x20 : 0)
      | (this.vbiPending ? 0x40 : 0),
    );
  }

  loadState(r: StateReader): void {
    this.dmactl = r.u8(); this.chactl = r.u8(); this.hscrol = r.u8(); this.vscrol = r.u8();
    this.pmbase = r.u8(); this.chbase = r.u8(); this.nmien = r.u8(); this.nmist = r.u8();
    this.line = r.u16();
    this.dlistPc = r.u16();
    this.mode = r.u8();
    this.bytesPerLine = r.u16();
    this.rowInMode = r.u8();
    this.linesLeft = r.u8();
    this.screenAddr = r.u16();
    this.startRow = r.u8();
    this.lineDlCycles = r.u16();
    this.lineScreenCycles = r.u16();
    const f = r.u8();
    this.vscrollOn = (f & 0x01) !== 0;
    this.prevVscroll = (f & 0x02) !== 0;
    this.jvbDli = (f & 0x04) !== 0;
    this.hscrollOn = (f & 0x08) !== 0;
    this.dliEnabled = (f & 0x10) !== 0;
    this.waiting = (f & 0x20) !== 0;
    this.vbiPending = (f & 0x40) !== 0;
    // The line being described is rebuilt by the next beginLine().
    this.blankOut();
  }

  /** The display-list counter, as DLISTL/DLISTH see it. */
  get dlist(): number { return this.dlistPc; }
  set dlist(addr: number) { this.dlistPc = addr & 0xFFFF; }

  // ── DMA enables ──────────────────────────────────────────────────────────

  /** DMACTL bit 5: display-list DMA (and with it all playfield DMA). */
  get playfieldDma(): boolean { return (this.dmactl & 0x20) !== 0; }
  /** Player DMA (DMACTL bit 3) also fetches the missiles. */
  get playerDma(): boolean { return (this.dmactl & 0x08) !== 0; }
  /** Missile DMA: its own bit 2, or implied by player DMA. */
  get missileDma(): boolean { return (this.dmactl & 0x0c) !== 0; }
  get pmgDma(): boolean { return this.playerDma || this.missileDma; }
  /** DMACTL bit 4: single-line player/missile resolution. */
  get pmSingleLine(): boolean { return (this.dmactl & 0x10) !== 0; }

  /** Playfield width in display pixels: 0 off, 256 narrow, 320 normal,
   *  384 wide (DMACTL bits 0-1). */
  get playfieldWidth(): number {
    return PLAYFIELD_WIDTHS[this.dmactl & 0x03];
  }

  /** Character glyph base for `mode`. Modes 2-5 use a 1K-aligned set of 128
   *  glyphs; modes 6/7 use a 512-byte-aligned set of 64. */
  charBase(mode: number): number {
    return mode >= 6 ? (this.chbase & 0xFE) << 8 : (this.chbase & 0xFC) << 8;
  }

  /** Player/missile base: 2K-aligned at single-line resolution, 1K-aligned
   *  at double-line. */
  get pmBase(): number {
    return this.pmSingleLine ? (this.pmbase & 0xF8) << 8 : (this.pmbase & 0xFC) << 8;
  }

  // ── Frame / line stepping ────────────────────────────────────────────────

  beginFrame(): void {
    // The display-list counter is deliberately not reloaded: JVB already
    // pointed it at the list's start, and DLISTL/H writes went straight in.
    this.mode = 0;
    this.bytesPerLine = 0;
    this.rowInMode = 0;
    this.linesLeft = 0;
    this.vscrollOn = false;
    this.hscrollOn = false;
    this.dliEnabled = false;
    this.waiting = false;
    this.jvbDli = false;
    this.prevVscroll = false;
    this.startRow = 0;
    this.vbiPending = false;
    this.blankOut();
  }

  /** Advance ANTIC to `line` and return that line's display description. */
  beginLine(line: number): AnticLine {
    this.line = line;
    this.blankOut();
    this.lineDlCycles = 0;
    this.lineScreenCycles = 0;
    // VBI is a fixed scanline, not a consequence of the display list: the OS
    // waits for it during boot before it enables DMA, so it must fire even
    // when no display list is being fetched.
    if (line === ANTIC_VBI_LINE) this.vbiPending = true;
    if (this.waiting) {
      // After JVB ANTIC replays the jump as blank lines until the vertical
      // blank, firing its DLI each time if the instruction had one.
      if (this.jvbDli && this.playfieldDma && line >= ANTIC_FIRST_LINE && line < ANTIC_LAST_LINE) {
        this.lineOut.dli = true;
      }
      return this.lineOut;
    }
    if (!this.playfieldDma) return this.lineOut;
    // Lines 0-7 are the top blanking and 248 on are the vertical blank; the
    // display list only runs in between.
    if (line < ANTIC_FIRST_LINE || line >= ANTIC_LAST_LINE) return this.lineOut;

    if (this.linesLeft > 0) {
      this.linesLeft--;
      this.rowInMode++;
      this.fillOut(false);
      this.endModeLine();
      return this.lineOut;
    }

    // Fetch one or more instructions until one consumes the scanline: blank
    // and JVB are single-byte, so a short run of them can fit in one line.
    for (let guard = 0; guard < 16; guard++) {
      const instr = this.read(this.dlistPc) & 0xFF;
      this.advanceDlist();
      this.lineDlCycles++;
      const mode = instr & 0x0F;

      if (mode === 0) {
        // Blank line(s): the high nibble is the repeat count minus one. Bits
        // 4-5 are not scroll flags here, so a blank line ends a VSCROL region.
        const count = ((instr >> 4) & 0x07) + 1;
        this.mode = 0;
        this.bytesPerLine = 0;
        this.setRows(false, count);
        this.dliEnabled = (instr & 0x80) !== 0;
        return this.fillOut(false);
      }

      if (mode === 1) {
        // Jump: load the new display-list address; the instruction takes a
        // blank line (more if it ends a VSCROL region) and can fire a DLI.
        // With bit 6 it is JVB: ANTIC then idles, replaying the jump as
        // blank lines until the vertical blank, and resumes from the loaded
        // address at the next frame's line 8. Neither raises VBI itself
        // (that is the fixed scanline above).
        this.dlistPc = this.readWord(this.dlistPc);
        this.lineDlCycles += 2;
        this.mode = 0;
        this.bytesPerLine = 0;
        this.setRows(false, 1);
        this.dliEnabled = (instr & 0x80) !== 0;
        if ((instr & 0x40) !== 0) {
          this.waiting = true;
          this.jvbDli = this.dliEnabled;
          this.linesLeft = 0;
        }
        return this.fillOut(false);
      }

      const info = ANTIC_MODES[mode];
      if (!info) return this.lineOut;

      this.mode = mode;
      this.vscrollOn = (instr & 0x20) !== 0;
      this.hscrollOn = (instr & 0x10) !== 0;
      this.bytesPerLine = this.fetchBytes(info);
      if ((instr & 0x40) !== 0) {
        this.screenAddr = this.readWord(this.dlistPc);
        this.advanceDlist();
        this.advanceDlist();
        this.lineDlCycles += 2;
      }
      // The first scanline of a mode line fetches its screen bytes (the
      // character names in a text mode); later scanlines replay ANTIC's line
      // buffer.
      this.lineScreenCycles = this.bytesPerLine;

      this.setRows(this.vscrollOn, info.lines);
      this.dliEnabled = (instr & 0x80) !== 0;
      this.fillOut(true);
      this.endModeLine();
      return this.lineOut;
    }
    return this.lineOut;
  }

  /** True once per frame, at the fixed vertical-blank scanline. */
  takeVbi(): boolean {
    if (!this.vbiPending) return false;
    this.vbiPending = false;
    return true;
  }

  /**
   * Post this line's interrupt status to NMIST. ANTIC does this a few cycles
   * into the line (cycle 7 for VBI, 8 for a DLI), at the moment it raises
   * the NMI, so the machine calls this at that point of the line rather than
   * at its start: a program polling NMIST can then read the bit in the few
   * cycles before the 6502 takes the NMI and the OS handler clears it.
   * A VBI clears the DLI bit and a DLI the VBI bit.
   */
  postNmiStatus(vbi: boolean, dli: boolean, reset = false): void {
    if (vbi) this.nmist = (this.nmist & ~0x80) | 0x40;
    if (dli) this.nmist = (this.nmist & ~0x40) | 0x80;
    if (reset) this.nmist |= 0x20; // RNMI (SYSTEM RESET) sets its own bit
  }

  /** True while the display list has ended; no playfield is drawn. */
  get inVerticalBlank(): boolean { return this.waiting; }

  /**
   * Cycles ANTIC steals from the CPU on the current line.
   *
   * Every line pays nine DRAM refresh cycles. On top of that: one cycle per
   * display-list byte fetched, the mode line's screen bytes on its first
   * scanline, one glyph byte per character on *every* scanline of a text
   * mode, and on picture lines one cycle per player plus one for the
   * missiles.
   */
  stealCycles(): number {
    let n = REFRESH_CYCLES + this.lineDlCycles + this.lineScreenCycles;
    const out = this.lineOut;
    if (!out.blank && ANTIC_MODES[out.mode]?.text) n += out.bytes;
    if (this.line >= ANTIC_FIRST_LINE && this.line < ANTIC_LAST_LINE) {
      if (this.playerDma) n += 5;
      else if (this.missileDma) n += 1;
    }
    return n;
  }

  // ── Bus ──────────────────────────────────────────────────────────────────

  readReg(addr: number): number {
    switch (addr & 0x0F) {
      case REG_VCOUNT: return (this.line >> 1) & 0xFF;
      case REG_PENH: return 0;
      case REG_PENV: return 0xFF; // no light pen: the register idles inverted
      case REG_NMIST: return this.nmist | 0x1F; // the unused bits read high
      default: return 0xFF;
    }
  }

  /**
   * VCOUNT as a read `cycle` cycles into the current line sees it. The count
   * moves on for the next line a little before that line begins: the new value
   * shows from cycle 111, and the wrap back to 0 at the end of the frame one
   * cycle later.
   */
  vcountAt(cycle: number, linesPerFrame: number): number {
    if (cycle < VCOUNT_ADVANCE_CYCLE) return (this.line >> 1) & 0xFF;
    const next = this.line + 1;
    if (next >= linesPerFrame) {
      return cycle > VCOUNT_ADVANCE_CYCLE ? 0 : (next >> 1) & 0xFF;
    }
    return (next >> 1) & 0xFF;
  }

  /** What write register `a` (CHACTL, HSCROL or CHBASE) currently holds. */
  regValue(a: number): number {
    switch (a & 0x0F) {
      case REG_CHACTL: return this.chactl;
      case REG_HSCROL: return this.hscrol;
      case REG_CHBASE: return this.chbase;
      default: return 0;
    }
  }

  writeReg(addr: number, value: number): void {
    const v = value & 0xFF;
    switch (addr & 0x0F) {
      case REG_DMACTL: this.dmactl = v; break;
      case REG_CHACTL: this.chactl = v; break;
      case REG_DLISTL: this.dlistPc = (this.dlistPc & 0xFF00) | v; break;
      case REG_DLISTH: this.dlistPc = (this.dlistPc & 0x00FF) | (v << 8); break;
      case REG_HSCROL: this.hscrol = v & 0x0F; break;
      case REG_VSCROL: this.vscrol = v & 0x0F; break;
      case REG_PMBASE: this.pmbase = v; break;
      case REG_CHBASE: this.chbase = v; break;
      case REG_WSYNC: this.onWsyc?.(); break;
      case REG_NMIEN: this.nmien = v; break;
      case REG_NMIST: this.nmist = 0; break; // NMIRES
      default: break;
    }
  }

  /**
   * Set the current instruction's rows. The row counter (4 bits, wrapping)
   * runs from its start row to its end row: normally 0 to the mode's height
   * less one. Vertical scrolling changes that at the region's edges only:
   * the first line with VSCROL on starts at row VSCROL, and the first line
   * after the region (VSCROL off; a blank or jump line included) ends at row
   * VSCROL. Lines inside the region keep their normal height.
   */
  private setRows(vscroll: boolean, normalLines: number): void {
    const start = vscroll && !this.prevVscroll ? this.vscrol : 0;
    const end = !vscroll && this.prevVscroll ? this.vscrol : normalLines - 1;
    this.prevVscroll = vscroll;
    this.startRow = start;
    this.rowInMode = 0;
    this.linesLeft = (end - start) & 0x0F;
  }

  /** After the last scanline of a mode line the memory scan counter moves on
   *  by the bytes fetched, so a following mode line with no LMS starts on the
   *  next row. It counts within its 4K block only. */
  private endModeLine(): void {
    if (this.linesLeft !== 0) return;
    const s = this.screenAddr;
    this.screenAddr = (s & 0xF000) | ((s + this.bytesPerLine) & 0x0FFF);
  }

  /** Screen bytes a mode line fetches: the normal-width count scaled by the
   *  playfield width, one size wider when HSCROL is on. */
  private fetchBytes(info: AnticModeInfo): number {
    let width = this.dmactl & 0x03;
    if (width === 0) return 0;
    if (this.hscrollOn && width < 3) width++;
    return (info.bytes * PLAYFIELD_WIDTHS[width]) / 320;
  }

  private advanceDlist(): void {
    // The display-list counter wraps within its 1K page.
    this.dlistPc = (this.dlistPc & 0xFC00) | ((this.dlistPc + 1) & 0x03FF);
  }

  private readWord(addr: number): number {
    const lo = this.read(addr) & 0xFF;
    const hi = this.read((addr & 0xFC00) | ((addr + 1) & 0x03FF)) & 0xFF;
    return lo | (hi << 8);
  }

  /**
   * Settle what the current line's fetch depends on, from DMACTL as it stands
   * when ANTIC samples it, about 16 cycles in. A store made just after a
   * WSYNC is in time and gives this line its width; one made by a display-list
   * interrupt handler is not and gives it to the next. The first scanline of
   * a mode line also takes its byte count from the width (and the memory scan
   * counter moves on by that many); the later ones replay that line buffer
   * and only take the width, for the window.
   */
  sampleFetch(): void {
    const out = this.lineOut;
    out.width = this.playfieldWidth;
    if (!out.fetch || out.mode === 0) return;
    const info = ANTIC_MODES[out.mode];
    if (!info) return;
    const bytes = this.fetchBytes(info);
    if (bytes === this.bytesPerLine) return;
    this.bytesPerLine = bytes;
    out.bytes = bytes;
    out.blank = bytes === 0;
    this.lineScreenCycles = bytes;
    // A one-scanline mode line has already moved the scan counter on.
    if (this.linesLeft === 0) {
      const s = out.screenAddr;
      this.screenAddr = (s & 0xF000) | ((s + bytes) & 0x0FFF);
    }
  }

  private fillOut(fetch: boolean): AnticLine {
    const info = ANTIC_MODES[this.mode];
    const out = this.lineOut;
    out.fetch = fetch;
    out.width = this.playfieldWidth;
    out.playerDma = this.playerDma;
    out.missileDma = this.missileDma;
    out.pmSingle = this.pmSingleLine;
    out.mode = this.mode;
    out.screenAddr = this.screenAddr;
    out.bytes = info ? this.bytesPerLine : 0;
    out.row = (this.startRow + this.rowInMode) & 0x0F;
    out.hscrollOn = this.hscrollOn;
    out.hscrol = this.hscrollOn ? this.hscrol : 0;
    out.blank = this.mode === 0 || out.bytes === 0;
    // A DLI fires on the *last* scanline of the mode (or blank) line, giving
    // the handler the horizontal blank before the next mode row.
    out.dli = this.dliEnabled && this.linesLeft === 0;
    return out;
  }

  private blankOut(): void {
    const out = this.lineOut;
    out.fetch = false;
    out.width = this.playfieldWidth;
    out.playerDma = this.playerDma;
    out.missileDma = this.missileDma;
    out.pmSingle = this.pmSingleLine;
    out.mode = 0;
    out.screenAddr = 0;
    out.bytes = 0;
    out.row = 0;
    out.hscrollOn = false;
    out.hscrol = 0;
    out.dli = false;
    out.blank = true;
  }
}
