/**
 * The Z80's clock on the 128: the VIC-IIe makes it from AEC low as a 4 MHz
 * clock, two Z80 clocks to the 1 MHz cycle, with no wait states. Every
 * instruction therefore takes T-states / 2 master cycles, an odd T-state
 * carrying on into the next instruction (the real-hardware timing suite,
 * `c128z80timing`, measures exactly that: LDIR runs at 10.5 cycles a byte, not
 * the 11 a round-up gives). The Z80 has no NMI line.
 */

import { describe, it, expect } from 'vitest';
import { C128Machine } from '@/machines/c128/c128-machine.ts';

/** A machine whose Z80 BIOS is `program` (the BIOS sits at $1000 of the system ROM). */
function z80Running(program: number[]): C128Machine {
  const kernal = new Uint8Array(0x4000);
  kernal.set(program, 0x1000);
  const m = new C128Machine(null);
  m.loadRoms(null, null, kernal, null);
  m.reset();
  return m;
}

describe('the Z80 on the 128', () => {
  it('takes half its T-states in master cycles, carrying the odd one: LDIR is 10.5 cycles a byte', () => {
    const m = z80Running([
      0x21, 0x00, 0x20,                                   // LD HL,$2000
      0x11, 0x00, 0x30,                                   // LD DE,$3000
      0x01, 0x00, 0x04,                                   // LD BC,$0400
      0xED, 0xB0,                                         // LDIR
      0x76,                                               // HALT
    ]);
    let steps = 0;
    while (m.z80.pc !== 0x000B && steps++ < 5000) m.stepInstruction();
    expect(m.z80.pc).toBe(0x000B);
    // 3 x 10 T-states, then 1023 x 21 and a last pass of 16: 21,529 T-states.
    expect(m.z80.tStates).toBe(30 + 1023 * 21 + 16);
    expect(m.cpu.tStates, 'cycles of the 1 MHz clock').toBe(Math.floor((30 + 1023 * 21 + 16) / 2));
  });

  it('keeps the odd T-state from one instruction to the next: a run of 4-T-state ops and one 7-T-state op', () => {
    // 3 x LD A,n (7 T) = 21 T = 10.5 cycles, not 12 (3 x ceil(3.5)).
    const m = z80Running([0x3E, 0x01, 0x3E, 0x02, 0x3E, 0x03, 0x76]);
    for (let i = 0; i < 3; i++) m.stepInstruction();
    expect(m.cpu.tStates).toBe(10);
  });

  it('does not take an NMI: the line is not connected to it', () => {
    const m = z80Running([0xC3, 0x00, 0x00]);               // JP $0000
    // The Z80 would vector to $0066 on an NMI.
    m.keyboard.restore = true;
    let vectored = false;
    for (let i = 0; i < 20; i++) {
      m.stepInstruction();
      if (m.z80.pc === 0x0066) vectored = true;
    }
    expect(vectored, 'RESTORE does nothing to the Z80').toBe(false);
    m.keyboard.restore = false;
    expect(m.cpuIs8502).toBe(false);
  });
});
