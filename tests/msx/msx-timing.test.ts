import { describe, it, expect } from 'vitest';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';
import { Z80 } from '@/cores/z80.ts';

// Independent timings: https://map.grauw.nl/resources/z80instr.php (Z80+M1 column).
// DD/FD CB displacement and final opcode are memory reads, not additional M1s.
describe('MSX opcode wait states', () => {
  it.each([
    ['NOP', [0x00], 5],
    ['LD A,n', [0x3e, 0x42], 8],
    ['LD HL,nn', [0x21, 0x34, 0x12], 11],
    ['BIT 0,B', [0xcb, 0x40], 10],
    ['NEG', [0xed, 0x44], 10],
    ['LD IX,nn', [0xdd, 0x21, 0x34, 0x12], 16],
    ['LD IY,nn', [0xfd, 0x21, 0x34, 0x12], 16],
    ['BIT 0,(IX+0)', [0xdd, 0xcb, 0, 0x46], 22],
    ['BIT 0,(IY+0)', [0xfd, 0xcb, 0, 0x46], 22],
    ['redundant DD FD NOP', [0xdd, 0xfd, 0], 15],
  ] as const)('%s has the correct bus timing', (_name, bytes, cycles) => {
    const m = new MsxMachine('hx-10');
    try {
      m.memory.setPrimarySlots(0xaa);
      bytes.forEach((b, i) => m.memory.writeByte(i, b));
      m.cpu.step();
      expect(m.cpu.tStates).toBe(cycles);
    } finally { m.destroy(); }
  });

  it('keeps waits after reset and during HALT refetches', () => {
    const m = new MsxMachine('hx-10');
    try {
      m.reset();
      m.memory.setPrimarySlots(0xaa);
      m.memory.writeByte(0, 0x76);
      m.cpu.step();
      expect(m.cpu.tStates).toBe(5);
      m.cpu.step();
      expect(m.cpu.tStates).toBe(10);
    } finally { m.destroy(); }
  });

  it('charges both opcode waits on each LDIR iteration', () => {
    const m = new MsxMachine('hx-10');
    try {
      m.memory.setPrimarySlots(0xaa);
      m.memory.writeByte(0, 0xed); m.memory.writeByte(1, 0xb0);
      m.cpu.hl = 0x1000; m.cpu.de = 0x2000; m.cpu.bc = 2;
      m.cpu.step();
      expect(m.cpu.tStates).toBe(23);
      m.cpu.step();
      expect(m.cpu.tStates).toBe(41);
    } finally { m.destroy(); }
  });

  it('leaves an unconfigured Z80 at the standard 4T NOP timing', () => {
    const cpu = new Z80(); cpu.read8 = () => 0;
    cpu.step(); expect(cpu.tStates).toBe(4);
  });
});

