/**
 * General Instrument SP0256 "Narrator" speech processor (SP0256-AL2 allophone
 * set) — the chip behind the Currah µSpeech, the Intellivoice, the Odyssey² Voice
 * and the SAM Coupé's SAMBUS speech board.
 *
 * Architecture (from the SP0256 datasheet and the General Instrument SP0250
 * application manual):
 *
 *   • a microsequencer reads a bit-serial instruction stream out of the chip's
 *     2 KB mask ROM. The host writes a 6-bit allophone number into the address-load
 *     (ALD) register; that selects a two-byte JMP vector at the start of the ROM,
 *     and the stream it leads to is executed until a RTS with an empty stack halts
 *     the sequencer again. LRQ ("load request") tells the host whether the ALD
 *     register is free.
 *   • each speech instruction loads amplitude, pitch period and up to six pairs of
 *     filter coefficients (B and F, 8-bit sign/magnitude codes looked up through a
 *     quantisation table), then holds them for a repeat count of pitch periods.
 *   • an excitation source (periodic impulses, or LFSR noise when the period is 0)
 *     drives a 12-pole lattice filter built from six 2-pole sections.
 *   • the filter runs at clock/312 — 10 kHz with the nominal 3.12 MHz crystal.
 *
 * The ROM is the chip's only data. It is mask-programmed and copyrighted, so it is
 * supplied from outside (see `loadRom`); nothing in this file contains speech data.
 *
 * Timing is modelled per output sample (312 chip clocks) rather than per clock:
 * the sequencer fetches and decodes between samples, which is indistinguishable at
 * the output and about 300x cheaper.
 */

/** Chip clocks per output sample (nominally 3.12 MHz / 312 = 10 kHz). */
export const SP0256_CLOCKS_PER_SAMPLE = 312;
/** The nominal crystal frequency the AL2 allophone set is tuned for. */
export const SP0256_NOMINAL_CLOCK = 3_120_000;
/** Size of the on-chip mask ROM. */
export const SP0256_ROM_SIZE = 2048;

/** Pitch period (in samples) the chip substitutes for a pause or for noise. */
const PAUSE_PERIOD = 64;
const NOISE_PERIOD = 64;
/** The ROM is mapped at byte address 0x1000 of the sequencer's 64 KB space. */
const ROM_BASE = 0x1000;
/** The power-up value of the PAGE register: JMP/JSR stay within page 1. */
const INITIAL_PAGE = 1;

// Register file indices.
const AM = 0;   // amplitude: 3-bit exponent, 5-bit mantissa
const PR = 1;   // pitch period (0 = noise)
const B0 = 2;   // B0,F0,B1,F1 ... B5,F5 follow in pairs
const F0 = 3;
const B5 = 12;
const F5 = 13;
const IA = 14;  // amplitude interpolation increment
const IP = 15;  // pitch interpolation increment

// Opcode nibbles, as the sequencer reads them. The bit stream is consumed
// least-significant-bit first, so each value is the bit-reverse of the opcode as
// the datasheet writes it (the datasheet spelling is given alongside).
const OP_RTS_SETPAGE = 0x0; // 0000
const OP_SETMODE = 0x1;     // 1000
const OP_LOAD_4 = 0x2;      // 0100
const OP_LOAD_C = 0x3;      // 1100
const OP_LOAD_2 = 0x4;      // 0010
const OP_SETMSB_A = 0x5;    // 1010
const OP_SETMSB_6 = 0x6;    // 0110
const OP_LOAD_E = 0x7;      // 1110
const OP_LOADALL = 0x8;     // 0001
const OP_DELTA_9 = 0x9;     // 1001
const OP_SETMSB_5 = 0xA;    // 0101
const OP_DELTA_D = 0xB;     // 1101
const OP_SETMSB_3 = 0xC;    // 0011
const OP_JSR = 0xD;         // 1011
const OP_JMP = 0xE;         // 0111
const OP_PAUSE = 0xF;       // 1111

/** How a field in an instruction's data block is applied to its register. */
const enum Apply {
  /** Replace the whole register with the field (shifted into place). */
  Set,
  /** Replace only the field's bits, keeping the register's low bits. */
  Merge,
  /** Sign-extend the field and add it to the register (8-bit wraparound). */
  Delta,
}

interface Field {
  readonly reg: number;
  /** Bits to read from the stream (0 = no data; used for the clear-only entries). */
  readonly len: number;
  /** Left shift that justifies the field into the 8-bit register. */
  readonly shift: number;
  readonly apply: Apply;
  /** Zero all 16 registers before applying this field. */
  readonly clearAll?: boolean;
  /** Zero B5/F5 before applying this field. */
  readonly clear5?: boolean;
}

// ── Data-block layouts ──────────────────────────────────────────────────────
//
// Coefficient codes are sign/magnitude in an 8-bit register, bit 7 being the sign.
// A field of `m` magnitude bits sits in bits 6..(7-m); when it also carries the
// sign it is `m + 1` bits wide and reaches bit 7. Either way its shift is 7 - m.
// (The datasheet writes these as e.g. "B3" — 3 magnitude bits, implied sign 0 —
// and "F4s" — 4 magnitude bits plus a sign bit.)

const fld = (reg: number, len: number, shift: number, apply: Apply = Apply.Set, opts: { clearAll?: boolean; clear5?: boolean } = {}): Field =>
  ({ reg, len, shift, apply, ...opts });

/** A coefficient of `m` magnitude bits, with or without its sign bit. */
const coef = (reg: number, m: number, signed: boolean, apply: Apply = Apply.Set): Field =>
  fld(reg, m + (signed ? 1 : 0), 7 - m, apply);

/** Amplitude of `len` bits. Loads that start a new frame clear every register first. */
const amp = (len: number, clearAll: boolean): Field =>
  fld(AM, len, 8 - len, Apply.Set, clearAll ? { clearAll: true } : {});
const pitch = (): Field => fld(PR, 8, 0);
const clear5 = (): Field => fld(0, 0, 0, Apply.Set, { clear5: true });

type ModeLayouts = readonly [Field[], Field[], Field[], Field[]];

const B = (pair: number) => B0 + 2 * pair;
const F = (pair: number) => F0 + 2 * pair;

/** LOAD_C / LOAD_2 / LOAD_4 coefficient pairs. `from` is the first pair carried. */
function loadPairs(mode: number, from: number): Field[] {
  const wide = (mode & 2) !== 0;        // format sets 2 and 3 carry more precision
  const pair5 = (mode & 1) !== 0;       // format sets 1 and 3 add pair 5
  const out: Field[] = [];
  for (let p = from; p < 3; p++) {
    out.push(wide ? coef(B(p), 6, false) : coef(B(p), 3, false));
    out.push(wide ? coef(F(p), 5, true) : coef(F(p), 4, true));
  }
  if (from <= 3) {
    out.push(wide ? coef(B(3), 6, false) : coef(B(3), 4, false));
    out.push(wide ? coef(F(3), 6, true) : coef(F(3), 5, true));
  }
  out.push(wide ? coef(B(4), 7, true) : coef(B(4), 6, true));
  out.push(wide ? coef(F(4), 7, true) : coef(F(4), 5, true));
  if (pair5) out.push(coef(B5, 7, true), coef(F5, 7, true));
  return out;
}

const interpLsbs = (): Field[] => [fld(IA, 5, 0), fld(IP, 5, 0)];

/** Layouts per mode (0..3) for the opcodes that carry a data block. */
function buildLayouts(): (ModeLayouts | null)[] {
  const t: (ModeLayouts | null)[] = new Array(16).fill(null);
  const each = (f: (mode: number) => Field[]): ModeLayouts => [f(0), f(1), f(2), f(3)];

  // LOADALL: everything at full 8-bit precision; modes 1 and 3 add the interpolation bytes.
  t[OP_LOADALL] = each((m) => {
    const o: Field[] = [amp(8, true), pitch()];
    for (let r = B0; r <= F5; r++) o.push(fld(r, 8, 0));
    if (m & 1) o.push(fld(IA, 8, 0), fld(IP, 8, 0));
    return o;
  });

  t[OP_LOAD_C] = each((m) => [amp(6, true), pitch(), ...loadPairs(m, 0)]);
  t[OP_LOAD_2] = each((m) => [amp(6, true), pitch(), ...loadPairs(m, 0), ...interpLsbs()]);
  t[OP_LOAD_4] = each((m) => [amp(6, true), pitch(), ...loadPairs(m, 3)]);
  t[OP_LOAD_E] = each(() => [amp(6, false), pitch()]);

  // SETMSB_*: refresh the high bits of F0..F2 (the low bits survive), optionally
  // with amplitude / pitch / interpolation. Formats 0 and 2 also zero B5/F5.
  const msbF = (m: number, first: number, last: number): Field[] => {
    const o: Field[] = [];
    for (let p = first; p <= last; p++) o.push(fld(F(p), (m & 2) ? 6 : 5, (m & 2) ? 2 : 3, Apply.Merge));
    return o;
  };
  const lead = (m: number): Field[] => ((m & 1) === 0 ? [clear5()] : []);
  t[OP_SETMSB_A] = each((m) => [...lead(m), amp(6, false), ...msbF(m, 0, 2)]);
  t[OP_SETMSB_5] = each((m) => [...lead(m), amp(6, false), pitch(), ...msbF(m, 0, 2)]);
  t[OP_SETMSB_3] = each((m) => [...lead(m), amp(6, false), pitch(), ...msbF(m, 0, 2), ...interpLsbs()]);
  t[OP_SETMSB_6] = each((m) => {
    const o: Field[] = [...lead(m), amp(6, false)];
    if (m & 2) o.push(fld(F(3), 7, 1, Apply.Merge), fld(F(4), 8, 0, Apply.Merge));
    else o.push(fld(F(3), 6, 2, Apply.Merge), fld(F(4), 6, 2, Apply.Merge));
    if (m & 1) o.push(fld(F5, 8, 0, Apply.Merge));
    return o;
  });

  // Delta updates. A delta is expressed at the precision the coefficient has in the
  // matching load format, so its shift is that coefficient's shift.
  const d = (reg: number, len: number, shift: number): Field => fld(reg, len, shift, Apply.Delta);
  t[OP_DELTA_9] = each((m) => {
    const o: Field[] = [d(AM, 4, 2), d(PR, 5, 0)];
    if (m & 2) {
      for (let p = 0; p < 3; p++) o.push(d(B(p), 4, 1), d(F(p), 4, 2));
      o.push(d(B(3), 4, 1), d(F(3), 5, 1), d(B(4), 5, 0), d(F(4), 5, 0));
    } else {
      for (let p = 0; p < 3; p++) o.push(d(B(p), 3, 4), d(F(p), 3, 3));
      o.push(d(B(3), 3, 3), d(F(3), 4, 2), d(B(4), 4, 1), d(F(4), 4, 2));
    }
    if (m & 1) o.push(d(B5, 5, 0), d(F5, 5, 0));
    return o;
  });
  t[OP_DELTA_D] = each((m) => {
    const o: Field[] = [d(AM, 4, 2), d(PR, 5, 0)];
    if (m & 2) o.push(d(B(3), 4, 1), d(F(3), 5, 1), d(B(4), 5, 0), d(F(4), 5, 0));
    else o.push(d(B(3), 3, 3), d(F(3), 4, 2), d(B(4), 4, 1), d(F(4), 4, 2));
    if (m & 1) o.push(d(B5, 5, 0), d(F5, 5, 0));
    return o;
  });

  // PAUSE carries no data, only the implicit "clear everything".
  t[OP_PAUSE] = each(() => [fld(0, 0, 0, Apply.Set, { clearAll: true })]);
  return t;
}

const LAYOUTS = buildLayouts();

/**
 * Coefficient quantisation: the 7-bit magnitude of a B/F code selects a value in
 * 0..511. Step size narrows as the magnitude grows (8, then 4, then 2, then 1), so
 * resolution is finest near the unit circle where the filter poles live.
 */
const QUANT = (() => {
  const q = new Int16Array(128);
  for (let i = 0; i < 128; i++) {
    if (i === 0) q[i] = 0;
    else if (i <= 37) q[i] = 8 * i + 1;
    else if (i <= 69) q[i] = 297 + 4 * (i - 37);
    else if (i <= 97) q[i] = 427 + 2 * (i - 70);
    else q[i] = 482 + (i - 98);
  }
  return q;
})();

/** Decode an 8-bit coefficient code to its signed filter value. */
export function decodeSp0256Coefficient(code: number): number {
  return (code & 0x80) ? QUANT[(256 - code) & 0x7F] : (-QUANT[code] | 0);
}

function reverseBits(v: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) { r = (r << 1) | (v & 1); v >>= 1; }
  return r;
}

/**
 * Put a ROM image into the order the sequencer reads it (first bit of the stream =
 * least-significant bit of each byte). Dumps circulate in both bit orders; the
 * first 64 entries of a valid AL2 ROM are 16-bit JMP vectors, which identifies the
 * order. Anything that matches neither (a custom test ROM, say) is used as given.
 */
export function normaliseSp0256Rom(data: Uint8Array): Uint8Array {
  let straight = 0, reversed = 0;
  for (let i = 0; i < 64 && 2 * i < data.length; i++) {
    if ((data[2 * i] >> 4) === OP_JMP) straight++;
    if ((data[2 * i] & 0x0F) === reverseBits(OP_JMP, 4)) reversed++;
  }
  if (reversed > straight && reversed >= 32) {
    return Uint8Array.from(data, (b) => reverseBits(b, 8));
  }
  return data;
}

export class Sp0256 {
  private readonly rom = new Uint8Array(0x10000);
  /** True once a ROM image has been supplied. */
  romLoaded = false;

  // Microsequencer
  private pc = 0;               // BIT address into the 64 KB space
  private stack = 0;            // one-level return address (bit address, 0 = none)
  private page = INITIAL_PAGE;  // upper nibble of JMP/JSR targets
  private mode = 0;             // bits 1-2: data format set; bits 4-5: repeat prefix
  private halted = true;
  /** True when the ALD register is free to accept a command (LRQ asserted). */
  private loadReady = true;
  private ald = -1;             // pending command, or -1

  // Filter state
  private readonly r = new Uint8Array(16);
  private ampl = 0;
  private period = 0;
  private count = 0;
  /** Pitch periods left in the current instruction; <= 0 means fetch the next one. */
  private repeat = 0;
  private interp = false;
  private noise = 1;
  private readonly bCoef = new Int16Array(6);
  private readonly fCoef = new Int16Array(6);
  private readonly z1 = new Int16Array(6);
  private readonly z2 = new Int16Array(6);

  constructor() { this.reset(); }

  /** Install the 2 KB allophone ROM (either bit order). */
  loadRom(data: Uint8Array): void {
    const rom = normaliseSp0256Rom(data.subarray(0, SP0256_ROM_SIZE));
    this.rom.fill(0);
    this.rom.set(rom, ROM_BASE);
    this.romLoaded = true;
  }

  /** Install an arbitrary program at the sequencer's ROM window (tests). */
  loadRaw(data: Uint8Array): void {
    this.rom.fill(0);
    this.rom.set(data, ROM_BASE);
    this.romLoaded = true;
  }

  reset(): void {
    this.pc = 0;
    this.stack = 0;
    this.page = INITIAL_PAGE;
    this.mode = 0;
    this.halted = true;
    this.loadReady = true;
    this.ald = -1;
    this.r.fill(0);
    this.ampl = 0;
    this.period = 0;
    this.count = 0;
    this.repeat = 0;
    this.interp = false;
    this.noise = 1;
    this.bCoef.fill(0);
    this.fCoef.fill(0);
    this.z1.fill(0);
    this.z2.fill(0);
  }

  /** LRQ: the ALD register is empty and a command will be accepted. */
  get ready(): boolean { return this.loadReady; }

  /** The sequencer is idle (halted with nothing queued). */
  get idle(): boolean { return this.halted && this.ald < 0; }

  /**
   * Write the address-load register. Commands arriving while LRQ is deasserted are
   * dropped, as on the chip. Returns whether the command was accepted.
   */
  writeAld(command: number): boolean {
    if (!this.loadReady) return false;
    this.loadReady = false;
    this.ald = command & 0xFF;
    return true;
  }

  // ── Bit-serial ROM reader ───────────────────────────────────────────────

  /** Read `len` (<= 8) bits at the program counter, least-significant bit first. */
  private bits(len: number): number {
    const byte = this.pc >> 3;
    const word = this.rom[byte & 0xFFFF] | (this.rom[(byte + 1) & 0xFFFF] << 8);
    const v = (word >> (this.pc & 7)) & ((1 << len) - 1);
    this.pc += len;
    return v;
  }

  // ── Microsequencer ──────────────────────────────────────────────────────

  /** Run instructions until one supplies a repeat count (or the chip halts). */
  private runSequencer(): void {
    while (this.repeat <= 0) {
      if (this.halted) {
        if (this.ald < 0) { this.repeat = 0; return; }
        // Pick up the pending command: a 2-byte vector per allophone from the ROM base.
        this.pc = ((ROM_BASE + this.ald * 2) << 3);
        this.ald = -1;
        this.loadReady = true;
        this.halted = false;
        this.r.fill(0);
      }

      const imm = this.bits(4);
      const op = this.bits(4);
      let repeat = 0;

      switch (op) {
        case OP_RTS_SETPAGE:
          if (imm !== 0) {
            this.page = reverseBits(imm, 4);
          } else if (this.stack === 0) {
            this.halted = true;
            this.pc = 0;
          } else {
            this.pc = this.stack;
            this.stack = 0;
          }
          break;
        case OP_JMP:
        case OP_JSR: {
          const low = reverseBits(this.bits(8), 8);
          const target = (this.page << 12) | (reverseBits(imm, 4) << 8) | low;
          if (op === OP_JSR) this.stack = (this.pc + 7) & ~7;
          this.pc = target << 3;
          break;
        }
        case OP_SETMODE:
          // imm = bits (b0 b1) repeat prefix MSBs, (b2 b3) data format set.
          this.mode = ((imm & 8) >> 2) | (imm & 4) | ((imm & 3) << 4);
          break;
        default:
          repeat = imm | (this.mode & 0x30);
          break;
      }
      // The repeat prefix and format set persist only until the next instruction
      // that isn't SETMODE; the prefix is consumed by it, the format set is kept.
      if (op !== OP_SETMODE) this.mode &= 0x0F;

      if (op === OP_RTS_SETPAGE || op === OP_JMP || op === OP_JSR || op === OP_SETMODE) continue;

      // Speech instruction: read its data block into the registers.
      const layout = LAYOUTS[op]![(this.mode & 6) >> 1];
      this.loadBlock(layout, repeat !== 0);
      if (repeat === 0) continue;       // consumed but not played

      if (op === OP_PAUSE) this.r[PR] = PAUSE_PERIOD;
      this.decodeRegisters();
      this.repeat = repeat + 1;          // +1: the opening impulse is counted too
    }
  }

  /** Read a data block; when `apply` is false the bits are consumed and discarded. */
  private loadBlock(layout: readonly Field[], apply: boolean): void {
    const r = this.r;
    for (const f of layout) {
      if (apply && f.clearAll) r.fill(0);
      if (apply && f.clear5) { r[B5] = 0; r[F5] = 0; }
      if (f.len === 0) continue;
      let v = this.bits(f.len);
      if (!apply) continue;
      if (f.apply === Apply.Delta) {
        if (v & (1 << (f.len - 1))) v -= 1 << f.len;
        r[f.reg] += v << f.shift;
      } else if (f.apply === Apply.Merge) {
        r[f.reg] = (r[f.reg] & ((1 << f.shift) - 1)) | (v << f.shift);
      } else {
        r[f.reg] = v << f.shift;
      }
    }
  }

  /** Turn the register file into the values the filter works with. */
  private decodeRegisters(): void {
    const r = this.r;
    this.ampl = (r[AM] & 0x1F) << (r[AM] >> 5);
    this.period = r[PR];
    this.count = 0;                       // force an impulse on the first sample
    for (let i = 0; i < 6; i++) {
      this.bCoef[i] = decodeSp0256Coefficient(r[B0 + 2 * i]);
      this.fCoef[i] = decodeSp0256Coefficient(r[F0 + 2 * i]);
    }
    this.interp = r[IA] !== 0 || r[IP] !== 0;
  }

  /** Advance the amplitude/period by their per-period increments. */
  private interpolate(): void {
    const r = this.r;
    r[AM] += r[IA];
    r[PR] += r[IP];
    this.ampl = (r[AM] & 0x1F) << (r[AM] >> 5);
    this.period = r[PR];
  }

  // ── Sample generation ───────────────────────────────────────────────────

  /**
   * Produce the next output sample (one per 312 chip clocks), scaled to -1..+1.
   * Silent while the chip is idle.
   */
  nextSample(): number {
    for (;;) {
      if (this.repeat <= 0) {
        this.runSequencer();
        if (this.repeat <= 0) return 0;     // halted, nothing queued
      }

      // Excitation: a one-sample impulse each pitch period, or noise when period = 0.
      let x: number;
      let boundary = false;
      if (this.period !== 0) {
        if (this.count <= 0) {
          this.count += this.period;
          x = this.ampl;
          boundary = true;
        } else {
          this.count--;
          x = 0;
        }
      } else {
        if (--this.count <= 0) {
          this.count = NOISE_PERIOD;
          boundary = true;
        }
        const bit = this.noise & 1;
        this.noise = (this.noise >> 1) ^ (bit ? 0x4001 : 0);
        x = bit ? this.ampl : -this.ampl;
      }
      if (boundary) {
        this.repeat--;
        this.z1.fill(0);
        this.z2.fill(0);
        if (this.interp) this.interpolate();
      }
      // The instruction's last period ends before it produces a sample: go and
      // fetch the next one (which opens with its own impulse).
      if (this.repeat <= 0) continue;

      // Six cascaded 2-pole sections: y = x + B*z2 + 2F*z1 (all 16-bit wrapping).
      let s = (x << 16) >> 16;
      for (let i = 0; i < 6; i++) {
        s += (this.bCoef[i] * this.z2[i]) >> 9;
        s += (this.fCoef[i] * this.z1[i]) >> 8;
        s = (s << 16) >> 16;
        this.z2[i] = this.z1[i];
        this.z1[i] = s;
      }
      // The DAC is 14 bits.
      return (s > 8191 ? 8191 : s < -8192 ? -8192 : s) / 8192;
    }
  }
}
