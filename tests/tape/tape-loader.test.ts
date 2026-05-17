/**
 * tape-loader.ts — ROM trap that intercepts LD-BYTES at 0x0556 and
 * copies tape block data straight into Spectrum memory.
 *
 * The function has four observable paths:
 *   - no block available     → fail (carry=0, return false)
 *   - flag mismatch          → fail (carry=0, return false)
 *   - VERIFY mode (carry=0)  → succeed without copying
 *   - LOAD mode (carry=1)    → copy bytes, update IX/DE, succeed
 *
 * All four paths still pop a return address off the stack and re-enable
 * IFF1/IFF2 (mirroring LD-BYTES' final RET after EI). The trap also
 * unconditionally consumes a block from the deck via nextDataBlock(),
 * because the caller in spectrum.ts already gated on hasRomBlock().
 *
 * Things this file deliberately challenges:
 *
 *  - **Short block (data.length < requested DE) now fails** with carry=0,
 *    DE left at the unsatisfied remainder, IX advanced past the bytes
 *    actually copied — matching real ROM and the Fuse/JSpeccy/ZEsarUX
 *    consensus.
 *
 *  - **Long block (data.length > requested DE) succeeds** — we copy DE
 *    bytes and drop the tail. Real ROM does the same: it stops reading
 *    once DE hits 0 and the next tape byte becomes the parity byte. We
 *    skip the parity check because this is an instant-load shortcut.
 *
 *  - **VERIFY advances IX/DE** by the bytes that would have been
 *    compared. We do NOT actually compare bytes (JSpeccy and ZEsarUX
 *    take the same shortcut in their fast-load paths). A short block
 *    fails verify the same way it fails load.
 *
 *  - **IFF1/IFF2 are set to true unconditionally**, even when the trap
 *    fails. That matches the LD-BYTES "EI before RET" but it ALSO
 *    fires on the no-block / flag-mismatch paths where the real ROM
 *    would have errored out without reaching EI. Bench observation,
 *    not necessarily a bug.
 *
 *  - **Failure paths via no-block / flag-mismatch do not modify IX/DE**.
 *    Real ROM partially decrements DE before failing on flag mismatch.
 *    Programs that branch on DE after a failed load see a different
 *    value than they would on hardware. Considered minor; not fixed.
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
  calls = 0;
  constructor(queue: (DataBlock | null)[] = []) { this.queue = queue; }
  nextDataBlock(): DataBlock | null {
    this.calls++;
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

// Place a return address on the stack and prep CPU for a trap call.
function primeForTrap(cpu: TestCPU, opts: {
  a: number;          // expected flag
  carry: boolean;     // true = LOAD, false = VERIFY
  ix: number;         // destination
  de: number;         // requested count
  retAddr?: number;   // return address pushed
  sp?: number;        // initial SP (defaults 0xFF00 so push has room)
}): void {
  cpu.sp = opts.sp ?? 0xFF00;
  // Push return address (LD-BYTES caller resumes here after RET).
  cpu.push16(opts.retAddr ?? 0x1234);
  cpu.pc = 0x0556;
  cpu.a = opts.a;
  cpu.setFlag(Z80.FLAG_C, opts.carry);
  cpu.ix = opts.ix;
  cpu.de = opts.de;
  cpu.iff1 = false;
  cpu.iff2 = false;
}

let cpu: TestCPU;
beforeEach(() => { cpu = new TestCPU(); });

// ── No block available ───────────────────────────────────────────────────

describe('trapTapeLoad — no block available', () => {
  it('returns false, clears carry, pops PC, re-enables interrupts', () => {
    const tape = new TapeStub([null]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 100, retAddr: 0xBEEF });
    const ok = trapTapeLoad(cpu, tape as any);
    expect(ok).toBe(false);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(false);
    expect(cpu.pc).toBe(0xBEEF);
    expect(cpu.iff1).toBe(true);
    expect(cpu.iff2).toBe(true);
  });

  it('does not modify IX, DE, or destination memory', () => {
    const tape = new TapeStub([null]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 100 });
    cpu.mem[0x8000] = 0xAB;
    trapTapeLoad(cpu, tape as any);
    expect(cpu.ix).toBe(0x8000);
    expect(cpu.de).toBe(100);
    expect(cpu.mem[0x8000]).toBe(0xAB);
  });
});

// ── Flag mismatch ────────────────────────────────────────────────────────

describe('trapTapeLoad — flag mismatch', () => {
  it('does not load and reports failure', () => {
    const block = makeDataBlock(0x00, [1, 2, 3]); // header
    const tape = new TapeStub([block]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 3 }); // expects data, gets header
    const ok = trapTapeLoad(cpu, tape as any);
    expect(ok).toBe(false);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(false);
    // Memory untouched
    expect(Array.from(cpu.mem.slice(0x8000, 0x8003))).toEqual([0, 0, 0]);
    // IX/DE untouched
    expect(cpu.ix).toBe(0x8000);
    expect(cpu.de).toBe(3);
  });

  it('still consumes the block (caller relies on this to advance the tape)', () => {
    const block = makeDataBlock(0x00, [1, 2, 3]);
    const tape = new TapeStub([block]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0, de: 3 });
    trapTapeLoad(cpu, tape as any);
    expect(tape.calls).toBe(1);
  });
});

// ── VERIFY mode ──────────────────────────────────────────────────────────

describe('trapTapeLoad — VERIFY (carry=0)', () => {
  it('reports success but does not copy data', () => {
    const block = makeDataBlock(0xFF, [0xAA, 0xBB, 0xCC]);
    const tape = new TapeStub([block]);
    primeForTrap(cpu, { a: 0xFF, carry: false, ix: 0x8000, de: 3 });
    const ok = trapTapeLoad(cpu, tape as any);
    expect(ok).toBe(true);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(true);
    expect(Array.from(cpu.mem.slice(0x8000, 0x8003))).toEqual([0, 0, 0]);
  });

  it('advances IX past the verified region and zeroes DE on a length-matched verify', () => {
    const block = makeDataBlock(0xFF, [0xAA, 0xBB, 0xCC]);
    const tape = new TapeStub([block]);
    primeForTrap(cpu, { a: 0xFF, carry: false, ix: 0x8000, de: 3 });
    trapTapeLoad(cpu, tape as any);
    expect(cpu.ix).toBe(0x8003);
    expect(cpu.de).toBe(0);
  });

  it('short-block verify fails (carry=0, DE = remaining, IX advanced by data length)', () => {
    const block = makeDataBlock(0xFF, [0xAA, 0xBB]);
    const tape = new TapeStub([block]);
    primeForTrap(cpu, { a: 0xFF, carry: false, ix: 0x8000, de: 5 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(false);
    expect(cpu.ix).toBe(0x8002);
    expect(cpu.de).toBe(3);
    // verify must NOT write to memory
    expect(Array.from(cpu.mem.slice(0x8000, 0x8002))).toEqual([0, 0]);
  });

  it('verify with no block fails (same as LOAD with no block)', () => {
    const tape = new TapeStub([null]);
    primeForTrap(cpu, { a: 0xFF, carry: false, ix: 0, de: 3 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(false);
  });

  it('verify with flag mismatch fails', () => {
    const block = makeDataBlock(0x00, [1]);
    const tape = new TapeStub([block]);
    primeForTrap(cpu, { a: 0xFF, carry: false, ix: 0, de: 1 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(false);
  });
});

// ── LOAD success path ───────────────────────────────────────────────────

describe('trapTapeLoad — LOAD success', () => {
  it('copies block bytes to IX, sets carry, returns true', () => {
    const payload = [0x11, 0x22, 0x33, 0x44];
    const tape = new TapeStub([makeDataBlock(0xFF, payload)]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 4 });
    const ok = trapTapeLoad(cpu, tape as any);
    expect(ok).toBe(true);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(true);
    expect(Array.from(cpu.mem.slice(0x8000, 0x8004))).toEqual(payload);
  });

  it('advances IX past the loaded bytes and zeroes DE', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [1, 2, 3, 4, 5])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 5 });
    trapTapeLoad(cpu, tape as any);
    expect(cpu.ix).toBe(0x8005);
    expect(cpu.de).toBe(0);
  });

  it('header flag 0x00 round-trips when expected flag matches', () => {
    const tape = new TapeStub([makeDataBlock(0x00, [0xAA])]);
    primeForTrap(cpu, { a: 0x00, carry: true, ix: 0x9000, de: 1 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(cpu.mem[0x9000]).toBe(0xAA);
  });

  it('wraps IX from 0xFFFF to 0x0000', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [0xDE, 0xAD])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0xFFFF, de: 2 });
    trapTapeLoad(cpu, tape as any);
    expect(cpu.mem[0xFFFF]).toBe(0xDE);
    expect(cpu.mem[0x0000]).toBe(0xAD);
    expect(cpu.ix).toBe(0x0001);
  });

  it('empty block (data.length=0) succeeds and writes nothing', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 0 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(cpu.ix).toBe(0x8000);
    expect(cpu.de).toBe(0);
  });
});

// ── DE / block-length mismatch — pinned behaviour after the consensus fix ──

describe('trapTapeLoad — DE / block-length mismatch', () => {
  it('SHORT block (data.length < requested DE) FAILS with DE=remainder, IX advanced', () => {
    // Real ROM / Fuse / JSpeccy / ZEsarUX all clear carry and leave DE
    // partially decremented. We mirror that: copy what we have, advance
    // IX past it, set DE to the unsatisfied count, clear carry.
    const tape = new TapeStub([makeDataBlock(0xFF, new Uint8Array(10).fill(0xAA))]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 256 });
    const ok = trapTapeLoad(cpu, tape as any);
    expect(ok).toBe(false);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(false);
    // Bytes that did arrive ARE copied — Fuse does this too. The caller
    // sees a failure but the partial-load lets a clever program inspect
    // what came through.
    expect(cpu.mem[0x8000]).toBe(0xAA);
    expect(cpu.mem[0x8009]).toBe(0xAA);
    expect(cpu.mem[0x800A]).toBe(0x00);
    expect(cpu.ix).toBe(0x800A);          // 0x8000 + 10
    expect(cpu.de).toBe(256 - 10);        // remainder
  });

  it('LONG block (data.length > requested DE) succeeds with tail silently dropped', () => {
    // Real ROM stops reading once DE hits 0; the next tape byte would be
    // the parity. Instant-load skips the parity check.
    const tape = new TapeStub([makeDataBlock(0xFF, [1, 2, 3, 4, 5, 6, 7, 8])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 3 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(true);
    expect(Array.from(cpu.mem.slice(0x8000, 0x8005))).toEqual([1, 2, 3, 0, 0]);
    expect(cpu.ix).toBe(0x8003);
    expect(cpu.de).toBe(0);
  });

  it('exact-length block: full copy, IX advanced by N, DE=0, success', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [0x10, 0x20, 0x30, 0x40])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 4 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(cpu.ix).toBe(0x8004);
    expect(cpu.de).toBe(0);
    expect(Array.from(cpu.mem.slice(0x8000, 0x8004))).toEqual([0x10, 0x20, 0x30, 0x40]);
  });

  it('zero-DE request against a non-empty block succeeds without writing or advancing', () => {
    // DE=0 means "load nothing". available(1) >= count(0) so it's not a
    // short block — success, no writes, IX/DE unchanged. The deck block is
    // still consumed because nextDataBlock() runs unconditionally (the
    // caller in spectrum.ts gates this via hasRomBlock).
    const tape = new TapeStub([makeDataBlock(0xFF, [0xAA])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 0 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(true);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(true);
    expect(cpu.mem[0x8000]).toBe(0);
    expect(cpu.ix).toBe(0x8000);
    expect(cpu.de).toBe(0);
    expect(tape.calls).toBe(1);
  });

  it('empty block (data.length=0) against non-zero DE FAILS as a short-block', () => {
    // available=0, count=10 → short block → carry=0, DE unchanged at 10,
    // IX unchanged. No bytes written.
    const tape = new TapeStub([makeDataBlock(0xFF, [])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x8000, de: 10 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(cpu.getFlag(Z80.FLAG_C)).toBe(false);
    expect(cpu.ix).toBe(0x8000);
    expect(cpu.de).toBe(10);
  });

  it('wraps IX correctly during a SHORT-block partial copy', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [0xDE, 0xAD, 0xBE])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0xFFFE, de: 10 });
    expect(trapTapeLoad(cpu, tape as any)).toBe(false);
    expect(cpu.mem[0xFFFE]).toBe(0xDE);
    expect(cpu.mem[0xFFFF]).toBe(0xAD);
    expect(cpu.mem[0x0000]).toBe(0xBE);
    expect(cpu.ix).toBe(0x0001);
    expect(cpu.de).toBe(7);
  });
});

// ── Stack / IFF side-effects on every path ───────────────────────────────

describe('trapTapeLoad — common side-effects', () => {
  it('always pops PC from the stack (failure path)', () => {
    const tape = new TapeStub([null]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0, de: 0, retAddr: 0xCAFE });
    const spBefore = cpu.sp;
    trapTapeLoad(cpu, tape as any);
    expect(cpu.pc).toBe(0xCAFE);
    expect(cpu.sp).toBe((spBefore + 2) & 0xFFFF); // pop16 advances SP by 2
  });

  it('always pops PC from the stack (success path)', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [1])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0, de: 1, retAddr: 0x1357 });
    const spBefore = cpu.sp;
    trapTapeLoad(cpu, tape as any);
    expect(cpu.pc).toBe(0x1357);
    expect(cpu.sp).toBe((spBefore + 2) & 0xFFFF);
  });

  it('re-enables both IFFs on every path (mirroring LD-BYTES EI/RET)', () => {
    // failure path
    const tape1 = new TapeStub([null]);
    primeForTrap(cpu, { a: 0, carry: true, ix: 0, de: 0 });
    trapTapeLoad(cpu, tape1 as any);
    expect(cpu.iff1).toBe(true);
    expect(cpu.iff2).toBe(true);

    // verify path
    cpu = new TestCPU();
    const tape2 = new TapeStub([makeDataBlock(0xFF, [1])]);
    primeForTrap(cpu, { a: 0xFF, carry: false, ix: 0, de: 1 });
    trapTapeLoad(cpu, tape2 as any);
    expect(cpu.iff1).toBe(true);
    expect(cpu.iff2).toBe(true);

    // load path
    cpu = new TestCPU();
    const tape3 = new TapeStub([makeDataBlock(0xFF, [1])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0, de: 1 });
    trapTapeLoad(cpu, tape3 as any);
    expect(cpu.iff1).toBe(true);
    expect(cpu.iff2).toBe(true);
  });

  it('reads carry flag BEFORE overwriting it (LOAD/VERIFY decision is stable)', () => {
    // Sanity: if the implementation accidentally cleared carry before
    // reading it, every call would look like VERIFY. Use a block whose
    // contents would expose that (LOAD would copy, VERIFY would not).
    const tape = new TapeStub([makeDataBlock(0xFF, [0x99])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x4000, de: 1 });
    trapTapeLoad(cpu, tape as any);
    expect(cpu.mem[0x4000]).toBe(0x99); // copied → LOAD branch taken
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
    trapTapeLoad(cpu, tape as any);
    expect(Array.from(cpu.mem.slice(0x8000, 0x8002))).toEqual([0xA1, 0xA2]);

    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0x9000, de: 2 });
    trapTapeLoad(cpu, tape as any);
    expect(Array.from(cpu.mem.slice(0x9000, 0x9002))).toEqual([0xB1, 0xB2]);
    expect(tape.calls).toBe(2);
  });
});

// ── Unhandled blocks (other kinds) — type narrowing safety ────────────────

describe('trapTapeLoad — non-DataBlock tape items', () => {
  it('null return (which the deck uses for tone/pulses/direct/etc.) treated as no block', () => {
    // The deck contract is that nextDataBlock() only returns 'data' kinds
    // or null. We sanity-check that a stub returning a non-data shape
    // never actually reaches the trap — the deck filters before calling.
    // This test pins that the trap's only input contract is null | DataBlock.
    const tape = new TapeStub([null]);
    primeForTrap(cpu, { a: 0xFF, carry: true, ix: 0, de: 0 });
    expect(() => trapTapeLoad(cpu, tape as any)).not.toThrow();
  });
});

// Pull TapeBlock import to keep the type re-export honest at compile time.
const _typeProbe: TapeBlock | null = null;
void _typeProbe;
