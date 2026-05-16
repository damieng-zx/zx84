import { describe, it, expect } from 'vitest';
import { SpectrumMemory } from '@/memory.ts';

describe('SpectrumMemory — construction', () => {
  it('creates 48K memory without banking', () => {
    const mem = new SpectrumMemory('48k');
    expect(mem.is128K).toBe(false);
    expect(mem.is16K).toBe(false);
  });

  it('creates 128K memory with banking', () => {
    const mem = new SpectrumMemory('128k');
    expect(mem.is128K).toBe(true);
  });

  it('creates 16K memory', () => {
    const mem = new SpectrumMemory('16k');
    expect(mem.is16K).toBe(true);
    expect(mem.is128K).toBe(false);
  });
});

describe('SpectrumMemory — read/write', () => {
  it('reads 0xFF from uninitialized memory', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));
    expect(mem.readByte(0x0000)).toBe(0);
  });

  it('round-trips a byte through RAM', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));
    mem.writeByte(0x4000, 0x42);
    expect(mem.readByte(0x4000)).toBe(0x42);
  });

  it('round-trips bytes across slot boundaries', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));
    mem.writeByte(0x3FFF, 0xAA);
    mem.writeByte(0x4000, 0xBB);
    expect(mem.readByte(0x3FFF)).toBe(0xAA);
    expect(mem.readByte(0x4000)).toBe(0xBB);
  });

  it('reads 0xFF from unpopulated slots on 16K model', () => {
    const mem = new SpectrumMemory('16k');
    mem.loadROM(new Uint8Array(16384));
    expect(mem.readByte(0x8000)).toBe(0xFF);
    expect(mem.readByte(0xC000)).toBe(0xFF);
  });

  it('writes to unpopulated slots modify the open-bus buffer directly', () => {
    const mem = new SpectrumMemory('16k');
    mem.loadROM(new Uint8Array(16384));
    mem.writeByte(0x8000, 0x42);
    expect(mem.readByte(0x8000)).toBe(0x42);
  });
});

describe('SpectrumMemory — readBlock', () => {
  it('reads a contiguous block', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));
    mem.writeByte(0x4000, 0x11);
    mem.writeByte(0x4001, 0x22);
    mem.writeByte(0x4002, 0x33);
    const block = mem.readBlock(0x4000, 3);
    expect(block).toEqual(new Uint8Array([0x11, 0x22, 0x33]));
  });
});

describe('SpectrumMemory — ROM loading', () => {
  it('loads 16KB ROM for 48K', () => {
    const mem = new SpectrumMemory('48k');
    const rom = new Uint8Array(16384);
    rom[0] = 0xF3;
    mem.loadROM(rom);
    expect(mem.readByte(0x0000)).toBe(0xF3);
  });

  it('loads 32KB ROM for 128K', () => {
    const mem = new SpectrumMemory('128k');
    const rom = new Uint8Array(32768);
    rom[0] = 0xF3;
    rom[16384] = 0xCD;
    mem.loadROM(rom);
    expect(mem.readByte(0x0000)).toBe(0xF3);
    mem.bankSwitch(0x10);
    expect(mem.readByte(0x0000)).toBe(0xCD);
  });
});

describe('SpectrumMemory — bank switching (128K)', () => {
  it('switches RAM banks at 0xC000', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));

    mem.getRamBank(0)[0] = 0xAA;
    mem.getRamBank(3)[0] = 0xBB;
    mem.applyBanking();

    expect(mem.readByte(0xC000)).toBe(0xAA);

    mem.bankSwitch(0x03);
    expect(mem.readByte(0xC000)).toBe(0xBB);
    expect(mem.currentBank).toBe(3);
  });

  it('switches ROM pages', () => {
    const mem = new SpectrumMemory('128k');
    const rom = new Uint8Array(32768);
    rom[0] = 0x01;
    rom[16384] = 0x02;
    mem.loadROM(rom);

    expect(mem.readByte(0x0000)).toBe(0x01);

    mem.bankSwitch(0x10);
    expect(mem.readByte(0x0000)).toBe(0x02);
    expect(mem.currentROM).toBe(1);
  });

  it('locks paging when bit 5 is set', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));

    mem.bankSwitch(0x20);
    expect(mem.pagingLocked).toBe(true);

    mem.getRamBank(7)[0] = 0xFF;
    mem.bankSwitch(0x07);
    expect(mem.currentBank).toBe(0);
  });

  it('does not switch banks on 48K model', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));
    mem.bankSwitch(0x07);
    expect(mem.currentBank).toBe(0);
  });
});

describe('SpectrumMemory — special paging (+2A/+3)', () => {
  it('enters special paging mode via bankSwitch1FFD', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));

    mem.bankSwitch1FFD(0x01);
    expect(mem.specialPaging).toBe(true);
  });

  it('maps all-RAM configuration 0 (banks 0,1,2,3)', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));

    mem.getRamBank(0)[0] = 0x00;
    mem.getRamBank(1)[0] = 0x01;
    mem.getRamBank(2)[0] = 0x02;
    mem.getRamBank(3)[0] = 0x03;
    mem.applyBanking();

    mem.bankSwitch1FFD(0x01);

    expect(mem.readByte(0x0000)).toBe(0x00);
    expect(mem.readByte(0x4000)).toBe(0x01);
    expect(mem.readByte(0x8000)).toBe(0x02);
    expect(mem.readByte(0xC000)).toBe(0x03);
  });

  it('leaves special paging when bit 0 cleared', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));

    mem.bankSwitch1FFD(0x01);
    expect(mem.specialPaging).toBe(true);

    mem.bankSwitch1FFD(0x00);
    expect(mem.specialPaging).toBe(false);
  });
});

describe('SpectrumMemory — slot 0 overlay', () => {
  it('setSlot0 replaces slot 0 and returns previous', () => {
    const mem = new SpectrumMemory('48k');
    const rom = new Uint8Array(16384);
    rom[0] = 0xAA;
    mem.loadROM(rom);

    const prev = mem.getSlot(0);
    const overlay = new Uint8Array(16384);
    overlay[0] = 0xBB;
    mem.setSlot0(overlay);

    expect(mem.readByte(0x0000)).toBe(0xBB);
    expect(prev[0]).toBe(0xAA);
  });

  it('restoreSlot0 reverts to ROM', () => {
    const mem = new SpectrumMemory('48k');
    const rom = new Uint8Array(16384);
    rom[0] = 0xAA;
    mem.loadROM(rom);

    mem.setSlot0(new Uint8Array(16384));
    mem.restoreSlot0();

    expect(mem.readByte(0x0000)).toBe(0xAA);
  });
});

describe('SpectrumMemory — snapshot', () => {
  it('snapshot returns 64KB view', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));
    const snap = mem.snapshot();
    expect(snap.length).toBe(65536);
  });

  it('load48KRAM loads 49152 bytes into correct banks', () => {
    const mem = new SpectrumMemory('48k');
    const data = new Uint8Array(49152);
    data[0] = 0x11;
    data[16384] = 0x22;
    data[32768] = 0x33;
    mem.load48KRAM(data);

    expect(mem.readByte(0x4000)).toBe(0x11);
    expect(mem.readByte(0x8000)).toBe(0x22);
    expect(mem.readByte(0xC000)).toBe(0x33);
  });
});

describe('SpectrumMemory — reset', () => {
  it('clears all RAM and resets paging state', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    mem.writeByte(0x4000, 0x42);
    mem.bankSwitch(0x07);

    mem.reset();

    expect(mem.readByte(0x4000)).toBe(0x00);
    expect(mem.currentBank).toBe(0);
    expect(mem.pagingLocked).toBe(false);
    expect(mem.port7FFD).toBe(0);
  });
});

describe('SpectrumMemory — bankAt', () => {
  it('returns correct bank indices for 48K', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));

    expect(mem.bankAt(0x0000)).toBe(-1);
    expect(mem.bankAt(0x4000)).toBe(5);
    expect(mem.bankAt(0x8000)).toBe(2);
    expect(mem.bankAt(0xC000)).toBe(0);
  });

  it('returns correct bank indices after bank switch', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));

    mem.bankSwitch(0x07);
    expect(mem.bankAt(0xC000)).toBe(7);
    expect(mem.bankAt(0x4000)).toBe(5);
    expect(mem.bankAt(0x8000)).toBe(2);
  });
});
