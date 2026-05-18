/**
 * Z80 load tests — 8-bit/16-bit loads, PUSH/POP, LD r,(HL),
 * LD (HL),r, LD A,(nn), LD SP,HL.
 */
import { describe, it, expect } from 'vitest';
import { newCpu, load, step, type Harness, F_C, F_Z } from './_harness.ts';

describe('Z80 — 8-bit loads', () => {
  it('LD r,n loads immediate', () => {
    const h = newCpu();
    load(h.mem, 0, 0x3E, 0x42); // LD A,$42
    step(h);
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.pc).toBe(2);
  });

  it("LD r,r' copies register without affecting flags", () => {
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

describe('Z80 — LD r,(HL) and LD (HL),r', () => {
  it('LD B,(HL) reads from the address in HL into B', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x55;
    load(h.mem, 0, 0x46); // LD B,(HL)
    step(h);
    expect(h.cpu.b).toBe(0x55);
    expect(h.cpu.hl).toBe(0xC000); // HL unchanged
  });

  it('LD C,(HL) / LD D,(HL) / LD E,(HL) / LD H,(HL) / LD L,(HL) all work', () => {
    const regs = [
      { op: 0x4E, get: (h: Harness) => h.cpu.c },
      { op: 0x56, get: (h: Harness) => h.cpu.d },
      { op: 0x5E, get: (h: Harness) => h.cpu.e },
      { op: 0x66, get: (h: Harness) => h.cpu.h },
      { op: 0x6E, get: (h: Harness) => h.cpu.l },
    ];
    for (const { op, get } of regs) {
      const h = newCpu();
      h.cpu.hl = 0xD000;
      h.mem[0xD000] = 0xAB;
      load(h.mem, 0, op);
      step(h);
      expect(get(h)).toBe(0xAB);
    }
  });

  it('LD (HL),B writes B into memory at HL', () => {
    const h = newCpu();
    h.cpu.hl = 0xC100;
    h.cpu.b = 0x77;
    load(h.mem, 0, 0x70); // LD (HL),B
    step(h);
    expect(h.mem[0xC100]).toBe(0x77);
  });

  it('LD (HL),A writes A into memory at HL', () => {
    const h = newCpu();
    h.cpu.hl = 0xC200;
    h.cpu.a = 0x42;
    load(h.mem, 0, 0x77); // LD (HL),A
    step(h);
    expect(h.mem[0xC200]).toBe(0x42);
  });

  it('LD (HL),B does not modify flags', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000; h.cpu.b = 0x01; h.cpu.f = 0xFF;
    load(h.mem, 0, 0x70);
    step(h);
    expect(h.cpu.f).toBe(0xFF);
  });
});

describe('Z80 — LD A,(nn)', () => {
  it('reads from the absolute address into A', () => {
    const h = newCpu();
    h.mem[0x8000] = 0xC3;
    load(h.mem, 0, 0x3A, 0x00, 0x80); // LD A,($8000)
    step(h);
    expect(h.cpu.a).toBe(0xC3);
    expect(h.cpu.pc).toBe(3);
  });

  it('does not affect flags', () => {
    const h = newCpu();
    h.mem[0x4000] = 0xFF; h.cpu.f = 0xAA;
    load(h.mem, 0, 0x3A, 0x00, 0x40);
    step(h);
    expect(h.cpu.f).toBe(0xAA);
  });
});

describe('Z80 — LD SP,HL', () => {
  it('copies HL into SP without affecting flags', () => {
    const h = newCpu();
    h.cpu.hl = 0xBEEF; h.cpu.f = F_C | F_Z;
    load(h.mem, 0, 0xF9); // LD SP,HL
    step(h);
    expect(h.cpu.sp).toBe(0xBEEF);
    expect(h.cpu.f & F_C).toBe(F_C);
    expect(h.cpu.f & F_Z).toBe(F_Z);
  });
});
