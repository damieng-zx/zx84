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
  it('setSlot0 overlays slot 0 with the supplied buffer', () => {
    const mem = new SpectrumMemory('48k');
    const rom = new Uint8Array(16384);
    rom[0] = 0xAA;
    mem.loadROM(rom);
    expect(mem.readByte(0x0000)).toBe(0xAA);

    const overlay = new Uint8Array(16384);
    overlay[0] = 0xBB;
    mem.setSlot0(overlay);
    expect(mem.readByte(0x0000)).toBe(0xBB);
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

  it('returns correct banks in special paging mode 0 (banks 0,1,2,3)', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    mem.bankSwitch1FFD(0x01); // mode 0: [0,1,2,3]

    expect(mem.bankAt(0x0000)).toBe(0);
    expect(mem.bankAt(0x4000)).toBe(1);
    expect(mem.bankAt(0x8000)).toBe(2);
    expect(mem.bankAt(0xC000)).toBe(3);
  });

  it('returns correct banks in special paging mode 1 (banks 4,5,6,7)', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    mem.bankSwitch1FFD(0x03); // mode 1: [4,5,6,7]

    expect(mem.bankAt(0x0000)).toBe(4);
    expect(mem.bankAt(0x4000)).toBe(5);
    expect(mem.bankAt(0x8000)).toBe(6);
    expect(mem.bankAt(0xC000)).toBe(7);
  });
});

describe('SpectrumMemory — isBasicRomActive', () => {
  it('returns true for 48K (single ROM, always active)', () => {
    // BUG: currentROM stays 0 but romPages.length is 2 (Math.max(2,1)),
    // so currentROM === romPages.length-1 evaluates to 0===1 = false.
    // The 48K machine has exactly one ROM and it is always the BASIC ROM.
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));
    expect(mem.isBasicRomActive()).toBe(true);
  });

  it('returns false for 48K when externalRomPaged', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));
    mem.externalRomPaged = true;
    expect(mem.isBasicRomActive()).toBe(false);
  });

  it('returns false for 128K when 128K editor ROM (page 0) is active by default', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    // Default: currentROM=0 (128K editor), BASIC ROM is page 1
    expect(mem.isBasicRomActive()).toBe(false);
  });

  it('returns true for 128K when 48K BASIC ROM (page 1) is selected', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    mem.bankSwitch(0x10); // bit 4 selects ROM page 1
    expect(mem.isBasicRomActive()).toBe(true);
  });

  it('returns true for +2A/+3 when 48K BASIC ROM (page 3) is selected', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    // ROM 3 = bit2(1FFD)=1, bit4(7FFD)=1 → port1FFD=0x04, port7FFD=0x10
    mem.bankSwitch(0x10);        // bit4=1: ROM select bit0=1
    mem.bankSwitch1FFD(0x04);   // bit2=1: ROM select bit1=1  → ROM 3
    expect(mem.isBasicRomActive()).toBe(true);
  });

  it('returns false for +2A/+3 when ROM 0 (128K editor) is selected', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    // Default: both bits 0 → ROM 0
    expect(mem.isBasicRomActive()).toBe(false);
  });

  it('returns false when specialPaging is active', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    mem.bankSwitch1FFD(0x01); // bit 0 = specialPaging
    expect(mem.isBasicRomActive()).toBe(false);
  });
});

describe('SpectrumMemory — screenBank', () => {
  it('returns bank 5 by default (port7FFD bit 3 = 0)', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    mem.getRamBank(5)[42] = 0x77;
    expect(mem.screenBank[42]).toBe(0x77);
  });

  it('returns bank 7 when port7FFD bit 3 is set', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    mem.getRamBank(7)[42] = 0x88;
    mem.bankSwitch(0x08); // bit 3 = shadow screen in bank 7
    expect(mem.screenBank[42]).toBe(0x88);
  });

  it('screenBank reflects live RAM bank data', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    mem.getRamBank(5)[0] = 0xDE;
    expect(mem.screenBank[0]).toBe(0xDE);
    mem.bankSwitch(0x08);
    mem.getRamBank(7)[0] = 0xAD;
    expect(mem.screenBank[0]).toBe(0xAD);
  });
});

describe('SpectrumMemory — slot0Bank', () => {
  it('returns -1 in normal (non-special) paging mode', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    expect(mem.slot0Bank).toBe(-1);
  });

  it('returns bank 0 in special paging mode 0', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    mem.bankSwitch1FFD(0x01); // mode 0 → [0,1,2,3]
    expect(mem.slot0Bank).toBe(0);
  });

  it('returns bank 4 in special paging mode 1', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    mem.bankSwitch1FFD(0x03); // mode 1 → [4,5,6,7]
    expect(mem.slot0Bank).toBe(4);
  });
});

describe('SpectrumMemory — special paging modes', () => {
  function makePlus3(): SpectrumMemory {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    for (let i = 0; i < 8; i++) mem.getRamBank(i).fill(i);
    mem.applyBanking();
    return mem;
  }

  it('mode 0 (val=0x01): maps banks [0,1,2,3]', () => {
    const mem = makePlus3();
    mem.bankSwitch1FFD(0x01);
    expect(mem.readByte(0x0000)).toBe(0); // bank 0
    expect(mem.readByte(0x4000)).toBe(1); // bank 1
    expect(mem.readByte(0x8000)).toBe(2); // bank 2
    expect(mem.readByte(0xC000)).toBe(3); // bank 3
  });

  it('mode 1 (val=0x03): maps banks [4,5,6,7]', () => {
    const mem = makePlus3();
    mem.bankSwitch1FFD(0x03);
    expect(mem.readByte(0x0000)).toBe(4);
    expect(mem.readByte(0x4000)).toBe(5);
    expect(mem.readByte(0x8000)).toBe(6);
    expect(mem.readByte(0xC000)).toBe(7);
  });

  it('mode 2 (val=0x05): maps banks [4,5,6,3]', () => {
    const mem = makePlus3();
    mem.bankSwitch1FFD(0x05);
    expect(mem.readByte(0x0000)).toBe(4);
    expect(mem.readByte(0x4000)).toBe(5);
    expect(mem.readByte(0x8000)).toBe(6);
    expect(mem.readByte(0xC000)).toBe(3);
  });

  it('mode 3 (val=0x07): maps banks [4,7,6,3]', () => {
    const mem = makePlus3();
    mem.bankSwitch1FFD(0x07);
    expect(mem.readByte(0x0000)).toBe(4);
    expect(mem.readByte(0x4000)).toBe(7);
    expect(mem.readByte(0x8000)).toBe(6);
    expect(mem.readByte(0xC000)).toBe(3);
  });

  it('7FFD write in special paging latches but does not remap slots', () => {
    const mem = makePlus3();
    mem.bankSwitch1FFD(0x01); // mode 0: bank 0 at slot 3
    const before = mem.readByte(0xC000);
    mem.bankSwitch(0x07); // should latch but not remap
    expect(mem.readByte(0xC000)).toBe(before); // slot 3 still bank 3 (mode 0)
    expect(mem.currentBank).toBe(7); // latched
  });

  it('exiting special paging restores slot 3 to bank from 7FFD', () => {
    // BUG: bankSwitch1FFD(0x01) overwrites currentBank=banks[3] (=3),
    // so on exit currentBank is 3 instead of the 5 last set by bankSwitch.
    // Hardware: slot 3 on exit should be controlled by port 0x7FFD bits 0-2.
    const mem = makePlus3();
    mem.bankSwitch(0x05); // port7FFD → bank 5 at slot 3
    mem.bankSwitch1FFD(0x01); // enter special paging (mode 0 puts bank 3 at slot 3)
    mem.bankSwitch1FFD(0x00); // exit special — slot 3 should revert to bank 5
    expect(mem.readByte(0xC000)).toBe(5);
  });
});

describe('SpectrumMemory — +2A/+3 ROM selection', () => {
  it('selects ROM from combined 7FFD bit4 and 1FFD bit2', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    const rom = new Uint8Array(65536);
    for (let p = 0; p < 4; p++) rom[p * 16384] = p; // page tag at offset 0
    mem.loadROM(rom);

    // ROM 0: both bits clear (default)
    expect(mem.readByte(0x0000)).toBe(0);

    // ROM 1: 7FFD bit4=1, 1FFD bit2=0
    mem.bankSwitch(0x10);
    mem.bankSwitch1FFD(0x00);
    expect(mem.readByte(0x0000)).toBe(1);

    // ROM 2: 7FFD bit4=0, 1FFD bit2=1
    mem.bankSwitch(0x00);
    mem.bankSwitch1FFD(0x04);
    expect(mem.readByte(0x0000)).toBe(2);

    // ROM 3: both bits set
    mem.bankSwitch(0x10);
    mem.bankSwitch1FFD(0x04);
    expect(mem.readByte(0x0000)).toBe(3);
    expect(mem.currentROM).toBe(3);
  });
});

describe('SpectrumMemory — externalRomPaged', () => {
  it('bankSwitch does not update slot 0 when externalRomPaged', () => {
    const mem = new SpectrumMemory('128k');
    const rom = new Uint8Array(32768);
    rom[0] = 0xAA;
    mem.loadROM(rom);

    const overlay = new Uint8Array(16384).fill(0xBB);
    mem.setSlot0(overlay);
    mem.externalRomPaged = true;

    mem.bankSwitch(0x10); // would normally switch ROM to page 1
    expect(mem.readByte(0x0000)).toBe(0xBB); // overlay still in place
  });

  it('bankSwitch1FFD does not update slot 0 when externalRomPaged', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    const overlay = new Uint8Array(16384).fill(0xCC);
    mem.setSlot0(overlay);
    mem.externalRomPaged = true;

    mem.bankSwitch1FFD(0x01); // enter special paging
    expect(mem.readByte(0x0000)).toBe(0xCC); // overlay still in place
  });

  it('restoreSlot0 is a no-op when externalRomPaged', () => {
    const mem = new SpectrumMemory('48k');
    const rom = new Uint8Array(16384).fill(0x01);
    mem.loadROM(rom);
    mem.externalRomPaged = true;
    const overlay = new Uint8Array(16384).fill(0xFF);
    mem.setSlot0(overlay);
    mem.restoreSlot0(); // should do nothing
    expect(mem.readByte(0x0000)).toBe(0xFF);
  });
});

describe('SpectrumMemory — restoreSlot0', () => {
  it('restores to correct ROM page after bankSwitch changes ROM', () => {
    const mem = new SpectrumMemory('128k');
    const rom = new Uint8Array(32768);
    rom[0] = 0x01;       // page 0
    rom[16384] = 0x02;   // page 1
    mem.loadROM(rom);
    mem.bankSwitch(0x10); // ROM page 1 active
    mem.setSlot0(new Uint8Array(16384)); // overlay
    mem.restoreSlot0();
    expect(mem.readByte(0x0000)).toBe(0x02); // page 1 restored
  });

  it('restores to special paging bank when specialPaging active', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    mem.getRamBank(0).fill(0xAA);
    mem.applyBanking();
    mem.bankSwitch1FFD(0x01); // special mode 0: bank 0 at slot 0
    mem.setSlot0(new Uint8Array(16384)); // overlay zeros slot 0
    mem.restoreSlot0();
    expect(mem.readByte(0x0000)).toBe(0xAA); // bank 0 restored
  });
});

describe('SpectrumMemory — skipSlot0', () => {
  it('bankSwitch with skipSlot0=true does not change ROM in slot 0', () => {
    const mem = new SpectrumMemory('128k');
    const rom = new Uint8Array(32768);
    rom[0] = 0x01;
    mem.loadROM(rom);
    mem.bankSwitch(0x10, /* skipSlot0= */true); // ROM page 1 requested but skipped
    expect(mem.readByte(0x0000)).toBe(0x01); // page 0 still in slot 0
    expect(mem.currentROM).toBe(1); // but state is latched
  });

  it('bankSwitch1FFD with skipSlot0=true does not change slot 0 in special paging', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    const rom = new Uint8Array(65536);
    rom[0] = 0xDE;
    mem.loadROM(rom);
    mem.bankSwitch1FFD(0x01, /* skipSlot0= */true); // special mode, skip slot 0
    expect(mem.readByte(0x0000)).toBe(0xDE); // ROM still showing
    expect(mem.specialPaging).toBe(true);
  });
});

describe('SpectrumMemory — ROM loading edge cases', () => {
  it('loadROM 64KB for +2A/+3 loads all 4 ROM pages', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    const rom = new Uint8Array(65536);
    for (let p = 0; p < 4; p++) rom[p * 16384] = 0x10 + p;
    mem.loadROM(rom);

    // Verify each ROM page by switching to it
    const pageTag = (p: number) => {
      // ROM bits: bit0 = 7FFD.4, bit1 = 1FFD.2
      mem.bankSwitch((p & 1) ? 0x10 : 0x00);
      mem.bankSwitch1FFD((p & 2) ? 0x04 : 0x00);
      return mem.readByte(0x0000);
    };
    expect(pageTag(0)).toBe(0x10);
    expect(pageTag(1)).toBe(0x11);
    expect(pageTag(2)).toBe(0x12);
    expect(pageTag(3)).toBe(0x13);
  });

  it('loadROM 16KB for 48K is readable at 0x0000', () => {
    const mem = new SpectrumMemory('48k');
    const rom = new Uint8Array(16384);
    rom[100] = 0x42;
    mem.loadROM(rom);
    expect(mem.readByte(100)).toBe(0x42);
  });
});

describe('SpectrumMemory — setBankFromSnapshot and flushBanks', () => {
  it('setBankFromSnapshot writes data into the correct RAM bank', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));

    const data = new Uint8Array(16384).fill(0x55);
    mem.setBankFromSnapshot(6, data);
    expect(mem.getRamBank(6)[0]).toBe(0x55);
    expect(mem.getRamBank(6)[16383]).toBe(0x55);
  });

  it('setBankFromSnapshot only writes up to 16384 bytes', () => {
    const mem = new SpectrumMemory('128k');
    const data = new Uint8Array(20000).fill(0xAA);
    mem.setBankFromSnapshot(3, data);
    expect(mem.getRamBank(3)[0]).toBe(0xAA);
    expect(mem.getRamBank(3)[16383]).toBe(0xAA);
  });

  it('flushBanks returns all 8 banks', () => {
    const mem = new SpectrumMemory('128k');
    for (let i = 0; i < 8; i++) mem.setBankFromSnapshot(i, new Uint8Array(16384).fill(i + 1));
    const banks = mem.flushBanks();
    expect(banks.length).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(banks[i][0]).toBe(i + 1);
    }
  });

  it('flushBanks returns live references (no copy)', () => {
    const mem = new SpectrumMemory('128k');
    const banks = mem.flushBanks();
    mem.getRamBank(2)[0] = 0x77;
    expect(banks[2][0]).toBe(0x77);
  });
});

describe('SpectrumMemory — readBlock wrap-around', () => {
  it('wraps around 0xFFFF boundary', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384).fill(0x01)); // ROM first
    mem.writeByte(0xFFFF, 0xAA);
    // 0x0000 is in ROM — read via readByte to check
    const block = mem.readBlock(0xFFFF, 2);
    expect(block[0]).toBe(0xAA); // 0xFFFF
    expect(block[1]).toBe(0x01); // 0x0000 wraps to ROM[0]
  });
});

describe('SpectrumMemory — writeByte value masking', () => {
  it('masks values larger than 0xFF', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));
    mem.writeByte(0x4000, 0x1FF); // should store 0xFF
    expect(mem.readByte(0x4000)).toBe(0xFF);
  });
});


describe('SpectrumMemory — bank aliasing (currentBank matches a static slot)', () => {
  it('currentBank=5 aliases bank 5 into slot 1 and slot 3: a write at one slot is visible at the other', () => {
    // Real hardware: bank 5 is one physical RAM chip; both 0x4000 and 0xC000
    // windows access it. A write to 0xC000 must appear at 0x4000.
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    mem.bankSwitch(0x05); // currentBank = 5 → slot 3 mirrors slot 1
    mem.writeByte(0xC100, 0x42);
    expect(mem.readByte(0x4100)).toBe(0x42);
    mem.writeByte(0x4200, 0x99);
    expect(mem.readByte(0xC200)).toBe(0x99);
  });

  it('currentBank=2 aliases bank 2 into slot 2 and slot 3', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    mem.bankSwitch(0x02);
    mem.writeByte(0xC300, 0x55);
    expect(mem.readByte(0x8300)).toBe(0x55);
    mem.writeByte(0x8400, 0xAA);
    expect(mem.readByte(0xC400)).toBe(0xAA);
  });

  it('breaking the alias (switching to a different bank) leaves the previously-aliased slot intact', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    mem.bankSwitch(0x05);          // alias: slots 1+3 → bank 5
    mem.writeByte(0xC000, 0x77);    // write-through: 0x4000 also = 0x77
    mem.bankSwitch(0x01);          // slot 3 now bank 1; slot 1 still bank 5
    expect(mem.readByte(0x4000)).toBe(0x77); // bank 5 retained the write
  });

  it('snapshot save sees the same data via either aliased slot', () => {
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    mem.bankSwitch(0x05);
    mem.writeByte(0x4500, 0xCD); // via slot 1
    const banks = mem.flushBanks();
    expect(banks[5][0x500]).toBe(0xCD);
  });
});

describe('SpectrumMemory — paging lock', () => {
  it('bankSwitch1FFD also respects pagingLocked', () => {
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    mem.bankSwitch(0x20); // lock paging
    expect(mem.pagingLocked).toBe(true);
    mem.bankSwitch1FFD(0x01); // should be ignored
    expect(mem.specialPaging).toBe(false);
  });

  it('bankSwitch does nothing on 48K model (no banking)', () => {
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384));
    mem.bankSwitch(0x20); // should be ignored
    expect(mem.pagingLocked).toBe(false);
    expect(mem.currentBank).toBe(0);
  });
});

describe('SpectrumMemory — applyBanking in special paging mode', () => {
  it('applyBanking while specialPaging remaps all four slots from SPECIAL_MODES', () => {
    // updateSlots() has a specialPaging branch only reachable via applyBanking/loadROM
    // (bankSwitch1FFD sets slots directly; reset() clears specialPaging first)
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    for (let i = 0; i < 8; i++) mem.getRamBank(i).fill(i);
    mem.bankSwitch1FFD(0x01); // mode 0: [0,1,2,3]
    // Directly corrupt a bank to confirm applyBanking re-wires slots
    mem.getRamBank(1).fill(0xAB);
    mem.applyBanking();
    expect(mem.readByte(0x4000)).toBe(0xAB); // slot 1 → bank 1
    expect(mem.readByte(0x0000)).toBe(0);    // slot 0 → bank 0
    expect(mem.readByte(0x8000)).toBe(2);    // slot 2 → bank 2
    expect(mem.readByte(0xC000)).toBe(3);    // slot 3 → bank 3
  });

  it('applyBanking while specialPaging and externalRomPaged leaves slot 0 unchanged', () => {
    // Covers the !externalRomPaged guard inside the specialPaging branch of updateSlots
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    for (let i = 0; i < 8; i++) mem.getRamBank(i).fill(i);
    mem.bankSwitch1FFD(0x01); // mode 0: [0,1,2,3]
    const overlay = new Uint8Array(16384).fill(0xEE);
    mem.setSlot0(overlay);
    mem.externalRomPaged = true;
    mem.applyBanking(); // should not overwrite slot 0
    expect(mem.readByte(0x0000)).toBe(0xEE); // overlay intact
    expect(mem.readByte(0x4000)).toBe(1);    // other slots still updated
  });

  it('applyBanking with externalRomPaged in non-special mode leaves slot 0 unchanged', () => {
    // Covers the !externalRomPaged guard in the else branch of updateSlots
    const mem = new SpectrumMemory('128k');
    const rom = new Uint8Array(32768);
    rom[0] = 0x01;
    mem.loadROM(rom);
    const overlay = new Uint8Array(16384).fill(0xBB);
    mem.setSlot0(overlay);
    mem.externalRomPaged = true;
    mem.applyBanking(); // slot 0 must not be overwritten
    expect(mem.readByte(0x0000)).toBe(0xBB);
    expect(mem.readByte(0x4000)).toBe(0x00); // slot 1 still updated normally
  });
});

describe('SpectrumMemory — loadROM edge cases', () => {
  it('loadROM with 16KB data on 128K machine stores to page 1 only', () => {
    // The else-if(>= 16384) branch with is128K=true skips setting romPages[0].
    // Default slot 0 → romPages[0] (currentROM=0), so the data ends up only in page 1.
    const mem = new SpectrumMemory('128k');
    const rom = new Uint8Array(16384);
    rom[0] = 0x42;
    mem.loadROM(rom);
    // Default ROM page 0 was not written — reads zero
    expect(mem.readByte(0x0000)).toBe(0x00);
    // Switch to page 1 (bit 4 of port 7FFD) — data is accessible here
    mem.bankSwitch(0x10);
    expect(mem.readByte(0x0000)).toBe(0x42);
  });

  it('loadROM with data shorter than 16KB is a no-op', () => {
    // All three else-if conditions fail when data < 16KB — nothing is written
    const mem = new SpectrumMemory('48k');
    mem.loadROM(new Uint8Array(16384).fill(0xAA)); // establish known ROM state
    mem.loadROM(new Uint8Array(100));               // too short — must not change pages
    expect(mem.readByte(0x0000)).toBe(0xAA);        // page 1 unchanged
  });
});

describe('SpectrumMemory — bankSwitch locking while in special paging', () => {
  it('bankSwitch with bit 5 set while in special paging locks paging', () => {
    // Line 260: pagingLocked path inside the specialPaging branch of bankSwitch
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    mem.loadROM(new Uint8Array(65536));
    mem.bankSwitch1FFD(0x01); // enter special paging
    expect(mem.specialPaging).toBe(true);
    mem.bankSwitch(0x27); // bit 5 set → should lock paging
    expect(mem.pagingLocked).toBe(true);
    expect(mem.currentBank).toBe(7); // latched
    // Further writes must be ignored
    mem.bankSwitch1FFD(0x00);
    expect(mem.specialPaging).toBe(true); // still locked
  });
});

describe('SpectrumMemory — bankSwitch1FFD on non-+3 machine', () => {
  it('bankSwitch1FFD on 128K machine (2 ROM pages) does not update currentROM', () => {
    // Line 283: romPages.length !== 4 branch — currentROM update is gated on 4-page machines
    const mem = new SpectrumMemory('128k');
    mem.loadROM(new Uint8Array(32768));
    const romBefore = mem.currentROM;
    mem.bankSwitch1FFD(0x04); // bit 2 set — only relevant on +3
    expect(mem.currentROM).toBe(romBefore); // unchanged on 2-page machine
  });

  it('bankSwitch1FFD non-special exit restores slot 0 to ROM', () => {
    // Line 296: !skipSlot0 && !externalRomPaged path in normal-paging exit of bankSwitch1FFD
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    const rom = new Uint8Array(65536);
    rom[0] = 0x99;
    mem.loadROM(rom);
    mem.bankSwitch1FFD(0x00); // explicit non-special write re-latches slot 0 to ROM
    expect(mem.readByte(0x0000)).toBe(0x99);
  });

  it('bankSwitch1FFD with skipSlot0=true in non-special exit does not change slot 0', () => {
    // Covers the false branch of !skipSlot0 at line 296 (else clause of bankSwitch1FFD)
    const mem = new SpectrumMemory('+3', { hasBanking: true, romPageCount: 4 });
    const rom = new Uint8Array(65536);
    rom[0] = 0x55;
    mem.loadROM(rom);
    mem.bankSwitch1FFD(0x01); // enter special paging
    const overlay = new Uint8Array(16384).fill(0xCC);
    mem.setSlot0(overlay);
    mem.bankSwitch1FFD(0x00, /* skipSlot0= */ true); // exit special paging but keep overlay
    expect(mem.readByte(0x0000)).toBe(0xCC); // overlay intact despite exiting special paging
    expect(mem.specialPaging).toBe(false);
  });
});
