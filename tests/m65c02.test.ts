/**
 * 65C02 core tests.
 *
 * Expectations come from the G65SC02/WDC 65C02 datasheets (instruction set and
 * cycle counts) and Bruce Clark's decimal-mode notes, not from the code under
 * test.
 */

import { describe, it, expect } from 'vitest';
import { M6502, FLAG_C, FLAG_Z, FLAG_I, FLAG_D, FLAG_V, FLAG_N } from '@/cores/m6502.ts';
import { M65C02 } from '@/cores/m65c02.ts';

function harness(cmos = true) {
  const mem = new Uint8Array(0x10000);
  const cpu = cmos ? new M65C02() : new M6502();
  cpu.read = (a: number) => mem[a & 0xFFFF];
  cpu.write = (a: number, v: number) => { mem[a & 0xFFFF] = v & 0xFF; };
  return { cpu, mem };
}

function boot(mem: Uint8Array, cpu: M6502, bytes: number[], org = 0x0300): void {
  for (let i = 0; i < bytes.length; i++) mem[org + i] = bytes[i];
  cpu.pc = org;
}

describe('m65c02 — identity', () => {
  it('reports itself as CMOS, and the NMOS core does not', () => {
    expect(harness(true).cpu.cmos).toBe(true);
    expect(harness(false).cpu.cmos).toBe(false);
  });
});

describe('m65c02 — new instructions', () => {
  it('BRA is always taken, with the branch timing', () => {
    const { cpu, mem } = harness();
    boot(mem, cpu, [0x80, 0x10]);
    cpu.step();
    expect(cpu.pc).toBe(0x0312);
    expect(cpu.tStates).toBe(3);
    boot(mem, cpu, [0x80, 0xFE], 0x03F0);          // back to itself... crossing nothing
    const t = cpu.tStates;
    cpu.step();
    expect(cpu.pc).toBe(0x03F0);
    expect(cpu.tStates - t).toBe(3);
  });

  it('BRA across a page costs one more cycle', () => {
    const { cpu, mem } = harness();
    boot(mem, cpu, [0x80, 0x10], 0x03F0);
    cpu.step();
    expect(cpu.pc).toBe(0x0402);
    expect(cpu.tStates).toBe(4);
  });

  it('PHX/PHY/PLX/PLY move the index registers through the stack', () => {
    const { cpu, mem } = harness();
    boot(mem, cpu, [0xDA, 0x5A, 0xFA, 0x7A]);        // PHX PHY PLX PLY
    cpu.x = 0x11; cpu.y = 0x00;
    cpu.step(); cpu.step();
    cpu.step();                                       // PLX pops Y's byte
    expect(cpu.x).toBe(0x00);
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
    cpu.step();                                       // PLY pops X's byte
    expect(cpu.y).toBe(0x11);
    expect(cpu.p & FLAG_Z).toBe(0);
  });

  it('STZ stores zero in all four modes without touching flags', () => {
    const { cpu, mem } = harness();
    mem[0x20] = mem[0x25] = mem[0x1234] = mem[0x1239] = 0xFF;
    cpu.x = 5;
    const before = cpu.p;
    boot(mem, cpu, [0x64, 0x20, 0x74, 0x20, 0x9C, 0x34, 0x12, 0x9E, 0x34, 0x12]);
    for (let i = 0; i < 4; i++) cpu.step();
    expect([mem[0x20], mem[0x25], mem[0x1234], mem[0x1239]]).toEqual([0, 0, 0, 0]);
    expect(cpu.p).toBe(before);
  });

  it('INC A and DEC A set N and Z', () => {
    const { cpu, mem } = harness();
    boot(mem, cpu, [0x1A, 0x3A, 0x3A]);
    cpu.a = 0xFF;
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
    cpu.step();
    expect(cpu.a).toBe(0xFF);
    expect(cpu.p & FLAG_N).toBe(FLAG_N);
  });

  it('TSB sets bits and reports Z from A AND memory; TRB clears them', () => {
    const { cpu, mem } = harness();
    mem[0x40] = 0x0F;
    cpu.a = 0xF0;
    boot(mem, cpu, [0x04, 0x40, 0x14, 0x40]);
    cpu.step();                                       // TSB $40
    expect(mem[0x40]).toBe(0xFF);
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);              // 0xF0 & 0x0F == 0
    cpu.step();                                       // TRB $40
    expect(mem[0x40]).toBe(0x0F);
    expect(cpu.p & FLAG_Z).toBe(0);                   // 0xF0 & 0xFF != 0
  });

  it('BIT immediate changes only Z, while BIT zp,X changes N and V too', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x01;
    cpu.p |= FLAG_N | FLAG_V;
    boot(mem, cpu, [0x89, 0xC0]);
    cpu.step();
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
    expect(cpu.p & (FLAG_N | FLAG_V)).toBe(FLAG_N | FLAG_V);
    mem[0x13] = 0x41;
    cpu.x = 3;
    boot(mem, cpu, [0x34, 0x10]);
    cpu.step();
    expect(cpu.p & FLAG_N).toBe(0);
    expect(cpu.p & FLAG_V).toBe(FLAG_V);
    expect(cpu.p & FLAG_Z).toBe(0);
  });

  it('(zp) addressing works for LDA/STA/ADC and wraps the pointer in zero page', () => {
    const { cpu, mem } = harness();
    mem[0xFF] = 0x00; mem[0x00] = 0x20;               // pointer at $FF/$00 -> $2000
    mem[0x2000] = 0x42;
    boot(mem, cpu, [0xB2, 0xFF, 0x72, 0xFF, 0x92, 0xFF]);
    cpu.step();
    expect(cpu.a).toBe(0x42);
    cpu.p &= ~FLAG_C;
    cpu.step();                                       // ADC (zp)
    expect(cpu.a).toBe(0x84);
    cpu.step();                                       // STA (zp)
    expect(mem[0x2000]).toBe(0x84);
    expect(cpu.tStates).toBe(15);
  });

  it('JMP (abs,X) indexes the pointer', () => {
    const { cpu, mem } = harness();
    mem[0x2004] = 0x34; mem[0x2005] = 0x12;
    cpu.x = 4;
    boot(mem, cpu, [0x7C, 0x00, 0x20]);
    cpu.step();
    expect(cpu.pc).toBe(0x1234);
    expect(cpu.tStates).toBe(6);
  });

  it('JMP (abs) reads across a page boundary correctly (no NMOS bug)', () => {
    const { cpu, mem } = harness();
    mem[0x20FF] = 0x34; mem[0x2100] = 0x12; mem[0x2000] = 0x99;
    boot(mem, cpu, [0x6C, 0xFF, 0x20]);
    cpu.step();
    expect(cpu.pc).toBe(0x1234);
    const n = harness(false);
    n.mem[0x20FF] = 0x34; n.mem[0x2100] = 0x12; n.mem[0x2000] = 0x99;
    boot(n.mem, n.cpu, [0x6C, 0xFF, 0x20]);
    n.cpu.step();
    expect(n.cpu.pc).toBe(0x9934);                    // NMOS wraps within the page
  });
});

describe('m65c02 — undocumented NMOS opcodes are NOPs', () => {
  const cases: [number, number, number][] = [
    [0x03, 1, 1], [0xA3, 1, 1], [0xE7, 1, 1], [0xFB, 1, 1], [0xAF, 1, 1],
    [0x02, 2, 2], [0xE2, 2, 2], [0x44, 2, 3], [0x54, 2, 4], [0xF4, 2, 4],
    [0x5C, 3, 8], [0xDC, 3, 4], [0xFC, 3, 4],
  ];
  for (const [op, len, cycles] of cases) {
    it(`$${op.toString(16).toUpperCase().padStart(2, '0')} is a ${len}-byte, ${cycles}-cycle NOP`, () => {
      const { cpu, mem } = harness();
      cpu.a = 0x55; cpu.x = 0x66;
      const p = cpu.p;
      boot(mem, cpu, [op, 0x12, 0x34]);
      cpu.step();
      expect(cpu.pc).toBe(0x0300 + len);
      expect(cpu.tStates).toBe(cycles);
      expect([cpu.a, cpu.x, cpu.p]).toEqual([0x55, 0x66, p]);
    });
  }
});

describe('m65c02 — decimal mode', () => {
  it('ADC gives a valid Z flag from the decimal result', () => {
    const { cpu, mem } = harness();
    cpu.p |= FLAG_D;
    cpu.p &= ~FLAG_C;
    cpu.a = 0x99;
    boot(mem, cpu, [0x69, 0x01]);                     // 99 + 01 = 100 -> 00 with carry
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
    expect(cpu.tStates).toBe(3);                      // one extra cycle in decimal mode
  });

  it('ADC adds with carry through the nibbles', () => {
    const { cpu, mem } = harness();
    cpu.p |= FLAG_D | FLAG_C;
    cpu.a = 0x58;
    boot(mem, cpu, [0x69, 0x46]);                     // 58 + 46 + 1 = 105
    cpu.step();
    expect(cpu.a).toBe(0x05);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
  });

  it('SBC subtracts decimally with a valid Z/N', () => {
    const { cpu, mem } = harness();
    cpu.p |= FLAG_D | FLAG_C;
    cpu.a = 0x46;
    boot(mem, cpu, [0xE9, 0x12]);                     // 46 - 12 = 34
    cpu.step();
    expect(cpu.a).toBe(0x34);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
    cpu.p |= FLAG_C;
    cpu.a = 0x21;
    boot(mem, cpu, [0xE9, 0x34]);                     // 21 - 34 = -13 -> 87 with borrow
    cpu.step();
    expect(cpu.a).toBe(0x87);
    expect(cpu.p & FLAG_C).toBe(0);
    expect(cpu.p & FLAG_N).toBe(FLAG_N);
  });

  it('binary ADC/SBC are unchanged', () => {
    const { cpu, mem } = harness();
    cpu.p &= ~(FLAG_D | FLAG_C);
    cpu.a = 0x50;
    boot(mem, cpu, [0x69, 0x50]);
    cpu.step();
    expect(cpu.a).toBe(0xA0);
    expect(cpu.p & FLAG_V).toBe(FLAG_V);
    expect(cpu.tStates).toBe(2);
  });
});

describe('m65c02 — interrupts and BRK clear decimal mode', () => {
  it('BRK clears D and sets I', () => {
    const { cpu, mem } = harness();
    mem[0xFFFE] = 0x00; mem[0xFFFF] = 0x90;
    cpu.p |= FLAG_D;
    boot(mem, cpu, [0x00, 0x00]);
    cpu.step();
    expect(cpu.pc).toBe(0x9000);
    expect(cpu.p & FLAG_D).toBe(0);
    expect(cpu.p & FLAG_I).toBe(FLAG_I);
    expect(mem[0x01FB] & FLAG_D).toBe(FLAG_D);    // the pushed P still has D
  });

  it('IRQ clears D too', () => {
    const { cpu, mem } = harness();
    mem[0xFFFE] = 0x00; mem[0xFFFF] = 0x90;
    cpu.p = (cpu.p | FLAG_D) & ~FLAG_I;
    boot(mem, cpu, [0xEA]);
    cpu.setIRQ(true);
    cpu.step();
    expect(cpu.pc).toBe(0x9000);
    expect(cpu.p & FLAG_D).toBe(0);
  });
});
