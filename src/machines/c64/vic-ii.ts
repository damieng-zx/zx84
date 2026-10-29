/**
 * MOS 6569 VIC-II (PAL) — the Commodore 64's video chip.
 *
 * The behaviour follows Christian Bauer's "The MOS 6567/6569 video controller
 * (VIC-II) and its application in the Commodore 64" (1996), the standard
 * description of the chip's internals:
 *
 *  - 63 cycles a line, 312 lines a frame; the raster counter, its compare
 *    register and the raster interrupt.
 *  - Bad lines: on lines $30-$F7 whose low three bits equal YSCROLL (while
 *    DEN was set during line $30) the chip reads 40 bytes of the video matrix
 *    and colour RAM (the c-accesses, cycles 15-54), stopping the CPU from
 *    cycle 12 (BA goes low three cycles before).
 *  - The video counters VC/VCBASE/RC and the display/idle state, so FLD,
 *    line crunches and idle-state graphics come out of the same rules.
 *  - The main and vertical border flip-flops with their comparison values,
 *    so the borders can be opened the way programs do it.
 *  - The five valid graphics modes (and the three invalid ones, black).
 *  - Eight sprites with expansion, multicolour, background priority and both
 *    collision registers, their DMA (two cycles each, with the three-cycle BA
 *    lead) stealing from the CPU.
 *
 * The CPU core runs whole instructions, so cycle stealing is applied at
 * instruction granularity (the machine asks `stealEnd` and `stretch`), and the
 * picture is drawn lazily: `drawTo(t)` catches the line up to cycle `t`, and
 * the machine calls it before any write that changes what is drawn, so a
 * register changed mid-line shows from where the beam had got to.
 *
 * Line cycle t (0-62) here is Bauer's cycle t + 1. The X coordinate of the
 * pixels at cycle t is $194 + 8t, wrapping at 504; the frame buffer starts at
 * X = -8 (wrapped, $1F0), 32 pixels left of the 40-column display window.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { C64Memory } from './memory.ts';
import { C64_PALETTE } from './palette.ts';
import {
  C64_CYCLES_PER_LINE, C64_FIRST_LINE, C64_FIRST_X, C64_LINES_PER_FRAME,
  C64_SCREEN_HEIGHT, C64_SCREEN_WIDTH,
} from './constants.ts';

/** Interrupt sources ($D019 bits). */
export const VIC_IRQ_RASTER = 0x01;
export const VIC_IRQ_SB = 0x02;
export const VIC_IRQ_SS = 0x04;

/** Line cycles (0-based) of the chip's per-line events. */
export const EV_VC = 13;          // Bauer cycle 14: VC = VCBASE, c-accesses begin
export const EV_SPRITE_MCB = 15;  // cycles 15-16: sprite MCBASE advances, DMA ends
export const EV_SPRITE_DMA = 54;  // cycles 55-56: sprite DMA switched on
export const EV_LINE_END = 57;    // cycle 58: RC/VCBASE, sprite pointer and data fetches
/** First and last cycle the CPU is held by a bad line (BA low at Bauer 12). */
const BADLINE_BA = 11;
const BADLINE_END = 54;

/** Frame-buffer pixel reached by the end of line cycle t. */
function fbXAt(t: number): number {
  const p = 8 * t - 92;
  return p < 0 ? 0 : p > C64_SCREEN_WIDTH ? C64_SCREEN_WIDTH : p;
}

export class VicII {
  readonly regs = new Uint8Array(0x40);
  /** The raster line being drawn. */
  raster = 0;
  /** Absolute cycle at which the current line began. */
  lineStart = 0;
  irqFlags = 0;
  irqMask = 0;

  // Video logic.
  vcBase = 0;
  vc = 0;
  rc = 0;
  /** VC as it was at cycle 14 of this line: the g-accesses read from here. */
  private vcLine = 0;
  display = false;
  badline = false;
  /** DEN was set during line $30, enabling bad lines for the frame. */
  private denSeen = false;
  readonly matrix = new Uint8Array(40);
  readonly colors = new Uint8Array(40);

  // Border flip-flops.
  mainBorder = true;
  vBorder = true;

  // Sprites.
  private readonly spriteDma = new Uint8Array(8);
  private readonly mcBase = new Uint8Array(8);
  private readonly expFF = new Uint8Array(8);
  /** Data fetched at the end of the last line, shown on this one (24 bits). */
  private readonly spriteData = new Int32Array(8);
  private readonly spriteShow = new Uint8Array(8);
  private readonly nextData = new Int32Array(8);
  private readonly nextShow = new Uint8Array(8);
  collisionSS = 0;
  collisionSB = 0;

  // Cycle stealing: the bad-line window and the sprite DMA windows, absolute.
  private badStart = -1;
  private badEnd = -1;
  private readonly sprSteals = new Float64Array(16);
  private sprStealCount = 0;

  // Drawing.
  readonly pixels = new Uint32Array(C64_SCREEN_WIDTH * C64_SCREEN_HEIGHT);
  private row = -1;
  private drawnX = 0;
  /** The g-access byte cached for the character being drawn, -1 = refetch. */
  private gChar = -1;
  private gByte = 0;
  private lineSprites = 0;
  private lastLine = -1;

  constructor(private readonly mem: C64Memory) {
    this.reset();
  }

  reset(): void {
    this.regs.fill(0);
    this.raster = 0;
    this.irqFlags = 0;
    this.irqMask = 0;
    this.vcBase = this.vc = this.rc = this.vcLine = 0;
    this.display = false;
    this.badline = false;
    this.denSeen = false;
    this.matrix.fill(0);
    this.colors.fill(0);
    this.mainBorder = this.vBorder = true;
    this.spriteDma.fill(0);
    this.mcBase.fill(0);
    this.expFF.fill(1);
    this.spriteData.fill(0);
    this.spriteShow.fill(0);
    this.nextData.fill(0);
    this.nextShow.fill(0);
    this.collisionSS = this.collisionSB = 0;
    this.badStart = this.badEnd = -1;
    this.sprStealCount = 0;
    this.row = -1;
    this.drawnX = 0;
    this.gChar = -1;
    this.pixels.fill(C64_PALETTE[0]);
  }

  get irq(): boolean { return (this.irqFlags & this.irqMask & 0x0F) !== 0; }

  private get den(): boolean { return (this.regs[0x11] & 0x10) !== 0; }
  private get yscroll(): number { return this.regs[0x11] & 7; }
  get rasterCompare(): number { return ((this.regs[0x11] & 0x80) << 1) | this.regs[0x12]; }
  private get screenBase(): number { return (this.regs[0x18] & 0xF0) << 6; }
  private get charBase(): number { return (this.regs[0x18] & 0x0E) << 10; }

  private badlineCondition(): boolean {
    const line = this.raster;
    return line >= 0x30 && line <= 0xF7 && (line & 7) === this.yscroll && this.denSeen;
  }

  // ── Per-line events (the machine calls these at their line cycles) ───────

  /** Cycle 0 of a line: the raster counter moves on. */
  startLine(line: number, t: number): void {
    this.raster = line;
    this.lineStart = t;
    this.lastLine = line;
    if (line === 0) {
      this.vcBase = 0;
      this.denSeen = false;
    }
    if (line === 0x30 && this.den) this.denSeen = true;
    if (line === this.rasterCompare) this.irqFlags |= VIC_IRQ_RASTER;
    this.badline = this.badlineCondition();
    if (this.badline) {
      this.display = true;
      this.badStart = t + BADLINE_BA;
      this.badEnd = t + BADLINE_END;
    } else {
      this.badStart = this.badEnd = -1;
    }
    // The sprite data fetched at the end of the last line is shown on this one.
    this.lineSprites = 0;
    for (let n = 0; n < 8; n++) {
      this.spriteData[n] = this.nextData[n];
      this.spriteShow[n] = this.nextShow[n];
      if (this.nextShow[n]) this.lineSprites |= 1 << n;
    }
    const y = line - C64_FIRST_LINE;
    this.row = y >= 0 && y < C64_SCREEN_HEIGHT ? y * C64_SCREEN_WIDTH : -1;
    this.drawnX = 0;
    this.gChar = -1;
  }

  /** Cycle 14: the video counter is reloaded and a bad line reads the matrix. */
  loadCounters(): void {
    this.drawTo(this.lineStart + EV_VC);
    this.vc = this.vcBase;
    this.vcLine = this.vc;
    if (this.badline) {
      this.rc = 0;
      this.cAccess(0);
    }
  }

  /** The c-accesses from character `from` on (all 40 on a normal bad line). */
  private cAccess(from: number): void {
    const base = this.screenBase;
    for (let k = from; k < 40; k++) {
      const vc = (this.vcLine + k) & 0x3FF;
      this.matrix[k] = this.mem.vicRead(base | vc);
      this.colors[k] = this.mem.colorRam[vc] & 0x0F;
    }
  }

  /** Cycles 15-16: sprites that were shown advance a row; finished ones stop. */
  spriteRowAdvance(): void {
    for (let n = 0; n < 8; n++) {
      if (!this.expFF[n]) continue;
      this.mcBase[n] = (this.mcBase[n] + 3) & 0x3F;
      if (this.mcBase[n] === 63) {
        this.spriteDma[n] = 0;
      }
    }
  }

  /** Cycles 55-56: the Y-expansion flip-flops toggle and sprites whose Y
   *  matches start their DMA. Registers the DMA's stolen cycles. */
  spriteDmaCheck(): void {
    const yexp = this.regs[0x17];
    const enable = this.regs[0x15];
    const low = this.raster & 0xFF;
    for (let n = 0; n < 8; n++) {
      const bit = 1 << n;
      if ((yexp & bit) !== 0) this.expFF[n] ^= 1;
      if ((enable & bit) !== 0 && this.regs[1 + n * 2] === low && !this.spriteDma[n]) {
        this.spriteDma[n] = 1;
        this.mcBase[n] = 0;
        if ((yexp & bit) !== 0) this.expFF[n] = 0;
      }
    }
    // Each active sprite's two fetch cycles, with BA low three cycles ahead.
    // Sprites 0-2 fetch at Bauer cycles 58-63 of this line, 3-7 at 1-10 of
    // the next.
    this.sprStealCount = 0;
    let runStart = -1;
    let runEnd = -1;
    for (let n = 0; n < 8; n++) {
      if (!this.spriteDma[n]) continue;
      const fetch = this.lineStart + 57 + 2 * n;
      const s = fetch - 3;
      const e = fetch + 2;
      if (runStart >= 0 && s <= runEnd) { runEnd = e; continue; }
      if (runStart >= 0) this.pushSteal(runStart, runEnd);
      runStart = s;
      runEnd = e;
    }
    if (runStart >= 0) this.pushSteal(runStart, runEnd);
  }

  private pushSteal(s: number, e: number): void {
    this.sprSteals[this.sprStealCount * 2] = s;
    this.sprSteals[this.sprStealCount * 2 + 1] = e;
    this.sprStealCount++;
  }

  /** Cycle 58: the row counter and VCBASE, and the sprite fetches for the
   *  next line. */
  endOfLineFetches(): void {
    // What the beam has drawn so far was drawn in the state before this.
    this.drawTo(this.lineStart + EV_LINE_END);
    this.gChar = -1;
    if (this.display) this.vc = (this.vcLine + 40) & 0x3FF;
    if (this.rc === 7) {
      this.vcBase = this.vc;
      this.display = this.badline;
    }
    if (this.display) this.rc = (this.rc + 1) & 7;

    const low = this.raster & 0xFF;
    const ptrBase = this.screenBase | 0x3F8;
    for (let n = 0; n < 8; n++) {
      if (!this.spriteDma[n]) { this.nextShow[n] = 0; continue; }
      if (this.regs[1 + n * 2] === low) this.nextShow[n] = 1;
      const ptr = this.mem.vicRead(ptrBase | n) << 6;
      const mc = this.mcBase[n];
      this.nextData[n] = (this.mem.vicRead(ptr | mc) << 16)
        | (this.mem.vicRead(ptr | ((mc + 1) & 0x3F)) << 8)
        | this.mem.vicRead(ptr | ((mc + 2) & 0x3F));
    }
  }

  /** Cycle 63: the line is finished and the vertical border checked. */
  endLine(): void {
    this.drawTo(this.lineStart + C64_CYCLES_PER_LINE);
    const rsel = (this.regs[0x11] & 0x08) !== 0;
    if (this.raster === (rsel ? 251 : 247)) this.vBorder = true;
    else if (this.raster === (rsel ? 51 : 55) && this.den) this.vBorder = false;
  }

  // ── Cycle stealing ───────────────────────────────────────────────────────

  /** If cycle `t` is held by the VIC, the cycle the CPU gets the bus back;
   *  otherwise `t`. */
  stealEnd(t: number): number {
    let at = t;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      if (at >= this.badStart && at < this.badEnd) { at = this.badEnd; moved = true; }
      for (let i = 0; i < this.sprStealCount; i++) {
        const s = this.sprSteals[i * 2], e = this.sprSteals[i * 2 + 1];
        if (at >= s && at < e) { at = e; moved = true; }
      }
      if (!moved) break;
    }
    return at;
  }

  /** Extra cycles an instruction run from `start` to `end` loses to a hold
   *  that began part-way through it. `badline` is false when the bad line's
   *  hold was already charged (the CPU waited it out, or the instruction was
   *  stretched when it ran), so only the sprite windows count. */
  stretch(start: number, end: number, badline = true): number {
    let e = end;
    if (badline && this.badStart > start && this.badStart < e) e += this.badEnd - this.badStart;
    for (let i = 0; i < this.sprStealCount; i++) {
      const s = this.sprSteals[i * 2];
      if (s > start && s < e) e += this.sprSteals[i * 2 + 1] - s;
    }
    return e - end;
  }

  // ── Registers ────────────────────────────────────────────────────────────

  read(addr: number): number {
    const r = addr & 0x3F;
    switch (r) {
      case 0x11: return (this.regs[0x11] & 0x7F) | ((this.raster & 0x100) >> 1);
      case 0x12: return this.raster & 0xFF;
      case 0x13: case 0x14: return this.regs[r];
      case 0x16: return this.regs[0x16] | 0xC0;
      case 0x18: return this.regs[0x18] | 0x01;
      case 0x19: return this.irqFlags | 0x70 | (this.irq ? 0x80 : 0);
      case 0x1A: return this.irqMask | 0xF0;
      case 0x1E: { const v = this.collisionSS; this.collisionSS = 0; return v; }
      case 0x1F: { const v = this.collisionSB; this.collisionSB = 0; return v; }
      default:
        if (r >= 0x20 && r <= 0x2E) return this.regs[r] | 0xF0;
        if (r >= 0x2F) return 0xFF;
        return this.regs[r];
    }
  }

  /** Read without side effects. */
  peek(addr: number): number {
    const r = addr & 0x3F;
    if (r === 0x1E) return this.collisionSS;
    if (r === 0x1F) return this.collisionSB;
    return this.read(addr);
  }

  /** Write a register at absolute cycle `t` (the picture is caught up first). */
  write(addr: number, value: number, t: number): void {
    const r = addr & 0x3F;
    if (r >= 0x2F) return;
    this.drawTo(t);
    this.gChar = -1;
    switch (r) {
      case 0x11: case 0x12: {
        const before = this.rasterCompare;
        this.regs[r] = value;
        if (this.rasterCompare !== before && this.raster === this.rasterCompare) {
          this.irqFlags |= VIC_IRQ_RASTER;
        }
        if (r === 0x11) this.reevaluateBadline(t);
        return;
      }
      case 0x17:
        this.regs[r] = value;
        for (let n = 0; n < 8; n++) if ((value & (1 << n)) === 0) this.expFF[n] = 1;
        return;
      case 0x19: this.irqFlags &= ~value & 0x0F; return;
      case 0x1A: this.irqMask = value & 0x0F; return;
      case 0x1E: case 0x1F: return;
      default: this.regs[r] = value;
    }
  }

  /** $D011 changed mid-line: DEN on line $30, and whether this is a bad line
   *  now (the trick behind FLD, FLI and line crunching). */
  private reevaluateBadline(t: number): void {
    const cycle = t - this.lineStart;
    if (this.raster === 0x30 && this.den) this.denSeen = true;
    const now = this.badlineCondition();
    if (now === this.badline) return;
    this.badline = now;
    if (now) {
      this.display = true;
      if (cycle < BADLINE_END) {
        this.badStart = this.lineStart + Math.max(BADLINE_BA, cycle);
        this.badEnd = this.lineStart + BADLINE_END;
        // Turned into a bad line after the c-accesses began: they start late.
        if (cycle > EV_VC) {
          this.rc = 0;
          this.cAccess(Math.min(40, cycle - EV_VC));
        }
      }
    } else if (cycle < BADLINE_BA) {
      this.badStart = this.badEnd = -1;
    }
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  /** The g-access byte for character `k` (display or idle state). */
  private gAccess(k: number): number {
    const ecm = (this.regs[0x11] & 0x40) !== 0;
    if (!this.display) return this.mem.vicRead(ecm ? 0x39FF : 0x3FFF);
    const rc = this.rc;
    let addr: number;
    if ((this.regs[0x11] & 0x20) !== 0) {
      addr = ((this.regs[0x18] & 0x08) << 10) | (((this.vcLine + k) & 0x3FF) << 3) | rc;
    } else {
      addr = this.charBase | (this.matrix[k] << 3) | rc;
    }
    if (ecm) addr &= 0x39FF;
    return this.mem.vicRead(addr);
  }

  /** Draw the current line up to absolute cycle `t`. */
  drawTo(t: number): void {
    const target = fbXAt(t - this.lineStart);
    if (target <= this.drawnX) return;
    const from = this.drawnX;
    this.drawnX = target;
    this.drawSpan(from, target);
  }

  private drawSpan(from: number, to: number): void {
    const regs = this.regs;
    const px = this.pixels;
    const row = this.row;
    const leftCmp = (regs[0x16] & 0x08) !== 0 ? 24 : 31;
    const rightCmp = (regs[0x16] & 0x08) !== 0 ? 344 : 335;
    const rsel = (regs[0x11] & 0x08) !== 0;
    const topCmp = rsel ? 51 : 55;
    const botCmp = rsel ? 251 : 247;
    const xscroll = regs[0x16] & 7;
    const mode = ((regs[0x11] & 0x60) | (regs[0x16] & 0x10)) >> 4;   // ECM BMM MCM
    const border = C64_PALETTE[regs[0x20] & 0x0F];
    const sprites = this.lineSprites;
    const display = this.display;

    for (let p = from; p < to; p++) {
      const x = p + C64_FIRST_X;
      if (x === leftCmp) {
        if (this.raster === botCmp) this.vBorder = true;
        else if (this.raster === topCmp && this.den) this.vBorder = false;
        if (!this.vBorder) this.mainBorder = false;
      } else if (x === rightCmp) {
        this.mainBorder = true;
      }

      // Graphics: colour index and whether the pixel is foreground.
      let gColor = regs[0x21] & 0x0F;
      let fg = false;
      const col = x - 24 - xscroll;
      if (col >= 0 && col < 320) {
        const k = col >> 3;
        if (k !== this.gChar) { this.gChar = k; this.gByte = this.gAccess(k); }
        const g = this.gByte;
        const bit = col & 7;
        const code = display ? this.matrix[k] : 0;
        const color = display ? this.colors[k] : 0;
        switch (mode) {
          case 0: // standard text
            fg = ((g << bit) & 0x80) !== 0;
            if (fg) gColor = color;
            break;
          case 1: // multicolour text
            if ((color & 8) !== 0) {
              const pair = (g >> (6 - (bit & 6))) & 3;
              fg = pair >= 2;
              gColor = pair === 3 ? color & 7 : regs[0x21 + pair] & 0x0F;
            } else {
              fg = ((g << bit) & 0x80) !== 0;
              if (fg) gColor = color & 7;
            }
            break;
          case 2: // standard bitmap
            fg = ((g << bit) & 0x80) !== 0;
            gColor = fg ? code >> 4 : code & 0x0F;
            break;
          case 3: { // multicolour bitmap
            const pair = (g >> (6 - (bit & 6))) & 3;
            fg = pair >= 2;
            gColor = pair === 0 ? regs[0x21] & 0x0F : pair === 1 ? code >> 4 : pair === 2 ? code & 0x0F : color;
            break;
          }
          case 4: // extended background colour text
            fg = ((g << bit) & 0x80) !== 0;
            gColor = fg ? color : regs[0x21 + (code >> 6)] & 0x0F;
            break;
          default: // invalid modes: black, but the bits still count as foreground
            if ((mode & 1) !== 0 && (mode !== 5 || (color & 8) !== 0)) fg = ((g >> (6 - (bit & 6))) & 3) >= 2;
            else fg = ((g << bit) & 0x80) !== 0;
            gColor = 0;
        }
      }

      let out = gColor;
      if (sprites !== 0) out = this.mixSprites(x, out, fg, sprites);
      if (row >= 0) px[row + p] = this.mainBorder ? border : C64_PALETTE[out];
    }
  }

  /** Put the sprites over (or under) the graphics at X, noting collisions. */
  private mixSprites(x: number, gColor: number, fg: boolean, mask: number): number {
    const regs = this.regs;
    let out = gColor;
    let hits = 0;
    let topDone = false;
    for (let n = 0; n < 8; n++) {
      if ((mask & (1 << n)) === 0) continue;
      const bit = 1 << n;
      const sx = regs[n * 2] | ((regs[0x10] & bit) !== 0 ? 0x100 : 0);
      let dx = x - sx;
      if (dx < 0) dx += 504;
      const xexp = (regs[0x1D] & bit) !== 0;
      if (dx >= (xexp ? 48 : 24)) continue;
      const pxl = xexp ? dx >> 1 : dx;
      const data = this.spriteData[n];
      let color: number;
      if ((regs[0x1C] & bit) !== 0) {
        const pair = (data >> (22 - (pxl & ~1))) & 3;
        if (pair === 0) continue;
        color = pair === 1 ? regs[0x25] : pair === 2 ? regs[0x27 + n] : regs[0x26];
      } else {
        if (((data >> (23 - pxl)) & 1) === 0) continue;
        color = regs[0x27 + n];
      }
      hits |= bit;
      if (!topDone) {
        topDone = true;
        if (!fg || (regs[0x1B] & bit) === 0) out = color & 0x0F;
      }
    }
    if (hits !== 0) {
      if ((hits & (hits - 1)) !== 0) {
        if (this.collisionSS === 0) this.irqFlags |= VIC_IRQ_SS;
        this.collisionSS |= hits;
      }
      if (fg) {
        if (this.collisionSB === 0) this.irqFlags |= VIC_IRQ_SB;
        this.collisionSB |= hits;
      }
    }
    return out;
  }

  /** The line in progress, for the beam (or -1 between frames). */
  get currentLine(): number { return this.lastLine; }

  saveState(w: StateWriter): void {
    w.raw(this.regs);
    w.u16(this.raster); w.f64(this.lineStart);
    w.u8(this.irqFlags); w.u8(this.irqMask);
    w.u16(this.vcBase); w.u16(this.vc); w.u8(this.rc); w.u16(this.vcLine);
    w.bool(this.display); w.bool(this.badline); w.bool(this.denSeen);
    w.raw(this.matrix); w.raw(this.colors);
    w.bool(this.mainBorder); w.bool(this.vBorder);
    w.raw(this.spriteDma); w.raw(this.mcBase); w.raw(this.expFF);
    for (let n = 0; n < 8; n++) { w.u32(this.spriteData[n]); w.u32(this.nextData[n]); }
    w.raw(this.spriteShow); w.raw(this.nextShow);
    w.u8(this.collisionSS); w.u8(this.collisionSB);
  }

  loadState(r: StateReader): void {
    r.rawInto(this.regs);
    this.raster = r.u16(); this.lineStart = r.f64();
    this.irqFlags = r.u8(); this.irqMask = r.u8();
    this.vcBase = r.u16(); this.vc = r.u16(); this.rc = r.u8(); this.vcLine = r.u16();
    this.display = r.bool(); this.badline = r.bool(); this.denSeen = r.bool();
    r.rawInto(this.matrix); r.rawInto(this.colors);
    this.mainBorder = r.bool(); this.vBorder = r.bool();
    r.rawInto(this.spriteDma); r.rawInto(this.mcBase); r.rawInto(this.expFF);
    for (let n = 0; n < 8; n++) { this.spriteData[n] = r.u32(); this.nextData[n] = r.u32(); }
    r.rawInto(this.spriteShow); r.rawInto(this.nextShow);
    this.collisionSS = r.u8(); this.collisionSB = r.u8();
    this.badStart = this.badEnd = -1;
    this.sprStealCount = 0;
    this.lineSprites = 0;
    for (let n = 0; n < 8; n++) if (this.spriteShow[n]) this.lineSprites |= 1 << n;
    this.row = -1;
    this.gChar = -1;
  }

  /** Lines in a frame, for callers that do not import the constants. */
  static readonly LINES = C64_LINES_PER_FRAME;
}
