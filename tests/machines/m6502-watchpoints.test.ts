/**
 * Debugger memory watchpoints on the 6502 machines (Apple II, BBC Micro,
 * Electron). Every machine runs the same hand-assembled program, loaded as its
 * system ROM, which touches one RAM address with a read and then a write:
 *
 *   +0  AD 00 02   LDA $0200     ; read  $0200
 *   +3  A9 12      LDA #$12
 *   +5  8D 01 02   STA $0201     ; write $0201 (value $12)
 *   +8  4C xx xx   JMP *         ; spin
 *
 * Opcode bytes and instruction lengths are from the 6502 programming manual, so
 * the expected program counters (the address after the accessing instruction)
 * do not depend on the emulator.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';
import type { BaseMachine } from '@/machines/base-machine.ts';

interface Rig {
  readonly name: string;
  readonly org: number;
  make(): BaseMachine & { cpu: { pc: number }; memory: { writeByte(a: number, v: number): void } };
}

const program = (org: number): number[] =>
  [0xAD, 0x00, 0x02, 0xA9, 0x12, 0x8D, 0x01, 0x02, 0x4C, (org + 8) & 0xFF, (org + 8) >> 8];

/** A ROM image of `size` bytes that starts at address `base`, holds the program
 *  at `org` and has its reset vector ($FFFC) pointing there. */
function image(size: number, base: number, org: number): Uint8Array {
  const rom = new Uint8Array(size);
  rom.set(program(org), org - base);
  rom[0xFFFC - base] = org & 0xFF;
  rom[0xFFFD - base] = org >> 8;
  return rom;
}

const RIGS: Rig[] = [
  {
    name: 'Apple II',
    org: 0xD000,
    make: () => {
      const m = new Apple2Machine('apple2-plus', null);
      m.loadROM(image(0x3000, 0xD000, 0xD000));
      m.reset();
      return m;
    },
  },
  {
    name: 'BBC Micro',
    org: 0xC000,
    make: () => {
      const m = new BbcMachine('bbc-b', null);
      m.services.roms.installSystemRom(image(0x8000, 0xC000, 0xC000));
      m.reset();
      return m;
    },
  },
  {
    name: 'Electron',
    org: 0xC000,
    make: () => {
      const m = new ElectronMachine('electron', null);
      // BASIC in the first 16K, the OS in the second.
      const rom = new Uint8Array(0x8000);
      rom.set(image(0x4000, 0xC000, 0xC000), 0x4000);
      m.loadROM(rom);
      m.reset();
      return m;
    },
  },
];

describe.each(RIGS)('$name memory watchpoints', ({ org, make }) => {
  it('stops after the instruction that reads a watched address', () => {
    const m = make();
    try {
      m.memory.writeByte(0x0200, 0x34);
      m.memWatchpoints.push({ start: 0x0200, end: 0x0200, mode: 'read' });
      m.tick();
      expect(m.memWatchHit).toEqual({ addr: 0x0200, value: 0x34, dir: 'read' });
      expect(m.cpu.pc).toBe(org + 3);
    } finally { m.destroy(); }
  });

  it('stops after the instruction that writes a watched range, with the value', () => {
    const m = make();
    try {
      m.memWatchpoints.push({ start: 0x0201, end: 0x0210, mode: 'write' });
      m.tick();
      expect(m.memWatchHit).toEqual({ addr: 0x0201, value: 0x12, dir: 'write' });
      expect(m.cpu.pc).toBe(org + 8);
    } finally { m.destroy(); }
  });

  it('breaks on either direction in rw mode, reporting the first access', () => {
    const m = make();
    try {
      m.memWatchpoints.push({ start: 0x0200, end: 0x0201, mode: 'rw' });
      expect(m.runUntil(5)).toBe(1);
      expect(m.memWatchHit?.dir).toBe('read');
    } finally { m.destroy(); }
  });

  it('ignores accesses in the other direction and outside the range', () => {
    const m = make();
    try {
      m.memWatchpoints.push({ start: 0x0201, end: 0x0201, mode: 'read' });
      m.memWatchpoints.push({ start: 0x0300, end: 0x03FF, mode: 'rw' });
      m.tick();
      expect(m.memWatchHit).toBeNull();
      expect(m.cpu.pc).toBe(org + 8);        // the spin loop: the frame ran to the end
    } finally { m.destroy(); }
  });

  it('runs a whole frame when no watchpoints are set', () => {
    const m = make();
    try {
      m.tick();
      expect(m.memWatchHit).toBeNull();
      expect(m.cpu.pc).toBe(org + 8);
    } finally { m.destroy(); }
  });
});
