/**
 * MOS 6502 core tests.
 *
 * Expectations are derived from the MOS 6502 datasheet / the well-known NMOS
 * cycle table, not from the implementation under test. Edge cases (carry,
 * overflow, decimal mode, page crossings, zero-page pointer wrap) are the point.
 */

import { describe, it, expect } from 'vitest';
import {
  M6502, FLAG_C, FLAG_Z, FLAG_I, FLAG_D, FLAG_B, FLAG_U, FLAG_V, FLAG_N,
} from '@/cores/m6502.ts';

function harness() {
  const mem = new Uint8Array(0x10000);
  const cpu = new M6502();
  cpu.read = (a: number) => mem[a & 0xFFFF];
  cpu.write = (a: number, v: number) => { mem[a & 0xFFFF] = v & 0xFF; };
  return { cpu, mem };
}

/** Place a program at `org` and point PC at it. */
function boot(mem: Uint8Array, cpu: M6502, org: number, bytes: number[]): void {
  for (let i = 0; i < bytes.length; i++) mem[org + i] = bytes[i];
  cpu.pc = org;
}

describe('m6502 — reset & basic execution', () => {
  it('loads PC from the reset vector and initialises SP/P', () => {
    const { cpu, mem } = harness();
    mem[0xFFFC] = 0x00;
    mem[0xFFFD] = 0x80;
    cpu.reset();
    expect(cpu.pc).toBe(0x8000);
    expect(cpu.sp).toBe(0xFD);
    expect(cpu.p & FLAG_I).toBe(FLAG_I);
    expect(cpu.p & FLAG_U).toBe(FLAG_U);
    expect(cpu.tStates).toBe(0);
  });

  it('LDA #imm sets N and Z correctly', () => {
    const { cpu, mem } = harness();
    boot(mem, cpu, 0x0200, [0xA9, 0x00]);
    cpu.step(); // LDA #0
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
    expect(cpu.p & FLAG_N).toBe(0);
    expect(cpu.tStates).toBe(2);
  });

  it('STA zp then LDA zp round-trips a byte', () => {
    const { cpu, mem } = harness();
    boot(mem, cpu, 0x0200, [0xA9, 0x42, 0x85, 0x10, 0xA9, 0x00, 0xA5, 0x10]);
    cpu.step(); // LDA #$42
    cpu.step(); // STA $10
    expect(mem[0x10]).toBe(0x42);
    cpu.step(); // LDA #0
    cpu.step(); // LDA $10
    expect(cpu.a).toBe(0x42);
    expect(cpu.p & FLAG_Z).toBe(0);
  });
});

describe('m6502 — ADC/SBC binary flags', () => {
  it('positive + positive = negative sets V', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x50; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x69, 0x50]);
    cpu.step();
    expect(cpu.a).toBe(0xA0);
    expect(cpu.p & FLAG_C).toBe(0);
    expect(cpu.p & FLAG_V).toBe(FLAG_V);
    expect(cpu.p & FLAG_N).toBe(FLAG_N);
    expect(cpu.p & FLAG_Z).toBe(0);
  });

  it('FF + 01 wraps to 00 with carry and zero', () => {
    const { cpu, mem } = harness();
    cpu.a = 0xFF; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x69, 0x01]);
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
    expect(cpu.p & FLAG_V).toBe(0);
  });

  it('80 + 80 overflows to 00 with carry', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x80; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x69, 0x80]);
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
    expect(cpu.p & FLAG_V).toBe(FLAG_V);
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
  });

  it('SBC borrows: 50 - B0 leaves A0 with carry clear and V set', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x50; cpu.p |= FLAG_C;
    boot(mem, cpu, 0x0200, [0xE9, 0xB0]);
    cpu.step();
    expect(cpu.a).toBe(0xA0);
    expect(cpu.p & FLAG_C).toBe(0);
    expect(cpu.p & FLAG_V).toBe(FLAG_V);
  });

  it('SBC 00 - 01 => FF, C clear, N set', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x00; cpu.p |= FLAG_C;
    boot(mem, cpu, 0x0200, [0xE9, 0x01]);
    cpu.step();
    expect(cpu.a).toBe(0xFF);
    expect(cpu.p & FLAG_C).toBe(0);
    expect(cpu.p & FLAG_N).toBe(FLAG_N);
  });
});

describe('m6502 — decimal mode', () => {
  it('19 + 01 = 20 (BCD), no carry', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x19; cpu.p |= FLAG_D; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x69, 0x01]);
    cpu.step();
    expect(cpu.a).toBe(0x20);
    expect(cpu.p & FLAG_C).toBe(0);
  });

  it('99 + 01 = 00 with carry (BCD)', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x99; cpu.p |= FLAG_D; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x69, 0x01]);
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
  });

  it('20 - 01 = 19 (BCD), no borrow', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x20; cpu.p |= FLAG_D | FLAG_C;
    boot(mem, cpu, 0x0200, [0xE9, 0x01]);
    cpu.step();
    expect(cpu.a).toBe(0x19);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
  });

  it('00 - 01 = 99 with borrow (BCD)', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x00; cpu.p |= FLAG_D | FLAG_C;
    boot(mem, cpu, 0x0200, [0xE9, 0x01]);
    cpu.step();
    expect(cpu.a).toBe(0x99);
    expect(cpu.p & FLAG_C).toBe(0);
  });

  it('decimal Z uses the binary result (NMOS quirk)', () => {
    const { cpu, mem } = harness();
    // 0x99 + 0x01 => decimal 0x00 (Z would be set) but binary 0x9A (not zero).
    cpu.a = 0x99; cpu.p |= FLAG_D; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x69, 0x01]);
    cpu.step();
    expect(cpu.p & FLAG_Z).toBe(0);
  });
});

describe('m6502 — shifts & rotates', () => {
  it('ASL $80 => 00, C set, Z set', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x80; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x0A]);
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
  });

  it('ROL A rotates carry in and out', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x80; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x2A]);
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
  });

  it('ROR $01 => 00 with carry set', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x01; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x6A]);
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
  });

  it('LSR $01 => 00 with carry set', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x01; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x4A]);
    cpu.step();
    expect(cpu.a).toBe(0x00);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
  });
});

describe('m6502 — compares', () => {
  it('CMP sets carry when A >= M', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x00;
    boot(mem, cpu, 0x0200, [0xC9, 0x01]);
    cpu.step();
    expect(cpu.p & FLAG_C).toBe(0);
    expect(cpu.p & FLAG_N).toBe(FLAG_N);
  });

  it('CMP equal sets Z and C', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x01;
    boot(mem, cpu, 0x0200, [0xC9, 0x01]);
    cpu.step();
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
  });
});

describe('m6502 — flow control', () => {
  it('JSR pushes PC-1 and RTS returns to the next instruction', () => {
    const { cpu, mem } = harness();
    // JSR $0300 at $0200; RTS at $0300.
    mem[0x0200] = 0x20; mem[0x0201] = 0x00; mem[0x0202] = 0x03;
    mem[0x0300] = 0x60;
    cpu.pc = 0x0200;
    cpu.step(); // JSR
    expect(cpu.pc).toBe(0x0300);
    expect(cpu.sp).toBe(0xFB);
    // Pushed value is $0202: lo at $01FC, hi at $01FD.
    expect(mem[0x01FC]).toBe(0x02);
    expect(mem[0x01FD]).toBe(0x02);
    cpu.step(); // RTS
    expect(cpu.pc).toBe(0x0203);
    expect(cpu.sp).toBe(0xFD);
  });

  it('BEQ not taken costs 2 cycles', () => {
    const { cpu, mem } = harness();
    cpu.p |= FLAG_Z;
    boot(mem, cpu, 0x0200, [0xF0, 0x00]);
    cpu.a = 0x01; cpu.p &= ~FLAG_Z; // not equal
    cpu.pc = 0x0200;
    cpu.step();
    expect(cpu.tStates).toBe(2);
    expect(cpu.pc).toBe(0x0202);
  });

  it('BEQ taken same page costs 3 cycles', () => {
    const { cpu, mem } = harness();
    boot(mem, cpu, 0x0200, [0xF0, 0x02]);
    cpu.p |= FLAG_Z;
    cpu.step();
    expect(cpu.tStates).toBe(3);
    expect(cpu.pc).toBe(0x0204);
  });

  it('BEQ taken across a page costs 4 cycles', () => {
    const { cpu, mem } = harness();
    // PC after operand = $02FD; +$06 => $0303 (page crossed).
    boot(mem, cpu, 0x02FB, [0xF0, 0x06]);
    cpu.p |= FLAG_Z;
    cpu.step();
    expect(cpu.tStates).toBe(4);
    expect(cpu.pc).toBe(0x0303);
  });

  it('JMP (indirect) reproduces the page-wrap bug', () => {
    const { cpu, mem } = harness();
    // Pointer at $02FF: low byte at $02FF, high byte wraps to $0200 (not $0300).
    mem[0x02FF] = 0x34; mem[0x0200] = 0x12; mem[0x0300] = 0x56;
    boot(mem, cpu, 0x0100, [0x6C, 0xFF, 0x02]);
    cpu.step();
    expect(cpu.pc).toBe(0x1234);
  });
});

describe('m6502 — interrupts', () => {
  it('IRQ pushes state and vectors when I is clear', () => {
    const { cpu, mem } = harness();
    mem[0xFFFE] = 0x00; mem[0xFFFF] = 0x40;
    cpu.pc = 0x1234;
    cpu.p &= ~FLAG_I;
    cpu.irqLine = true;
    cpu.step();
    expect(cpu.pc).toBe(0x4000);
    expect(cpu.p & FLAG_I).toBe(FLAG_I);
    expect(cpu.sp).toBe(0xFA);
    // Saved PC: high byte at $01FD, low byte at $01FC; status at $01FB (B clear).
    expect(mem[0x01FD]).toBe(0x12);
    expect(mem[0x01FC]).toBe(0x34);
    expect(mem[0x01FB] & FLAG_B).toBe(0);
  });

  it('IRQ is masked when I is set', () => {
    const { cpu, mem } = harness();
    mem[0xFFFE] = 0x00; mem[0xFFFF] = 0x40;
    cpu.pc = 0x1234;
    cpu.p |= FLAG_I;
    cpu.irqLine = true;
    boot(mem, cpu, 0x1234, [0xEA]); // NOP — IRQ ignored
    cpu.step();
    expect(cpu.pc).toBe(0x1235);
  });

  it('NMI vectors through FFFA regardless of I', () => {
    const { cpu, mem } = harness();
    mem[0xFFFA] = 0x00; mem[0xFFFB] = 0x50;
    cpu.pc = 0x1234;
    cpu.p |= FLAG_I;
    cpu.nmi();
    cpu.step();
    expect(cpu.pc).toBe(0x5000);
  });

  it('BRK pushes PC+1 and sets B in the saved status', () => {
    const { cpu, mem } = harness();
    mem[0xFFFE] = 0x00; mem[0xFFFF] = 0x40;
    boot(mem, cpu, 0x0200, [0x00, 0xEA]);
    cpu.step();
    expect(cpu.pc).toBe(0x4000);
    expect(cpu.sp).toBe(0xFA);
    // Saved PC is BRK+1 = $0202: high at $01FD, low at $01FC.
    expect(mem[0x01FD]).toBe(0x02);
    expect(mem[0x01FC]).toBe(0x02);
    expect(mem[0x01FB] & FLAG_B).toBe(FLAG_B); // saved P includes B
  });
});

describe('m6502 — addressing modes', () => {
  it('(zp,X) wraps the pointer in zero page', () => {
    const { cpu, mem } = harness();
    cpu.x = 0xFF;
    // zp+X = $7F; pointer lo at $7F, hi at $80 (wrap).
    mem[0x007F] = 0x00;
    mem[0x0080] = 0x30;
    mem[0x3000] = 0x77;
    boot(mem, cpu, 0x0200, [0xA1, 0x80]);
    cpu.step();
    expect(cpu.a).toBe(0x77);
    expect(cpu.tStates).toBe(6);
  });

  it('(zp),Y adds a cycle on page cross', () => {
    const { cpu, mem } = harness();
    cpu.y = 0x01;
    mem[0x0010] = 0xFF;
    mem[0x0011] = 0x00; // base $00FF
    mem[0x0100] = 0x55;
    boot(mem, cpu, 0x0200, [0xB1, 0x10]);
    cpu.step();
    expect(cpu.a).toBe(0x55);
    expect(cpu.tStates).toBe(6); // 5 + page cross
  });

  it('abs,X adds a cycle on page cross', () => {
    const { cpu, mem } = harness();
    cpu.x = 0x01;
    mem[0x0100] = 0x99;
    boot(mem, cpu, 0x0200, [0xBD, 0xFF, 0x00]); // LDA $00FF,X
    cpu.step();
    expect(cpu.a).toBe(0x99);
    expect(cpu.tStates).toBe(5); // 4 + page cross
  });

  it('STA (zp,X) stores A through the indexed pointer', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x5A; cpu.x = 0x03;
    // Pointer at $13/$14 (base $10 + X): -> $3000.
    mem[0x0013] = 0x00;
    mem[0x0014] = 0x30;
    boot(mem, cpu, 0x0200, [0x81, 0x10]);
    cpu.step();
    expect(mem[0x3000]).toBe(0x5A);
  });
});

describe('m6502 — stable undocumented opcodes', () => {
  it('LAX zp loads A and X', () => {
    const { cpu, mem } = harness();
    mem[0x10] = 0x5A;
    boot(mem, cpu, 0x0200, [0xA7, 0x10]);
    cpu.step();
    expect(cpu.a).toBe(0x5A);
    expect(cpu.x).toBe(0x5A);
  });

  it('SAX zp stores A & X', () => {
    const { cpu, mem } = harness();
    cpu.a = 0xF0; cpu.x = 0x3C;
    boot(mem, cpu, 0x0200, [0x87, 0x10]);
    cpu.step();
    expect(mem[0x10]).toBe(0x30);
  });

  it('DCP zp decrements then compares', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x05; mem[0x10] = 0x06;
    boot(mem, cpu, 0x0200, [0xC7, 0x10]);
    cpu.step();
    expect(mem[0x10]).toBe(0x05);
    expect(cpu.p & FLAG_Z).toBe(FLAG_Z);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
  });

  it('ISC zp increments then subtracts with borrow', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x05; cpu.p |= FLAG_C; mem[0x10] = 0x01;
    boot(mem, cpu, 0x0200, [0xE7, 0x10]);
    cpu.step();
    expect(mem[0x10]).toBe(0x02);
    expect(cpu.a).toBe(0x03);
  });

  it('SLO zp shifts left then ORs', () => {
    const { cpu, mem } = harness();
    cpu.a = 0x01; mem[0x10] = 0x40; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x07, 0x10]);
    cpu.step();
    expect(mem[0x10]).toBe(0x80);
    expect(cpu.a).toBe(0x81);
    expect(cpu.p & FLAG_C).toBe(0);
  });

  it('ANC # ANDs and copies bit 7 to carry', () => {
    const { cpu, mem } = harness();
    cpu.a = 0xFF; cpu.p &= ~FLAG_C;
    boot(mem, cpu, 0x0200, [0x0B, 0x80]);
    cpu.step();
    expect(cpu.a).toBe(0x80);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
  });

  it('ALR # ANDs then shifts right', () => {
    const { cpu, mem } = harness();
    cpu.a = 0xFF;
    boot(mem, cpu, 0x0200, [0x4B, 0x03]);
    cpu.step();
    // (0xFF & 0x03) = 0x03 -> >>1 = 0x01, C = 1
    expect(cpu.a).toBe(0x01);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
  });

  it('AXS # subtracts immediate from A&X without affecting A', () => {
    const { cpu, mem } = harness();
    cpu.a = 0xFF; cpu.x = 0x0F;
    boot(mem, cpu, 0x0200, [0xCB, 0x05]);
    cpu.step();
    expect(cpu.x).toBe(0x0A);
    expect(cpu.a).toBe(0xFF);
    expect(cpu.p & FLAG_C).toBe(FLAG_C);
  });
});
