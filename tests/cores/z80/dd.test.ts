/**
 * IX / DD prefix coverage — the DD-side mirror of index.test.ts.
 *
 * index.test.ts has thorough FD/IY tests; this file provides the same
 * depth for DD/IX. DDCB basics and DD-chain prefixes live in
 * undocumented.test.ts; this file covers the (IX+d) instructions and
 * the DDCB shift/rotate variants that are not yet pinned there.
 *
 * References:
 *  - Zilog Z80 CPU User Manual (DD prefix tables)
 *  - Sean Young, "The Undocumented Z80 Documented" §5
 */

import { describe, it, expect } from 'vitest';
import { newCpu, load, step } from './_harness.ts';
import { F_S, F_Z, F_F5, F_H, F_F3, F_PV, F_N, F_C } from './_harness.ts';

// ─────────────────────────────────────────────────────────────────────────
// DD 16-bit IX loads and exchanges
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — DD prefix: 16-bit IX loads and exchanges', () => {
  it('DD 21 nn nn → LD IX,nn', () => {
    const h = newCpu();
    load(h.mem, 0, 0xDD, 0x21, 0x78, 0x56);
    step(h);
    expect(h.cpu.ix).toBe(0x5678);
  });

  it('DD 22 nn nn → LD (nn),IX stores low then high', () => {
    const h = newCpu();
    h.cpu.ix = 0xBEEF;
    load(h.mem, 0, 0xDD, 0x22, 0x00, 0xC0);
    step(h);
    expect(h.mem[0xC000]).toBe(0xEF);
    expect(h.mem[0xC001]).toBe(0xBE);
  });

  it('DD 2A nn nn → LD IX,(nn)', () => {
    const h = newCpu();
    h.mem[0xC000] = 0x34;
    h.mem[0xC001] = 0x12;
    load(h.mem, 0, 0xDD, 0x2A, 0x00, 0xC0);
    step(h);
    expect(h.cpu.ix).toBe(0x1234);
  });

  it('DD F9 → LD SP,IX', () => {
    const h = newCpu();
    h.cpu.ix = 0x8000;
    load(h.mem, 0, 0xDD, 0xF9);
    step(h);
    expect(h.cpu.sp).toBe(0x8000);
  });

  it('DD 23 → INC IX (16-bit, no flag change); DD 2B → DEC IX', () => {
    const h = newCpu();
    h.cpu.ix = 0xFFFF; h.cpu.f = 0;
    load(h.mem, 0, 0xDD, 0x23, 0xDD, 0x2B);
    step(h, 2);
    expect(h.cpu.ix).toBe(0xFFFF); // 0xFFFF+1=0, then -1=0xFFFF
    expect(h.cpu.f).toBe(0);
  });

  it('DD E5 / DD E1 → PUSH IX / POP IX round-trip', () => {
    const h = newCpu();
    h.cpu.ix = 0xCAFE;
    h.cpu.sp = 0xFF00;
    load(h.mem, 0,
      0xDD, 0xE5,          // PUSH IX
      0x21, 0x00, 0x00,    // LD HL,0 (clobber; IX stays)
      0xDD, 0xE1,          // POP IX
    );
    step(h, 3);
    expect(h.cpu.ix).toBe(0xCAFE);
    expect(h.cpu.sp).toBe(0xFF00);
  });

  it('DD E3 → EX (SP),IX swaps IX with top of stack', () => {
    const h = newCpu();
    h.cpu.ix = 0xAABB;
    h.cpu.sp = 0xFF00;
    h.mem[0xFF00] = 0x78; h.mem[0xFF01] = 0x56;
    load(h.mem, 0, 0xDD, 0xE3);
    step(h);
    expect(h.cpu.ix).toBe(0x5678);
    expect(h.mem[0xFF00]).toBe(0xBB);
    expect(h.mem[0xFF01]).toBe(0xAA);
  });

  it('DD E9 → JP (IX) sets PC = IX without stack op', () => {
    const h = newCpu();
    h.cpu.ix = 0x4000;
    const spBefore = h.cpu.sp;
    load(h.mem, 0, 0xDD, 0xE9);
    step(h);
    expect(h.cpu.pc).toBe(0x4000);
    expect(h.cpu.sp).toBe(spBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (IX+d) memory operations — LD, ALU, INC/DEC
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — DD prefix: (IX+d) memory operations', () => {
  it('LD A,(IX+d) reads with signed negative displacement', () => {
    const h = newCpu();
    h.cpu.ix = 0xC100;
    h.mem[0xC0FE] = 0x77;
    load(h.mem, 0, 0xDD, 0x7E, 0xFE); // LD A,(IX-2)
    step(h);
    expect(h.cpu.a).toBe(0x77);
  });

  it('LD (IX+d),A writes with positive displacement', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.cpu.a = 0x42;
    load(h.mem, 0, 0xDD, 0x77, 0x10); // LD (IX+16),A
    step(h);
    expect(h.mem[0xC010]).toBe(0x42);
  });

  it.each([
    [0x46, 'B'], [0x4E, 'C'], [0x56, 'D'], [0x5E, 'E'],
    [0x66, 'H'], [0x6E, 'L'], [0x7E, 'A'],
  ] as const)('LD r,(IX+0) for op=0x%s (%s)', (op, _name) => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC000] = 0x5A;
    load(h.mem, 0, 0xDD, op, 0x00);
    step(h);
    switch (op) {
      case 0x46: expect(h.cpu.b).toBe(0x5A); break;
      case 0x4E: expect(h.cpu.c).toBe(0x5A); break;
      case 0x56: expect(h.cpu.d).toBe(0x5A); break;
      case 0x5E: expect(h.cpu.e).toBe(0x5A); break;
      case 0x66: expect(h.cpu.h).toBe(0x5A); break;
      case 0x6E: expect(h.cpu.l).toBe(0x5A); break;
      case 0x7E: expect(h.cpu.a).toBe(0x5A); break;
    }
  });

  it.each([
    [0x70, 'B'], [0x71, 'C'], [0x72, 'D'], [0x73, 'E'],
    [0x74, 'H'], [0x75, 'L'], [0x77, 'A'],
  ] as const)('LD (IX+0),r for op=0x%s (%s)', (op, _name) => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.cpu.b = 0x11; h.cpu.c = 0x22; h.cpu.d = 0x33; h.cpu.e = 0x44;
    h.cpu.h = 0x55; h.cpu.l = 0x66; h.cpu.a = 0x77;
    load(h.mem, 0, 0xDD, op, 0x00);
    step(h);
    const expected: Record<string, number> = {
      B: 0x11, C: 0x22, D: 0x33, E: 0x44, H: 0x55, L: 0x66, A: 0x77,
    };
    expect(h.mem[0xC000]).toBe(expected[_name]);
  });

  it('LD (IX+d),n stores immediate byte', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    load(h.mem, 0, 0xDD, 0x36, 0x04, 0x99); // LD (IX+4),0x99
    step(h);
    expect(h.mem[0xC004]).toBe(0x99);
  });

  it('INC (IX+d): 0x7F → 0x80 sets S, PV, H; clears N; preserves C', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC000] = 0x7F;
    h.cpu.f = F_C;
    load(h.mem, 0, 0xDD, 0x34, 0x00); // INC (IX+0)
    step(h);
    expect(h.mem[0xC000]).toBe(0x80);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('DEC (IX+d): 0x01 → 0x00 sets Z and N', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC000] = 0x01;
    load(h.mem, 0, 0xDD, 0x35, 0x00); // DEC (IX+0)
    step(h);
    expect(h.mem[0xC000]).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('INC (IX+d) address wraparound: IX=0xFFFE, d=+3 → addr 0x0001', () => {
    const h = newCpu();
    h.cpu.ix = 0xFFFE;
    h.mem[0x0001] = 0x09;
    load(h.mem, 0x8000, 0xDD, 0x34, 0x03); // INC (IX+3) at 0x8000
    h.cpu.pc = 0x8000;
    step(h);
    expect(h.mem[0x0001]).toBe(0x0A);
  });

  it.each([
    { op: 0x86, name: 'ADD A,(IX+d)', a: 0x10, m: 0x22, result: 0x32 },
    { op: 0x8E, name: 'ADC A,(IX+d) C=1', a: 0x10, m: 0x22, result: 0x33, cIn: true },
    { op: 0x96, name: 'SUB (IX+d)', a: 0x50, m: 0x10, result: 0x40 },
    { op: 0x9E, name: 'SBC A,(IX+d) C=1', a: 0x50, m: 0x10, result: 0x3F, cIn: true },
    { op: 0xA6, name: 'AND (IX+d)', a: 0xF0, m: 0x0F, result: 0x00 },
    { op: 0xAE, name: 'XOR (IX+d)', a: 0xFF, m: 0x0F, result: 0xF0 },
    { op: 0xB6, name: 'OR (IX+d)', a: 0x80, m: 0x01, result: 0x81 },
  ])('$name', ({ op, a, m, result, cIn }) => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.cpu.a = a;
    h.mem[0xC000] = m;
    h.cpu.f = cIn ? F_C : 0;
    load(h.mem, 0, 0xDD, op, 0x00);
    step(h);
    expect(h.cpu.a).toBe(result);
  });

  it('CP (IX+d) leaves A unchanged but updates flags', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.cpu.a = 0x42;
    h.mem[0xC000] = 0x42;
    load(h.mem, 0, 0xDD, 0xBE, 0x00); // CP (IX+0)
    step(h);
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('MEMPTR ← IX+d (observable via subsequent BIT n,(HL))', () => {
    const h = newCpu();
    h.cpu.ix = 0x4810;          // (IX-0x10) = 0x4800 → MEMPTR.H = 0x48 (F3=1, F5=0)
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x01;       // bits 3/5 clear so source is unambiguous
    h.mem[0x4800] = 0x00;
    load(h.mem, 0,
      0xDD, 0x7E, 0xF0,         // LD A,(IX-16) — sets MEMPTR = 0x4800
      0xCB, 0x46,               // BIT 0,(HL) — F3/F5 from MEMPTR.H
    );
    step(h, 2);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ADD IX,rr — IX 16-bit add via the ddfdUsesHL path
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — DD prefix: ADD IX,rr', () => {
  it('DD 09 → ADD IX,BC', () => {
    const h = newCpu();
    h.cpu.ix = 0x1000; h.cpu.bc = 0x0234;
    load(h.mem, 0, 0xDD, 0x09);
    step(h);
    expect(h.cpu.ix).toBe(0x1234);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('DD 29 → ADD IX,IX must double IX, NOT HL', () => {
    const h = newCpu();
    h.cpu.ix = 0x0801; h.cpu.hl = 0xDEAD;
    load(h.mem, 0, 0xDD, 0x29);
    step(h);
    expect(h.cpu.ix).toBe(0x1002);
    expect(h.cpu.hl).toBe(0xDEAD); // HL must be untouched
  });

  it('DD 19 → ADD IX,DE clears N and updates H/C correctly', () => {
    const h = newCpu();
    h.cpu.ix = 0x0FFF; h.cpu.de = 0x0001;
    h.cpu.f = F_N; // N should be cleared by ADD
    load(h.mem, 0, 0xDD, 0x19);
    step(h);
    expect(h.cpu.ix).toBe(0x1000);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_H).toBe(F_H); // half-carry from bit 11
  });

  it('DD 39 → ADD IX,SP sets C on carry out of bit 15', () => {
    const h = newCpu();
    h.cpu.ix = 0x8000; h.cpu.sp = 0x8000;
    load(h.mem, 0, 0xDD, 0x39);
    step(h);
    expect(h.cpu.ix).toBe(0x0000);
    expect(h.cpu.f & F_C).toBe(F_C);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DDCB — remaining shift/rotate variants with register-store side effect
// (RLC/SLL/RES/SET are covered in undocumented.test.ts; this adds RRC, RL,
//  RR, SRA, SRL and all-register coverage for the full z=0..5,7 range)
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — DDCB rotate/shift with simultaneous register store', () => {
  it.each([
    { op: 0x00, name: 'RLC (IX+d),B', val: 0x81, out: 0x03, reg: 'b' },
    { op: 0x01, name: 'RLC (IX+d),C', val: 0x40, out: 0x80, reg: 'c' },
    { op: 0x02, name: 'RLC (IX+d),D', val: 0x01, out: 0x02, reg: 'd' },
    { op: 0x03, name: 'RLC (IX+d),E', val: 0xFF, out: 0xFF, reg: 'e' },
    { op: 0x04, name: 'RLC (IX+d),H', val: 0x55, out: 0xAA, reg: 'h' },
    { op: 0x05, name: 'RLC (IX+d),L', val: 0x80, out: 0x01, reg: 'l' },
    { op: 0x07, name: 'RLC (IX+d),A', val: 0x40, out: 0x80, reg: 'a' },
  ] as const)('$name copies result to register and memory', ({ op, val, out, reg }) => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC003] = val;
    load(h.mem, 0, 0xDD, 0xCB, 0x03, op);
    step(h);
    expect(h.mem[0xC003]).toBe(out);
    expect((h.cpu as unknown as Record<string, number>)[reg]).toBe(out);
  });

  it.each([
    { op: 0x08, name: 'RRC (IX+d),B', val: 0x01, out: 0x80, cIn: false },
    { op: 0x10, name: 'RL  (IX+d),B (C=1)', val: 0x80, out: 0x01, cIn: true },
    { op: 0x18, name: 'RR  (IX+d),B (C=1)', val: 0x01, out: 0x80, cIn: true },
    { op: 0x20, name: 'SLA (IX+d),B', val: 0x40, out: 0x80, cIn: false },
    { op: 0x28, name: 'SRA (IX+d),B', val: 0x80, out: 0xC0, cIn: false },
    { op: 0x38, name: 'SRL (IX+d),B', val: 0x80, out: 0x40, cIn: false },
  ])('$name (z=0 → copies to B)', ({ op, val, out, cIn }) => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.cpu.b = 0xAA; // pre-set to verify it changes
    h.cpu.f = cIn ? F_C : 0;
    h.mem[0xC000] = val;
    load(h.mem, 0, 0xDD, 0xCB, 0x00, op);
    step(h);
    expect(h.mem[0xC000]).toBe(out);
    expect(h.cpu.b).toBe(out);
  });

  it('DDCB d FF → SET 7,(IX+d),A copies result to A', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC000] = 0x01;
    load(h.mem, 0, 0xDD, 0xCB, 0x00, 0xFF); // SET 7,(IX+0),A
    step(h);
    expect(h.mem[0xC000]).toBe(0x81);
    expect(h.cpu.a).toBe(0x81);
  });

  it('DDCB d 87 → RES 0,(IX+d),A copies result to A', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC000] = 0xFF;
    load(h.mem, 0, 0xDD, 0xCB, 0x00, 0x87); // RES 0,(IX+0),A
    step(h);
    expect(h.mem[0xC000]).toBe(0xFE);
    expect(h.cpu.a).toBe(0xFE);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DDCB BIT — S, Z, PV flags + MEMPTR-derived F3/F5
// (basic MEMPTR/F3/F5 is in undocumented.test.ts; this pins S, Z, PV)
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — DDCB BIT n,(IX+d) flag behaviour', () => {
  it('BIT 7,(IX+d) sets S when bit 7 of the target byte is set', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC000] = 0x80;
    load(h.mem, 0, 0xDD, 0xCB, 0x00, 0x7E); // BIT 7,(IX+0)
    step(h);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_Z).toBe(0);
  });

  it('BIT 0,(IX+d) sets Z when target bit is clear; PV mirrors Z', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC000] = 0x00;
    load(h.mem, 0, 0xDD, 0xCB, 0x00, 0x46); // BIT 0,(IX+0)
    step(h);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('BIT n,(IX+d): F3/F5 reflect MEMPTR high byte (both set for 0x28xx)', () => {
    const h = newCpu();
    h.cpu.ix = 0x2820; // (IX+5) = 0x2825, high byte 0x28 → F3 and F5 set
    h.mem[0x2825] = 0x01;
    load(h.mem, 0, 0xDD, 0xCB, 0x05, 0x46); // BIT 0,(IX+5)
    step(h);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });
});
