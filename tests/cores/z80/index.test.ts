/**
 * IY / FD prefix and FDCB coverage.
 *
 * Mirrors the existing IX tests — coverage for the FD half of the prefix
 * dispatcher was previously missing, even though most encodings are
 * symmetric to DD. These tests pin both the well-trodden documented forms
 * and the undocumented IYH/IYL halves + FDCB register-store side effects.
 *
 * References:
 *  - Zilog Z80 CPU User Manual (DD/FD prefix tables)
 *  - Sean Young, "The Undocumented Z80 Documented" §5
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
  ports: Map<number, number>;
}

function newCpu(): Harness {
  const cpu = new Z80();
  const mem = new Uint8Array(0x10000);
  const ports = new Map<number, number>();
  cpu.read8 = (a) => mem[a & 0xFFFF];
  cpu.write8 = (a, v) => { mem[a & 0xFFFF] = v & 0xFF; };
  cpu.portInHandler = (p) => ports.get(p & 0xFFFF) ?? 0xFF;
  cpu.portOutHandler = (p, v) => { ports.set(p & 0xFFFF, v & 0xFF); };
  cpu.pc = 0;
  cpu.sp = 0xFFFF;
  return { cpu, mem, ports };
}

function load(mem: Uint8Array, addr: number, ...bytes: number[]): void {
  for (let i = 0; i < bytes.length; i++) mem[(addr + i) & 0xFFFF] = bytes[i] & 0xFF;
}

function step(h: Harness, n = 1): void { for (let i = 0; i < n; i++) h.cpu.step(); }

// ─────────────────────────────────────────────────────────────────────────
// LD IY,nn / LD (nn),IY / LD IY,(nn) / LD SP,IY
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — FD prefix: 16-bit IY loads and exchanges', () => {
  it('FD 21 nn nn → LD IY,nn', () => {
    const h = newCpu();
    load(h.mem, 0, 0xFD, 0x21, 0x34, 0x12);
    step(h);
    expect(h.cpu.iy).toBe(0x1234);
  });

  it('FD 22 nn nn → LD (nn),IY (stores low then high)', () => {
    const h = newCpu();
    h.cpu.iy = 0xBEEF;
    load(h.mem, 0, 0xFD, 0x22, 0x00, 0xC0);
    step(h);
    expect(h.mem[0xC000]).toBe(0xEF);
    expect(h.mem[0xC001]).toBe(0xBE);
  });

  it('FD 2A nn nn → LD IY,(nn)', () => {
    const h = newCpu();
    h.mem[0xC000] = 0x78;
    h.mem[0xC001] = 0x56;
    load(h.mem, 0, 0xFD, 0x2A, 0x00, 0xC0);
    step(h);
    expect(h.cpu.iy).toBe(0x5678);
  });

  it('FD F9 → LD SP,IY', () => {
    const h = newCpu();
    h.cpu.iy = 0x9000;
    load(h.mem, 0, 0xFD, 0xF9);
    step(h);
    expect(h.cpu.sp).toBe(0x9000);
  });

  it('FD 23 → INC IY; FD 2B → DEC IY (16-bit, no flag changes)', () => {
    const h = newCpu();
    h.cpu.iy = 0xFFFF; h.cpu.f = 0;
    load(h.mem, 0, 0xFD, 0x23, 0xFD, 0x2B);
    step(h, 2);
    expect(h.cpu.iy).toBe(0xFFFF);  // 0xFFFF+1 = 0, then -1 = 0xFFFF
    expect(h.cpu.f).toBe(0);
  });

  it('FD E5 / FD E1 → PUSH IY / POP IY round-trip', () => {
    const h = newCpu();
    h.cpu.iy = 0xCAFE;
    h.cpu.sp = 0xFF00;
    load(h.mem, 0,
      0xFD, 0xE5,   // PUSH IY
      0x21, 0x00, 0x00, // LD HL,0 (clobber; IY stays)
      0xFD, 0xE1,   // POP IY
    );
    step(h, 3);
    expect(h.cpu.iy).toBe(0xCAFE);
    expect(h.cpu.sp).toBe(0xFF00);
  });

  it('FD E3 → EX (SP),IY swaps IY with top of stack', () => {
    const h = newCpu();
    h.cpu.iy = 0xAABB;
    h.cpu.sp = 0xFF00;
    h.mem[0xFF00] = 0x34; h.mem[0xFF01] = 0x12;
    load(h.mem, 0, 0xFD, 0xE3);
    step(h);
    expect(h.cpu.iy).toBe(0x1234);
    expect(h.mem[0xFF00]).toBe(0xBB);
    expect(h.mem[0xFF01]).toBe(0xAA);
  });

  it('FD E9 → JP (IY) jumps to IY (PC = IY, no stack op)', () => {
    const h = newCpu();
    h.cpu.iy = 0x4000;
    h.cpu.sp = 0xFF00;
    const spBefore = h.cpu.sp;
    load(h.mem, 0, 0xFD, 0xE9);
    step(h);
    expect(h.cpu.pc).toBe(0x4000);
    expect(h.cpu.sp).toBe(spBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (IY+d) memory operations — LD, ALU, INC/DEC
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — FD prefix: (IY+d) memory operations', () => {
  it('LD A,(IY+d) reads with signed displacement', () => {
    const h = newCpu();
    h.cpu.iy = 0xC100;
    h.mem[0xC0FE] = 0x77;
    load(h.mem, 0, 0xFD, 0x7E, 0xFE); // LD A,(IY-2)
    step(h);
    expect(h.cpu.a).toBe(0x77);
  });

  it('LD (IY+d),A writes with signed displacement', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.cpu.a = 0x42;
    load(h.mem, 0, 0xFD, 0x77, 0x10); // LD (IY+16),A
    step(h);
    expect(h.mem[0xC010]).toBe(0x42);
  });

  it.each([
    [0x46, 'B'], [0x4E, 'C'], [0x56, 'D'], [0x5E, 'E'],
    [0x66, 'H'], [0x6E, 'L'], [0x7E, 'A'],
  ] as const)('LD r,(IY+0) for r=%i (%s)', (op, _name) => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.mem[0xC000] = 0x5A;
    load(h.mem, 0, 0xFD, op, 0x00);
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

  it('LD (IY+d),n: 14T-style immediate-store form', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    load(h.mem, 0, 0xFD, 0x36, 0x04, 0x99);
    step(h);
    expect(h.mem[0xC004]).toBe(0x99);
  });

  it('INC (IY+d) sets flags from the new value', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.mem[0xC000] = 0x7F;             // → 0x80 after INC: S set, PV set (overflow), H set
    h.cpu.f = F_C;                    // C preserved
    load(h.mem, 0, 0xFD, 0x34, 0x00);
    step(h);
    expect(h.mem[0xC000]).toBe(0x80);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('DEC (IY+d) sets N and reflects underflow flags', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.mem[0xC000] = 0x01;
    load(h.mem, 0, 0xFD, 0x35, 0x00);
    step(h);
    expect(h.mem[0xC000]).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it.each([
    { op: 0x86, name: 'ADD A,(IY+d)', a: 0x10, m: 0x22, expect: 0x32 },
    { op: 0x8E, name: 'ADC A,(IY+d) with C=1', a: 0x10, m: 0x22, expect: 0x33, cIn: true },
    { op: 0x96, name: 'SUB (IY+d)',   a: 0x50, m: 0x10, expect: 0x40 },
    { op: 0x9E, name: 'SBC A,(IY+d) with C=1', a: 0x50, m: 0x10, expect: 0x3F, cIn: true },
    { op: 0xA6, name: 'AND (IY+d)',   a: 0xF0, m: 0x0F, expect: 0x00 },
    { op: 0xAE, name: 'XOR (IY+d)',   a: 0xFF, m: 0x0F, expect: 0xF0 },
    { op: 0xB6, name: 'OR (IY+d)',    a: 0x80, m: 0x01, expect: 0x81 },
  ])('$name', ({ op, a, m, expect: result, cIn }) => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.cpu.a = a;
    h.mem[0xC000] = m;
    h.cpu.f = cIn ? F_C : 0;
    load(h.mem, 0, 0xFD, op, 0x00);
    step(h);
    expect(h.cpu.a).toBe(result);
  });

  it('CP (IY+d) leaves A unchanged but updates flags', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.cpu.a = 0x42;
    h.mem[0xC000] = 0x42;
    load(h.mem, 0, 0xFD, 0xBE, 0x00); // CP (IY+0)
    step(h);
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('FD 2E nn → LD IYL,n (low byte set, high preserved)', () => {
    const h = newCpu();
    h.cpu.iy = 0xAB00;
    load(h.mem, 0, 0xFD, 0x2E, 0x34); // LD IYL,$34
    step(h);
    expect(h.cpu.iy).toBe(0xAB34);
  });

  it('FD 06 nn → LD B,n passes through unchanged (FD on x=0,z=6,y=0 else path)', () => {
    // op=0x06: x=0, z=6, y=0 — enters x===0&&z===6&&y!==6, not 0x26/0x2E → executeMain
    const h = newCpu();
    h.cpu.iy = 0xABCD;
    load(h.mem, 0, 0xFD, 0x06, 0x99); // LD B,$99
    step(h);
    expect(h.cpu.b).toBe(0x99);
    expect(h.cpu.iy).toBe(0xABCD); // IY untouched
  });

  it('MEMPTR ← IY+d (observable via subsequent BIT n,(HL))', () => {
    const h = newCpu();
    h.cpu.iy = 0x4810;          // (IY-0x10) = 0x4800 → MEMPTR.H = 0x48 (F3=1, F5=0)
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x01;       // any value with bits 3/5 clear
    h.mem[0x4800] = 0x00;
    load(h.mem, 0,
      0xFD, 0x7E, 0xF0,         // LD A,(IY-16) — sets MEMPTR = 0x4800
      0xCB, 0x46,               // BIT 0,(HL) — F3/F5 from MEMPTR.H
    );
    step(h, 2);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ADD IY,rr — IY 16-bit add via the ddfdUsesHL path
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — FD prefix: ADD IY,rr', () => {
  it('FD 09 → ADD IY,BC', () => {
    const h = newCpu();
    h.cpu.iy = 0x1000; h.cpu.bc = 0x0234;
    load(h.mem, 0, 0xFD, 0x09);
    step(h);
    expect(h.cpu.iy).toBe(0x1234);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('FD 29 → ADD IY,IY (must double IY, NOT HL)', () => {
    const h = newCpu();
    h.cpu.iy = 0x0801; h.cpu.hl = 0xDEAD;
    load(h.mem, 0, 0xFD, 0x29);
    step(h);
    expect(h.cpu.iy).toBe(0x1002);
    expect(h.cpu.hl).toBe(0xDEAD); // HL must be untouched
  });

  it('FD 39 → ADD IY,SP sets C on carry out of bit 15', () => {
    const h = newCpu();
    h.cpu.iy = 0x8000; h.cpu.sp = 0x8000;
    load(h.mem, 0, 0xFD, 0x39);
    step(h);
    expect(h.cpu.iy).toBe(0x0000);
    expect(h.cpu.f & F_C).toBe(F_C);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FD prefix on a non-HL opcode: pass-through behaviour
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — FD prefix on non-HL opcode is a wasted M1', () => {
  it('FD 04 → INC B executes normally; IY untouched', () => {
    const h = newCpu();
    h.cpu.iy = 0xBEEF; h.cpu.b = 0x10;
    load(h.mem, 0, 0xFD, 0x04);
    step(h);
    expect(h.cpu.b).toBe(0x11);
    expect(h.cpu.iy).toBe(0xBEEF);
  });

  it('FD 00 → NOP-equivalent; PC advances 2', () => {
    const h = newCpu();
    h.cpu.iy = 0x1234;
    load(h.mem, 0, 0xFD, 0x00);
    step(h);
    expect(h.cpu.pc).toBe(2);
    expect(h.cpu.iy).toBe(0x1234);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FDCB — IY-indexed CB ops with undocumented register-store side effect
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — FDCB rotate/shift with simultaneous register store', () => {
  it.each([
    { op: 0x00, name: 'RLC (IY+d),B', val: 0x81, expect: 0x03, reg: 'b' },
    { op: 0x01, name: 'RLC (IY+d),C', val: 0x40, expect: 0x80, reg: 'c' },
    { op: 0x02, name: 'RLC (IY+d),D', val: 0x01, expect: 0x02, reg: 'd' },
    { op: 0x03, name: 'RLC (IY+d),E', val: 0xFF, expect: 0xFF, reg: 'e' },
    { op: 0x04, name: 'RLC (IY+d),H', val: 0x55, expect: 0xAA, reg: 'h' },
    { op: 0x05, name: 'RLC (IY+d),L', val: 0x80, expect: 0x01, reg: 'l' },
    { op: 0x07, name: 'RLC (IY+d),A', val: 0x40, expect: 0x80, reg: 'a' },
  ] as const)('$name copies result to register and to memory', ({ op, val, expect: out, reg }) => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.mem[0xC003] = val;
    load(h.mem, 0, 0xFD, 0xCB, 0x03, op);
    step(h);
    expect(h.mem[0xC003]).toBe(out);
    expect((h.cpu as unknown as Record<string, number>)[reg]).toBe(out);
  });

  it('FDCB d 06 → RLC (IY+d) with z=6 is the standard form (no register copy)', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.cpu.b = 0xAA;
    h.mem[0xC000] = 0x40;
    load(h.mem, 0, 0xFD, 0xCB, 0x00, 0x06);
    step(h);
    expect(h.mem[0xC000]).toBe(0x80);
    expect(h.cpu.b).toBe(0xAA);
  });

  it.each([
    { op: 0x08, name: 'RRC (IY+d),B', val: 0x01, expect: 0x80 },
    { op: 0x10, name: 'RL  (IY+d),B (cIn=1)', val: 0x80, expect: 0x01, cIn: true },
    { op: 0x18, name: 'RR  (IY+d),B (cIn=1)', val: 0x01, expect: 0x80, cIn: true },
    { op: 0x20, name: 'SLA (IY+d),B', val: 0x40, expect: 0x80 },
    { op: 0x28, name: 'SRA (IY+d),B', val: 0x80, expect: 0xC0 }, // SRA preserves bit 7
    { op: 0x30, name: 'SLL (IY+d),B (undoc, bit 0 forced)', val: 0x40, expect: 0x81 },
    { op: 0x38, name: 'SRL (IY+d),B', val: 0x80, expect: 0x40 },
  ])('$name (z=0 → copies to B)', ({ op, val, expect: out, cIn }) => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.cpu.b = 0xAA;
    h.cpu.f = cIn ? F_C : 0;
    h.mem[0xC000] = val;
    load(h.mem, 0, 0xFD, 0xCB, 0x00, op);
    step(h);
    expect(h.mem[0xC000]).toBe(out);
    expect(h.cpu.b).toBe(out);
  });

  it('FDCB d C0 → SET 0,(IY+d),B copies post-SET byte to B', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.mem[0xC001] = 0x00;
    load(h.mem, 0, 0xFD, 0xCB, 0x01, 0xC0);
    step(h);
    expect(h.mem[0xC001]).toBe(0x01);
    expect(h.cpu.b).toBe(0x01);
  });

  it('FDCB d 80 → RES 0,(IY+d),B copies post-RES byte to B', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.mem[0xC000] = 0xFF;
    load(h.mem, 0, 0xFD, 0xCB, 0x00, 0x80);
    step(h);
    expect(h.mem[0xC000]).toBe(0xFE);
    expect(h.cpu.b).toBe(0xFE);
  });

  it('FDCB d FF → SET 7,(IY+d),A copies result to A', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.mem[0xC000] = 0x01;
    load(h.mem, 0, 0xFD, 0xCB, 0x00, 0xFF);
    step(h);
    expect(h.mem[0xC000]).toBe(0x81);
    expect(h.cpu.a).toBe(0x81);
  });

  it('signed displacement: FDCB FE 06 → RLC (IY-2)', () => {
    const h = newCpu();
    h.cpu.iy = 0xC010;
    h.mem[0xC00E] = 0x81;
    load(h.mem, 0, 0xFD, 0xCB, 0xFE, 0x06);
    step(h);
    expect(h.mem[0xC00E]).toBe(0x03);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FDCB BIT — MEMPTR-derived F3/F5
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — FDCB BIT n,(IY+d) takes F3/F5 from MEMPTR high byte', () => {
  it('After BIT 0,(IY+5) with IY+5 = 0x4825, F3/F5 reflect 0x48 (F3=1, F5=0)', () => {
    const h = newCpu();
    h.cpu.iy = 0x4820;
    h.mem[0x4825] = 0x01;
    load(h.mem, 0, 0xFD, 0xCB, 0x05, 0x46); // BIT 0,(IY+5)
    step(h);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(0);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_Z).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('BIT 7,(IY+d) sets S when bit 7 of (IY+d) is set', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.mem[0xC000] = 0x80;
    load(h.mem, 0, 0xFD, 0xCB, 0x00, 0x7E); // BIT 7,(IY+0)
    step(h);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_Z).toBe(0);
  });

  it('BIT n,(IY+d) sets Z when target bit is clear', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    h.mem[0xC000] = 0x00;
    load(h.mem, 0, 0xFD, 0xCB, 0x00, 0x46); // BIT 0,(IY+0)
    step(h);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV); // PV mirrors Z for BIT n,(...)
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FD chained with FD or DD — prefix override
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — FD chained prefixes', () => {
  it('FD FD 23 → drops first FD; second FD takes effect → INC IY', () => {
    // The whole chain resolves within one step() call — a redundant prefix
    // never returns control to the frame loop mid-chain.
    const h = newCpu();
    h.cpu.iy = 0x2000;
    load(h.mem, 0, 0xFD, 0xFD, 0x23);
    step(h, 1);
    expect(h.cpu.iy).toBe(0x2001);
  });

  it('FD DD 23 → first FD dropped, DD takes over → INC IX (not IY)', () => {
    const h = newCpu();
    h.cpu.ix = 0x3000; h.cpu.iy = 0x2000;
    load(h.mem, 0, 0xFD, 0xDD, 0x23);
    step(h, 1);
    expect(h.cpu.ix).toBe(0x3001);
    expect(h.cpu.iy).toBe(0x2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// IX / IY documented prefix forms (DD / FD) — basic coverage from z80-core
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — IX/IY prefix (DD/FD)', () => {
  it('LD IX,nn loads the 16-bit immediate', () => {
    const h = newCpu();
    load(h.mem, 0, 0xDD, 0x21, 0x34, 0x12); // LD IX,$1234
    step(h);
    expect(h.cpu.ix).toBe(0x1234);
  });

  it('LD A,(IX+d) reads from IX-relative address with signed displacement', () => {
    const h = newCpu();
    h.cpu.ix = 0xC100;
    h.mem[0xC0FE] = 0x42;
    load(h.mem, 0, 0xDD, 0x7E, 0xFE); // LD A,(IX-2)
    step(h);
    expect(h.cpu.a).toBe(0x42);
  });

  it('LD (IY+d),n writes to IY-relative address', () => {
    const h = newCpu();
    h.cpu.iy = 0xC000;
    load(h.mem, 0, 0xFD, 0x36, 0x05, 0x77); // LD (IY+5),$77
    step(h);
    expect(h.mem[0xC005]).toBe(0x77);
  });

  it('DD prefix on a non-HL opcode (e.g. NOP) is effectively a wasted M1', () => {
    // DD 00 — the DD prefix is consumed and the following NOP executes normally.
    // PC advances by 2, IX is unchanged.
    const h = newCpu();
    h.cpu.ix = 0x1234;
    load(h.mem, 0, 0xDD, 0x00);
    const before = h.cpu.tStates;
    step(h);
    expect(h.cpu.ix).toBe(0x1234);
    expect(h.cpu.pc).toBe(2);
    expect(h.cpu.tStates - before).toBeGreaterThanOrEqual(8); // 4T (DD M1) + 4T (NOP M1)
  });
});
