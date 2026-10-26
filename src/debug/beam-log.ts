/**
 * BeamLog — a machine-owned, chronological ring of beam-stamped debug events.
 *
 * Every event is stamped with the frame number and `t`, the cycles since the
 * frame started (see `Machine.beam()`); `line` and `cycle` are derived when the
 * log is read (`line = floor(t / cyclesPerLine)`), so nothing but `t` is stored.
 *
 * The machine owns the buffer, not the MCP layer, so one object receives
 * events from every producer (the machine's own interrupt and display-list
 * events, and the debugger's trap and watchpoint hooks) and events that share a
 * `t` keep the order they happened in. It is a ring of preallocated integer
 * columns, like the Atari's `LineWrites`: recording allocates nothing. Rows
 * become text only when they are read.
 *
 * A machine keeps `beamLog: BeamLog | null` and every producer checks it for
 * null first, so nothing is paid until something is armed.
 *
 * This module imports nothing, so a machine may use it freely.
 */

/** Where the beam is: the frame in progress and the cycles since it started. */
export interface BeamPos {
  frame: number;
  t: number;
}

/** The machine's raster geometry, enough to turn `t` into line and cycle. */
export interface BeamInfo {
  cyclesPerLine: number;
  linesPerFrame: number;
  /** `t` of the first pixel of the first display line. */
  displayStart: number;
  /** A caveat a reader should see with the numbers, e.g. that the display
   *  start is a model's best-known figure and not hardware-verified. */
  note?: string;
}

/** Kinds of entry. One reader, many sources. */
export const BEAM_PC = 1;
export const BEAM_IO = 2;
export const BEAM_IRQ = 3;
export const BEAM_DL = 4;
export const BEAM_DMA = 5;
export const BEAM_EFF = 6;

/** Flags on an Atari VBI's BEAM_IRQ entry: the OS skips the deferred VBI when
 *  CRITIC ($42) is non-zero or the interrupted code had the I flag set. */
export const IRQ_CRITIC = 16;
export const IRQ_I_SET = 32;

/** Flags of a BEAM_DL entry. A pointer write has bit 0 (write) and, when it
 *  landed while ANTIC was drawing the picture, DL_VISIBLE; a fetched
 *  instruction has DL_FETCH. */
export const DL_FETCH = 16;
export const DL_VISIBLE = 8;

export const BEAM_KIND_NAMES: Readonly<Record<number, string>> = {
  [BEAM_PC]: 'pc', [BEAM_IO]: 'io', [BEAM_IRQ]: 'irq',
  [BEAM_DL]: 'dl', [BEAM_DMA]: 'dma', [BEAM_EFF]: 'eff',
};

/** An inclusive range; either end may be open. */
export interface BeamRange {
  min: number;
  max: number;
}

/** Parse "1500-1510" (or "1500", or "-40" / "8-" for an open end). */
export function parseBeamRange(spec: string | undefined): BeamRange | null {
  if (spec === undefined) return null;
  const s = spec.trim();
  if (s === '') return null;
  const m = /^(\d*)\s*-\s*(\d*)$/.exec(s);
  if (m) {
    return {
      min: m[1] === '' ? 0 : parseInt(m[1], 10),
      max: m[2] === '' ? Infinity : parseInt(m[2], 10),
    };
  }
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  return { min: n, max: n };
}

/** One entry, as read back. */
export interface BeamEntry {
  kind: number;
  frame: number;
  t: number;
  pc: number;
  addr: number;
  value: number;
  flags: number;
  /** Packed register snapshot, two words (only meaningful when written). */
  regLo: number;
  regHi: number;
  /** Two more words for a CPU with more registers (the Z80); 0 when unused. */
  regX0: number;
  regX1: number;
}

/** The return address a Z80 pushed on taking an interrupt, read with `peek`
 *  right after the entry: low byte at SP, high byte at SP+1. */
export function z80ReturnAddress(sp: number, peek: (addr: number) => number): number {
  return peek(sp & 0xFFFF) | (peek((sp + 1) & 0xFFFF) << 8);
}

/** The return address a 6502 pushed on taking an interrupt, read with `peek`
 *  right after the entry: it pushes PCH, PCL, P, so PCL is at $0100+SP+2 and
 *  PCH at $0100+SP+3. */
export function m6502ReturnAddress(sp: number, peek: (addr: number) => number): number {
  return peek(0x100 | ((sp + 2) & 0xFF)) | (peek(0x100 | ((sp + 3) & 0xFF)) << 8);
}

export const DEFAULT_BEAM_LOG_CAPACITY = 100_000;

export class BeamLog {
  readonly capacity: number;
  /** Entries lost to the ring wrapping since the last `clear()`. */
  dropped = 0;

  private readonly kinds: Uint8Array;
  private readonly frames: Int32Array;
  private readonly ts: Int32Array;
  private readonly pcs: Int32Array;
  private readonly addrs: Int32Array;
  private readonly values: Int32Array;
  private readonly flagsCol: Int32Array;
  private readonly regLos: Int32Array;
  private readonly regHis: Int32Array;
  /** Two more register words, allocated the first time an entry uses them, so
   *  a log that never needs them pays nothing. */
  private regX0s: Int32Array | null = null;
  private regX1s: Int32Array | null = null;
  /** Index the next entry is written to. */
  private head = 0;
  private size = 0;

  /** Capture filters, applied by `push` so a long run stays cheap. */
  private frameMin = 0;
  private frameMax = Infinity;
  private lineMin = 0;
  private lineMax = Infinity;
  private cyclesPerLine = 1;

  constructor(capacity = DEFAULT_BEAM_LOG_CAPACITY) {
    this.capacity = capacity;
    this.kinds = new Uint8Array(capacity);
    this.frames = new Int32Array(capacity);
    this.ts = new Int32Array(capacity);
    this.pcs = new Int32Array(capacity);
    this.addrs = new Int32Array(capacity);
    this.values = new Int32Array(capacity);
    this.flagsCol = new Int32Array(capacity);
    this.regLos = new Int32Array(capacity);
    this.regHis = new Int32Array(capacity);
  }

  /** Entries currently held. */
  get length(): number { return this.size; }

  /** Set the capture filters. `cyclesPerLine` is what `lines` is measured in. */
  setFilter(frames: BeamRange | null, lines: BeamRange | null, cyclesPerLine: number): void {
    this.frameMin = frames ? frames.min : 0;
    this.frameMax = frames ? frames.max : Infinity;
    this.lineMin = lines ? lines.min : 0;
    this.lineMax = lines ? lines.max : Infinity;
    this.cyclesPerLine = cyclesPerLine > 0 ? cyclesPerLine : 1;
  }

  /** Whether any event in `frame` can pass the capture filters. A producer
   *  that has to queue an event before it knows its `t` checks this first. */
  acceptsFrame(frame: number): boolean {
    return frame >= this.frameMin && frame <= this.frameMax;
  }

  /** Whether an event at (frame, t) passes the capture filters. Producers may
   *  call this first to skip building an entry that would be rejected. */
  accepts(frame: number, t: number): boolean {
    if (frame < this.frameMin || frame > this.frameMax) return false;
    if (this.lineMin === 0 && this.lineMax === Infinity) return true;
    const line = Math.floor(t / this.cyclesPerLine);
    return line >= this.lineMin && line <= this.lineMax;
  }

  /** Record an entry. Returns false when a capture filter rejected it. */
  push(
    kind: number, frame: number, t: number,
    pc = 0, addr = 0, value = 0, flags = 0, regLo = 0, regHi = 0, regX0 = 0, regX1 = 0,
  ): boolean {
    if (!this.accepts(frame, t)) return false;
    const i = this.head;
    // Once the extra words exist every entry writes them, so an old entry's
    // words never show through on a later one that has none.
    if (this.regX0s === null && (regX0 | regX1) !== 0) {
      this.regX0s = new Int32Array(this.capacity);
      this.regX1s = new Int32Array(this.capacity);
    }
    if (this.regX0s !== null) {
      this.regX0s[i] = regX0;
      this.regX1s![i] = regX1;
    }
    this.kinds[i] = kind;
    this.frames[i] = frame;
    this.ts[i] = t;
    this.pcs[i] = pc;
    this.addrs[i] = addr;
    this.values[i] = value;
    this.flagsCol[i] = flags;
    this.regLos[i] = regLo;
    this.regHis[i] = regHi;
    this.head = i + 1 === this.capacity ? 0 : i + 1;
    if (this.size < this.capacity) this.size++;
    else this.dropped++;
    return true;
  }

  /** The `i`th entry in chronological order (0 = oldest still held). */
  get(i: number): BeamEntry {
    const j = (this.head - this.size + i + this.capacity) % this.capacity;
    return {
      kind: this.kinds[j], frame: this.frames[j], t: this.ts[j], pc: this.pcs[j],
      addr: this.addrs[j], value: this.values[j], flags: this.flagsCol[j],
      regLo: this.regLos[j], regHi: this.regHis[j],
      regX0: this.regX0s !== null ? this.regX0s[j] : 0, regX1: this.regX1s !== null ? this.regX1s[j] : 0,
    };
  }

  /** Drop every entry and reset the dropped count. Filters are kept. */
  clear(): void {
    this.head = 0;
    this.size = 0;
    this.dropped = 0;
  }
}
