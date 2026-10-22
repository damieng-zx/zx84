/**
 * SP0256 speech processor — microsequencer, LRQ protocol and excitation.
 *
 * The allophone ROM is copyrighted and not in the repo, so these tests assemble
 * tiny instruction streams of their own and expect the outputs worked out by hand
 * from the SP0256 datasheet / SP0250 application manual: the instruction formats
 * (bit-serial, least-significant bit first), the quantisation table, the impulse /
 * noise excitation and the repeat-count timing. A real-ROM sweep lives in
 * sp0256-rom.local.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { Sp0256, decodeSp0256Coefficient, normaliseSp0256Rom } from '@/cores/sp0256.ts';

// ── A minimal assembler for the bit-serial stream ──────────────────────────

const rev = (v: number, bits: number): number => {
  let r = 0;
  for (let i = 0; i < bits; i++) { r = (r << 1) | ((v >> i) & 1); }
  return r;
};

class Bits {
  readonly bytes: number[] = [];
  private n = 0;
  /** Append `len` bits of `v`, least-significant bit first (the order they are read). */
  put(v: number, len: number): this {
    for (let i = 0; i < len; i++) {
      if ((this.n & 7) === 0) this.bytes.push(0);
      this.bytes[this.bytes.length - 1] |= ((v >> i) & 1) << (this.n & 7);
      this.n++;
    }
    return this;
  }
  /** imm4 + opcode nibble. */
  op(op: number, imm = 0): this { return this.put(imm, 4).put(op, 4); }
  align(): this { this.n = (this.bytes.length) * 8; return this; }
  get bitLength(): number { return this.n; }
}

// Opcode nibbles as read from the stream (the datasheet spelling, bit-reversed).
const RTS = 0x0, SETMODE = 0x1, LOAD_E = 0x7, DELTA_D = 0xB, JSR = 0xD, JMP = 0xE, PAUSE = 0xF;

/** A 2 KB ROM image: 64 JMP vectors at the front, and `program` placed at 0x100.
 *  Instructions inside a stream are packed bit-for-bit, with no byte alignment. */
function romWith(program: Bits, vectorTarget = 0x1100): Uint8Array {
  const rom = new Uint8Array(2048);
  for (let cmd = 0; cmd < 64; cmd++) {
    const v = new Bits().op(JMP, rev((vectorTarget >> 8) & 0xF, 4)).put(rev(vectorTarget & 0xFF, 8), 8);
    rom[cmd * 2] = v.bytes[0];
    rom[cmd * 2 + 1] = v.bytes[1];
  }
  rom.set(program.bytes, 0x100);
  return rom;
}

/** LOAD_E: amplitude register high 6 bits + 8-bit period, held for `rpt` periods. */
function loadE(b: Bits, ampReg: number, period: number, rpt: number): Bits {
  return b.op(LOAD_E, rpt).put(ampReg >> 2, 6).put(period, 8);
}
const prog = (): Bits => new Bits();

function run(chip: Sp0256, maxSamples = 20000): number[] {
  const out: number[] = [];
  while (out.length < maxSamples) {
    out.push(chip.nextSample());
    if (chip.idle) break;
  }
  return out;
}

const make = (rom: Uint8Array): Sp0256 => { const c = new Sp0256(); c.loadRaw(rom); return c; };
const LSB = 1 / 8192;

describe('SP0256 — coefficient quantisation', () => {
  it('maps sign/magnitude codes to the SP0250 table values', () => {
    // Anchors of each step-size band: 8 / 4 / 2 / 1 per code.
    expect(decodeSp0256Coefficient(0x00)).toBe(0);
    expect(decodeSp0256Coefficient(0x01)).toBe(-9);
    expect(decodeSp0256Coefficient(0x25)).toBe(-297);     // 37: last 8-step entry
    expect(decodeSp0256Coefficient(0x26)).toBe(-301);     // 38: first 4-step entry
    expect(decodeSp0256Coefficient(0x45)).toBe(-425);     // 69: last 4-step entry
    expect(decodeSp0256Coefficient(0x46)).toBe(-427);     // 70: first 2-step entry
    expect(decodeSp0256Coefficient(0x60)).toBe(-479);     // 96
    expect(decodeSp0256Coefficient(0x61)).toBe(-481);     // 97: last 2-step entry
    expect(decodeSp0256Coefficient(0x62)).toBe(-482);     // 98: first 1-step entry
    expect(decodeSp0256Coefficient(0x7F)).toBe(-511);     // full scale
  });

  it('inverts the polarity when the sign bit is set', () => {
    expect(decodeSp0256Coefficient(0xFF)).toBe(9);        // magnitude 1
    expect(decodeSp0256Coefficient(0x81)).toBe(511);      // magnitude 127
    expect(decodeSp0256Coefficient(0x80)).toBe(0);
  });
});

describe('SP0256 — ROM bit order', () => {
  it('leaves a ROM whose vectors are already in stream order alone', () => {
    const rom = romWith(prog());
    expect(Array.from(normaliseSp0256Rom(rom).subarray(0, 8))).toEqual(Array.from(rom.subarray(0, 8)));
  });

  it('recognises a bit-reversed dump by its 64 JMP vectors and puts it right', () => {
    const rom = romWith(loadE(prog(), 0x44, 3, 2).op(RTS));
    const reversed = Uint8Array.from(rom, (b) => rev(b, 8));
    expect(Array.from(normaliseSp0256Rom(reversed))).toEqual(Array.from(rom));
  });
});

describe('SP0256 — address load and LRQ', () => {
  const rom = romWith(loadE(prog(), 0x44, 3, 2).op(RTS));

  it('is ready and silent after reset', () => {
    const c = make(rom);
    expect(c.ready).toBe(true);
    expect(c.idle).toBe(true);
    expect(c.nextSample()).toBe(0);
  });

  it('deasserts LRQ on an ALD write and drops a second write until it is picked up', () => {
    const c = make(rom);
    expect(c.writeAld(5)).toBe(true);
    expect(c.ready).toBe(false);
    expect(c.writeAld(6)).toBe(false);   // register still full
    c.nextSample();                      // the sequencer takes the command
    expect(c.ready).toBe(true);
    expect(c.writeAld(6)).toBe(true);    // one command may be queued behind the playing one
  });

  it('plays a queued command after the current one finishes', () => {
    const c = make(rom);
    c.writeAld(0);
    c.nextSample();
    c.writeAld(1);
    const out = run(c);
    // Each command plays the same 8-sample LOAD_E frame; two of them produce impulses twice over.
    expect(out.filter((s) => s !== 0).length).toBeGreaterThanOrEqual(3);
    expect(c.idle).toBe(true);
  });

  it('reset empties the ALD register and silences the output', () => {
    const c = make(rom);
    c.writeAld(2);
    c.reset();
    expect(c.ready).toBe(true);
    expect(c.idle).toBe(true);
    expect(c.nextSample()).toBe(0);
  });
});

describe('SP0256 — excitation and timing', () => {
  it('emits an impulse of the decoded amplitude each pitch period', () => {
    // Amplitude register 0x44 = exponent 2, mantissa 4 -> 4 << 2 = 16.
    const c = make(romWith(loadE(prog(), 0x44, 3, 2).op(RTS)));
    c.writeAld(0);
    const out = run(c);
    const impulses = out.map((s, i) => (s !== 0 ? i : -1)).filter((i) => i >= 0);
    expect(impulses.length).toBe(2);                  // repeat 2 -> two periods
    expect(out[impulses[0]]).toBeCloseTo(16 * LSB, 10);
    expect(impulses[0]).toBe(0);                      // the first sample of a frame is an impulse
    expect(impulses[1] - impulses[0]).toBeGreaterThanOrEqual(3); // spaced by the period
  });

  it('holds the frame for repeat x period samples', () => {
    for (const [period, rpt] of [[5, 3], [12, 1], [9, 6]] as const) {
      const c = make(romWith(loadE(prog(), 0x44, period, rpt).op(RTS)));
      c.writeAld(0);
      const n = run(c).length - 1;   // the final sample is the idle poll that ends the run
      expect(n, `period ${period} x ${rpt}`).toBeGreaterThanOrEqual(period * rpt);
      expect(n, `period ${period} x ${rpt}`).toBeLessThanOrEqual((period + 1) * rpt);
    }
  });

  it('uses noise of the set amplitude when the period is zero', () => {
    const c = make(romWith(loadE(prog(), 0x44, 0, 2).op(RTS)));
    c.writeAld(0);
    const out = run(c);
    const body = out.slice(0, -1);
    expect(body.length).toBeGreaterThanOrEqual(2 * 64 - 2);   // noise is timed as a 64-sample period
    expect(body.every((s) => Math.abs(s) === 16 * LSB)).toBe(true);
    expect(body.some((s) => s > 0) && body.some((s) => s < 0)).toBe(true);
  });

  it('PAUSE is silent for repeat x ~64 samples and then the chip idles', () => {
    const c = make(romWith(prog().op(PAUSE, 4).op(RTS)));
    c.writeAld(0);
    const out = run(c);
    expect(out.every((s) => s === 0)).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(4 * 64);
    expect(out.length).toBeLessThanOrEqual(4 * 65 + 2);
    expect(c.idle).toBe(true);
  });
});

describe('SP0256 — sequencing', () => {
  it('JSR runs a subroutine and RTS returns to the instruction after it', () => {
    // main (0x100): JSR 0x1180 ; LOAD_E amp 0x24 ; RTS      sub (0x180): LOAD_E amp 0x44 ; RTS
    const target = 0x1180;
    const main = prog().op(JSR, rev((target >> 8) & 0xF, 4)).put(rev(target & 0xFF, 8), 8);
    loadE(main, 0x24, 3, 1).op(RTS);
    const rom = romWith(main);
    const sub = loadE(prog(), 0x44, 3, 1).op(RTS);
    rom.set(sub.bytes, 0x180);
    const c = make(rom);
    c.writeAld(0);
    const out = run(c).filter((s) => s !== 0);
    // Subroutine frame first (amp 16), then the main-line frame (0x24: exp 1, mantissa 4 -> 8).
    expect(out.map((s) => Math.round(s / LSB))).toEqual([16, 8]);
  });

  it('a lone RTS with an empty stack halts the chip', () => {
    const c = make(romWith(prog().op(RTS)));
    c.writeAld(3);
    c.nextSample();
    expect(c.idle).toBe(true);
    expect(c.ready).toBe(true);
  });

  it('DELTA_D adds a signed increment to the amplitude register', () => {
    // First frame amp 0x44 (16); then amplitude delta +1 at 6-bit precision = +4 on
    // the register -> 0x48 = exponent 2, mantissa 8 -> 32.
    const c = make(romWith(loadE(prog(), 0x44, 3, 1).op(DELTA_D, 1).put(1, 4).put(0, 5).put(0, 3).put(0, 4).put(0, 4).put(0, 4).op(RTS)));
    c.writeAld(0);
    const amps = run(c).filter((s) => s !== 0).map((s) => Math.round(s / LSB));
    expect(amps).toEqual([16, 32]);
  });

  it('SETMODE selects the wider data format for the next instruction only in its mode bits', () => {
    // With format set 2 a LOAD_E is unchanged (it ignores the mode), so the same
    // frame plays; this checks SETMODE consumes exactly its own 8 bits.
    const c = make(romWith(loadE(prog().op(SETMODE, 0b0100), 0x44, 3, 1).op(RTS)));
    c.writeAld(0);
    const amps = run(c).filter((s) => s !== 0).map((s) => Math.round(s / LSB));
    expect(amps).toEqual([16]);
  });
});

describe('SP0256 — data block widths', () => {
  // Bits in each instruction's data block, summed from the field widths in the
  // datasheet's per-format tables (e.g. LOAD_C format 0: A6 P8, three B3+F4s pairs,
  // B4+F5s, B6s+F5s = 6+8+24+10+13 = 61). If a width were wrong the following
  // LOAD_E would be read from the wrong bit and not play.
  const LOAD_C = 0x3, LOAD_2 = 0x4, LOAD_4 = 0x2, LOADALL = 0x8, DELTA_9 = 0x9;
  const SETMSB_A = 0x5, SETMSB_5 = 0xA, SETMSB_6 = 0x6;
  const cases: [string, number, [number, number, number, number]][] = [
    ['LOAD_C', LOAD_C, [61, 77, 79, 95]],
    ['LOAD_2', LOAD_2, [71, 87, 89, 105]],
    ['LOAD_4', LOAD_4, [37, 53, 43, 59]],
    ['LOADALL', LOADALL, [112, 128, 112, 128]],
    ['DELTA_9', DELTA_9, [42, 52, 52, 62]],
    ['DELTA_D', DELTA_D, [24, 34, 28, 38]],
    ['SETMSB_A', SETMSB_A, [21, 21, 24, 24]],
    ['SETMSB_5', SETMSB_5, [29, 29, 32, 32]],
    ['SETMSB_6', SETMSB_6, [18, 26, 21, 29]],
  ];
  // SETMODE's 4-bit immediate: format index f -> bit 3 = f&1, bit 2 = f>>1.
  const modeImm = (f: number): number => ((f & 1) << 3) | ((f >> 1) << 2);

  for (const [name, op, widths] of cases) {
    for (let f = 0; f < 4; f++) {
      it(`${name} format set ${f} carries ${widths[f]} data bits`, () => {
        const b = prog().op(SETMODE, modeImm(f)).op(op, 1).put(0, widths[f]);
        loadE(b, 0x44, 3, 1).op(RTS);
        const c = make(romWith(b));
        c.writeAld(0);
        const amps = run(c).filter((s) => s !== 0).map((s) => Math.round(s / LSB));
        expect(amps).toEqual([16]);
      });
    }
  }

  it('LOAD_E (14 data bits) and PAUSE (none) are unaffected by the format set', () => {
    for (let f = 0; f < 4; f++) {
      const b = prog().op(SETMODE, modeImm(f)).op(PAUSE, 1);
      loadE(b, 0x44, 3, 1).op(RTS);
      const c = make(romWith(b));
      c.writeAld(0);
      expect(run(c).filter((s) => s !== 0).map((s) => Math.round(s / LSB))).toEqual([16]);
    }
  });
});
