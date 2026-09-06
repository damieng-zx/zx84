/**
 * SAM tape-loader.ts — the ROM trap that intercepts the cassette LOAD at
 * PC=$E670 and copies block data straight into memory.
 *
 * The contract under test, and why each part of it is what it is:
 *
 *   - The trap point is one instruction BEFORE the loading loop's
 *     EX AF,AF', so unlike the Spectrum's trap the entry A/F are still in
 *     the MAIN registers: A is the expected flag byte, carry picks LOAD
 *     from VERIFY.
 *   - HL is the destination and DE the count, with C-1 holding the count's
 *     whole 64K units — the ROM's `INC C` at $E66F has already run by the
 *     time the trap sees it. A tape block never carries 64K, so a non-zero
 *     C-1 makes the length check decline and the real ROM loop runs.
 *   - Declines (no block, flag mismatch, short block) leave every CPU and
 *     tape register untouched, so the real edge loop can take over and
 *     custom-speed tapes still load.
 *   - Success lands PC on $E73C — the routine's own bare RET — rather than
 *     popping the stack by hand, so the shared exit at $E611 still runs its
 *     EI. Skipping it would leave interrupts off permanently.
 *   - A load that walks past $BFFF winds the address back to $8000 and bumps
 *     HMPR, which is how the ROM spills a long block into the next page.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Z80 } from '@/cores/z80.ts';
import {
  trapSamTapeLoad, SAM_TAPE_TRAP_PC, type SamTapePaging,
} from '@/machines/sam/tape-loader.ts';
import type { DataBlock } from '@/media/tape/tap.ts';

class TestCPU extends Z80 {
  mem = new Uint8Array(0x10000);
  read8(addr: number): number { return this.mem[addr & 0xFFFF]; }
  write8(addr: number, val: number): void { this.mem[addr & 0xFFFF] = val & 0xFF; }
}

/** Just enough paging for the trap: the HMPR it reads and bumps. */
class PagingStub implements SamTapePaging {
  hmpr = 0;
  bumps = 0;
  setHmpr(val: number): void { this.hmpr = val & 0xFF; this.bumps++; }
}

class TapeStub {
  queue: DataBlock[];
  consumed = 0;
  constructor(queue: DataBlock[] = []) { this.queue = queue; }
  peekDataBlock(): DataBlock | null { return this.queue.length ? this.queue[0] : null; }
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

/** CPU state as the ROM leaves it at $E670. */
function primeForTrap(cpu: TestCPU, opts: {
  a: number;          // expected flag byte
  carry: boolean;     // true = LOAD, false = VERIFY
  hl: number;         // destination
  de: number;         // byte count
  c?: number;         // 64K units + 1 (the ROM's INC C has run)
}): void {
  cpu.sp = 0xFF00;
  cpu.push16(0x1234);          // caller's return address
  cpu.push16(0xE611);          // the CALL at $E60E
  cpu.pc = SAM_TAPE_TRAP_PC;
  cpu.a = opts.a;
  cpu.setFlag(Z80.FLAG_C, opts.carry);
  cpu.hl = opts.hl;
  cpu.de = opts.de;
  cpu.c = opts.c ?? 1;
}

let cpu: TestCPU;
let paging: PagingStub;
beforeEach(() => { cpu = new TestCPU(); paging = new PagingStub(); });

describe('trapSamTapeLoad — declines without side-effects', () => {
  it('declines with no block, leaving the CPU alone', () => {
    const tape = new TapeStub([]);
    primeForTrap(cpu, { a: 0xFF, carry: true, hl: 0x8000, de: 100 });
    cpu.mem[0x8000] = 0xAB;
    expect(trapSamTapeLoad(cpu, paging, tape as never)).toBe(false);
    expect(cpu.pc).toBe(SAM_TAPE_TRAP_PC);
    expect(cpu.hl).toBe(0x8000);
    expect(cpu.de).toBe(100);
    expect(cpu.sp).toBe(0xFF00 - 4);
    expect(cpu.mem[0x8000]).toBe(0xAB);
    expect(tape.consumed).toBe(0);
  });

  it('declines on a flag mismatch without eating the block', () => {
    // $01 is the SAM's header flag, $FF its data flag.
    const tape = new TapeStub([makeDataBlock(0x01, [1, 2, 3])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, hl: 0x8000, de: 3 });
    expect(trapSamTapeLoad(cpu, paging, tape as never)).toBe(false);
    expect(tape.consumed).toBe(0);
    expect(tape.queue.length).toBe(1);
  });

  it('declines a block shorter than the ROM asked for', () => {
    // The real ROM would read past the block and fail, so hand it back.
    const tape = new TapeStub([makeDataBlock(0xFF, [1, 2, 3])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, hl: 0x8000, de: 4 });
    expect(trapSamTapeLoad(cpu, paging, tape as never)).toBe(false);
    expect(tape.consumed).toBe(0);
  });

  it('declines a load of more than 64K, which no tape block holds', () => {
    // C-1 is the count's 64K units; C=2 asks for 64K + DE.
    const tape = new TapeStub([makeDataBlock(0xFF, new Uint8Array(0x2000))]);
    primeForTrap(cpu, { a: 0xFF, carry: true, hl: 0x8000, de: 0, c: 2 });
    expect(trapSamTapeLoad(cpu, paging, tape as never)).toBe(false);
    expect(tape.consumed).toBe(0);
  });
});

describe('trapSamTapeLoad — loads', () => {
  it('copies the payload, advances HL, zeroes DE and returns via $E73C', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [0x11, 0x22, 0x33, 0x44])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, hl: 0x8000, de: 4 });
    expect(trapSamTapeLoad(cpu, paging, tape as never)).toBe(true);
    expect([...cpu.mem.subarray(0x8000, 0x8004)]).toEqual([0x11, 0x22, 0x33, 0x44]);
    expect(cpu.hl).toBe(0x8004);
    expect(cpu.de).toBe(0);
    expect(cpu.pc).toBe(0xE73C);
    expect(cpu.f & Z80.FLAG_C).toBe(Z80.FLAG_C);
    expect(tape.consumed).toBe(1);
  });

  it('leaves the stack alone so the ROM RET reaches the exit at $E611', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [1])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, hl: 0x8000, de: 1 });
    trapSamTapeLoad(cpu, paging, tape as never);
    expect(cpu.sp).toBe(0xFF00 - 4);
    expect(cpu.read8(cpu.sp) | (cpu.read8(cpu.sp + 1) << 8)).toBe(0xE611);
  });

  it('loads a header into the system page without touching HMPR', () => {
    // The 80-byte header goes to $4B50 in section B, well clear of $C000.
    const header = new Uint8Array(80).fill(0x5A);
    const tape = new TapeStub([makeDataBlock(0x01, header)]);
    primeForTrap(cpu, { a: 0x01, carry: true, hl: 0x4B50, de: 80 });
    expect(trapSamTapeLoad(cpu, paging, tape as never)).toBe(true);
    expect(cpu.mem[0x4B50]).toBe(0x5A);
    expect(cpu.mem[0x4B9F]).toBe(0x5A);
    expect(cpu.hl).toBe(0x4BA0);
    expect(paging.bumps).toBe(0);
  });

  it('takes only the first DE bytes of an oversize block', () => {
    // The ROM reads DE bytes and ignores the rest, so an over-long block
    // still loads on hardware; declining it would drop the tape to real time.
    const tape = new TapeStub([makeDataBlock(0xFF, [1, 2, 3, 4, 5, 6])]);
    primeForTrap(cpu, { a: 0xFF, carry: true, hl: 0x8000, de: 3 });
    expect(trapSamTapeLoad(cpu, paging, tape as never)).toBe(true);
    expect([...cpu.mem.subarray(0x8000, 0x8004)]).toEqual([1, 2, 3, 0]);
    expect(tape.consumed).toBe(1);
  });

  it('winds back to $8000 and bumps HMPR when the load reaches $C000', () => {
    const data = new Uint8Array(4).map((_, i) => 0xE0 + i);
    const tape = new TapeStub([makeDataBlock(0xFF, data)]);
    primeForTrap(cpu, { a: 0xFF, carry: true, hl: 0xBFFE, de: 4 });
    paging.hmpr = 0x03;
    expect(trapSamTapeLoad(cpu, paging, tape as never)).toBe(true);
    expect(cpu.mem[0xBFFE]).toBe(0xE0);
    expect(cpu.mem[0xBFFF]).toBe(0xE1);
    // The page changed under the emulated write, so the last two bytes land
    // at the bottom of section C again.
    expect(cpu.mem[0x8000]).toBe(0xE2);
    expect(cpu.mem[0x8001]).toBe(0xE3);
    expect(paging.hmpr).toBe(0x04);
    expect(paging.bumps).toBe(1);
    expect(cpu.hl).toBe(0x8002);
  });
});

describe('trapSamTapeLoad — verify', () => {
  it('writes nothing but still consumes the block and advances HL', () => {
    const tape = new TapeStub([makeDataBlock(0xFF, [9, 9, 9])]);
    primeForTrap(cpu, { a: 0xFF, carry: false, hl: 0x8000, de: 3 });
    cpu.mem.fill(0xCC, 0x8000, 0x8003);
    expect(trapSamTapeLoad(cpu, paging, tape as never)).toBe(true);
    expect([...cpu.mem.subarray(0x8000, 0x8003)]).toEqual([0xCC, 0xCC, 0xCC]);
    expect(cpu.hl).toBe(0x8003);
    expect(tape.consumed).toBe(1);
  });
});
