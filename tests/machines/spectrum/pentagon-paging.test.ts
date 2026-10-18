/**
 * Pentagon 512 / 1024 extended paging.
 *
 * Expected values are worked out by hand from the published port descriptions,
 * not from the implementation:
 *   - 7FFD D0-D2 are page bits 0-2, D6 is page bit 3, D7 is page bit 4, so the
 *     512 pages 0-31 (e.g. page 20 = 0b10100 is written as D7 | D2 = 0x84).
 *   - On the 512, D5 is the paging lock.
 *   - On the 1024, D5 is page bit 5 while EFF7 bit 2 is clear (the 1MB mode),
 *     and the lock again once EFF7 bit 2 is set (128K mode).
 *   - The 1024 decodes 7FFD with A15=0, A14=1, A1=0 and EFF7 with A15-A12=1110,
 *     A3=0.
 */

import { describe, it, expect } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { loadSZX, saveSZXSync, applySZXPaging } from '@/machines/spectrum/snapshots/szx.ts';
import type { SpectrumModel } from '@/models.ts';

function machine(model: SpectrumModel): Spectrum {
  const s = new Spectrum(model, null);
  const rom = new Uint8Array(32768);
  rom[0] = 0xA0;
  rom[16384] = 0xA1;
  s.loadROM(rom);
  return s;
}

/** Tag the first byte of every RAM bank with its own number + 0x40 so a read at
 *  0xC000 says which bank is paged there. */
function tagBanks(s: Spectrum): void {
  for (let n = 0; n < s.memory.ramBankCount; n++) s.memory.getRamBank(n)[0] = 0x40 + n;
}

describe('Pentagon 512 — RAM size and page number', () => {
  it('has 32 banks of 16K (512K); the 128 keeps 8 and the 1024 has 64', () => {
    expect(machine('pentagon512').memory.ramBankCount).toBe(32);
    expect(machine('pentagon128').memory.ramBankCount).toBe(8);
    expect(machine('pentagon1024').memory.ramBankCount).toBe(64);
    expect(machine('zx128k').memory.ramBankCount).toBe(8);
  });

  it('forms the page from D0-D2, D6 (bit 3) and D7 (bit 4)', () => {
    const s = machine('pentagon512');
    tagBanks(s);
    const cases: Array<[number, number]> = [
      [0x00, 0], [0x07, 7], [0x40, 8], [0x47, 15], [0x80, 16], [0x84, 20], [0xC0, 24], [0xC7, 31],
    ];
    for (const [val, bank] of cases) {
      s.cpu.portOut(0x7FFD, val);
      expect(s.memory.currentBank).toBe(bank);
      expect(s.memory.readByte(0xC000)).toBe(0x40 + bank);
    }
  });

  it('writes through 0xC000 land in the selected extended bank only', () => {
    const s = machine('pentagon512');
    s.cpu.portOut(0x7FFD, 0x84);          // page 20
    s.memory.writeByte(0xC123, 0x99);
    s.cpu.portOut(0x7FFD, 0x04);          // page 4
    expect(s.memory.readByte(0xC123)).toBe(0);
    s.cpu.portOut(0x7FFD, 0x84);
    expect(s.memory.readByte(0xC123)).toBe(0x99);
    expect(s.memory.getRamBank(20)[0x123]).toBe(0x99);
  });

  it('leaves the fixed banks alone: 0x4000 is page 5 and 0x8000 is page 2', () => {
    const s = machine('pentagon512');
    tagBanks(s);
    s.cpu.portOut(0x7FFD, 0xC7);
    expect(s.memory.readByte(0x4000)).toBe(0x45);
    expect(s.memory.readByte(0x8000)).toBe(0x42);
  });

  it('treats D5 as the paging lock, so a locked 512 ignores later writes', () => {
    const s = machine('pentagon512');
    tagBanks(s);
    s.cpu.portOut(0x7FFD, 0x23);          // page 3 + lock
    expect(s.memory.pagingLocked).toBe(true);
    expect(s.memory.currentBank).toBe(3);
    s.cpu.portOut(0x7FFD, 0xC7);
    expect(s.memory.currentBank).toBe(3);
    expect(s.memory.readByte(0xC000)).toBe(0x43);
  });

  it('shows page 7 (shadow screen) from D3 whatever the extended bits are', () => {
    const s = machine('pentagon512');
    s.cpu.portOut(0x7FFD, 0x88);          // D7 (page 16) + screen select
    expect(s.memory.screenBank).toBe(s.memory.getRamBank(7));
  });

  it('does not decode EFF7', () => {
    const s = machine('pentagon512');
    expect(s.variant.decodesEFF7(0xEFF7)).toBe(false);
  });
});

describe('Pentagon 1024 — 1MB mode (EFF7 bit 2 clear, the reset state)', () => {
  it('starts in 1MB mode: EFF7 is 0 after reset', () => {
    const s = machine('pentagon1024');
    s.cpu.portOut(0xEFF7, 0x04);
    s.reset();
    expect(s.memory.portEFF7).toBe(0);
  });

  it('adds D5 as page bit 5 (pages 0-63)', () => {
    const s = machine('pentagon1024');
    tagBanks(s);
    const cases: Array<[number, number]> = [
      [0x00, 0], [0x20, 32], [0x27, 39], [0x60, 40], [0xA0, 48], [0xE0, 56], [0xFF, 63],
    ];
    for (const [val, bank] of cases) {
      s.cpu.portOut(0x7FFD, val);
      expect(s.memory.currentBank).toBe(bank);
      expect(s.memory.readByte(0xC000)).toBe(0x40 + bank);
    }
  });

  it('cannot lock paging in 1MB mode, because D5 is a page bit', () => {
    const s = machine('pentagon1024');
    s.cpu.portOut(0x7FFD, 0x20);
    expect(s.memory.pagingLocked).toBe(false);
    s.cpu.portOut(0x7FFD, 0x01);
    expect(s.memory.currentBank).toBe(1);
  });
});

describe('Pentagon 1024 — 128K mode (EFF7 bit 2 set)', () => {
  it('ignores D6/D7/D5 as page bits: only D0-D2 select the page', () => {
    const s = machine('pentagon1024');
    tagBanks(s);
    s.cpu.portOut(0xEFF7, 0x04);
    s.cpu.portOut(0x7FFD, 0xC3);
    expect(s.memory.currentBank).toBe(3);
    expect(s.memory.readByte(0xC000)).toBe(0x43);
  });

  it('turns D5 back into the paging lock', () => {
    const s = machine('pentagon1024');
    s.cpu.portOut(0xEFF7, 0x04);
    s.cpu.portOut(0x7FFD, 0x22);
    expect(s.memory.pagingLocked).toBe(true);
    s.cpu.portOut(0x7FFD, 0x05);
    expect(s.memory.currentBank).toBe(2);
  });

  it('re-derives the page at once when EFF7 changes, without a new 7FFD write', () => {
    const s = machine('pentagon1024');
    tagBanks(s);
    s.cpu.portOut(0x7FFD, 0xE3);          // 1MB mode: page 3 + 8 + 16 + 32 = 59
    expect(s.memory.currentBank).toBe(59);
    s.cpu.portOut(0xEFF7, 0x04);          // 128K mode: only D0-D2 count -> page 3
    expect(s.memory.currentBank).toBe(3);
    expect(s.memory.readByte(0xC000)).toBe(0x43);
    s.cpu.portOut(0xEFF7, 0x00);          // back to 1MB mode -> page 59 again
    expect(s.memory.currentBank).toBe(59);
    expect(s.memory.readByte(0xC000)).toBe(0x40 + 59);
  });

  it('keeps writes made to a page across an EFF7 mode switch', () => {
    const s = machine('pentagon1024');
    s.cpu.portOut(0x7FFD, 0xE3);
    s.memory.writeByte(0xC010, 0x5A);     // page 59
    s.cpu.portOut(0xEFF7, 0x04);
    s.memory.writeByte(0xC010, 0xA5);     // page 3
    s.cpu.portOut(0xEFF7, 0x00);
    expect(s.memory.readByte(0xC010)).toBe(0x5A);
    s.cpu.portOut(0xEFF7, 0x04);
    expect(s.memory.readByte(0xC010)).toBe(0xA5);
  });
});

describe('Pentagon 1024 — port decoding', () => {
  const v = machine('pentagon1024').variant;

  it('decodes 7FFD with A15=0, A14=1, A1=0', () => {
    expect(v.decodes7FFD(0x7FFD)).toBe(true);
    expect(v.decodes7FFD(0x7FFC)).toBe(true);   // A0 is ignored
    expect(v.decodes7FFD(0x3FFD)).toBe(false);  // A14 clear
    expect(v.decodes7FFD(0xFFFD)).toBe(false);  // A15 set (the AY register port)
    expect(v.decodes7FFD(0x7FFF)).toBe(false);  // A1 set
  });

  it('decodes EFF7 with A15-A12 = 1110 and A3 = 0', () => {
    expect(v.decodesEFF7(0xEFF7)).toBe(true);
    expect(v.decodesEFF7(0xE000)).toBe(true);
    expect(v.decodesEFF7(0xEFFF)).toBe(false);  // A3 set
    expect(v.decodesEFF7(0xFFF7)).toBe(false);  // A12 set, A13 set
    expect(v.decodesEFF7(0x7FFD)).toBe(false);
  });

  it('a 128K-style 7FFD write to 0x3FFD does not page memory on the 1024', () => {
    const s = machine('pentagon1024');
    s.cpu.portOut(0x3FFD, 0x03);
    expect(s.memory.currentBank).toBe(0);
  });
});

describe('Pentagon 512/1024 — snapshots (SZX)', () => {
  async function roundTrip(model: SpectrumModel, setup: (s: Spectrum) => void) {
    const a = machine(model);
    setup(a);
    const szx = saveSZXSync(a.cpu, a.memory, 0, model, 0);
    const b = machine(model);
    const result = await loadSZX(szx, b.cpu, b.memory);
    applySZXPaging(b.memory, false, result);
    return { a, b, szx };
  }

  it('writes SZX machine id 13 for the 512 and 14 for the 1024', async () => {
    const { szx: s512 } = await roundTrip('pentagon512', () => {});
    const { szx: s1024 } = await roundTrip('pentagon1024', () => {});
    expect(s512[6]).toBe(13);
    expect(s1024[6]).toBe(14);
  });

  it('keeps every extended bank, and the 7FFD page, across a save and load of a 512', async () => {
    const { b } = await roundTrip('pentagon512', (s) => {
      s.memory.getRamBank(9)[0x100] = 0x91;
      s.memory.getRamBank(20)[0x200] = 0xB4;
      s.memory.getRamBank(31)[0x3FFF] = 0xF1;
      s.cpu.portOut(0x7FFD, 0x84);      // page 20
    });
    expect(b.memory.getRamBank(9)[0x100]).toBe(0x91);
    expect(b.memory.getRamBank(20)[0x200]).toBe(0xB4);
    expect(b.memory.getRamBank(31)[0x3FFF]).toBe(0xF1);
    expect(b.memory.port7FFD).toBe(0x84);
    expect(b.memory.currentBank).toBe(20);
    expect(b.memory.readByte(0xC200)).toBe(0xB4);
  });

  it('keeps EFF7 on a 1024, in the byte shared with 1FFD, and re-reads 7FFD through it', async () => {
    const { b, szx } = await roundTrip('pentagon1024', (s) => {
      s.memory.getRamBank(3)[0x10] = 0x33;
      s.memory.getRamBank(59)[0x10] = 0x59;
      s.cpu.portOut(0x7FFD, 0xE3);      // page 59 in 1MB mode
    });
    expect(b.memory.currentBank).toBe(59);
    expect(b.memory.readByte(0xC010)).toBe(0x59);
    expect(b.memory.portEFF7).toBe(0);

    // The same 7FFD value with EFF7 bit 2 set is page 3 and D5 is a lock.
    const a2 = machine('pentagon1024');
    a2.cpu.portOut(0xEFF7, 0x04);
    a2.cpu.portOut(0x7FFD, 0x03);
    a2.memory.getRamBank(3)[0x10] = 0x33;
    const szx2 = saveSZXSync(a2.cpu, a2.memory, 0, 'pentagon1024', 0);
    const b2 = machine('pentagon1024');
    applySZXPaging(b2.memory, false, await loadSZX(szx2, b2.cpu, b2.memory));
    expect(b2.memory.portEFF7).toBe(0x04);
    expect(b2.memory.currentBank).toBe(3);
    expect(szx.length).toBeGreaterThan(64 * 16384);
  });

  it('rejects the .z80 export for the extended models via the save menu', () => {
    const ui = (m: SpectrumModel) => machine(m).descriptor.ui.saveMenu;
    expect(ui('pentagon512')).not.toContain('snapshot-z80');
    expect(ui('pentagon1024')).not.toContain('snapshot-z80');
    expect(ui('pentagon128')).toContain('snapshot-z80');
    expect(ui('pentagon512')).toContain('snapshot-szx');
  });
});
