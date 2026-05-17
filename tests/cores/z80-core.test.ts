/**
 * Z80 CPU tests — documented external behaviour.
 *
 * Authoritative references:
 *  - Zilog Z80 CPU User Manual (UM008011-0816)
 *  - Sean Young, "The Undocumented Z80 Documented" v0.91 (2005)
 *  - Patrik Rak, "Q register / SCF/CCF flag behaviour" (2012)
 *
 * The tests build short programs in a flat 64KB RAM, wire it to a fresh CPU
 * via cpu.read8/write8, and assert post-execution register/flag/memory state.
 * No reliance on the Spectrum harness — these are pure CPU tests.
 *
 * Flag constants — documented Z80 layout:
 *   S Z F5 H F3 PV N C
 *   7 6  5 4  3  2 1 0
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

// ─────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────

interface Harness {
  cpu: Z80;
  mem: Uint8Array;
  ports: Map<number, number>;
  portReads: number[];
  portWrites: { port: number; val: number }[];
}

function newCpu(): Harness {
  const cpu = new Z80();
  const mem = new Uint8Array(0x10000);
  const ports = new Map<number, number>();
  const portReads: number[] = [];
  const portWrites: { port: number; val: number }[] = [];
  cpu.read8 = (a) => mem[a & 0xFFFF];
  cpu.write8 = (a, v) => { mem[a & 0xFFFF] = v & 0xFF; };
  cpu.portInHandler = (port) => { portReads.push(port); return ports.get(port & 0xFFFF) ?? 0xFF; };
  cpu.portOutHandler = (port, val) => { portWrites.push({ port, val }); ports.set(port & 0xFFFF, val & 0xFF); };
  cpu.pc = 0;
  cpu.sp = 0xFFFF;
  return { cpu, mem, ports, portReads, portWrites };
}

function load(mem: Uint8Array, addr: number, ...bytes: number[]): void {
  for (let i = 0; i < bytes.length; i++) mem[(addr + i) & 0xFFFF] = bytes[i] & 0xFF;
}

function step(h: Harness, n = 1): void {
  for (let i = 0; i < n; i++) h.cpu.step();
}

// ─────────────────────────────────────────────────────────────────────────
// Reset & basic state
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — reset state', () => {
  it('zeros main and shadow registers, IM=1, halted=false', () => {
    const { cpu } = newCpu();
    cpu.a = 0xAA; cpu.f = 0x55; cpu.bc = 0x1234;
    cpu.iff1 = true; cpu.halted = true;
    cpu.reset();
    expect(cpu.a).toBe(0); expect(cpu.f).toBe(0);
    expect(cpu.bc).toBe(0); expect(cpu.de).toBe(0); expect(cpu.hl).toBe(0);
    expect(cpu.ix).toBe(0); expect(cpu.iy).toBe(0);
    expect(cpu.pc).toBe(0); expect(cpu.sp).toBe(0);
    expect(cpu.i).toBe(0); expect(cpu.r).toBe(0);
    expect(cpu.im).toBe(1);
    expect(cpu.iff1).toBe(false); expect(cpu.iff2).toBe(false);
    expect(cpu.halted).toBe(false);
  });
});

describe('Z80 — register pair packing', () => {
  it('hl/bc/de/af getter/setter pack big-endian', () => {
    const { cpu } = newCpu();
    cpu.hl = 0x1234;
    expect(cpu.h).toBe(0x12);
    expect(cpu.l).toBe(0x34);
    cpu.b = 0xAB; cpu.c = 0xCD;
    expect(cpu.bc).toBe(0xABCD);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8-bit loads
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — 8-bit loads', () => {
  it('LD r,n loads immediate', () => {
    const h = newCpu();
    load(h.mem, 0, 0x3E, 0x42); // LD A,$42
    step(h);
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.pc).toBe(2);
  });

  it('LD r,r\' copies register without affecting flags', () => {
    const h = newCpu();
    h.cpu.b = 0x99; h.cpu.f = 0xFF;
    load(h.mem, 0, 0x78); // LD A,B
    step(h);
    expect(h.cpu.a).toBe(0x99);
    expect(h.cpu.f).toBe(0xFF);
  });

  it('LD (HL),n writes immediate to memory', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000;
    load(h.mem, 0, 0x36, 0x7E); // LD (HL),$7E
    step(h);
    expect(h.mem[0xC000]).toBe(0x7E);
  });

  it('LD A,(BC) and LD A,(DE) round-trip', () => {
    const h = newCpu();
    h.cpu.bc = 0xC000; h.cpu.de = 0xC001;
    h.mem[0xC000] = 0x11; h.mem[0xC001] = 0x22;
    load(h.mem, 0, 0x0A, 0x1A); // LD A,(BC) ; LD A,(DE)
    step(h);
    expect(h.cpu.a).toBe(0x11);
    step(h);
    expect(h.cpu.a).toBe(0x22);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 16-bit loads / PUSH / POP
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — 16-bit loads, PUSH, POP', () => {
  it('LD HL,nn / LD (nn),HL / LD HL,(nn)', () => {
    const h = newCpu();
    load(h.mem, 0,
      0x21, 0x34, 0x12,          // LD HL,$1234
      0x22, 0x00, 0xC0,          // LD ($C000),HL
      0x21, 0x00, 0x00,          // LD HL,$0000
      0x2A, 0x00, 0xC0,          // LD HL,($C000)
    );
    step(h, 4);
    expect(h.mem[0xC000]).toBe(0x34);
    expect(h.mem[0xC001]).toBe(0x12);
    expect(h.cpu.hl).toBe(0x1234);
  });

  it('PUSH writes high byte first to (--SP), then low byte', () => {
    const h = newCpu();
    h.cpu.bc = 0xBEEF;
    h.cpu.sp = 0xC010;
    load(h.mem, 0, 0xC5); // PUSH BC
    step(h);
    expect(h.cpu.sp).toBe(0xC00E);
    expect(h.mem[0xC00E]).toBe(0xEF);
    expect(h.mem[0xC00F]).toBe(0xBE);
  });

  it('POP recovers the value', () => {
    const h = newCpu();
    h.cpu.sp = 0xC000;
    h.mem[0xC000] = 0x21; h.mem[0xC001] = 0x43;
    load(h.mem, 0, 0xE1); // POP HL
    step(h);
    expect(h.cpu.hl).toBe(0x4321);
    expect(h.cpu.sp).toBe(0xC002);
  });

  it('PUSH/POP AF roundtrips F bit-exact (including undocumented bits 3/5)', () => {
    const h = newCpu();
    h.cpu.a = 0x5A; h.cpu.f = 0xFF;
    h.cpu.sp = 0xC010;
    load(h.mem, 0, 0xF5, 0xF1); // PUSH AF ; POP AF
    step(h, 2);
    expect(h.cpu.a).toBe(0x5A);
    expect(h.cpu.f).toBe(0xFF);
  });

  it('LD (BC),A stores A at address in BC', () => {
    const h = newCpu();
    h.cpu.a = 0x42; h.cpu.bc = 0xC000;
    load(h.mem, 0, 0x02); // LD (BC),A
    step(h);
    expect(h.mem[0xC000]).toBe(0x42);
  });

  it('LD (DE),A stores A at address in DE', () => {
    const h = newCpu();
    h.cpu.a = 0x77; h.cpu.de = 0xD000;
    load(h.mem, 0, 0x12); // LD (DE),A
    step(h);
    expect(h.mem[0xD000]).toBe(0x77);
  });

  it('LD (nn),A stores A at absolute address', () => {
    const h = newCpu();
    h.cpu.a = 0x55;
    load(h.mem, 0, 0x32, 0x00, 0x80); // LD ($8000),A
    step(h);
    expect(h.mem[0x8000]).toBe(0x55);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ALU: ADD / SUB / CP / AND / OR / XOR — flag tables
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — ADD A,n flag semantics', () => {
  function add(a: number, n: number): { res: number; f: number } {
    const h = newCpu();
    h.cpu.a = a;
    load(h.mem, 0, 0xC6, n); // ADD A,n
    step(h);
    return { res: h.cpu.a, f: h.cpu.f };
  }

  it('0x10 + 0x20 → no carry, no half-carry, no zero, no sign', () => {
    const { res, f } = add(0x10, 0x20);
    expect(res).toBe(0x30);
    expect(f & F_C).toBe(0);
    expect(f & F_H).toBe(0);
    expect(f & F_Z).toBe(0);
    expect(f & F_S).toBe(0);
    expect(f & F_N).toBe(0);
  });

  it('0x0F + 0x01 → half-carry set', () => {
    const { res, f } = add(0x0F, 0x01);
    expect(res).toBe(0x10);
    expect(f & F_H).toBe(F_H);
  });

  it('0xFF + 0x01 → 0, carry, half-carry, zero', () => {
    const { res, f } = add(0xFF, 0x01);
    expect(res).toBe(0);
    expect(f & F_C).toBe(F_C);
    expect(f & F_H).toBe(F_H);
    expect(f & F_Z).toBe(F_Z);
  });

  it('0x7F + 0x01 → 0x80: sign set, overflow set', () => {
    const { res, f } = add(0x7F, 0x01);
    expect(res).toBe(0x80);
    expect(f & F_S).toBe(F_S);
    expect(f & F_PV).toBe(F_PV); // signed overflow: positive + positive = negative
    expect(f & F_C).toBe(0);
  });

  it('0x80 + 0x80 → 0: overflow set, carry set', () => {
    const { res, f } = add(0x80, 0x80);
    expect(res).toBe(0);
    expect(f & F_PV).toBe(F_PV);
    expect(f & F_C).toBe(F_C);
    expect(f & F_Z).toBe(F_Z);
  });

  it('undocumented F3/F5 copy from result bits 3/5', () => {
    const { f } = add(0x20, 0x08); // result 0x28 → bits 3,5 set
    expect(f & F_F3).toBe(F_F3);
    expect(f & F_F5).toBe(F_F5);
  });
});

describe('Z80 — SUB A,n flag semantics', () => {
  function sub(a: number, n: number): { res: number; f: number } {
    const h = newCpu();
    h.cpu.a = a;
    load(h.mem, 0, 0xD6, n);
    step(h);
    return { res: h.cpu.a, f: h.cpu.f };
  }

  it('always sets N flag', () => {
    const { f } = sub(0x10, 0x05);
    expect(f & F_N).toBe(F_N);
  });

  it('0x10 - 0x10 → zero', () => {
    const { res, f } = sub(0x10, 0x10);
    expect(res).toBe(0);
    expect(f & F_Z).toBe(F_Z);
  });

  it('0x00 - 0x01 → 0xFF, borrow (C), half-borrow (H), sign', () => {
    const { res, f } = sub(0x00, 0x01);
    expect(res).toBe(0xFF);
    expect(f & F_C).toBe(F_C);
    expect(f & F_H).toBe(F_H);
    expect(f & F_S).toBe(F_S);
  });

  it('0x80 - 0x01 → 0x7F: signed overflow (negative - positive = positive)', () => {
    const { res, f } = sub(0x80, 0x01);
    expect(res).toBe(0x7F);
    expect(f & F_PV).toBe(F_PV);
  });
});

describe('Z80 — CP n is SUB without storing result', () => {
  it('CP equal → Z set, A unchanged', () => {
    const h = newCpu();
    h.cpu.a = 0x42;
    load(h.mem, 0, 0xFE, 0x42); // CP $42
    step(h);
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('CP: undocumented F3/F5 come from the *operand*, not the result', () => {
    const h = newCpu();
    h.cpu.a = 0x00;
    load(h.mem, 0, 0xFE, 0x28); // CP $28 (bits 3,5 set in operand)
    step(h);
    // Documented quirk: CP copies F3/F5 from the operand byte, unlike SUB
    // which copies them from the result.
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });
});

describe('Z80 — AND / OR / XOR flag semantics', () => {
  it('AND sets H, clears C and N, computes parity', () => {
    const h = newCpu();
    h.cpu.a = 0xFF;
    load(h.mem, 0, 0xE6, 0x0F); // AND $0F → 0x0F (4 bits set = even parity)
    step(h);
    expect(h.cpu.a).toBe(0x0F);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_C).toBe(0);
    expect(h.cpu.f & F_PV).toBe(F_PV); // parity even
  });

  it('OR clears C/N/H, computes parity', () => {
    const h = newCpu();
    h.cpu.a = 0x0F;
    load(h.mem, 0, 0xF6, 0xF0); // OR $F0 → 0xFF (8 bits = even parity)
    step(h);
    expect(h.cpu.a).toBe(0xFF);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_C).toBe(0);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('XOR A,A always zeroes A and sets Z, P', () => {
    const h = newCpu();
    h.cpu.a = 0x42;
    load(h.mem, 0, 0xAF); // XOR A
    step(h);
    expect(h.cpu.a).toBe(0);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_C).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// INC / DEC
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — INC/DEC 8-bit flag semantics', () => {
  it('INC B preserves C, sets N=0', () => {
    const h = newCpu();
    h.cpu.b = 0x10; h.cpu.f = F_C;
    load(h.mem, 0, 0x04); // INC B
    step(h);
    expect(h.cpu.b).toBe(0x11);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('INC 0x7F → 0x80: PV set (signed overflow), S set, H set', () => {
    const h = newCpu();
    h.cpu.b = 0x7F;
    load(h.mem, 0, 0x04);
    step(h);
    expect(h.cpu.b).toBe(0x80);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_H).toBe(F_H);
  });

  it('DEC always sets N=1', () => {
    const h = newCpu();
    h.cpu.b = 0x01;
    load(h.mem, 0, 0x05); // DEC B
    step(h);
    expect(h.cpu.b).toBe(0);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('DEC 0x80 → 0x7F: PV set', () => {
    const h = newCpu();
    h.cpu.b = 0x80;
    load(h.mem, 0, 0x05);
    step(h);
    expect(h.cpu.b).toBe(0x7F);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('INC (HL): increments memory at HL, same flag semantics as INC r', () => {
    const h = newCpu();
    h.cpu.hl = 0x4000;
    h.mem[0x4000] = 0x7F;
    load(h.mem, 0, 0x34); // INC (HL)
    step(h);
    expect(h.mem[0x4000]).toBe(0x80);
    expect(h.cpu.f & F_PV).toBe(F_PV); // 0x7F→0x80: signed overflow
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('INC (HL): wrap 0xFF → 0x00, Z set, H set', () => {
    const h = newCpu();
    h.cpu.hl = 0x5000;
    h.mem[0x5000] = 0xFF;
    load(h.mem, 0, 0x34);
    step(h);
    expect(h.mem[0x5000]).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_H).toBe(F_H);
  });

  it('DEC (HL): decrements memory at HL, sets N', () => {
    const h = newCpu();
    h.cpu.hl = 0x4000;
    h.mem[0x4000] = 0x01;
    load(h.mem, 0, 0x35); // DEC (HL)
    step(h);
    expect(h.mem[0x4000]).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('DEC (HL): 0x80 → 0x7F: PV set (signed overflow)', () => {
    const h = newCpu();
    h.cpu.hl = 0x4000;
    h.mem[0x4000] = 0x80;
    load(h.mem, 0, 0x35);
    step(h);
    expect(h.mem[0x4000]).toBe(0x7F);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_N).toBe(F_N);
  });
});

describe('Z80 — INC/DEC 16-bit do not affect flags', () => {
  it('INC HL: F preserved', () => {
    const h = newCpu();
    h.cpu.hl = 0xFFFF; h.cpu.f = 0xFF;
    load(h.mem, 0, 0x23);
    step(h);
    expect(h.cpu.hl).toBe(0);
    expect(h.cpu.f).toBe(0xFF);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Rotates / shifts (CB prefix)
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — CB rotates/shifts', () => {
  it('RLC B: bit 7 → C and bit 0', () => {
    const h = newCpu();
    h.cpu.b = 0x81;
    load(h.mem, 0, 0xCB, 0x00); // RLC B
    step(h);
    expect(h.cpu.b).toBe(0x03);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('RR B: C → bit 7, bit 0 → C', () => {
    const h = newCpu();
    h.cpu.b = 0x01; h.cpu.f = F_C;
    load(h.mem, 0, 0xCB, 0x18); // RR B
    step(h);
    expect(h.cpu.b).toBe(0x80);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_S).toBe(F_S);
  });

  it('SLA B clears bit 0, SRL B clears bit 7', () => {
    const h = newCpu();
    h.cpu.b = 0xFF;
    load(h.mem, 0, 0xCB, 0x20, 0xCB, 0x38); // SLA B ; SRL B
    step(h); expect(h.cpu.b).toBe(0xFE); expect(h.cpu.f & F_C).toBe(F_C);
    step(h); expect(h.cpu.b).toBe(0x7F); expect(h.cpu.f & F_C).toBe(0);
  });

  it('SRA preserves sign bit (arithmetic shift right)', () => {
    const h = newCpu();
    h.cpu.b = 0x80;
    load(h.mem, 0, 0xCB, 0x28); // SRA B
    step(h);
    expect(h.cpu.b).toBe(0xC0);
  });

  it('SLL (undocumented) shifts bit 0 in as 1', () => {
    const h = newCpu();
    h.cpu.b = 0x40;
    load(h.mem, 0, 0xCB, 0x30); // SLL B
    step(h);
    expect(h.cpu.b).toBe(0x81);
  });
});

describe('Z80 — CB BIT/SET/RES', () => {
  it('BIT n,r: Z reflects bit, H always set, N=0, C preserved', () => {
    const h = newCpu();
    h.cpu.b = 0x10; h.cpu.f = F_C;
    load(h.mem, 0, 0xCB, 0x60); // BIT 4,B (set)
    step(h);
    expect(h.cpu.f & F_Z).toBe(0);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_C).toBe(F_C); // preserved
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('BIT n,r: Z set when bit clear, also sets PV (= Z)', () => {
    const h = newCpu();
    h.cpu.b = 0x00;
    load(h.mem, 0, 0xCB, 0x40); // BIT 0,B
    step(h);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('SET 7,B / RES 7,B', () => {
    const h = newCpu();
    h.cpu.b = 0x00;
    load(h.mem, 0, 0xCB, 0xF8, 0xCB, 0xB8); // SET 7,B ; RES 7,B
    step(h); expect(h.cpu.b).toBe(0x80);
    step(h); expect(h.cpu.b).toBe(0x00);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Jumps, calls, returns
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — JP / JR / DJNZ', () => {
  it('JP nn sets PC absolutely', () => {
    const h = newCpu();
    load(h.mem, 0, 0xC3, 0x34, 0x12); // JP $1234
    step(h);
    expect(h.cpu.pc).toBe(0x1234);
  });

  it('JR e: forward and backward relative', () => {
    const h = newCpu();
    load(h.mem, 0x100, 0x18, 0x05); // JR +5
    h.cpu.pc = 0x100;
    step(h);
    expect(h.cpu.pc).toBe(0x107); // PC was at 0x102 after fetch, +5
    load(h.mem, 0x200, 0x18, 0xFE); // JR -2 → loops on itself
    h.cpu.pc = 0x200;
    step(h);
    expect(h.cpu.pc).toBe(0x200);
  });

  it('JR NZ taken / not taken based on Z flag', () => {
    const h = newCpu();
    h.cpu.f = F_Z;
    load(h.mem, 0, 0x20, 0x05); // JR NZ,+5
    step(h);
    expect(h.cpu.pc).toBe(2); // Z set → not taken
    h.cpu.f = 0;
    h.cpu.pc = 0;
    step(h);
    expect(h.cpu.pc).toBe(7); // taken
  });

  it('DJNZ decrements B; takes branch when B≠0', () => {
    const h = newCpu();
    h.cpu.b = 3;
    load(h.mem, 0, 0x10, 0xFE); // DJNZ -2
    step(h); expect(h.cpu.b).toBe(2); expect(h.cpu.pc).toBe(0);
    step(h); expect(h.cpu.b).toBe(1); expect(h.cpu.pc).toBe(0);
    step(h); expect(h.cpu.b).toBe(0); expect(h.cpu.pc).toBe(2);
  });
});

describe('Z80 — CALL / RET', () => {
  it('CALL pushes return address, jumps; RET pops it back', () => {
    const h = newCpu();
    h.cpu.sp = 0xC010;
    load(h.mem, 0,
      0xCD, 0x00, 0x10,  // CALL $1000
    );
    load(h.mem, 0x1000, 0xC9); // RET
    step(h);
    expect(h.cpu.pc).toBe(0x1000);
    expect(h.cpu.sp).toBe(0xC00E);
    expect(h.mem[0xC00E]).toBe(0x03); // return = 0x0003
    expect(h.mem[0xC00F]).toBe(0x00);
    step(h);
    expect(h.cpu.pc).toBe(0x0003);
    expect(h.cpu.sp).toBe(0xC010);
  });

  it('CALL cc: not-taken consumes 3 bytes but no stack write', () => {
    const h = newCpu();
    h.cpu.sp = 0xC010;
    h.cpu.f = 0; // NZ
    load(h.mem, 0, 0xCC, 0x00, 0x10); // CALL Z,$1000
    step(h);
    expect(h.cpu.pc).toBe(3);
    expect(h.cpu.sp).toBe(0xC010);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// EX / EXX
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — EX / EXX', () => {
  it("EX AF,AF' swaps A and F with the shadow set", () => {
    const h = newCpu();
    h.cpu.a = 0x11; h.cpu.f = 0x22;
    h.cpu.a_ = 0x33; h.cpu.f_ = 0x44;
    load(h.mem, 0, 0x08);
    step(h);
    expect(h.cpu.a).toBe(0x33); expect(h.cpu.f).toBe(0x44);
    expect(h.cpu.a_).toBe(0x11); expect(h.cpu.f_).toBe(0x22);
  });

  it('EXX swaps BC/DE/HL with shadows, leaves AF alone', () => {
    const h = newCpu();
    h.cpu.bc = 0x1111; h.cpu.de = 0x2222; h.cpu.hl = 0x3333;
    h.cpu.b_ = 0xAA; h.cpu.c_ = 0xBB;
    h.cpu.d_ = 0xCC; h.cpu.e_ = 0xDD;
    h.cpu.h_ = 0xEE; h.cpu.l_ = 0xFF;
    h.cpu.a = 0x99; h.cpu.f = 0x88;
    load(h.mem, 0, 0xD9);
    step(h);
    expect(h.cpu.bc).toBe(0xAABB);
    expect(h.cpu.de).toBe(0xCCDD);
    expect(h.cpu.hl).toBe(0xEEFF);
    expect(h.cpu.a).toBe(0x99); expect(h.cpu.f).toBe(0x88);
  });

  it('EX DE,HL swaps DE and HL', () => {
    const h = newCpu();
    h.cpu.de = 0x1234; h.cpu.hl = 0x5678;
    load(h.mem, 0, 0xEB);
    step(h);
    expect(h.cpu.de).toBe(0x5678);
    expect(h.cpu.hl).toBe(0x1234);
  });

  it('EX (SP),HL swaps top of stack with HL', () => {
    const h = newCpu();
    h.cpu.sp = 0xC000;
    h.mem[0xC000] = 0x34; h.mem[0xC001] = 0x12;
    h.cpu.hl = 0xABCD;
    load(h.mem, 0, 0xE3);
    step(h);
    expect(h.cpu.hl).toBe(0x1234);
    expect(h.mem[0xC000]).toBe(0xCD);
    expect(h.mem[0xC001]).toBe(0xAB);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Block ops
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — Block ops (ED-prefix)', () => {
  it('LDI copies a byte, increments HL/DE, decrements BC', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000; h.cpu.de = 0xC100; h.cpu.bc = 0x0003;
    h.mem[0xC000] = 0x42;
    load(h.mem, 0, 0xED, 0xA0);
    step(h);
    expect(h.mem[0xC100]).toBe(0x42);
    expect(h.cpu.hl).toBe(0xC001);
    expect(h.cpu.de).toBe(0xC101);
    expect(h.cpu.bc).toBe(0x0002);
    expect(h.cpu.f & F_PV).toBe(F_PV); // BC != 0
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_H).toBe(0);
  });

  it('LDIR repeats until BC = 0', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000; h.cpu.de = 0xC100; h.cpu.bc = 0x0004;
    for (let i = 0; i < 4; i++) h.mem[0xC000 + i] = 0x10 + i;
    load(h.mem, 0, 0xED, 0xB0);
    // Step until LDIR completes (each iteration steps once and the
    // instruction re-executes via PC backtrack)
    for (let i = 0; i < 16 && h.cpu.bc !== 0; i++) h.cpu.step();
    expect(h.cpu.bc).toBe(0);
    expect(h.cpu.pc).toBe(2);
    for (let i = 0; i < 4; i++) expect(h.mem[0xC100 + i]).toBe(0x10 + i);
    expect(h.cpu.f & F_PV).toBe(0); // BC = 0 → PV clear
  });

  it('CPI compares A with (HL), sets Z if equal, decrements BC', () => {
    const h = newCpu();
    h.cpu.a = 0x42; h.cpu.hl = 0xC000; h.cpu.bc = 0x0003;
    h.mem[0xC000] = 0x42;
    load(h.mem, 0, 0xED, 0xA1);
    step(h);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
    expect(h.cpu.hl).toBe(0xC001);
    expect(h.cpu.bc).toBe(0x0002);
    expect(h.cpu.a).toBe(0x42); // A unchanged
  });
});

// ─────────────────────────────────────────────────────────────────────────
// IN / OUT
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — IN / OUT', () => {
  it('IN A,(n) reads from port (A<<8)|n', () => {
    const h = newCpu();
    h.cpu.a = 0xFE;
    h.ports.set(0xFE7F, 0x99);
    load(h.mem, 0, 0xDB, 0x7F); // IN A,($7F)
    step(h);
    expect(h.cpu.a).toBe(0x99);
    expect(h.portReads[0]).toBe(0xFE7F);
  });

  it('OUT (n),A writes A to port (A<<8)|n', () => {
    const h = newCpu();
    h.cpu.a = 0x12;
    load(h.mem, 0, 0xD3, 0x34); // OUT ($34),A
    step(h);
    expect(h.portWrites[0]).toEqual({ port: 0x1234, val: 0x12 });
  });

  it('IN r,(C) uses BC as port and sets S/Z/P from input', () => {
    const h = newCpu();
    h.cpu.bc = 0x1234;
    h.ports.set(0x1234, 0x80);
    load(h.mem, 0, 0xED, 0x40); // IN B,(C)
    step(h);
    expect(h.cpu.b).toBe(0x80);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_N).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Interrupts
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — Interrupt modes', () => {
  it('IM 1 fires RST 38h and clears IFF1/IFF2', () => {
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.iff2 = true; h.cpu.im = 1;
    h.cpu.sp = 0xC010; h.cpu.pc = 0x1234;
    const t = h.cpu.interrupt();
    expect(t).toBeGreaterThan(0);
    expect(h.cpu.pc).toBe(0x38);
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(false);
    // return address pushed
    expect(h.mem[0xC00E]).toBe(0x34);
    expect(h.mem[0xC00F]).toBe(0x12);
  });

  it('interrupt blocked when IFF1=0', () => {
    const h = newCpu();
    h.cpu.iff1 = false; h.cpu.pc = 0x100;
    const t = h.cpu.interrupt();
    expect(t).toBe(0);
    expect(h.cpu.pc).toBe(0x100); // untouched
  });

  it('EI sets eiDelay so an interrupt during the next M1 is blocked', () => {
    // Documented Zilog behaviour: EI enables interrupts but the *next*
    // instruction's M1 cycle still rejects them. In this core, eiDelay is set
    // by EI and the surrounding run loop (io-ports.ts / spectrum.ts) clears
    // it after the next instruction executes — step() alone does not.
    const h = newCpu();
    load(h.mem, 0, 0xFB, 0x00); // EI ; NOP
    step(h); // EI
    expect(h.cpu.iff1).toBe(true);
    expect(h.cpu.eiDelay).toBe(true);
    expect(h.cpu.interrupt()).toBe(0); // blocked
    // Simulate what the run loop does after dispatching the post-EI instruction
    step(h); // NOP
    h.cpu.eiDelay = false;
    expect(h.cpu.interrupt()).toBeGreaterThan(0);
  });

  it('IM 2 vectors via I:vector and pushes return address', () => {
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.im = 2;
    h.cpu.i = 0x40; h.cpu.pc = 0xABCD; h.cpu.sp = 0xC010;
    // Vector table: at $40FF, store a 16-bit jump destination
    h.mem[0x40FE] = 0x00; h.mem[0x40FF] = 0x80; // standard frame vector $FF
    // Standard IM2: vector byte $FF, pointer = (I<<8)|$FF = $40FF
    h.mem[0x40FF] = 0x34; h.mem[0x4100] = 0x12;
    h.cpu.interrupt();
    expect(h.cpu.pc).toBe(0x1234);
    expect(h.mem[0xC00E]).toBe(0xCD);
    expect(h.mem[0xC00F]).toBe(0xAB);
  });

  it('NMI jumps to $66 and saves IFF1 into IFF2 (IFF1 cleared)', () => {
    const h = newCpu();
    h.cpu.iff1 = true; h.cpu.iff2 = false;
    h.cpu.pc = 0x500; h.cpu.sp = 0xC010;
    h.cpu.nmi();
    expect(h.cpu.pc).toBe(0x66);
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(true); // saved
    expect(h.mem[0xC00E]).toBe(0x00);
    expect(h.mem[0xC00F]).toBe(0x05);
  });
});

describe('Z80 — HALT', () => {
  it('HALT sets halted flag and stalls PC', () => {
    const h = newCpu();
    load(h.mem, 0, 0x76); // HALT
    step(h);
    expect(h.cpu.halted).toBe(true);
    const pcBefore = h.cpu.pc;
    step(h); // another step while halted — PC stays put
    expect(h.cpu.pc).toBe(pcBefore);
  });

  it('interrupt wakes HALT and advances PC past the HALT', () => {
    const h = newCpu();
    h.cpu.iff1 = true;
    h.cpu.sp = 0xC010;
    load(h.mem, 0, 0x76); // HALT
    step(h);
    expect(h.cpu.halted).toBe(true);
    h.cpu.interrupt();
    expect(h.cpu.halted).toBe(false);
    // The pushed return address must be the instruction *after* the HALT, so
    // RETI/RET returns to the next instruction — not to the HALT itself.
    expect(h.mem[0xC00E]).toBe(0x01);
    expect(h.mem[0xC00F]).toBe(0x00);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DAA — decimal adjust
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — DAA', () => {
  it('adjusts BCD addition: 0x09 + 0x01 → 0x10 after DAA', () => {
    const h = newCpu();
    load(h.mem, 0,
      0x3E, 0x09,        // LD A,$09
      0xC6, 0x01,        // ADD A,$01 → $0A, H=1
      0x27,              // DAA → $10
    );
    step(h, 3);
    expect(h.cpu.a).toBe(0x10);
  });

  it('adjusts BCD subtraction: 0x10 - 0x01 → 0x09 after DAA', () => {
    const h = newCpu();
    load(h.mem, 0,
      0x3E, 0x10,        // LD A,$10
      0xD6, 0x01,        // SUB $01 → $0F, H=1, N=1
      0x27,              // DAA → $09
    );
    step(h, 3);
    expect(h.cpu.a).toBe(0x09);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CPL — complement accumulator
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — CPL', () => {
  it('inverts all bits of A', () => {
    const h = newCpu();
    h.cpu.a = 0xA5;
    load(h.mem, 0, 0x2F); // CPL
    step(h);
    expect(h.cpu.a).toBe(0x5A);
  });

  it('always sets H=1 and N=1', () => {
    const h = newCpu();
    h.cpu.a = 0x00;
    h.cpu.f = 0x00;
    load(h.mem, 0, 0x2F);
    step(h);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('preserves S, Z, PV, C', () => {
    const h = newCpu();
    h.cpu.a = 0x00;
    h.cpu.f = F_S | F_Z | F_PV | F_C;
    load(h.mem, 0, 0x2F);
    step(h);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('F3/F5 come from result bits 3 and 5', () => {
    const h = newCpu();
    h.cpu.a = 0xD7; // 11010111 → CPL → 00101000 = 0x28
    load(h.mem, 0, 0x2F);
    step(h);
    expect(h.cpu.a).toBe(0x28);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SCF / CCF — Q register undocumented behaviour (Patrik Rak)
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — SCF/CCF and the Q register', () => {
  it('SCF sets C, clears H and N', () => {
    const h = newCpu();
    h.cpu.f = F_H | F_N;
    load(h.mem, 0, 0x37);
    step(h);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('CCF inverts C; H gets the old C', () => {
    const h = newCpu();
    h.cpu.f = F_C;
    load(h.mem, 0, 0x3F);
    step(h);
    expect(h.cpu.f & F_C).toBe(0);
    expect(h.cpu.f & F_H).toBe(F_H);
  });

  it('SCF after a non-flag instruction: F3/F5 = A bits 3/5 (Q=0 case)', () => {
    // Sequence: LD A,$FF (does NOT modify F) ; SCF
    // After SCF, F3/F5 should come from A (0xFF → both set).
    const h = newCpu();
    load(h.mem, 0, 0x3E, 0xFF, 0x37); // LD A,$FF ; SCF
    step(h, 2);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// R register
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — R register increment', () => {
  it('only the low 7 bits increment; bit 7 is preserved', () => {
    const h = newCpu();
    h.cpu.r = 0xFF; // 0x7F + bit 7
    load(h.mem, 0, 0x00, 0x00); // NOP NOP
    step(h);
    // 0x7F + 1 wraps to 0x00 in low 7 bits, bit 7 preserved
    expect(h.cpu.r).toBe(0x80);
    step(h);
    expect(h.cpu.r).toBe(0x81);
  });

  it('LD A,R reads the live R, LD R,A writes all 8 bits', () => {
    const h = newCpu();
    h.cpu.a = 0x42;
    load(h.mem, 0,
      0xED, 0x4F,   // LD R,A
      0xED, 0x5F,   // LD A,R
    );
    step(h); // LD R,A — both M1s increment R first, *then* A is written to R
    expect(h.cpu.r & 0x7F).toBe(0x42 & 0x7F);
    step(h); // LD A,R — its own two M1 cycles increment R twice before A := R
    // Documented: A receives R *after* both M1 increments of this very op.
    expect(h.cpu.a & 0x7F).toBe((0x42 + 2) & 0x7F);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 16-bit arithmetic
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — ADD HL,rr', () => {
  it('preserves S/Z/PV; sets C and H from bit-12/bit-16 carries', () => {
    const h = newCpu();
    h.cpu.hl = 0x0FFF; h.cpu.bc = 0x0001; h.cpu.f = F_S | F_Z | F_PV;
    load(h.mem, 0, 0x09); // ADD HL,BC
    step(h);
    expect(h.cpu.hl).toBe(0x1000);
    expect(h.cpu.f & F_H).toBe(F_H);    // half-carry out of bit 11
    expect(h.cpu.f & F_C).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
    // S/Z/PV preserved
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('overflow into bit 16 sets C', () => {
    const h = newCpu();
    h.cpu.hl = 0xFFFF; h.cpu.bc = 0x0001;
    load(h.mem, 0, 0x09);
    step(h);
    expect(h.cpu.hl).toBe(0x0000);
    expect(h.cpu.f & F_C).toBe(F_C);
  });
});

describe('Z80 — ED SBC HL,rr', () => {
  it('SBC HL,DE with HL=0, DE=1, C=0 → 0xFFFF, S/H/C/N set', () => {
    const h = newCpu();
    h.cpu.hl = 0x0000; h.cpu.de = 0x0001; h.cpu.f = 0;
    load(h.mem, 0, 0xED, 0x52);
    step(h);
    expect(h.cpu.hl).toBe(0xFFFF);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_N).toBe(F_N);
  });
});

describe('Z80 — ED ADC HL,rr', () => {
  it('ADC HL,BC adds HL, BC, and carry', () => {
    const h = newCpu();
    h.cpu.hl = 0x0001; h.cpu.bc = 0x0001; h.cpu.f = F_C;
    load(h.mem, 0, 0xED, 0x4A); // ADC HL,BC
    step(h);
    expect(h.cpu.hl).toBe(0x0003);
    expect(h.cpu.f & F_C).toBe(0);
    expect(h.cpu.f & F_N).toBe(0); // ADC clears N (unlike SBC)
  });

  it('carry out of bit 15 sets C', () => {
    const h = newCpu();
    h.cpu.hl = 0xFFFF; h.cpu.bc = 0x0000; h.cpu.f = F_C;
    load(h.mem, 0, 0xED, 0x4A);
    step(h);
    expect(h.cpu.hl).toBe(0x0000);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_Z).toBe(F_Z);
  });

  it('signed overflow sets V: 0x7FFF + 0 + C=1 → 0x8000', () => {
    const h = newCpu();
    h.cpu.hl = 0x7FFF; h.cpu.bc = 0x0000; h.cpu.f = F_C;
    load(h.mem, 0, 0xED, 0x4A);
    step(h);
    expect(h.cpu.hl).toBe(0x8000);
    expect(h.cpu.f & F_PV).toBe(F_PV);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_C).toBe(0);
  });

  it('result zero with no carry sets Z', () => {
    const h = newCpu();
    h.cpu.hl = 0x0000; h.cpu.bc = 0x0000; h.cpu.f = 0;
    load(h.mem, 0, 0xED, 0x4A);
    step(h);
    expect(h.cpu.hl).toBe(0x0000);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_S).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// IX / IY (DD / FD prefix)
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

// ─────────────────────────────────────────────────────────────────────────
// Accumulator rotations — RLCA / RRCA / RLA / RRA
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — RLCA / RRCA / RLA / RRA', () => {
  it('RLCA: rotates A left, bit 7 wraps to bit 0 and to C', () => {
    const h = newCpu();
    h.cpu.a = 0x85; // 10000101
    load(h.mem, 0, 0x07); // RLCA
    step(h);
    expect(h.cpu.a).toBe(0x0B); // 00001011: bit7=1 wrapped to bit0
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('RLCA: C clear when bit 7 was 0', () => {
    const h = newCpu();
    h.cpu.a = 0x42; // 01000010
    load(h.mem, 0, 0x07);
    step(h);
    expect(h.cpu.a).toBe(0x84);
    expect(h.cpu.f & F_C).toBe(0);
  });

  it('RLCA: clears H and N; preserves S, Z, PV from before', () => {
    const h = newCpu();
    h.cpu.a = 0x01;
    h.cpu.f = F_S | F_Z | F_PV | F_H | F_N; // all set before
    load(h.mem, 0, 0x07);
    step(h);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_S).toBe(F_S); // preserved
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('RLCA: F3/F5 come from result bits 3 and 5', () => {
    const h = newCpu();
    h.cpu.a = 0x14; // 00010100 → rotated → 00101000 = 0x28
    load(h.mem, 0, 0x07);
    step(h);
    expect(h.cpu.a).toBe(0x28);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });

  it('RRCA: rotates A right, bit 0 wraps to bit 7 and to C', () => {
    const h = newCpu();
    h.cpu.a = 0x85; // 10000101
    load(h.mem, 0, 0x0F); // RRCA
    step(h);
    expect(h.cpu.a).toBe(0xC2); // 11000010: bit0=1 wrapped to bit7
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('RRCA: C clear when bit 0 was 0', () => {
    const h = newCpu();
    h.cpu.a = 0x84; // 10000100
    load(h.mem, 0, 0x0F);
    step(h);
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.f & F_C).toBe(0);
  });

  it('RRCA: clears H and N', () => {
    const h = newCpu();
    h.cpu.a = 0x02;
    h.cpu.f = F_H | F_N;
    load(h.mem, 0, 0x0F);
    step(h);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
  });

  it('RLA: rotates A left through carry (old C into bit 0, bit 7 to new C)', () => {
    const h = newCpu();
    h.cpu.a = 0x85; // 10000101
    h.cpu.f = F_C;  // incoming carry = 1
    load(h.mem, 0, 0x17); // RLA
    step(h);
    // bit7 (1) → new C; bit0 ← old C (1); A = 00001011
    expect(h.cpu.a).toBe(0x0B);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('RLA: incoming C=0 feeds into bit 0', () => {
    const h = newCpu();
    h.cpu.a = 0x80; // 10000000
    h.cpu.f = 0;    // carry clear
    load(h.mem, 0, 0x17);
    step(h);
    expect(h.cpu.a).toBe(0x00); // bit7 shifted out, bit0=0 from old C
    expect(h.cpu.f & F_C).toBe(F_C); // bit7 went to C
  });

  it('RLA: clears H and N; preserves S/Z/PV', () => {
    const h = newCpu();
    h.cpu.a = 0x01;
    h.cpu.f = F_S | F_Z | F_PV | F_H | F_N;
    load(h.mem, 0, 0x17);
    step(h);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('RRA: rotates A right through carry (old C into bit 7, bit 0 to new C)', () => {
    const h = newCpu();
    h.cpu.a = 0x85; // 10000101
    h.cpu.f = 0;    // incoming carry = 0
    load(h.mem, 0, 0x1F); // RRA
    step(h);
    // bit0 (1) → new C; bit7 ← old C (0); A = 01000010
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('RRA: incoming C=1 feeds into bit 7', () => {
    const h = newCpu();
    h.cpu.a = 0x84; // 10000100
    h.cpu.f = F_C;  // carry set
    load(h.mem, 0, 0x1F);
    step(h);
    expect(h.cpu.a).toBe(0xC2); // bit7 ← 1 from old C; 11000010
    expect(h.cpu.f & F_C).toBe(0); // bit0 was 0
  });

  it('RRA: clears H and N', () => {
    const h = newCpu();
    h.cpu.a = 0x02;
    h.cpu.f = F_H | F_N;
    load(h.mem, 0, 0x1F);
    step(h);
    expect(h.cpu.f & F_H).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Stack-based interrupt vector handling — regression area
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — interruptWithVector(vector)', () => {
  it('returns 0 and clears pending vector when blocked by IFF1', () => {
    const h = newCpu();
    h.cpu.im = 2;
    h.cpu.iff1 = false;
    expect(h.cpu.interruptWithVector(0x10)).toBe(0);
    expect(h.cpu._pendingVector).toBe(0xFF);
  });
});
