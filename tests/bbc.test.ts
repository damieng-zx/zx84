/**
 * BBC Micro Model B integration tests — registration, memory map and a minimal
 * boot (install ROM, reset, run frames, observe a store).
 */

import { describe, it, expect } from 'vitest';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { bbcEntry } from '@/machines/bbc/descriptor.ts';

function makeBbc(): BbcMachine {
  return new BbcMachine('bbc-b', null);
}

/** Build a 32K system image (16K OS + 16K BASIC). */
function makeRom(): Uint8Array {
  const rom = new Uint8Array(0x8000);
  // OS program at $C000: LDA #$42 ; STA $10 ; JMP $C004
  rom.set([0xA9, 0x42, 0x85, 0x10, 0x4C, 0x04, 0xC0], 0x0000);
  // Reset vector at $FFFC -> $C000.
  rom[0x3FFC] = 0x00;
  rom[0x3FFD] = 0xC0;
  return rom;
}

describe('bbc-b registration', () => {
  it('is registered with the m6502 CPU family', () => {
    expect(bbcEntry.models).toContain('bbc-b');
    const m = makeBbc();
    try {
      expect(m.kind).toBe('bbc');
      expect(m.descriptor.cpuFamily).toBe('m6502');
      // The 6502 has no I/O-port space.
      expect(m.services.debug.ports).toBeNull();
    } finally {
      m.destroy();
    }
  });
});

describe('bbc-b memory map', () => {
  it('maps RAM below $8000, a sideways ROM at $8000 and OS at $C000', () => {
    const m = makeBbc();
    try {
      m.memory.ram[0x1234] = 0xAB;
      expect(m.memory.readByte(0x1234)).toBe(0xAB);

      m.memory.loadSidewaysRom(1, Uint8Array.from({ length: 0x4000 }, () => 0x5A));
      m.memory.romsel = 0x81; // enable socket 1
      expect(m.memory.readByte(0x8000)).toBe(0x5A);
      expect(m.memory.readByte(0xBFFF)).toBe(0x5A);

      m.memory.osRom[0x0000] = 0x77;
      expect(m.memory.readByte(0xC000)).toBe(0x77);
      expect(m.memory.readByte(0xFFFF)).toBe(0x00);
    } finally {
      m.destroy();
    }
  });

  it('ignores writes to the ROM windows', () => {
    const m = makeBbc();
    try {
      m.memory.writeByte(0x8000, 0x99);
      m.memory.writeByte(0xC000, 0x99);
      expect(m.memory.readByte(0x8000)).toBe(0x00);
      expect(m.memory.readByte(0xC000)).toBe(0x00);
    } finally {
      m.destroy();
    }
  });

  it('splits RAM into two 16K banks', () => {
    const m = makeBbc();
    try {
      expect(m.memory.ramBankCount).toBe(2);
      m.memory.ram[0x4000] = 0x11;
      expect(m.memory.getRamBank(1)[0]).toBe(0x11);
      expect(m.memory.getRamBank(0)[0]).toBe(0x00);
    } finally {
      m.destroy();
    }
  });
});

describe('bbc-b boot smoke', () => {
  it('runs 6502 code installed as the system ROM', () => {
    const m = makeBbc();
    try {
      m.services.roms.installSystemRom(makeRom());
      m.reset();
      expect(m.cpu.pc).toBe(0xC000);
      m.tick();
      expect(m.memory.ram[0x10]).toBe(0x42);
    } finally {
      m.destroy();
    }
  });

  it('offers a raw RAM dump for the Save menu', () => {
    const m = makeBbc();
    try {
      const dump = m.services.debug.ramExport();
      expect(dump).not.toBeNull();
      expect(dump!.data.length).toBe(0x8000);
      expect(dump!.filename).toContain('bbc-b');
    } finally {
      m.destroy();
    }
  });
});
