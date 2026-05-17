/**
 * RRD / RLD — Z80 BCD digit rotate through accumulator and (HL).
 *
 * References:
 *  - Zilog Z80 CPU User Manual, §RRD/RLD
 *  - Sean Young, "The Undocumented Z80 Documented" §5 (flag tables)
 *  - Patrik Rak, MEMPTR rules — RRD/RLD: MEMPTR = HL + 1
 *
 * Layout (using nibbles, H/L for high/low):
 *
 *   RRD:  A.L  <─  (HL).L
 *         (HL).L  <─  (HL).H
 *         (HL).H  <─  A.L (old)
 *   RLD:  A.L  <─  (HL).H
 *         (HL).H  <─  (HL).L
 *         (HL).L  <─  A.L (old)
 *
 * Flags: S, Z, F5, F3, P/V from new A; H = 0; N = 0; C preserved.
 */

import { describe, it, expect } from 'vitest';
import { Z80 } from '@/cores/z80.ts';

const F_S  = 0x80;
const F_Z  = 0x40;
const F_F5 = 0x20;
const F_H  = 0x10;
const F_F3 = 0x08;
const F_PV = 0x04;
const F_N  = 0x02;
const F_C  = 0x01;

interface Harness {
  cpu: Z80;
  mem: Uint8Array;
}

function newCpu(): Harness {
  const cpu = new Z80();
  const mem = new Uint8Array(0x10000);
  cpu.read8 = (a) => mem[a & 0xFFFF];
  cpu.write8 = (a, v) => { mem[a & 0xFFFF] = v & 0xFF; };
  cpu.portInHandler = () => 0xFF;
  cpu.portOutHandler = () => {};
  cpu.pc = 0;
  cpu.sp = 0xFFFF;
  return { cpu, mem };
}

function load(mem: Uint8Array, addr: number, ...bytes: number[]): void {
  for (let i = 0; i < bytes.length; i++) mem[(addr + i) & 0xFFFF] = bytes[i] & 0xFF;
}

describe('Z80 — RRD (ED 67)', () => {
  it('rotates the three nibbles right: A.L ← (HL).L, (HL).L ← (HL).H, (HL).H ← old A.L', () => {
    const h = newCpu();
    h.cpu.a = 0x84;             // high=8, low=4 (only low matters for rotate)
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x20;       // high=2, low=0
    load(h.mem, 0, 0xED, 0x67); // RRD
    h.cpu.step();
    // A.L ← (HL).L = 0  → A = 0x80
    expect(h.cpu.a).toBe(0x80);
    // (HL).H ← old A.L = 4 ; (HL).L ← old (HL).H = 2 → 0x42
    expect(h.mem[0xC000]).toBe(0x42);
  });

  it('preserves A high nibble', () => {
    const h = newCpu();
    h.cpu.a = 0xF1;
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x73;
    load(h.mem, 0, 0xED, 0x67);
    h.cpu.step();
    expect(h.cpu.a & 0xF0).toBe(0xF0); // high nibble preserved
    expect(h.cpu.a & 0x0F).toBe(0x03); // new low = old (HL).low
    expect(h.mem[0xC000]).toBe(0x17);  // high = old A.low = 1; low = old (HL).high = 7
  });

  it('sets Z when result A == 0; clears S and PV (PV = parity even)', () => {
    const h = newCpu();
    h.cpu.a = 0x00;
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x00;
    h.cpu.f = F_C;              // C should survive
    load(h.mem, 0, 0xED, 0x67);
    h.cpu.step();
    expect(h.cpu.a).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_S).toBe(0);
    expect(h.cpu.f & F_PV).toBe(F_PV); // 0 has even parity
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_C).toBe(F_C);   // preserved
  });

  it('sets S when bit 7 of result A is set; clears Z', () => {
    const h = newCpu();
    h.cpu.a = 0x80;             // high=8, low=0
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x05;       // high=0, low=5
    h.cpu.f = 0;
    load(h.mem, 0, 0xED, 0x67);
    h.cpu.step();
    expect(h.cpu.a).toBe(0x85); // 0x80 | 5
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_Z).toBe(0);
  });

  it('clears C when C was already clear, and never sets it', () => {
    const h = newCpu();
    h.cpu.a = 0x10; h.cpu.hl = 0xC000; h.mem[0xC000] = 0xFF;
    h.cpu.f = 0;
    load(h.mem, 0, 0xED, 0x67);
    h.cpu.step();
    expect(h.cpu.f & F_C).toBe(0);
  });

  it('PV reflects parity of A (odd parity → PV clear)', () => {
    const h = newCpu();
    // After RRD with A=0x00, (HL)=0x03 → A = 0x03 (two bits set, even parity → PV set).
    // Pick an odd-parity result instead: A=0x00, (HL)=0x01 → A=0x01 (one bit, odd → PV clear).
    h.cpu.a = 0x00; h.cpu.hl = 0xC000; h.mem[0xC000] = 0x01;
    load(h.mem, 0, 0xED, 0x67);
    h.cpu.step();
    expect(h.cpu.a).toBe(0x01);
    expect(h.cpu.f & F_PV).toBe(0);
  });

  it('MEMPTR ← HL+1 (observable via BIT n,(HL) leaking MEMPTR.H into F3/F5)', () => {
    const h = newCpu();
    h.cpu.hl = 0x47FF;          // after +1 → 0x4800 → MEMPTR.H = 0x48 (bit 3 set, bit 5 clear)
    h.mem[0x47FF] = 0x10;
    load(h.mem, 0,
      0xED, 0x67,               // RRD — leaves MEMPTR = 0x4800
      0xCB, 0x46,               // BIT 0,(HL)
    );
    h.cpu.step();               // RRD
    h.cpu.step();               // BIT 0,(HL)
    // MEMPTR.H = 0x48 → F3 set, F5 clear
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(0);
  });

  it('F3 / F5 reflect bits 3 and 5 of new A (not of (HL))', () => {
    const h = newCpu();
    // Pick A.H = 0x20 (F5 of A set, F3 of A clear), and (HL).L = 0x08 (F3 of result set).
    h.cpu.a = 0x20; h.cpu.hl = 0xC000; h.mem[0xC000] = 0x08;
    load(h.mem, 0, 0xED, 0x67);
    h.cpu.step();
    expect(h.cpu.a).toBe(0x28);
    expect(h.cpu.f & F_F5).toBe(F_F5);
    expect(h.cpu.f & F_F3).toBe(F_F3);
  });
});

describe('Z80 — RLD (ED 6F)', () => {
  it('rotates the three nibbles left: A.L ← (HL).H, (HL).H ← (HL).L, (HL).L ← old A.L', () => {
    const h = newCpu();
    h.cpu.a = 0x84;             // high=8, low=4
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x27;       // high=2, low=7
    load(h.mem, 0, 0xED, 0x6F);
    h.cpu.step();
    // A.L ← (HL).H = 2 → A = 0x82
    expect(h.cpu.a).toBe(0x82);
    // (HL).H ← old (HL).L = 7 ; (HL).L ← old A.L = 4 → 0x74
    expect(h.mem[0xC000]).toBe(0x74);
  });

  it('preserves A high nibble', () => {
    const h = newCpu();
    h.cpu.a = 0xF1; h.cpu.hl = 0xC000; h.mem[0xC000] = 0x73;
    load(h.mem, 0, 0xED, 0x6F);
    h.cpu.step();
    expect(h.cpu.a & 0xF0).toBe(0xF0);
    expect(h.cpu.a & 0x0F).toBe(0x07); // new low = old (HL).high = 7
    expect(h.mem[0xC000]).toBe(0x31);  // high = old (HL).low = 3 ; low = old A.low = 1
  });

  it('preserves C; clears H and N; sets Z when A==0', () => {
    const h = newCpu();
    h.cpu.a = 0x00; h.cpu.hl = 0xC000; h.mem[0xC000] = 0x00;
    h.cpu.f = F_C | F_H | F_N;
    load(h.mem, 0, 0xED, 0x6F);
    h.cpu.step();
    expect(h.cpu.a).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('sets S when bit 7 of new A is set', () => {
    const h = newCpu();
    h.cpu.a = 0x80; h.cpu.hl = 0xC000; h.mem[0xC000] = 0x90;
    load(h.mem, 0, 0xED, 0x6F);
    h.cpu.step();
    // A.L ← (HL).H = 9 → A = 0x89
    expect(h.cpu.a).toBe(0x89);
    expect(h.cpu.f & F_S).toBe(F_S);
  });

  it('MEMPTR ← HL+1 (observable via BIT n,(HL))', () => {
    const h = newCpu();
    h.cpu.hl = 0x47FF;          // +1 → 0x4800 → MEMPTR.H = 0x48 (bit 3 set, bit 5 clear)
    h.mem[0x47FF] = 0x10;
    h.cpu.a = 0x00;
    load(h.mem, 0,
      0xED, 0x6F,               // RLD
      0xCB, 0x46,               // BIT 0,(HL)
    );
    h.cpu.step();
    h.cpu.step();
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(0);
  });

  it('round-trip: RRD then RLD restores both A and (HL) (sanity check on nibble routing)', () => {
    const h = newCpu();
    h.cpu.a = 0x9C; h.cpu.hl = 0xC000; h.mem[0xC000] = 0x37;
    const aOrig = h.cpu.a, mOrig = h.mem[0xC000];
    load(h.mem, 0,
      0xED, 0x67,               // RRD
      0xED, 0x6F,               // RLD
    );
    h.cpu.step();
    h.cpu.step();
    expect(h.cpu.a).toBe(aOrig);
    expect(h.mem[0xC000]).toBe(mOrig);
  });
});
