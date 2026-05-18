/**
 * tape-loader.ts — ROM trap that intercepts LD-BYTES at PC=0x056C
 * (LD-START, just after the BREAK check) and copies tape block data
 * straight into Spectrum memory. Modelled on FUSE's tape_load_trap.
 *
 * Contract under test:
 *   - The entry A/F have been swapped into the shadow regs by the
 *     EX AF,AF' at 0x0557; the trap reads `a_` and `f_`.
 *   - Trap DECLINES (returns false, leaves all CPU/tape state
 *     untouched) on: no block, flag mismatch, block-length mismatch,
 *     and pure-data / custom-loader blocks. The caller then runs real
 *     LD-BYTES so custom-speed and protected tapes load correctly.
 *   - Trap SUCCEEDS by copying `cpu.de` bytes to `cpu.ix`, advancing
 *     IX by DE, zeroing DE, consuming the block from the tape, then
 *     popping TWO words from the stack (the 0x053F parity-error
 *     return that LD-BYTES pushed at $0561, and the caller's actual
 *     return address). PC is set to the caller's return; main-F's
 *     carry bit is set to 1 to signal success.
 *   - SAVE-half of LD-BYTES is "VERIFY" semantics: cleared carry.
 *     Verify advances IX/DE the same way but writes nothing. We do
 *     NOT compare bytes (JSpeccy/ZEsarUX shortcut).
 *   - The trap never touches IFF1/IFF2 — the caller's EI handles
 *     interrupt re-enable.
 *
 * Behaviour deliberately pinned because it differs from earlier
 * versions:
 *
 *  - **Short block (block shorter than DE)** now DECLINES (used to do
 *    a partial copy with carry=0). The real ROM runs instead — which
 *    matches what would happen on hardware when the block runs short.
 *
 *  - **Long block (block longer than DE)** now DECLINES too. The real
 *    ROM is faithful to the actual tape contents.
 *
 *  - **Flag mismatch** declines without consuming the block. Previous
 *    versions consumed the block even on mismatch; now we leave it
 *    for the real ROM to chew through.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Z80 } from '@/cores/z80.ts';
import { trapTapeLoad } from '@/tape/tape-loader.ts';
import type { DataBlock, TapeBlock } from '@/tape/tap.ts';

// ── Minimal CPU with a 64K byte memory ────────────────────────────────────

class TestCPU extends Z80 {
  mem = new Uint8Array(0x10000);
  read8(addr: number): number { return this.mem[addr & 0xFFFF]; }
  write8(addr: number, val: number): void { this.mem[addr & 0xFFFF] = val & 0xFF; }
}

// ── Tape deck stub ────────────────────────────────────────────────────────

class TapeStub {
  queue: (DataBlock | null)[];
  peeks = 0;
  consumed = 0;
  constructor(queue: (DataBlock | null)[] = []) { this.queue = queue; }
  peekDataBlock(): DataBlock | null {
    this.peeks++;
    return this.queue.length ? this.queue[0] : null;
  }
  nextDataBlock(): DataBlock | null {
    this.consumed++;
    return this.queue.length ? this.queue.shift()! : null;
  }
}

function makeDataBlock(flag: number, data: Uint8Array | number[]): DataBlock {
  return {
    kind: 'data', flag,
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    pause: 0, pilotPulse: 0, syncPulse1: 0, syncPulse2: 0,
    bit0Pulse: 0, bit1Pulse: 0, pilotCount: 0, usedBits: 8,
    source: 'standard',
  };
}

/**
 * Set up CPU state as it would be at PC=0x056C inside LD-BYTES:
 *   - expected flag byte in A' (entry A was saved by EX AF,AF')
 *   - carry in F' (entry carry: 1=LOAD, 0=VERIFY)
 *   - IX = destination, DE = byte count
 *   - Stack: 0x053F on top (the PUSH HL at $0561), caller's return below.
 */
function primeForTrap(cpu: TestCPU, opts: {
  a: number;          // expected flag byte
  carry: boolean;     // true = LOAD, false = VERIFY
  ix: number;
  de: number;
  retAddr?: number;   // caller's return address
  sp?: number;
}): void {
  cpu.sp = opts.sp ?? 0xFF00;
  cpu.push16(opts.retAddr ?? 0x1234);  // caller's return address (pushed by original CALL)
  cpu.push16(0x053F);                  // ROM's PUSH HL at $0561
  cpu.pc = 0x056C;
  // Entry A/F → shadow regs (EX AF,AF' at 0x0557)
  cpu.a_ = opts.a;
  cpu.f_ = opts.carry ? (cpu.f_ | Z80.FLAG_C) : (cpu.f_ & ~Z80.FLAG_C);
  cpu.ix = opts.ix;
  cpu.de = opts.de;
  cpu.iff1 = false;
  cpu.iff2 = false;
}

let cpu: TestCPU;
beforeEach(() => { cpu = new TestCPU(); });

// ── Decline paths: trap returns false and leaves state untouched ───────────

describe('trapTapeLoad — declines without side-effects', () => {
  it('no block available → return false, CPU untouched, block not consumed', () => {
    const tape = new TapeStub([]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 100 });
    cpu.mem[0x8000] = 0xAB;
    const before = { pc: cpu.pc, ix: cpu.ix, de: cpu.de, sp: cpu.sp, iff1: cpu.iff1 };
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(cpu.pc).toBe(before.pc);
    expect(cpu.ix).toBe(before.ix);
    expect(cpu.de).toBe(before.de);
    expect(cpu.sp).toBe(before.sp);
    expect(cpu.iff1).toBe(before.iff1);
    expect(cpu.mem[0x8000]).toBe(0xAB);
    expect(tape.consumed).toBe(0);
  });

  it('flag mismatch → declines without consuming the block', () => {
    const tape = new TapeStub([makeDataBlock(0x00, [1, 2, 3])]);   // header
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 3 }); // expects data
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(cpu.ix).toBe(0x8000);
    expect(cpu.de).toBe(3);
    expect(cpu.pc).toBe(0x056C);
    expect(tape.consumed).toBe(0);
    expect(Array.from(cpu.mem.slice(0x8000, 0x8003))).toEqual([0, 0, 0]);
  });

  it('short block (length < DE) → declines, block left for real ROM', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [1, 2, 3])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 10 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(cpu.de).toBe(10);
    expect(cpu.ix).toBe(0x8000);
    expect(tape.consumed).toBe(0);
    expect(cpu.mem[0x8000]).toBe(0);
  });

  it('long block (length > DE) → declines, block left for real ROM', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [1, 2, 3, 4, 5, 6, 7, 8])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 3 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(cpu.de).toBe(3);
    expect(cpu.ix).toBe(0x8000);
    expect(tape.consumed).toBe(0);
  });

  it('empty block against non-zero DE declines', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 10 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(cpu.ix).toBe(0x8000);
    expect(cpu.de).toBe(10);
    expect(tape.consumed).toBe(0);
  });
});

// ── Success paths ────────────────────────────────────────────────────────

describe('trapTapeLoad — LOAD success', () => {
  it('exact-length block: copies bytes, advances IX, zeroes DE, returns to caller with carry=1', () => {
    const payload = [0x11, 0x22, 0x33, 0x44];
    const tape = new TapeStub([makeDataBlock(0xFF, payload)]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 4, retAddr: 0xBEEF });
    const spBefore = cpu.sp;
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(Array.from(cpu.mem.slice(0x8000, 0x8004))).toEqual(payload);
    expect(cpu.ix).toBe(0x8004);
    expect(cpu.de).toBe(0);
    expect(cpu.pc).toBe(0xBEEF);
    expect(cpu.sp).toBe((spBefore + 4) & 0xFFFF); // popped both 0x053F and caller return
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(true);
    expect(tape.consumed).toBe(1);
  });

  it('header (flag=0x00) round-trips', () => {
    const tape = new TapeStub([makeDataBlock(0x00, [0xAA, 0xBB])]);
    primeForTrap(cpu, { a: 0x00, carry: true, ix: 0x9000, de: 2 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(cpu.mem[0x9000]).toBe(0xAA);
    expect(cpu.mem[0x9001]).toBe(0xBB);
  });

  it('wraps IX from 0xFFFF to 0x0000', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [0xDE, 0xAD])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0xFFFF, de: 2 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(cpu.mem[0xFFFF]).toBe(0xDE);
    expect(cpu.mem[0x0000]).toBe(0xAD);
    expect(cpu.ix).toBe(0x0001);
  });

  it('zero-length block with DE=0 succeeds and writes nothing', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 0 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(cpu.ix).toBe(0x8000);
    expect(cpu.de).toBe(0);
    expect(cpu.mem[0x8000]).toBe(0);
    expect(tape.consumed).toBe(1);
  });

  it('reads expected flag from A_ and carry from F_ (not main regs)', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [0x99])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x4000, de: 1 });
    cpu.a = 0x02;
    cpu.f = 0;     // no main-F carry
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(cpu.mem[0x4000]).toBe(0x99);
  });
});

describe('trapTapeLoad — VERIFY success (carry=0 in F_)', () => {
  it('succeeds without writing to memory', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [0xAA, 0xBB, 0xCC])]);
    primeForTrap(cpu, { a: 0xFF, carry: false, ix: 0x8000, de: 3, retAddr: 0xABCD });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(Array.from(cpu.mem.slice(0x8000, 0x8003))).toEqual([0, 0, 0]);
    expect(cpu.ix).toBe(0x8003);
    expect(cpu.de).toBe(0);
    expect(cpu.pc).toBe(0xABCD);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(true);
  });

  it('verify with no block declines (same as LOAD)', () => {
    const tape = new TapeStub([]);
    primeForTrap(cpu, { a: 0xFF, carry: false, ix: 0, de: 3 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
  });

  it('verify with flag mismatch declines', () => {
    const tape = new TapeStub([makeDataBlock(0x00, [1])]);
    primeForTrap(cpu, { a: 0xFF, carry: false, ix: 0, de: 1 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
  });

  it('verify with length mismatch declines', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [1, 2])]);
    primeForTrap(cpu, { a: 0xFF, carry: false, ix: 0, de: 5 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
  });
});

// ── Stack and IFF behaviour ───────────────────────────────────────────────

describe('trapTapeLoad — stack and IFF behaviour', () => {
  it('pops the 0x053F push and the caller return on success', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [1])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0, de: 1, retAddr: 0x1357, sp: 0xF000 });
    const spBefore = cpu.sp;
    trapTapeLoad(cpu, tape as any);
    expect(cpu.pc).toBe(0x1357);
    expect(cpu.sp).toBe((spBefore + 4) & 0xFFFF);
  });

  it('does NOT touch IFF1/IFF2 on success (caller does its own EI)', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [1])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0, de: 1 });
    cpu.iff1 = false;
    cpu.iff2 = false;
    trapTapeLoad(cpu, tape as any);
    expect(cpu.iff1).toBe(false);
    expect(cpu.iff2).toBe(false);
  });

  it('does NOT touch IFF1/IFF2 on decline', () => {
    const tape = new TapeStub([]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0, de: 0 });
    cpu.iff1 = false;
    cpu.iff2 = false;
    trapTapeLoad(cpu, tape as any);
    expect(cpu.iff1).toBe(false);
    expect(cpu.iff2).toBe(false);
  });

  it('does NOT touch SP on decline', () => {
    const tape = new TapeStub([]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0, de: 100, sp: 0xF000 });
    const spBefore = cpu.sp;
    trapTapeLoad(cpu, tape as any);
    expect(cpu.sp).toBe(spBefore);
  });
});

// ── Multiple sequential calls (caller pattern) ───────────────────────────

describe('trapTapeLoad — sequential loads consume blocks in order', () => {
  it('two LOAD calls drain the queue', () => {
    const tape = new TapeStub([
      makeDataBlock(0xFF, [0xA1, 0xA2]),
      makeDataBlock(0xFF, [0xB1, 0xB2]),
    ]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 2 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(Array.from(cpu.mem.slice(0x8000, 0x8002))).toEqual([0xA1, 0xA2]);

    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x9000, de: 2 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(Array.from(cpu.mem.slice(0x9000, 0x9002))).toEqual([0xB1, 0xB2]);
    expect(tape.consumed).toBe(2);
  });

  it('a declining trap leaves the block for the next call to consume', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [1, 2, 3])]);
    // First call: length mismatch → decline, block stays
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 10 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(tape.consumed).toBe(0);
    // Second call with matching DE: succeeds
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 3 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(tape.consumed).toBe(1);
  });
});

// ── Type narrowing safety ────────────────────────────────────────────────

describe('trapTapeLoad — non-DataBlock inputs', () => {
  it('null peek declines cleanly without throwing', () => {
    const tape = new TapeStub([]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0, de: 0 });
    expect(() => trapTapeLoad(cpu, tape as any)).not.toThrow();
  });
});

const _typeProbe: TapeBlock | null = null;
void _typeProbe;
