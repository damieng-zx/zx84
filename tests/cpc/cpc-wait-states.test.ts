/**
 * CPC Z80 instruction timing on the Gate Array's 1µs /WAIT grid.
 *
 * Every expectation below is transcribed from an external source, not derived
 * from the implementation:
 *
 *  1. CPCWiki "Z80" page, the CPC µs ("NOP") timing table
 *     (https://www.cpcwiki.eu/index.php/Z80, section "Instruction timings on
 *     the CPC" — the `Instruction | µs | Size` table), for every documented
 *     mnemonic group. Row text is quoted in each case's label.
 *  2. Caprice32 src/z80.cpp (github.com/ColinPitrat/caprice32, commit 082eb57),
 *     the `cc_op / cc_cb / cc_ed / cc_xy / cc_xycb / cc_ex` tables, copied
 *     verbatim, for exhaustive per-opcode coverage (every main, CB, ED, DD/FD
 *     and DDCB/FDCB opcode, documented or not). These are T-states on the 1µs
 *     grid; Caprice32 adds `cc_ex` when a conditional branch is taken / a block
 *     instruction repeats, and the `Oa_ / Ia_ / Ox_ / Ix_ / Oy_ / Iy_` I/O tails
 *     separately — both reproduced in `capriceT` below.
 *  3. cpctech "Instruction timings" (cpctech.cpcwiki.de/docs/instrtim.html,
 *     Kevin Thacker, measured) for the interrupt response: "Mode 1: 5".
 *
 * Where the sources disagree: cpctech lists POP IX/IY = 5, CPI/CPD = 5,
 * CPIR/CPDR final = 5 and IM 2 = 19; CPCWiki and Caprice32 both give POP IX = 4,
 * CPI/CPD = 4, CPIR/CPDR = 6/4 and IM 2 = 7 (19 is the Zilog T-state figure).
 * The CPCWiki/Caprice32 values are used — they are also what the Z80's cycle
 * breakdown gives under the /WAIT rule (e.g. POP IX = 4T M1 + 4T M1 + 3T + 3T
 * with no internal cycles, so nothing to stretch it to a 5th µs).
 */

import { describe, it, expect } from 'vitest';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { cpcAcknowledgeInterrupt } from '@/machines/cpc/wait-states.ts';

// ── Caprice32 src/z80.cpp tables (verbatim) ──────────────────────────────

const Oa = 8, Oa_ = 4, Ia = 12, Ia_ = 0;
const Ox = 8, Ox_ = 4, Oy = 12, Oy_ = 4, Ix = 12, Ix_ = 0, Iy = 16, Iy_ = 0;

// prettier-ignore
const CC_OP: readonly number[] = [
  4, 12,  8,  8,  4,  4,  8,  4,  4, 12,  8,  8,  4,  4,  8,  4,
  12, 12,  8,  8,  4,  4,  8,  4, 12, 12,  8,  8,  4,  4,  8,  4,
  8, 12, 20,  8,  4,  4,  8,  4,  8, 12, 20,  8,  4,  4,  8,  4,
  8, 12, 16,  8, 12, 12, 12,  4,  8, 12, 16,  8,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  8,  8,  8,  8,  8,  8,  4,  8,  4,  4,  4,  4,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  8, 12, 12, 12, 12, 16,  8, 16,  8, 12, 12,  4, 12, 20,  8, 16,
  8, 12, 12, Oa, 12, 16,  8, 16,  8,  4, 12, Ia, 12,  4,  8, 16,
  8, 12, 12, 24, 12, 16,  8, 16,  8,  4, 12,  4, 12,  4,  8, 16,
  8, 12, 12,  4, 12, 16,  8, 16,  8,  8, 12,  4, 12,  4,  8, 16,
];

// prettier-ignore
const CC_CB: readonly number[] = [
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  4,  4,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
  4,  4,  4,  4,  4,  4, 12,  4,  4,  4,  4,  4,  4,  4, 12,  4,
];

// prettier-ignore
const CC_ED: readonly number[] = [
  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
  Ix, Ox, 12, 20,  4, 12,  4,  8, Ix, Ox, 12, 20,  4, 12,  4,  8,
  Ix, Ox, 12, 20,  4, 12,  4,  8, Ix, Ox, 12, 20,  4, 12,  4,  8,
  Ix, Ox, 12, 20,  4, 12,  4, 16, Ix, Ox, 12, 20,  4, 12,  4, 16,
  Ix, Ox, 12, 20,  4, 12,  4,  4, Ix, Ox, 12, 20,  4, 12,  4,  4,
  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
  16, 12, Iy, Oy,  4,  4,  4,  4, 16, 12, Iy, Oy,  4,  4,  4,  4,
  16, 12, Iy, Oy,  4,  4,  4,  4, 16, 12, Iy, Oy,  4,  4,  4,  4,
  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
];

// prettier-ignore
const CC_XY: readonly number[] = [
  4, 12,  8,  8,  4,  4,  8,  4,  4, 12,  8,  8,  4,  4,  8,  4,
  12, 12,  8,  8,  4,  4,  8,  4, 12, 12,  8,  8,  4,  4,  8,  4,
  8, 12, 20,  8,  4,  4,  8,  4,  8, 12, 20,  8,  4,  4,  8,  4,
  8, 12, 16,  8, 20, 20, 20,  4,  8, 12, 16,  8,  4,  4,  8,  4,
  4,  4,  4,  4,  4,  4, 16,  4,  4,  4,  4,  4,  4,  4, 16,  4,
  4,  4,  4,  4,  4,  4, 16,  4,  4,  4,  4,  4,  4,  4, 16,  4,
  4,  4,  4,  4,  4,  4, 16,  4,  4,  4,  4,  4,  4,  4, 16,  4,
  16, 16, 16, 16, 16, 16,  4, 16,  4,  4,  4,  4,  4,  4, 16,  4,
  4,  4,  4,  4,  4,  4, 16,  4,  4,  4,  4,  4,  4,  4, 16,  4,
  4,  4,  4,  4,  4,  4, 16,  4,  4,  4,  4,  4,  4,  4, 16,  4,
  4,  4,  4,  4,  4,  4, 16,  4,  4,  4,  4,  4,  4,  4, 16,  4,
  4,  4,  4,  4,  4,  4, 16,  4,  4,  4,  4,  4,  4,  4, 16,  4,
  8, 12, 12, 12, 12, 16,  8, 16,  8, 12, 12,  4, 12, 20,  8, 16,
  8, 12, 12, Oa, 12, 16,  8, 16,  8,  4, 12, Ia, 12,  4,  8, 16,
  8, 12, 12, 24, 12, 16,  8, 16,  8,  4, 12,  4, 12,  4,  8, 16,
  8, 12, 12,  4, 12, 16,  8, 16,  8,  8, 12,  4, 12,  4,  8, 16,
];

// prettier-ignore
const CC_XYCB: readonly number[] = [
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
  16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
];

// prettier-ignore
const CC_EX: readonly number[] = [
  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
  4,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
  4,  0,  0,  0,  0,  0,  0,  0,  4,  0,  0,  0,  0,  0,  0,  0,
  4,  0,  0,  0,  0,  0,  0,  0,  4,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
  4,  8,  4,  4,  0,  0,  0,  0,  4,  8,  4,  4,  0,  0,  0,  0,
  8,  0,  0,  0,  8,  0,  0,  0,  8,  0,  0,  0,  8,  0,  0,  0,
  8,  0,  0,  0,  8,  0,  0,  0,  8,  0,  0,  0,  8,  0,  0,  0,
  8,  0,  0,  0,  8,  0,  0,  0,  8,  0,  0,  0,  8,  0,  0,  0,
  8,  0,  0,  0,  8,  0,  0,  0,  8,  0,  0,  0,  8,  0,  0,  0,
];

// ── Harness ──────────────────────────────────────────────────────────────

const CODE = 0x4000;
const DATA = 0x6000;   // HL, IX, IY and DE (+0x100) point here; filled with 0x55
const T0 = 4000;       // a µs boundary

/** Register scenarios, chosen to take / not take every condition:
 *  F=00 → NZ NC PO P true; F=FF → Z C PE M true. BC=FFFF → LDIR/CPIR/INIR/
 *  DJNZ repeat; BC=0001 → LDIR/CPIR stop (BC-1=0), INIR/DJNZ repeat (B 0→FF);
 *  BC=0101 → INIR/OTIR/DJNZ stop (B-1=0), LDIR repeats. A=00 ≠ (HL)=55. */
const SCENARIOS = [
  { f: 0x00, bc: 0xFFFF },
  { f: 0xFF, bc: 0x0001 },
  { f: 0x00, bc: 0x0101 },
] as const;
type Scenario = (typeof SCENARIOS)[number];

const m = new CpcMachine('cpc6128', null);
const cpu = m.cpu;

function prepare(bytes: readonly number[], s: Scenario): void {
  for (let i = 0; i < 8; i++) m.memory.writeByte(CODE + i, i < bytes.length ? bytes[i] : 0x00);
  for (let i = 0; i < 0x200; i++) m.memory.writeByte(DATA + i, 0x55);
  cpu.pc = CODE; cpu.sp = 0x8000;
  cpu.a = 0x00; cpu.f = s.f; cpu.bc = s.bc; cpu.de = DATA + 0x100; cpu.hl = DATA;
  cpu.ix = DATA; cpu.iy = DATA; cpu.i = 0x70;
  cpu.iff1 = false; cpu.iff2 = false; cpu.halted = false; cpu.im = 1;
}

/** Execute one instruction starting on a µs boundary; return its length in µs
 *  (the next opcode fetch waits for the following boundary, hence the ceil). */
function nops(bytes: readonly number[], s: Scenario = SCENARIOS[0]): number {
  prepare(bytes, s);
  cpu.tStates = T0;
  cpu.step();
  return Math.ceil((cpu.tStates - T0) / 4);
}

// ── Expectations from the Caprice32 tables ───────────────────────────────

function cond(y: number, f: number): boolean {
  switch (y) {
    case 0: return (f & 0x40) === 0;  // NZ
    case 1: return (f & 0x40) !== 0;  // Z
    case 2: return (f & 0x01) === 0;  // NC
    case 3: return (f & 0x01) !== 0;  // C
    case 4: return (f & 0x04) === 0;  // PO
    case 5: return (f & 0x04) !== 0;  // PE
    case 6: return (f & 0x80) === 0;  // P
    default: return (f & 0x80) !== 0; // M
  }
}

/** Extra T for an unprefixed (or DD/FD-prefixed) opcode: Caprice32 adds
 *  cc_ex on a taken DJNZ / JR cc / RET cc / CALL cc, and the I/O tails. */
function mainExtra(op: number, s: Scenario): number {
  const b = s.bc >> 8;
  if (op === 0x10) return ((b - 1) & 0xFF) !== 0 ? CC_EX[op] : 0;
  if (op === 0x20 || op === 0x28 || op === 0x30 || op === 0x38) return cond((op >> 3) - 4, s.f) ? CC_EX[op] : 0;
  if ((op & 0xC7) === 0xC0 || (op & 0xC7) === 0xC4) return cond((op >> 3) & 7, s.f) ? CC_EX[op] : 0;
  if (op === 0xD3) return Oa_;
  if (op === 0xDB) return Ia_;
  return 0;
}

function edExtra(op: number, s: Scenario): number {
  const b = s.bc >> 8;
  if ((op & 0xC7) === 0x40) return Ix_;
  if ((op & 0xC7) === 0x41) return Ox_;
  let t = 0;
  if ((op & 0xE7) === 0xA2) t += Iy_;   // INI IND INIR INDR
  if ((op & 0xE7) === 0xA3) t += Oy_;   // OUTI OUTD OTIR OTDR
  if ((op & 0xF4) === 0xB0) {           // LDIR CPIR INIR OTIR / LDDR CPDR INDR OTDR
    // A=00 never matches (HL)=55, so CPIR/CPDR repeat exactly when BC-1 ≠ 0.
    const repeats = (op & 3) <= 1 ? s.bc !== 1 : b !== 1;
    if (repeats) t += CC_EX[op];
  }
  return t;
}

const main = (op: number, s: Scenario): number => (CC_OP[op] + mainExtra(op, s)) / 4;
const cb = (op: number): number => (CC_OP[0xCB] + CC_CB[op]) / 4;
const ed = (op: number, s: Scenario): number => (CC_OP[0xED] + CC_ED[op] + edExtra(op, s)) / 4;
const xy = (op: number, s: Scenario): number => (CC_OP[0xDD] + CC_XY[op] + mainExtra(op, s)) / 4;
const xycb = (op: number): number => (CC_OP[0xDD] + CC_XY[0xCB] + CC_XYCB[op]) / 4;

/** Run every scenario over one opcode space; collect disagreements so a
 *  failure lists every wrong opcode at once. */
function sweep(
  name: string,
  encode: (op: number) => number[],
  expected: (op: number, s: Scenario) => number,
  skip: (op: number) => boolean = () => false,
): string[] {
  const bad: string[] = [];
  for (let op = 0; op < 256; op++) {
    if (skip(op)) continue;
    for (const s of SCENARIOS) {
      const want = expected(op, s);
      const got = nops(encode(op), s);
      if (got !== want) {
        bad.push(`${name} ${op.toString(16).padStart(2, '0')} F=${s.f.toString(16)} BC=${s.bc.toString(16)}: ${got}µs, want ${want}`);
      }
    }
  }
  return bad;
}

const isPrefix = (op: number): boolean => op === 0xCB || op === 0xDD || op === 0xED || op === 0xFD;

describe('CPC /WAIT grid — every opcode vs Caprice32 cycle tables', () => {
  it('unprefixed', () => {
    expect(sweep('', (op) => [op, 0x05, 0x05], main, isPrefix)).toEqual([]);
  });
  it('CB', () => {
    expect(sweep('CB', (op) => [0xCB, op], (op) => cb(op))).toEqual([]);
  });
  it('ED', () => {
    expect(sweep('ED', (op) => [0xED, op, 0x05, 0x05], ed)).toEqual([]);
  });
  it('DD and FD', () => {
    expect(sweep('DD', (op) => [0xDD, op, 0x05, 0x05], xy, isPrefix)).toEqual([]);
    expect(sweep('FD', (op) => [0xFD, op, 0x05, 0x05], xy, isPrefix)).toEqual([]);
  });
  it('DDCB and FDCB', () => {
    expect(sweep('DDCB', (op) => [0xDD, 0xCB, 0x05, op], (op) => xycb(op))).toEqual([]);
    expect(sweep('FDCB', (op) => [0xFD, 0xCB, 0x05, op], (op) => xycb(op))).toEqual([]);
  });
  it('prefix chains cost one µs per extra DD/FD (cpctech note 1)', () => {
    // DD DD NOP: 4 (DD) + cc_xy[DD]=4 + cc_xy[00]=4 → 3µs.
    expect(nops([0xDD, 0xDD, 0x00])).toBe((CC_OP[0xDD] + CC_XY[0xDD] + CC_XY[0x00]) / 4);
    // FD DD LD A,(IX+5): 1µs + 5µs.
    expect(nops([0xFD, 0xDD, 0x7E, 0x05])).toBe((CC_OP[0xFD] + CC_XY[0xDD] + CC_XY[0x7E]) / 4);
    // DD ED LDI: 4 + cc_xy[ED]=4 + cc_ed[A0]=16 → 6µs.
    expect(nops([0xDD, 0xED, 0xA0])).toBe((CC_OP[0xDD] + CC_XY[0xED] + CC_ED[0xA0]) / 4);
  });
});

// ── CPCWiki µs table (documented instructions) ───────────────────────────

const [S_TAKEN, S_ALT, S_B1] = SCENARIOS;  // S_ALT: F=FF, BC=0001; S_B1: BC=0101

/** [CPCWiki row = µs, bytes, scenario, µs]. */
const WIKI: readonly [string, number[], Scenario, number][] = [
  ['ADC/ADD/SBC/SUB A, (HL) = 2', [0x86], S_TAKEN, 2],
  ['ADC/ADD/SBC/SUB A, (IX/IY+d) = 5', [0xDD, 0x9E, 0x05], S_TAKEN, 5],
  ['ADC/ADD/SBC/SUB A, A/B/C/D/E/H/L = 1', [0x88], S_TAKEN, 1],
  ['ADC/ADD/SBC/SUB A, HX/LX/HY/LY = 2', [0xFD, 0x95], S_TAKEN, 2],
  ['ADC/ADD/SBC/SUB A, d = 2', [0xD6, 0x05], S_TAKEN, 2],
  ['ADD/SUB HL, BC/DE/HL/SP = 3', [0x39], S_TAKEN, 3],
  ['ADD/SUB IX/IY, BC/DE/HL/SP = 4', [0xDD, 0x09], S_TAKEN, 4],
  ['AND/OR/XOR A, (IX/IY+d) = 5', [0xFD, 0xAE, 0x05], S_TAKEN, 5],
  ['BIT x, (HL) = 3', [0xCB, 0x46], S_TAKEN, 3],
  ['BIT x, (IX/IY+d) = 6', [0xDD, 0xCB, 0x05, 0x7E], S_TAKEN, 6],
  ['BIT x, A/B/C/D/E/H/L = 2', [0xCB, 0x47], S_TAKEN, 2],
  ['CALL cond, aa = 5 (taken)', [0xC4, 0x05, 0x05], S_TAKEN, 5],
  ['CALL cond, aa = 3 (not taken)', [0xC4, 0x05, 0x05], S_ALT, 3],
  ['CALL aa = 5', [0xCD, 0x05, 0x05], S_TAKEN, 5],
  ['CCF/SCF = 1', [0x37], S_TAKEN, 1],
  ['CP A, (IX/IY+d) = 5', [0xDD, 0xBE, 0x05], S_TAKEN, 5],
  ['CPD/CPI = 4', [0xED, 0xA1], S_TAKEN, 4],
  ['CPDR/CPIR = 6 (repeat)', [0xED, 0xB9], S_TAKEN, 6],
  ['CPDR/CPIR = 4 (BC-1=0)', [0xED, 0xB1], S_ALT, 4],
  ['CPL = 1', [0x2F], S_TAKEN, 1],
  ['DAA = 1', [0x27], S_TAKEN, 1],
  ['DEC/INC (HL) = 3', [0x34], S_TAKEN, 3],
  ['DEC/INC (IX/IY+d) = 6', [0xFD, 0x35, 0x05], S_TAKEN, 6],
  ['DEC/INC A/B/C/D/E/H/L = 1', [0x3C], S_TAKEN, 1],
  ['DEC/INC HX/LX/HY/LY = 2', [0xDD, 0x24], S_TAKEN, 2],
  ['DEC/INC BC/DE/HL/SP = 2', [0x0B], S_TAKEN, 2],
  ['DEC/INC IX/IY = 3', [0xDD, 0x23], S_TAKEN, 3],
  ['DI/EI = 1', [0xFB], S_TAKEN, 1],
  ['DJNZ = 4 (taken)', [0x10, 0x05], S_TAKEN, 4],
  ['DJNZ = 3 (B-1=0)', [0x10, 0x05], S_B1, 3],
  ['EX (SP), HL = 6', [0xE3], S_TAKEN, 6],
  ['EX (SP), IX/IY = 7', [0xDD, 0xE3], S_TAKEN, 7],
  ['EX AF, AF\' = 1', [0x08], S_TAKEN, 1],
  ['EX DE, HL = 1', [0xEB], S_TAKEN, 1],
  ['EXX = 1', [0xD9], S_TAKEN, 1],
  ['HALT = 1', [0x76], S_TAKEN, 1],
  ['IM m = 2', [0xED, 0x5E], S_TAKEN, 2],
  ['IN A/B/C/D/E/H/L, (C) = 4', [0xED, 0x78], S_TAKEN, 4],
  ['IN A, (d) = 3', [0xDB, 0xFF], S_TAKEN, 3],
  ['IN F = 4', [0xED, 0x70], S_TAKEN, 4],
  ['IND/INI = 5', [0xED, 0xA2], S_TAKEN, 5],
  ['INDR/INIR = 6 (repeat)', [0xED, 0xBA], S_TAKEN, 6],
  ['INDR/INIR = 5 (B-1=0)', [0xED, 0xB2], S_B1, 5],
  ['JP aa = 3', [0xC3, 0x05, 0x05], S_TAKEN, 3],
  ['JP cond, aa = 3 (taken)', [0xC2, 0x05, 0x05], S_TAKEN, 3],
  ['JP cond, aa = 3 (not taken)', [0xC2, 0x05, 0x05], S_ALT, 3],
  ['JP (HL) = 1', [0xE9], S_TAKEN, 1],
  ['JP (IX/IY) = 2', [0xFD, 0xE9], S_TAKEN, 2],
  ['JR a = 3', [0x18, 0x05], S_TAKEN, 3],
  ['JR cond, a = 3 (taken)', [0x20, 0x05], S_TAKEN, 3],
  ['JR cond, a = 2 (not taken)', [0x20, 0x05], S_ALT, 2],
  ['LD (BC/DE), A = 2', [0x12], S_TAKEN, 2],
  ['LD (HL), A/B/C/D/E/H/L = 2', [0x77], S_TAKEN, 2],
  ['LD (HL),d = 3', [0x36, 0x05], S_TAKEN, 3],
  ['LD (IX/IY+d), A/B/C/D/E/H/L = 5', [0xDD, 0x77, 0x05], S_TAKEN, 5],
  ['LD (IX/IY+d), d = 6', [0xFD, 0x36, 0x05, 0x05], S_TAKEN, 6],
  ['LD (aa), A = 4', [0x32, 0x05, 0x60], S_TAKEN, 4],
  ['LD (aa), BC/DE/SP/IX/IY = 6', [0xED, 0x43, 0x05, 0x60], S_TAKEN, 6],
  ['LD (aa), BC/DE/SP/IX/IY = 6 (IX)', [0xDD, 0x22, 0x05, 0x60], S_TAKEN, 6],
  ['LD (aa), HL = 5', [0x22, 0x05, 0x60], S_TAKEN, 5],
  ['LD A, (BC/DE) = 2', [0x1A], S_TAKEN, 2],
  ['LD A/B/C/D/E/H/L, (HL) = 2', [0x7E], S_TAKEN, 2],
  ['LD A/B/C/D/E/H/L, (IX/IY+d) = 5', [0xFD, 0x46, 0x05], S_TAKEN, 5],
  ['LD A,(aa) = 4', [0x3A, 0x05, 0x60], S_TAKEN, 4],
  ['LD A/B/C/D/E/H/L, A/B/C/D/E/H/L = 1', [0x41], S_TAKEN, 1],
  ['LD A/B/C/D/E/H/L, d = 2', [0x06, 0x05], S_TAKEN, 2],
  ['LD HX/LX, A/B/C/D/E/HX/LX = 2', [0xDD, 0x67], S_TAKEN, 2],
  ['LD BC/DE/HL/SP, dd = 3', [0x31, 0x05, 0x80], S_TAKEN, 3],
  ['LD IX/IY, dd = 4', [0xDD, 0x21, 0x05, 0x05], S_TAKEN, 4],
  ['LD SP, IX/IY = 3', [0xFD, 0xF9], S_TAKEN, 3],
  ['LD SP, HL = 2', [0xF9], S_TAKEN, 2],
  ['LD HX/LX/HY/LY, d = 3', [0xDD, 0x26, 0x05], S_TAKEN, 3],
  ['LD BC/DE/HL/SP/IX/IY, (aa) = 6', [0xED, 0x7B, 0x05, 0x60], S_TAKEN, 6],
  ['LD BC/DE/HL/SP/IX/IY, (aa) = 6 (IY)', [0xFD, 0x2A, 0x05, 0x60], S_TAKEN, 6],
  ['LD HL, (aa) = 5', [0x2A, 0x05, 0x60], S_TAKEN, 5],
  ['LD A, I/R = 3', [0xED, 0x5F], S_TAKEN, 3],
  ['LD I/R, A = 3', [0xED, 0x47], S_TAKEN, 3],
  ['LDD/LDI = 5', [0xED, 0xA0], S_TAKEN, 5],
  ['LDDR/LDIR = 6 (repeat)', [0xED, 0xB8], S_TAKEN, 6],
  ['LDDR/LDIR = 5 (BC-1=0)', [0xED, 0xB0], S_ALT, 5],
  ['NEG = 2', [0xED, 0x44], S_TAKEN, 2],
  ['NOP = 1', [0x00], S_TAKEN, 1],
  ['OUT (C), A/B/C/D/E/H/L = 4', [0xED, 0x79], S_TAKEN, 4],
  ['OUT (C), 0 = 4', [0xED, 0x71], S_TAKEN, 4],
  ['OUT (d), A = 3', [0xD3, 0xFF], S_TAKEN, 3],
  ['OUTD/OUTI = 5', [0xED, 0xA3], S_TAKEN, 5],
  ['OTDR/OTIR = 6 (repeat)', [0xED, 0xBB], S_TAKEN, 6],
  ['OTDR/OTIR = 5 (B-1=0)', [0xED, 0xB3], S_B1, 5],
  ['POP AF/BC/DE/HL = 3', [0xF1], S_TAKEN, 3],
  ['POP IX/IY = 4', [0xDD, 0xE1], S_TAKEN, 4],
  ['PUSH AF/BC/DE/HL = 4', [0xC5], S_TAKEN, 4],
  ['PUSH IX/IY = 5', [0xFD, 0xE5], S_TAKEN, 5],
  ['RES/SET x, (HL) = 4', [0xCB, 0xC6], S_TAKEN, 4],
  ['RES/SET x, (IX/IY+d) = 7', [0xDD, 0xCB, 0x05, 0x86], S_TAKEN, 7],
  ['RES/SET x, (IX/IY+d), A/B/C/D/E/H/L = 7', [0xFD, 0xCB, 0x05, 0xC7], S_TAKEN, 7],
  ['RES/SET x, A/B/C/D/E/H/L = 2', [0xCB, 0x80], S_TAKEN, 2],
  ['RET = 3', [0xC9], S_TAKEN, 3],
  ['RET cond = 4 (taken)', [0xC0], S_TAKEN, 4],
  ['RET cond = 2 (not taken)', [0xC0], S_ALT, 2],
  ['RETI/RETN = 4', [0xED, 0x4D], S_TAKEN, 4],
  ['RL/RLC/RR/RRC/SLA/SLL/SRA/SRL (HL) = 4', [0xCB, 0x16], S_TAKEN, 4],
  ['RL/RLC/RR/RRC/SLA/SLL/SRA/SRL (IX/IY+d) = 7', [0xDD, 0xCB, 0x05, 0x3E], S_TAKEN, 7],
  ['RL/RLC/RR/RRC/SLA/SLL/SRA/SRL (IX/IY+d), A/B/C/D/E/H/L = 7', [0xFD, 0xCB, 0x05, 0x00], S_TAKEN, 7],
  ['RL/RLC/RR/RRC/SLA/SLL/SRA/SRL A/B/C/D/E/H/L = 2', [0xCB, 0x38], S_TAKEN, 2],
  ['RLA/RLCA/RRA/RRCA = 1', [0x17], S_TAKEN, 1],
  ['RLD/RRD = 5', [0xED, 0x6F], S_TAKEN, 5],
  ['RST 0/8/10h/18h/20h/28h/30h/38h = 4', [0xFF], S_TAKEN, 4],
];

describe('CPC /WAIT grid — CPCWiki µs table', () => {
  it.each(WIKI)('%s', (_row, bytes, s, us) => {
    expect(nops(bytes, s)).toBe(us);
  });

  it('ED "nop" (ED 00 - ED 3F) = 2 (cpctech)', () => {
    expect(nops([0xED, 0x00])).toBe(2);
    expect(nops([0xED, 0x3F])).toBe(2);
  });
});

// ── Interrupts and HALT ──────────────────────────────────────────────────

/** Run `bytes` from a µs boundary, then accept an interrupt; return the µs
 *  from where the next instruction would have started to the ISR's first
 *  opcode fetch. */
function intAckNops(bytes: readonly number[], im: number, vector = -1): number {
  prepare(bytes, SCENARIOS[0]);
  cpu.im = im; cpu.iff1 = true; cpu.iff2 = true;
  m.memory.writeByte(0x70FF, 0x00); m.memory.writeByte(0x7100, 0x50);   // IM 2 table → 0x5000
  cpu.tStates = T0;
  cpu.step();
  const slot = Math.ceil(cpu.tStates / 4) * 4;
  cpcAcknowledgeInterrupt(cpu, vector);
  return (Math.ceil(cpu.tStates / 4) * 4 - slot) / 4;
}

describe('CPC /WAIT grid — interrupt acknowledge and HALT', () => {
  it('IM 1 takes 5µs (cpctech "Mode 1: 5"; Caprice32 iCycleCount = 20)', () => {
    expect(intAckNops([0x00], 1)).toBe(5);        // after NOP (ends on a boundary)
    expect(intAckNops([0x3E, 0x05], 1)).toBe(5);  // after LD A,n (ends 1T short)
  });

  it('IM 1 takes 4µs straight after an instruction ending in internal cycles (Caprice32 iWSAdjust)', () => {
    // Caprice32 sets iWSAdjust after INC/DEC rr, LD SP,HL, EX (SP),HL and a
    // not-taken RET cc, and then charges the interrupt 16 instead of 20.
    expect(intAckNops([0x03], 1)).toBe(4);        // INC BC
    expect(intAckNops([0xF9], 1)).toBe(4);        // LD SP,HL
    expect(intAckNops([0xE3], 1)).toBe(4);        // EX (SP),HL
  });

  it('IM 2 takes 7µs (Caprice32 iCycleCount = 28), 6µs after internal cycles', () => {
    expect(intAckNops([0x00], 2)).toBe(7);
    expect(cpu.pc).toBe(0x5000);
    expect(intAckNops([0x03], 2)).toBe(6);
  });

  it('IM 2 with a Plus ASIC vector byte takes the same 7µs', () => {
    m.memory.writeByte(0x7004, 0x00); m.memory.writeByte(0x7005, 0x51);
    expect(intAckNops([0x00], 2, 0x04)).toBe(7);
    expect(cpu.pc).toBe(0x5100);
  });

  it('a HALTed CPU burns exactly 1µs per re-fetch (cpctech "HALT 1")', () => {
    prepare([0x76], SCENARIOS[0]);
    cpu.tStates = T0;
    cpu.step();
    expect(cpu.halted).toBe(true);
    for (let i = 1; i <= 5; i++) {
      cpu.step();
      expect(cpu.tStates - T0).toBe(4 * (i + 1));
    }
  });

  it('an opcode fetch that would start off the grid waits for the next µs', () => {
    prepare([0x00], SCENARIOS[0]);
    cpu.tStates = T0 + 1;       // e.g. straight after a 5T internal-cycle tail
    cpu.step();
    expect(cpu.tStates).toBe(T0 + 8);   // fetch held to T0+4, NOP ends T0+8
  });
});

// ── Frame cadence ────────────────────────────────────────────────────────

describe('CPC /WAIT grid — frame cadence', () => {
  it('keeps frames at exactly 19968µs even when instructions overshoot a frame end', () => {
    const fm = new CpcMachine('cpc6128', null);
    // Standard firmware CRTC setup: 64 chars × 312 lines.
    const regs: [number, number][] = [
      [0, 63], [1, 40], [2, 46], [3, 0x8E], [4, 38], [5, 0], [6, 25], [7, 30], [9, 7],
    ];
    for (const [r, v] of regs) { fm.crtc.selectRegister(r); fm.crtc.writeRegister(v); }
    fm.gateArray.write(0x8C);   // RMR: both ROMs off → RAM everywhere
    // Fill RAM with EX (SP),HL (6µs): 64µs lines and 19968µs frames are not
    // multiples of 6, so each frame's last instruction overshoots its end.
    for (let a = 0; a < 0x10000; a++) fm.memory.writeByte(a, 0xE3);
    fm.cpu.tStates = 0; fm.cpu.pc = 0; fm.cpu.sp = 0x8000;
    const FRAME_T = 19968 * 4;
    for (let n = 1; n <= 10; n++) {
      fm.tick();
      // The clock ends within one instruction (24T) past the n-th frame end —
      // the overshoot is carried into the next frame, never added to it.
      expect(fm.cpu.tStates - n * FRAME_T).toBeGreaterThanOrEqual(0);
      expect(fm.cpu.tStates - n * FRAME_T).toBeLessThan(24);
    }
  });
});
