/**
 * Atari 400/800 scanline renderer.
 *
 * ANTIC describes one scanline (mode, screen bytes, scroll, which line of the
 * mode) and GTIA owns the colours and the players/missiles. This module turns
 * the two into RGBA pixels, and records the object collisions GTIA exposes at
 * $D000-$D00F.
 *
 * Geometry: a 336x240 buffer, with a normal (320-pixel) playfield starting 8
 * pixels in from the left. Narrow (256) and wide (384) playfields are centred
 * on the same window; a wide playfield runs into the 8-pixel side borders and
 * is clipped by the buffer edge, as a TV's overscan clips it. One colour
 * clock is two buffer pixels: the 160-pixel modes draw each colour pixel
 * twice as wide as GRAPHICS 8 does.
 *
 * Playfield colours, per mode:
 *
 *   2, 3, F (hi-res)  the whole playfield is COLPF2; a set bit shows COLPF2's
 *                     hue at COLPF1's luminance (white text on blue)
 *   4, 5              glyph bit pairs: BAK / PF0 / PF1 / PF2 (PF3 when the
 *                     character code has bit 7 set)
 *   6, 7              64-glyph set; code bits 6-7 pick PF0-PF3 for set bits
 *   9, B, C           one bit per pixel: BAK / PF0
 *   8, A, D, E        two bits per pixel: BAK / PF0 / PF1 / PF2
 *
 * Colour values are GTIA bytes: bits 7-4 hue, bits 3-1 luminance, bit 0
 * unused. The palette that turns them into RGB is computed in `palette.ts`.
 *
 * GTIA's special modes (PRIOR bits 7-6, over the hi-res ANTIC modes 2, 3 and
 * F) pair the hi-res bits into 4-bit pixels two colour clocks wide, aligned
 * to horizontal blank:
 *
 *   9  (%01)  sixteen luminances of COLBK's hue (OR'd with COLBK)
 *   10 (%10)  nine colours: 0-3 COLPM0-3, x100-x111 COLPF0-3, 10xx COLBK;
 *             delayed one colour clock
 *   11 (%11)  sixteen hues at COLBK's luminance (OR'd with COLBK); 0000 is
 *             forced to luminance 0
 *
 * Players and missiles show over these playfields (it is background to the
 * priority logic), and modes 9 and 11 register no playfield collisions.
 */

import type { AtariMemory } from './memory.ts';
import type { Antic, AnticLine } from './antic.ts';
import { ANTIC_FIRST_LINE, ANTIC_MODES } from './antic.ts';
import type { Gtia } from './gtia.ts';
import {
  ATARI_BORDER_LEFT, ATARI_PLAYFIELD_LEFT_CLOCK, ATARI_SCREEN_HEIGHT, ATARI_SCREEN_WIDTH,
} from './constants.ts';
import {
  applyWrite, REG_CHACTL, REG_CHBASE, REG_HITCLR, REG_HSCROL, writeCutX, type LineWrites,
} from './line-writes.ts';
import { buildAtariPalette } from './palette.ts';

const WIDTH = ATARI_SCREEN_WIDTH;

/**
 * HSCROL as ANTIC samples it for a line: the last HSCROL write made by
 * HSCROL_CYCLE, else the value the line started with. One rule for the
 * renderer's two paths and for the debugger's view of it.
 */
function sampleHscrol(w: LineWrites, atStart: number): number {
  let hs = atStart;
  for (let i = 0; i < w.count && w.cycle[i] <= HSCROL_CYCLE; i++) {
    if (w.reg[i] === REG_HSCROL) hs = w.value[i] & 0x0F;
  }
  return hs;
}

/** Writes made on or before this cycle of a line count as made in the
 *  horizontal blank before it: ANTIC fetches the player/missile data (cycles
 *  0-5) and so reads VDELAY/GRACTL/GRAF with them in place. A WSYNC wait in
 *  this machine ends on the line boundary, where the CPU really resumes near
 *  cycle 105 of the line before, so the first stores after it land here. */
const LATCH_CYCLE = 8;
/** No write made by this cycle can show inside the picture: the earliest
 *  (CHBASE) reaches the window's left edge at cycle 18, the others later. */
const BLANK_CYCLE = 18;
/** ANTIC samples HSCROL as the line's playfield starts; a write made by this
 *  cycle shifts that line, a later one the next. */
export const HSCROL_CYCLE = 10;

/** Playfield colour classes held per pixel while a line is composed. */
const BAK = 0;
const PF0 = 1;
const PF1 = 2;
const PF2 = 3;
const PF3 = 4;

/** Two-bit graphics/multicolour values to playfield class. */
const PAIR_CLASS = [BAK, PF0, PF1, PF2] as const;

/** Player width multipliers by SIZEP/SIZEM value: normal, double, normal,
 *  quadruple. */
const PMG_SIZE = [1, 2, 1, 4] as const;
/** Images of one object that can be live at once on a line. */
const OBJECT_SLOTS = 4;

/** Buffer x of colour clock `clock`: two pixels per clock, with the normal
 *  playfield's first clock at the buffer's left border. */
function clockToX(clock: number): number {
  return ATARI_BORDER_LEFT + (clock - ATARI_PLAYFIELD_LEFT_CLOCK) * 2;
}

export class AtariVideo {
  readonly pixels: Uint8Array;
  private readonly pixels32: Uint32Array;
  private readonly palette: Uint32Array;

  /** Playfield colour class per buffer pixel (BAK, PF0-PF3). */
  private readonly pf = new Uint8Array(WIDTH);
  /** 1 where a hi-res mode's set bit replaces the luminance with COLPF1's. */
  private readonly hires = new Uint8Array(WIDTH);
  /** The object images (players 0-3, then missiles 0-3) that have started on
   *  the line so far, `OBJECT_SLOTS` each: where each began, its graphics
   *  (8 bits for a player, 2 for a missile) and its pixels per bit. An image
   *  that has begun shifting out finishes whatever is written afterwards. */
  private readonly objX = new Int32Array(8 * OBJECT_SLOTS);
  private readonly objBits = new Uint8Array(8 * OBJECT_SLOTS);
  private readonly objDot = new Uint8Array(8 * OBJECT_SLOTS);
  private readonly objCount = new Uint8Array(8);
  /** Player presence per buffer pixel, bit per player. */
  private readonly players = new Uint8Array(WIDTH);
  /** Missile presence per buffer pixel, bit per missile. */
  private readonly missiles = new Uint8Array(WIDTH);

  /** GTIA colour value to ABGR, as the frame is drawn (for the OCR overlay). */
  get paletteTable(): Uint32Array { return this.palette; }

  /**
   * Paint over the cells of a `cols`x`rows` grid of `cellW`x`cellH` cells
   * starting at buffer (x0, y0), wherever `mask` is set: each cell is filled
   * with its own most common colour, which is its background (colours can
   * change line by line under DLIs, so no single paper colour would do).
   */
  blankCells(mask: readonly boolean[], cols: number, rows: number,
    x0: number, y0: number, cellW: number, cellH: number): void {
    const px = this.pixels32;
    const counts = new Map<number, number>();
    for (let row = 0; row < rows; row++) {
      const top = y0 + row * cellH;
      if (top + cellH > ATARI_SCREEN_HEIGHT) break;
      for (let col = 0; col < cols; col++) {
        if (!mask[row * cols + col]) continue;
        const left = x0 + col * cellW;
        if (left + cellW > WIDTH) continue;
        counts.clear();
        let best = 0;
        let bestN = -1;
        for (let y = 0; y < cellH; y++) {
          const base = (top + y) * WIDTH + left;
          for (let x = 0; x < cellW; x++) {
            const c = px[base + x];
            const n = (counts.get(c) ?? 0) + 1;
            counts.set(c, n);
            if (n > bestN) { bestN = n; best = c; }
          }
        }
        for (let y = 0; y < cellH; y++) {
          const base = (top + y) * WIDTH + left;
          px.fill(best, base, base + cellW);
        }
      }
    }
  }

  constructor(pal: boolean) {
    this.pixels = new Uint8Array(WIDTH * ATARI_SCREEN_HEIGHT * 4);
    this.pixels32 = new Uint32Array(this.pixels.buffer);
    this.palette = buildAtariPalette(pal);
  }

  /** Switch palettes. The table is copied into the one already handed out
   *  (the OCR reads it), and shows from the next line drawn. */
  setPalette(table: Uint32Array): void {
    this.palette.set(table);
  }

  /** Draw one displayed scanline (`y` is the buffer row, 0-239, which is
   *  ANTIC scanline `y + 8`). */
  /** The playfield window of the last line built (for the GTIA modes). */
  private winLeft = 0;
  private winRight = 0;
  /** Per-pixel GTIA-mode colour of the current line. */
  private readonly gtiaColour = new Uint8Array(WIDTH);
  /** GTIA mode 10: the playfield class (BAK or PF0-3) each pixel reaches the
   *  priority logic as, and the player bits (P0-3 colours) it reaches it as. */
  private readonly mode10Field = new Uint8Array(WIDTH);
  private readonly mode10Players = new Uint8Array(WIDTH);

  /** ANTIC's line buffer: the screen bytes its mode line's first scanline
   *  fetched, replayed by the scanlines after it. */
  private readonly screenBuf = new Uint8Array(64);
  /** The machine already fetched this scanline's screen bytes (see
   *  `fetchScreen`). */
  private screenFetched = false;
  /** The player and missile bytes DMA read as the line began, in the order
   *  P0-P3 then the missiles, when the machine captured them; else the
   *  latch reads memory itself. */
  private readonly pmBytes = new Uint8Array(5);
  private pmCaptured = false;

  /** Scratch for the mid-line path: the buffer x each late write shows from,
   *  and the writes in that order. */
  private readonly cuts = new Int32Array(512);
  private readonly order = new Uint16Array(512);
  /** What the current line's last playfield/object build found. */
  private hiresLine = false;
  private anyPmg = false;
  /** Registers changed since the playfield / the objects were last built. */
  private pfStale = true;
  private pmgStale = true;

  /**
   * Called for each line drawn with horizontal scrolling on, with what the
   * renderer decided about HSCROL for it: the value used, the cycle of the
   * write that supplied it (-1 if the line started with it), the cutoff cycle,
   * and the writes that came too late to count (how many, and the last one's
   * value and cycle). Null costs nothing; a debugger uses it for the
   * effective-HSCROL view. (A repeat of the value the register already holds
   * is not in the line's write log and is not counted: it changes nothing.)
   */
  onHscrol: ((y: number, value: number, source: number, cutoff: number,
    lateCount: number, lateValue: number, lateCycle: number) => void) | null = null;

  /**
   * Called for each write that changed a playfield or background colour
   * register (COLPF0-3, COLBK) during a line: the register (a GTIA offset), the
   * value written and the one it replaced, the buffer x at which the renderer
   * starts drawing with it (`writeCutX`; at or left of the picture's left
   * edge, 8, means from the line's first pixel) and the cycle of the write.
   * Null costs nothing. Writes that repeat the register's value are not in
   * the line's write log and are not reported.
   */
  onColour: ((y: number, reg: number, value: number, old: number, cutX: number, cycle: number) => void) | null = null;

  private reportColours(y: number, w: LineWrites): void {
    for (let i = 0; i < w.count; i++) {
      const reg = w.reg[i];
      if (reg >= 0x16 && reg <= 0x1A) this.onColour!(y, reg, w.value[i], w.old[i], writeCutX(reg, w.cycle[i]), w.cycle[i]);
    }
  }

  private reportHscrol(y: number, line: AnticLine, w: LineWrites | undefined): void {
    let source = -1;
    let lateCount = 0, lateValue = 0, lateCycle = 0;
    if (w !== undefined) {
      for (let i = 0; i < w.count; i++) {
        if (w.reg[i] !== REG_HSCROL) continue;
        if (w.cycle[i] <= HSCROL_CYCLE) {
          source = w.cycle[i];
        } else {
          lateCount++;
          lateValue = w.value[i] & 0x0F;
          lateCycle = w.cycle[i];
        }
      }
    }
    const value = w !== undefined ? sampleHscrol(w, line.hscrol) : line.hscrol;
    this.onHscrol!(y, value, source, HSCROL_CYCLE, lateCount, lateValue, lateCycle);
  }

  /**
   * Draw one scanline. `writes` is the log of register writes the CPU made
   * during it: with none (the usual line) it is drawn once from the registers
   * as they stand; otherwise the line is rewound to the state it began in and
   * drawn in pieces, each write taking effect at the beam position its cycle
   * and register imply (see `writeCutX`), and the registers end the line in
   * their final state.
   */
  renderLine(y: number, line: AnticLine, antic: Antic, gtia: Gtia, memory: AtariMemory,
    writes?: LineWrites): void {
    if (y < 0 || y >= ATARI_SCREEN_HEIGHT) return;
    // A caller that did not fetch at the right moment (a test, a snapshot
    // resumed mid-line) gets the bytes as they are now.
    if (!this.screenFetched && line.fetch !== false) this.fetchScreen(line, memory);
    this.screenFetched = false;
    if (this.onHscrol !== null && line.hscrollOn) this.reportHscrol(y, line, writes);
    if (this.onColour !== null && writes !== undefined && writes.count > 0) this.reportColours(y, writes);
    if (writes !== undefined && writes.count > 0) {
      if (!this.inBlankOnly(line, writes)) {
        this.renderSegmented(y, line, antic, gtia, memory, writes);
        return;
      }
    }
    this.latchPmg(y + ANTIC_FIRST_LINE, line, antic, gtia, memory);
    this.composeRange(y * WIDTH, gtia, 0, WIDTH,
      this.buildPlayfield(line, antic, memory), this.drawPmg(gtia));
  }

  /**
   * Read a mode line's screen bytes into the line buffer, as ANTIC does on the
   * mode line's first scanline. The machine calls this at the point of the
   * scanline where the fetch happens, so stores the CPU makes after it do not
   * show until the next mode line, and the scanlines after the first draw
   * from the buffer rather than from memory that may have changed since. The
   * memory scan counter only counts within its 4K block.
   */
  fetchScreen(line: AnticLine, memory: AtariMemory): void {
    this.screenFetched = true;
    const base = line.screenAddr;
    const n = Math.min(line.bytes, this.screenBuf.length);
    for (let i = 0; i < n; i++) this.screenBuf[i] = memory.readRam((base & 0xF000) | ((base + i) & 0x0FFF));
  }

  /**
   * Read this scanline's player and missile bytes, as ANTIC's DMA does in the
   * first cycles of the line, before the CPU has run: a store of the CPU's
   * made during the line shows on the next one. Uses the DMA state the line
   * began with; whether GTIA latches the bytes (GRACTL) is up to it later.
   */
  capturePm(scanline: number, line: AnticLine, antic: Antic, memory: AtariMemory): void {
    const single = line.pmSingle ?? antic.pmSingleLine;
    const base = antic.pmBase;
    const index = single ? scanline : scanline >> 1;
    const bytes = this.pmBytes;
    for (let p = 0; p < 4; p++) {
      bytes[p] = (line.playerDma ?? antic.playerDma)
        ? memory.readRam((single ? base + 0x400 + p * 0x100 + index : base + 0x200 + p * 0x80 + index) & 0xFFFF)
        : 0;
    }
    bytes[4] = (line.missileDma ?? antic.missileDma)
      ? memory.readRam((single ? base + 0x300 + index : base + 0x180 + index) & 0xFFFF)
      : 0;
    this.pmCaptured = true;
  }

  /**
   * True when every write of the line was made in the horizontal blank, so
   * the registers as they stand are what the whole picture is drawn with (a
   * DLI that sets up the next band right after the line starts: the common
   * case). Also settles HSCROL, which only counts if written early enough.
   */
  private inBlankOnly(line: AnticLine, w: LineWrites): boolean {
    const n = w.count;
    for (let i = 0; i < n; i++) if (w.cycle[i] > BLANK_CYCLE) return false;
    if (line.hscrollOn) line.hscrol = sampleHscrol(w, line.hscrol);
    return true;
  }

  private renderSegmented(y: number, line: AnticLine, antic: Antic, gtia: Gtia,
    memory: AtariMemory, w: LineWrites): void {
    const n = w.count;
    const cycle = w.cycle;
    const reg = w.reg;
    const value = w.value;
    // (A HITCLR has nothing to put back: it is applied again at its place in
    // the line, and the collisions it cleared are not ones to restore.)
    for (let i = n - 1; i >= 0; i--) if (reg[i] !== REG_HITCLR) applyWrite(gtia, antic, reg[i], w.old[i]);

    // HSCROL as the line starts.
    if (line.hscrollOn) line.hscrol = sampleHscrol(w, antic.hscrol);

    // The writes of the horizontal blank are in place when the objects are
    // latched; the rest take effect as the beam passes them.
    let early = 0;
    while (early < n && cycle[early] <= LATCH_CYCLE) early++;
    for (let i = 0; i < early; i++) applyWrite(gtia, antic, reg[i], value[i]);
    this.latchPmg(y + ANTIC_FIRST_LINE, line, antic, gtia, memory);

    // Glyph fetches move a change of CHBASE/CHACTL to a character boundary.
    const info = line.blank ? null : ANTIC_MODES[line.mode];
    const grid = info && info.text && antic.playfieldWidth !== 0 && line.bytes !== 0;
    const cellPx = grid ? 320 / info.bytes : 1;
    const cellX = grid ? ATARI_BORDER_LEFT + ((320 - line.bytes * cellPx) >> 1) + line.hscrol * 2 : 0;
    const cuts = this.cuts;
    const order = this.order;
    let m = 0;
    for (let i = early; i < n; i++) {
      let x = writeCutX(reg[i], cycle[i]);
      if (reg[i] === REG_CHACTL || reg[i] === REG_CHBASE) {
        x = grid ? cellX + Math.ceil((x - cellX) / cellPx) * cellPx : 0;
      }
      cuts[i] = x;
      // Stable insertion by cut: writes to one register stay in order.
      let j = m++;
      while (j > 0 && cuts[order[j - 1]] > x) { order[j] = order[j - 1]; j--; }
      order[j] = i;
    }

    this.pfStale = true;
    this.pmgStale = true;
    let j = 0;
    while (j < m && cuts[order[j]] <= 0) this.applyLate(gtia, antic, w, order[j++]);
    const rowBase = y * WIDTH;
    let from = 0;
    for (;;) {
      const next = j < m ? Math.min(WIDTH, cuts[order[j]]) : WIDTH;
      if (next > from) {
        if (this.pfStale) { this.hiresLine = this.buildPlayfield(line, antic, memory); this.pfStale = false; }
        if (this.pmgStale) { this.anyPmg = this.drawPmg(gtia, from); this.pmgStale = false; }
        this.composeRange(rowBase, gtia, from, next, this.hiresLine, this.anyPmg);
        from = next;
      }
      if (j >= m) break;
      const at = cuts[order[j]];
      while (j < m && cuts[order[j]] === at) this.applyLate(gtia, antic, w, order[j++]);
    }
  }

  /** Apply logged write `i` and note what it makes stale. */
  private applyLate(gtia: Gtia, antic: Antic, w: LineWrites, i: number): void {
    const r = w.reg[i];
    applyWrite(gtia, antic, r, w.value[i]);
    if (r === REG_CHACTL || r === REG_CHBASE) this.pfStale = true;
    else if (r <= 0x11) this.pmgStale = true;
  }

  /** Draw colour pixels [xa, xb) of the row from the built playfield and
   *  objects and the colour registers as they stand. */
  private composeRange(rowBase: number, gtia: Gtia, xa: number, xb: number,
    hiresLine: boolean, anyPmg: boolean): void {
    const pal = this.palette;
    const px = this.pixels32;
    const pfArr = this.pf;

    if (hiresLine && (gtia.prior & 0xC0) !== 0) {
      this.renderGtiaModeLine(rowBase, gtia, anyPmg, xa, xb);
      return;
    }

    if (!anyPmg && !hiresLine) {
      // No objects and no luminance substitution: a straight lookup.
      for (let x = xa; x < xb; x++) {
        const c = pfArr[x];
        px[rowBase + x] = pal[c === BAK ? gtia.colbk : gtia.colpf[c - 1]];
      }
      return;
    }

    for (let x = xa; x < xb; x++) {
      px[rowBase + x] = pal[this.composePixel(x, hiresLine, gtia)];
    }
  }

  /**
   * GTIA's priority logic for one pixel, returning the colour register value.
   *
   * Objects fall into four groups: P0/P1, P2/P3, PF0/PF1 and PF2/PF3. PRIOR
   * bits 0-3 decide which group hides which:
   *
   *   bit 0  P0-3 over PF0-3              bit 2  PF0-3 over P0-3
   *   bit 1  P0-1 over PF0-3 over P2-3    bit 3  PF0-1 over P0-3 over PF2-3
   *
   * P0/P1 always hide P2/P3, and P0 hides P1 (P2 hides P3) unless PRIOR bit 5
   * (multicolour players) ORs them. When the bits conflict (or none is set)
   * more than one group can survive and GTIA ORs their colour registers,
   * which is the real chip's behaviour. PRIOR bit 4 turns the missiles into a
   * fifth player drawn in COLPF3 with PF3's priority.
   */
  private composePixel(x: number, hiresLine: boolean, gtia: Gtia, extraPlayers = 0): number {
    const pfc = this.pf[x];
    const p = this.players[x];
    const m = this.missiles[x];
    const hon = this.hires[x] !== 0;

    // Collisions see the raw objects. On a hi-res line only the set bits are
    // playfield (PF2); the COLPF2 background behind them is not.
    if (p !== 0 || m !== 0) {
      const hits = gtia.hits;
      const pfBit = hiresLine ? (hon ? 0x04 : 0) : (pfc === BAK ? 0 : 1 << (pfc - 1));
      for (let i = 0; i < 4; i++) {
        const bit = 1 << i;
        if ((m & bit) !== 0) { hits[i] |= pfBit; hits[8 + i] |= p; }
        if ((p & bit) !== 0) { hits[4 + i] |= pfBit; hits[12 + i] |= p & ~bit; }
      }
    }

    const prior = gtia.prior;
    // `extraPlayers` are playfield pixels (GTIA mode 10) that stand for
    // players in the priority logic only: they hit nothing.
    let players = p | extraPlayers;
    let field = pfc;
    if (m !== 0) {
      if ((prior & 0x10) !== 0) field = PF3; // fifth player
      else players |= m;
    }

    let color: number;
    if (players === 0) {
      color = field === BAK ? gtia.colbk : gtia.colpf[field - 1];
    } else {
      const pri0 = (prior & 0x01) !== 0;
      const pri1 = (prior & 0x02) !== 0;
      const pri2 = (prior & 0x04) !== 0;
      const pri3 = (prior & 0x08) !== 0;
      const multi = (prior & 0x20) !== 0;
      const p01 = (players & 0x03) !== 0;
      const p23 = (players & 0x0C) !== 0;
      const pf01 = field === PF0 || field === PF1;
      const pf23 = field === PF2 || field === PF3;

      const showP01 = p01 && !(pf01 && (pri2 || pri3)) && !(pf23 && pri2);
      const showP23 = p23 && !p01 && !(pf23 && (pri1 || pri2)) && !(pf01 && !pri0);
      const showPf01 = pf01 && !(p01 && (pri0 || pri1)) && !(p23 && pri0);
      const showPf23 = pf23 && !(p01 && !pri2) && !(p23 && (pri0 || pri3));

      color = 0;
      if (showP01) {
        if ((players & 0x01) !== 0) color |= gtia.colpm[0];
        if ((players & 0x02) !== 0 && ((players & 0x01) === 0 || multi)) color |= gtia.colpm[1];
      }
      if (showP23) {
        if ((players & 0x04) !== 0) color |= gtia.colpm[2];
        if ((players & 0x08) !== 0 && ((players & 0x04) === 0 || multi)) color |= gtia.colpm[3];
      }
      if (showPf01 || showPf23) color |= gtia.colpf[field - 1];
    }

    // A hi-res set bit keeps the hue underneath but takes COLPF1's luminance.
    if (hon) color = (color & 0xF0) | (gtia.colpf[1] & 0x0E);
    return color;
  }

  /** Decode the line's playfield into `pf`/`hires`. Returns true for a
   *  hi-res (ANTIC 2, 3 or F) line. */
  private buildPlayfield(line: AnticLine, antic: Antic, memory: AtariMemory): boolean {
    const pf = this.pf;
    const hires = this.hires;
    pf.fill(BAK);
    hires.fill(0);
    if (line.blank) return false;
    const mode = line.mode;
    const info = ANTIC_MODES[mode];
    const width = line.width ?? antic.playfieldWidth;
    if (!info || width === 0 || line.bytes === 0) return false;

    // The display window is the selected playfield width, centred; with
    // HSCROL ANTIC fetches the next wider band and delays it by HSCROL colour
    // clocks, and the window crops it.
    const winLeft = Math.max(0, ATARI_BORDER_LEFT + ((320 - width) >> 1));
    const winRight = Math.min(WIDTH, ATARI_BORDER_LEFT + ((320 + width) >> 1));
    this.winLeft = winLeft;
    this.winRight = winRight;
    const bytePx = 320 / info.bytes;
    const fetchWidth = line.bytes * bytePx;
    const startX = ATARI_BORDER_LEFT + ((320 - fetchWidth) >> 1) + line.hscrol * 2;
    const pixW = 320 / info.pixels;
    const isHires = mode === 2 || mode === 3 || mode === 0x0F;
    if (isHires) pf.fill(PF2, winLeft, winRight);

    const row = line.row;
    const chactl = antic.chactl;
    const vreflect = (chactl & 0x04) !== 0;
    const charBase = antic.charBase(mode);

    for (let i = 0; i < line.bytes; i++) {
      const x0 = startX + i * bytePx;
      if (x0 >= winRight) break;
      if (x0 + bytePx <= winLeft) continue;
      const b = this.screenBuf[i];

      if (!info.text) {
        if (info.bpp === 1) {
          for (let k = 0; k < 8; k++) {
            if (((b >> (7 - k)) & 1) === 0) continue;
            if (isHires) this.fillHires(x0 + k * pixW, pixW, winLeft, winRight);
            else this.fillClass(x0 + k * pixW, pixW, PF0, winLeft, winRight);
          }
        } else {
          for (let k = 0; k < 4; k++) {
            const v = (b >> (6 - 2 * k)) & 3;
            if (v !== 0) this.fillClass(x0 + k * pixW, pixW, PAIR_CLASS[v], winLeft, winRight);
          }
        }
        continue;
      }

      if (mode === 2 || mode === 3) {
        const idx = b & 0x7F;
        // Mode 2 has eight scanlines, but a scroll region can run its row
        // counter on: rows 8 and 9 are always blank (inverse characters
        // still invert them), the rest repeat the glyph's rows.
        const glyphRow = mode === 3 ? mode3GlyphRow(idx, row) : (row & 14) === 8 ? -1 : row & 7;
        let data = glyphRow < 0 ? 0
          : memory.readRam((charBase + idx * 8 + (vreflect ? 7 - glyphRow : glyphRow)) & 0xFFFF);
        // CHACTL: bit 0 blanks bit-7 characters, bit 1 inverts them (both
        // together give a solid block).
        if ((b & 0x80) !== 0) {
          if ((chactl & 0x01) !== 0) data = 0;
          if ((chactl & 0x02) !== 0) data ^= 0xFF;
        }
        for (let k = 0; k < 8; k++) {
          if (((data >> (7 - k)) & 1) !== 0) this.fillHires(x0 + k, 1, winLeft, winRight);
        }
      } else if (mode === 4 || mode === 5) {
        const glyphRow = (mode === 5 ? row >> 1 : row) & 7;
        const data = memory.readRam(
          (charBase + (b & 0x7F) * 8 + (vreflect ? 7 - glyphRow : glyphRow)) & 0xFFFF,
        );
        const top = (b & 0x80) !== 0 ? PF3 : PF2;
        for (let k = 0; k < 4; k++) {
          const v = (data >> (6 - 2 * k)) & 3;
          if (v === 0) continue;
          this.fillClass(x0 + k * pixW, pixW, v === 3 ? top : PAIR_CLASS[v], winLeft, winRight);
        }
      } else {
        // Modes 6 and 7: 64 glyphs, colour from the code's top two bits.
        const glyphRow = (mode === 7 ? row >> 1 : row) & 7;
        const data = memory.readRam(
          (charBase + (b & 0x3F) * 8 + (vreflect ? 7 - glyphRow : glyphRow)) & 0xFFFF,
        );
        const cls = PF0 + (b >> 6);
        for (let k = 0; k < 8; k++) {
          if (((data >> (7 - k)) & 1) !== 0) this.fillClass(x0 + k * pixW, pixW, cls, winLeft, winRight);
        }
      }
    }
    return isHires;
  }

  /**
   * A hi-res line under GTIA mode 9, 10 or 11: each 4-pixel cell's hi-res
   * bits (MSB first) form the pixel value. Cells are aligned to horizontal
   * blank, so to even colour clocks (buffer x 8 is colour clock 48); mode 10
   * is one colour clock later.
   *
   * Objects take their place through the priority logic. In modes 9 and 11
   * the playfield is background to it. In mode 10 a pixel enters it as the
   * object whose colour it selects: P0-P3 colours act as players (so they
   * share the real players' priority and do not collide), PF0-PF3 as the
   * playfield (and do collide), and the BAK ones as background.
   */
  private renderGtiaModeLine(rowBase: number, gtia: Gtia, anyPmg: boolean, xa: number, xb: number): void {
    const mode = gtia.prior & 0xC0;
    const delay = mode === 0x80 ? 2 : 0;
    const hires = this.hires;
    const colours = this.gtiaColour;
    const colbk = gtia.colbk;
    colours.fill(colbk);
    const field10 = this.mode10Field;
    const players10 = this.mode10Players;
    if (mode === 0x80) { field10.fill(BAK); players10.fill(0); }
    const left = this.winLeft;
    const right = this.winRight;
    for (let cell = ATARI_BORDER_LEFT + delay - 32; cell < right; cell += 4) {
      if (cell + 4 <= left) continue;
      let nibble = 0;
      for (let k = 0; k < 4; k++) {
        const x = cell + k - delay;
        if (x >= left && x < right && hires[x] !== 0) nibble |= 8 >> k;
      }
      let c: number;
      let field = BAK;
      let asPlayer = 0;
      if (mode === 0x40) {
        c = colbk | nibble;
      } else if (mode === 0xC0) {
        c = nibble === 0 ? colbk & 0xF0 : (nibble << 4) | colbk;
      } else if (nibble < 4) {
        c = gtia.colpm[nibble];
        asPlayer = 1 << nibble;
      } else if ((nibble & 0x0C) === 0x08) {
        c = colbk;
      } else {
        c = gtia.colpf[nibble & 3];
        field = PF0 + (nibble & 3);
      }
      for (let k = 0; k < 4; k++) {
        const x = cell + k;
        if (x >= left && x < right) {
          colours[x] = c;
          if (mode === 0x80) { field10[x] = field; players10[x] = asPlayer; }
        }
      }
    }

    const px = this.pixels32;
    const pal = this.palette;
    const mode10 = mode === 0x80;
    for (let x = xa; x < xb; x++) {
      const objects = anyPmg && (this.players[x] | this.missiles[x]) !== 0;
      if (objects || (mode10 && (field10[x] !== BAK || players10[x] !== 0))) {
        // The GTIA playfield goes into the priority logic as background, or
        // in mode 10 as what its pixel selects. (The line may be drawn again
        // in pieces, so the playfield is put back.)
        const pfSaved = this.pf[x];
        const hiresSaved = this.hires[x];
        this.pf[x] = mode10 ? field10[x] : BAK;
        this.hires[x] = 0;
        px[rowBase + x] = pal[this.composePixel(x, false, gtia, mode10 ? players10[x] : 0) & 0xFE];
        this.pf[x] = pfSaved;
        this.hires[x] = hiresSaved;
      } else {
        px[rowBase + x] = pal[colours[x]];
      }
    }
  }

  private fillClass(x: number, w: number, cls: number, left: number, right: number): void {
    const from = Math.max(left, x);
    const to = Math.min(right, x + w);
    for (let px = from; px < to; px++) this.pf[px] = cls;
  }

  private fillHires(x: number, w: number, left: number, right: number): void {
    const from = Math.max(left, x);
    const to = Math.min(right, x + w);
    for (let px = from; px < to; px++) this.hires[px] = 1;
  }

  /**
   * Latch this scanline's player/missile graphics into GTIA's GRAF registers.
   *
   * With DMA on (ANTIC DMACTL and GTIA GRACTL both enabled) the GRAF
   * registers are reloaded from the player/missile area every line:
   *
   *   single-line  missiles base+$300, player n base+$400+n*$100, + scanline
   *   double-line  missiles base+$180, player n base+$200+n*$80, + scanline/2
   *
   * With DMA off they hold whatever the CPU last stored. VDELAY delays an
   * object by one scanline: it then only takes new data on odd scanlines.
   * GTIA applies this whatever the resolution, so at single-line resolution a
   * delayed object shows each odd line's data for two lines.
   */
  private latchPmg(scanline: number, line: AnticLine, antic: Antic, gtia: Gtia, memory: AtariMemory): void {
    const single = line.pmSingle ?? antic.pmSingleLine;
    const base = antic.pmBase;
    const index = single ? scanline : scanline >> 1;
    const delayed = (scanline & 1) === 0;
    const vdelay = gtia.vdelay;
    const captured = this.pmCaptured;
    this.pmCaptured = false;

    if ((line.playerDma ?? antic.playerDma) && (gtia.gractl & 0x02) !== 0) {
      for (let p = 0; p < 4; p++) {
        if (delayed && (vdelay & (0x10 << p)) !== 0) continue;
        const addr = single ? base + 0x400 + p * 0x100 + index : base + 0x200 + p * 0x80 + index;
        gtia.grafp[p] = captured ? this.pmBytes[p] : memory.readRam(addr & 0xFFFF);
      }
    }
    if ((line.missileDma ?? antic.missileDma) && (gtia.gractl & 0x01) !== 0) {
      const fetched = captured
        ? this.pmBytes[4]
        : memory.readRam((single ? base + 0x300 + index : base + 0x180 + index) & 0xFFFF);
      let keep = 0;
      if (delayed) {
        for (let m = 0; m < 4; m++) if ((vdelay & (1 << m)) !== 0) keep |= 3 << (m * 2);
      }
      gtia.grafm = (gtia.grafm & keep) | (fetched & ~keep & 0xFF);
    }
  }

  /**
   * Spread the objects into the `players`/`missiles` masks. An object starts
   * to shift out when the beam reaches its HPOS, taking the graphics and size
   * it has then, and the image finishes whatever is written next, until a new
   * image starts and replaces it. So `from` (the buffer x a register write
   * takes effect at; 0 for the whole line) keeps the images that started
   * before it and replaces the rest by the registers as they stand: a new
   * image only starts if its position is still ahead of the beam, and a
   * GRAF write after an image has started changes nothing about that image.
   * Returns true if any object is set.
   */
  private drawPmg(gtia: Gtia, from = 0): boolean {
    const players = this.players;
    const missiles = this.missiles;
    players.fill(0);
    missiles.fill(0);

    const objX = this.objX;
    const count = this.objCount;
    let any = false;
    for (let o = 0; o < 8; o++) {
      const slot = o * OBJECT_SLOTS;
      let n = 0;
      if (from > 0) {
        for (let k = 0; k < count[o]; k++) {
          if (objX[slot + k] >= from) continue; // not started: this write replaces it
          if (n !== k) {
            objX[slot + n] = objX[slot + k];
            this.objBits[slot + n] = this.objBits[slot + k];
            this.objDot[slot + n] = this.objDot[slot + k];
          }
          n++;
        }
      }
      const isPlayer = o < 4;
      const graphic = isPlayer ? gtia.grafp[o] : (gtia.grafm >> ((o - 4) * 2)) & 3;
      if (graphic !== 0) {
        const size = isPlayer ? gtia.sizep[o] & 3 : (gtia.sizem >> ((o - 4) * 2)) & 3;
        const x0 = clockToX(isPlayer ? gtia.hposp[o] : gtia.hposm[o - 4]);
        if (from === 0 || x0 >= from) {
          if (n === OBJECT_SLOTS) n--;
          objX[slot + n] = x0;
          this.objBits[slot + n] = graphic;
          this.objDot[slot + n] = 2 * PMG_SIZE[size];
          n++;
        }
      }
      count[o] = n;

      const mask = isPlayer ? players : missiles;
      const id = 1 << (isPlayer ? o : o - 4);
      const bitCount = isPlayer ? 8 : 2;
      const top = isPlayer ? 0x80 : 0x02;
      for (let k = 0; k < n; k++) {
        const bits = this.objBits[slot + k];
        const dot = this.objDot[slot + k];
        const x0 = objX[slot + k];
        any = true;
        // An image runs until the object's next one starts. The higher bit is
        // the left pixel (of a missile's two, the left dot).
        const limit = k + 1 < n ? objX[slot + k + 1] : WIDTH;
        for (let bit = 0; bit < bitCount; bit++) {
          if ((bits & (top >> bit)) === 0) continue;
          const start = Math.max(0, x0 + bit * dot);
          const end = Math.min(limit, WIDTH, x0 + (bit + 1) * dot);
          for (let x = start; x < end; x++) mask[x] |= id;
        }
      }
    }
    return any;
  }
}

/**
 * Glyph row for ANTIC mode 3's ten-scanline character cell, or -1 for a
 * blank scanline. Characters $00-$5F show rows 0-7 then two blank lines;
 * the lower-case block $60-$7F drops by two lines so its top two rows act as
 * descenders: two blank lines, rows 2-7, then rows 0-1.
 */
function mode3GlyphRow(idx: number, scan: number): number {
  if (scan >= 10) return -1;
  if (idx < 0x60) return scan < 8 ? scan : -1;
  if (scan < 2) return -1;
  return scan < 8 ? scan : scan - 8;
}
