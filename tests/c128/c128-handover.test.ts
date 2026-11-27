/**
 * The two CPUs hand the bus to each other through the MMU's mode register
 * (bit 0: 1 the 8502, 0 the Z80). Out of power-on the 8502 starts as if reset
 * (the BIOS has set its vector); after that each carries on where it stopped.
 * CP/M 3 depends on it: its Z80 code calls the stub at $FFE0, which gives the
 * bus to the 8502 at the instruction after the one that started the Z80, to run
 * a disk handler, and takes it back the same way.
 */

import { describe, it, expect } from 'vitest';
import { C128Machine } from '@/machines/c128/c128-machine.ts';

/** A ROM-less machine: the Z80 BIOS starts the 8502 at $1100 on `program`, and when the 8502
 *  hands the bus back writes $77 at $2000 and starts the 8502 again. */
function machine(program: number[]): C128Machine {
  const table = 0x40;
  const bios = [
    0x3E, 0x3F, 0x32, 0x00, 0xFF,                         // 00 LD A,$3F : LD ($FF00),A
    0x21, table, 0x00,                                    // 05 LD HL,table
    0x11, 0x00, 0x11,                                     // 08 LD DE,$1100
    0x01, program.length & 0xFF, program.length >> 8,     // 0B LD BC,length
    0xED, 0xB0,                                           // 0E LDIR
    0x21, 0x00, 0x11,                                     // 10 LD HL,$1100
    0x22, 0xFC, 0xFF,                                     // 13 LD ($FFFC),HL
    0x3E, 0x3E, 0x32, 0x00, 0xFF,                         // 16 LD A,$3E : LD ($FF00),A
    0x01, 0x05, 0xD5, 0x3E, 0xB1,                         // 1B LD BC,$D505 : LD A,$B1
    0xED, 0x79,                                           // 20 OUT (C),A      the 8502 runs
    0x21, 0x00, 0x20, 0x36, 0x77,                         // 22 LD HL,$2000 : LD (HL),$77   the Z80 is back
    0xED, 0x79,                                           // 27 OUT (C),A      the 8502 again
    0x76,                                                 // 29 HALT
  ];
  const kernal = new Uint8Array(0x4000);
  kernal.set(bios, 0x1000);
  kernal.set(program, 0x1000 + table);
  const m = new C128Machine(null);
  m.loadRoms(null, null, kernal, null);
  m.reset();
  return m;
}

describe('handing the bus between the Z80 and the 8502', () => {
  it('resumes the 8502 where it stopped, not at its reset vector', () => {
    const m = machine([
      0xE6, 0x20,                                           // 1100 INC $20        counts how often the program starts
      0xA9, 0xB0, 0x8D, 0x05, 0xD5,                         // 1102 LDA #$B0 : STA $D505   the Z80 takes the bus
      0xE6, 0x21,                                           // 1107 INC $21        reached only on a resume
      0x4C, 0x09, 0x11,                                     // 1109 JMP *
    ]);
    for (let f = 0; f < 4; f++) m.tick();
    expect(m.memory.ram[0x20], 'started once').toBe(1);
    expect(m.memory.ram[0x2000], 'the Z80 ran in between').toBe(0x77);
    expect(m.memory.ram[0x21], 'and the 8502 went on after its STA').toBe(1);
    expect(m.cpuIs8502).toBe(true);
    m.destroy();
  });
});
