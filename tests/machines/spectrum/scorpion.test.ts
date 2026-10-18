/**
 * Scorpion ZS-256.
 *
 * Expected values come from the published port descriptions and from the real
 * ZS-256 ROM's own boot code, not from the implementation:
 *   - 256K RAM = 16 banks; 7FFD D0-D2 are page bits 0-2, 1FFD D4 is page bit 3.
 *   - 7FFD decode A15=0 A14=1 A5=1 A1=0 A0=1; 1FFD decode A15=0 A14=0 A5=1 A1=0 A0=1.
 *   - 64K ROM: page 0 = 128K menu, 1 = 48K BASIC, 2 = service ROM, 3 = TR-DOS.
 *     7FFD D4 picks page 0/1; 1FFD D1 picks page 2 whatever 7FFD D4 says (the
 *     ROM's RAM test writes 7FFD with D4 set while 1FFD D1 is set and keeps
 *     running from the service ROM); TR-DOS is mapped in by the Beta trap.
 *   - 1FFD D0 maps RAM bank 0 over 0x0000-0x3FFF, writable.
 *   - 224 x 312 = 69888 T-states per frame at 3.5 MHz, no contention.
 */

import { describe, it, expect } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { buildSpectrumAuxRoms } from '@/machines/spectrum/aux-roms.ts';
import { loadSZX, saveSZXSync, applySZXPaging } from '@/machines/spectrum/snapshots/szx.ts';
import { entryForModel } from '@/machines/registry.ts';
import { MODEL_MENU } from '@/ui/panes/model-menu.ts';
import { bootWaitPc } from '@/machines/spectrum/boot-trap.ts';
import {
  isScorpionClass, is128kClass, isPlus2AClass, hasBuiltinBetaDisk, betaRomInSystemRom,
  romPageSlotCount, defaultRomPageLabel,
} from '@/models.ts';
import type { SettingsView } from '@/machines/machine.ts';

/** A 64K ROM whose pages are tagged 0xA0..0xA3 at offset 0 and 0xB0..0xB3 at 1. */
function rom64(): Uint8Array {
  const rom = new Uint8Array(65536);
  for (let p = 0; p < 4; p++) { rom[p * 16384] = 0xA0 + p; rom[p * 16384 + 1] = 0xB0 + p; }
  return rom;
}

function scorpion(): Spectrum {
  const s = new Spectrum('scorpion256', null);
  s.loadROM(rom64());
  return s;
}

function tagBanks(s: Spectrum): void {
  for (let n = 0; n < s.memory.ramBankCount; n++) s.memory.getRamBank(n)[0x40] = 0x40 + n;
}

const noSettings: SettingsView = { get: <T>(_k: string, fb: T) => fb };

describe('Scorpion — model and timing', () => {
  const s = scorpion();

  it('is a 128K-class model with 16 RAM banks and four ROM pages', () => {
    expect(isScorpionClass('scorpion256')).toBe(true);
    expect(is128kClass('scorpion256')).toBe(true);
    expect(isPlus2AClass('scorpion256')).toBe(false);
    expect(s.memory.ramBankCount).toBe(16);
    expect(s.memory.romPages).toHaveLength(4);
    expect(romPageSlotCount('scorpion256')).toBe(4);
  });

  it('runs 224 x 312 = 69888 T-states per frame at 3.5 MHz', () => {
    const t = s.contention.timing;
    expect(t.cpuClock).toBe(3_500_000);
    expect(t.tStatesPerLine).toBe(224);
    expect(t.tStatesPerFrame).toBe(224 * 312);
    expect(t.intLength).toBe(32);
  });

  it('has no contention', () => {
    for (const addr of [0x4000, 0x8000, 0xC000]) {
      for (const bank of [-1, 0, 5, 7, 8, 15]) expect(s.variant.isContended(addr, bank)).toBe(false);
    }
    expect(s.variant.hasIOContention).toBe(false);
  });

  it('names its ROM pages', () => {
    expect([0, 1, 2, 3].map(p => defaultRomPageLabel('scorpion256', p as 0 | 1 | 2 | 3))).toEqual(
      ['Scorpion 128K', '48K BASIC', 'Service Monitor', 'TR-DOS']);
  });
});

describe('Scorpion — port decode', () => {
  const v = scorpion().variant;

  it('decodes 7FFD only with A15=0, A14=1, A5=1, A1=0, A0=1', () => {
    expect(v.decodes7FFD(0x7FFD)).toBe(true);
    expect(v.decodes7FFD(0x7FFC)).toBe(false);   // A0 clear
    expect(v.decodes7FFD(0x7FDD)).toBe(false);   // A5 clear
    expect(v.decodes7FFD(0x3FFD)).toBe(false);   // A14 clear
    expect(v.decodes7FFD(0xFFFD)).toBe(false);   // A15 set (AY)
    expect(v.decodes7FFD(0x7FFF)).toBe(false);   // A1 set
    expect(v.decodes7FFD(0x1FFD)).toBe(false);
  });

  it('decodes 1FFD only with A15=0, A14=0, A5=1, A1=0, A0=1', () => {
    expect(v.decodes1FFD(0x1FFD)).toBe(true);
    expect(v.decodes1FFD(0x1FDD)).toBe(false);   // A5 clear
    expect(v.decodes1FFD(0x5FFD)).toBe(false);   // A14 set
    expect(v.decodes1FFD(0x9FFD)).toBe(false);   // A15 set
    expect(v.decodes1FFD(0x7FFD)).toBe(false);
  });

  it('does not let the loose 128K decode page memory on a 1FFD write', () => {
    const s = scorpion();
    s.cpu.portOut(0x1FFD, 0x07);                  // would be bank 7 under the 128K decode
    expect(s.memory.port7FFD).toBe(0);
    expect(s.memory.currentBank).toBe(0);
  });
});

describe('Scorpion — RAM paging (7FFD + 1FFD D4)', () => {
  it('forms the page from 7FFD D0-D2 and 1FFD D4 (banks 0-15)', () => {
    const s = scorpion();
    tagBanks(s);
    const cases: Array<[number, number, number]> = [   // [7FFD, 1FFD, bank]
      [0x00, 0x00, 0], [0x07, 0x00, 7], [0x00, 0x10, 8], [0x05, 0x10, 13], [0x07, 0x10, 15],
    ];
    for (const [v7, v1, bank] of cases) {
      s.cpu.portOut(0x1FFD, v1);
      s.cpu.portOut(0x7FFD, v7);
      expect(s.memory.currentBank).toBe(bank);
      expect(s.memory.readByte(0xC040)).toBe(0x40 + bank);
    }
  });

  it('re-derives the page at once when only 1FFD D4 changes', () => {
    const s = scorpion();
    tagBanks(s);
    s.cpu.portOut(0x7FFD, 0x03);
    expect(s.memory.readByte(0xC040)).toBe(0x43);
    s.cpu.portOut(0x1FFD, 0x10);
    expect(s.memory.readByte(0xC040)).toBe(0x4B);   // bank 11
    s.cpu.portOut(0x1FFD, 0x00);
    expect(s.memory.readByte(0xC040)).toBe(0x43);
  });

  it('keeps 0x4000 on bank 5 and 0x8000 on bank 2', () => {
    const s = scorpion();
    tagBanks(s);
    s.cpu.portOut(0x1FFD, 0x10);
    s.cpu.portOut(0x7FFD, 0x07);
    expect(s.memory.readByte(0x4040)).toBe(0x45);
    expect(s.memory.readByte(0x8040)).toBe(0x42);
  });

  it('locks both 7FFD and 1FFD with 7FFD D5', () => {
    const s = scorpion();
    tagBanks(s);
    s.cpu.portOut(0x7FFD, 0x23);
    expect(s.memory.pagingLocked).toBe(true);
    s.cpu.portOut(0x7FFD, 0x05);
    s.cpu.portOut(0x1FFD, 0x10);
    expect(s.memory.currentBank).toBe(3);
  });
});

describe('Scorpion — ROM select', () => {
  it('starts on ROM 0 (the 128K menu)', () => {
    const s = scorpion();
    expect(s.memory.currentROM).toBe(0);
    expect(s.memory.readByte(0x0000)).toBe(0xA0);
  });

  it('picks ROM 0 or ROM 1 with 7FFD D4', () => {
    const s = scorpion();
    s.cpu.portOut(0x7FFD, 0x10);
    expect(s.memory.currentROM).toBe(1);
    expect(s.memory.readByte(0x0000)).toBe(0xA1);
    s.cpu.portOut(0x7FFD, 0x00);
    expect(s.memory.currentROM).toBe(0);
  });

  it('picks the service ROM (page 2) with 1FFD D1, whatever 7FFD D4 is', () => {
    const s = scorpion();
    s.cpu.portOut(0x1FFD, 0x02);
    expect(s.memory.currentROM).toBe(2);
    expect(s.memory.readByte(0x0000)).toBe(0xA2);
    s.cpu.portOut(0x7FFD, 0x10);                   // D4 set: still page 2, not 3
    expect(s.memory.currentROM).toBe(2);
    expect(s.memory.readByte(0x0000)).toBe(0xA2);
    s.cpu.portOut(0x1FFD, 0x00);                   // back to 7FFD D4 -> page 1
    expect(s.memory.currentROM).toBe(1);
  });

  it('never selects the TR-DOS page (3) with a port write', () => {
    const s = scorpion();
    for (const v1 of [0x00, 0x02, 0x12, 0x1F]) {
      for (const v7 of [0x00, 0x10]) {
        s.reset();
        s.cpu.portOut(0x1FFD, v1);
        s.cpu.portOut(0x7FFD, v7);
        expect(s.memory.currentROM).not.toBe(3);
      }
    }
  });

  it('reports 48K BASIC active only on ROM page 1', () => {
    const s = scorpion();
    expect(s.memory.isBasicRomActive()).toBe(false);   // menu ROM
    s.cpu.portOut(0x7FFD, 0x10);
    expect(s.memory.isBasicRomActive()).toBe(true);
    s.cpu.portOut(0x1FFD, 0x02);
    expect(s.memory.isBasicRomActive()).toBe(false);   // service ROM
  });
});

describe('Scorpion — RAM at 0x0000 (1FFD D0)', () => {
  it('maps writable bank 0 over the ROM and restores the ROM afterwards', () => {
    const s = scorpion();
    s.cpu.portOut(0x7FFD, 0x01);                       // bank 1 at 0xC000, so bank 0 is not aliased
    s.cpu.write8(0x0010, 0x55);                        // ROM: the CPU write is discarded
    expect(s.memory.readByte(0x0010)).toBe(0);
    s.cpu.portOut(0x1FFD, 0x01);
    expect(s.memory.slot0Bank).toBe(0);
    s.cpu.write8(0x0010, 0x55);
    expect(s.memory.readByte(0x0010)).toBe(0x55);
    expect(s.memory.getRamBank(0)[0x10]).toBe(0x55);
    s.cpu.portOut(0x1FFD, 0x00);
    expect(s.memory.readByte(0x0000)).toBe(0xA0);      // ROM again
    expect(s.memory.readByte(0x0010)).toBe(0);
    s.cpu.portOut(0x1FFD, 0x01);
    expect(s.memory.readByte(0x0010)).toBe(0x55);      // RAM kept its contents
  });

  it('accepts CPU writes through the write hook, not just writeByte', () => {
    const s = scorpion();
    s.cpu.portOut(0x1FFD, 0x01);
    s.cpu.write8(0x0123, 0x9C);
    expect(s.memory.readByte(0x0123)).toBe(0x9C);
  });

  it('mirrors writes when bank 0 is also paged at 0xC000', () => {
    const s = scorpion();
    s.cpu.portOut(0x1FFD, 0x01);                       // 7FFD still 0: bank 0 at 0xC000 too
    s.memory.writeByte(0xC200, 0x77);
    expect(s.memory.readByte(0x0200)).toBe(0x77);
  });

  it('is not the 48K BASIC while RAM sits there', () => {
    const s = scorpion();
    s.cpu.portOut(0x7FFD, 0x10);
    s.cpu.portOut(0x1FFD, 0x01);
    expect(s.memory.isBasicRomActive()).toBe(false);
  });

  it('is cleared by reset', () => {
    const s = scorpion();
    s.cpu.portOut(0x1FFD, 0x13);
    s.reset();
    expect(s.memory.ramAtZero).toBe(false);
    expect(s.memory.port1FFD).toBe(0);
    expect(s.memory.readByte(0x0000)).toBe(0xA0);
  });
});

describe('Scorpion — built-in Beta Disk with TR-DOS in the system ROM', () => {
  it('is classed as having a built-in Beta Disk whose ROM is a system-ROM page', () => {
    expect(hasBuiltinBetaDisk('scorpion256')).toBe(true);
    expect(betaRomInSystemRom('scorpion256')).toBe(true);
    expect(betaRomInSystemRom('pentagon128')).toBe(false);
  });

  it('takes TR-DOS from page 3 of the system ROM and fetches no separate image', () => {
    const s = new Spectrum('scorpion256', null);
    const reqs = buildSpectrumAuxRoms(s, noSettings);
    expect(s.betaDisk.enabled).toBe(true);
    expect(reqs).toEqual([]);
    s.loadROM(rom64());
    expect(s.betaDisk.romLoaded).toBe(true);
    expect(s.betaDisk.rom[0]).toBe(0xA3);
    expect(s.betaDisk.rom[1]).toBe(0xB3);
  });

  it('leaves the other built-in-Beta machines fetching their TR-DOS ROM', () => {
    const p = new Spectrum('pentagon128', null);
    expect(buildSpectrumAuxRoms(p, noSettings).map(r => r.cacheKey)).toEqual(['betadisk-rom']);
  });

  it('has live FDC ports while the service ROM is selected, and not in the other ROMs', () => {
    const s = scorpion();
    s.betaDisk.enabled = true;
    expect(s.betaDisk.matchPort(0x1F)).toBe(false);    // menu ROM
    s.cpu.portOut(0x7FFD, 0x10);
    expect(s.betaDisk.matchPort(0x1F)).toBe(false);    // 48K BASIC
    s.cpu.portOut(0x1FFD, 0x02);
    for (const port of [0x1F, 0x3F, 0x5F, 0x7F, 0xFF]) expect(s.betaDisk.matchPort(port)).toBe(true);
    expect(s.betaDisk.matchPort(0xFE)).toBe(false);    // the keyboard port is never stolen
    s.cpu.portOut(0x1FFD, 0x00);
    expect(s.betaDisk.matchPort(0x1F)).toBe(false);
  });

  it('does not open the FDC ports on a Pentagon just because ROM 2 does not exist', () => {
    const p = new Spectrum('pentagon128', null);
    p.betaDisk.enabled = true;
    expect(p.betaDisk.matchPort(0x1F)).toBe(false);
  });
});

describe('Scorpion — snapshots (SZX)', () => {
  it('writes machine id 10', () => {
    const s = scorpion();
    expect(saveSZXSync(s.cpu, s.memory, 0, 'scorpion256', 0)[6]).toBe(10);
  });

  it('round-trips banks 8-15, 7FFD, 1FFD, the ROM page and RAM-at-0000', async () => {
    const a = scorpion();
    a.memory.getRamBank(11)[0x20] = 0xB1;
    a.memory.getRamBank(0)[0x20] = 0xC2;
    a.cpu.portOut(0x1FFD, 0x11);                        // D4 (bank bit 3) + RAM at 0
    a.cpu.portOut(0x7FFD, 0x13);                        // page 3 + 8 = 11, ROM bit set
    const szx = saveSZXSync(a.cpu, a.memory, 0, 'scorpion256', 0);
    const b = scorpion();
    applySZXPaging(b.memory, false, await loadSZX(szx, b.cpu, b.memory));
    expect(b.memory.port7FFD).toBe(0x13);
    expect(b.memory.port1FFD).toBe(0x11);
    expect(b.memory.currentBank).toBe(11);
    expect(b.memory.ramAtZero).toBe(true);
    expect(b.memory.readByte(0xC020)).toBe(0xB1);
    expect(b.memory.readByte(0x0020)).toBe(0xC2);       // RAM page 0 at 0x0000
  });

  it('restores the service ROM from 1FFD D1', async () => {
    const a = scorpion();
    a.cpu.portOut(0x1FFD, 0x02);
    a.cpu.portOut(0x7FFD, 0x10);
    const szx = saveSZXSync(a.cpu, a.memory, 0, 'scorpion256', 0);
    const b = scorpion();
    applySZXPaging(b.memory, false, await loadSZX(szx, b.cpu, b.memory));
    expect(b.memory.currentROM).toBe(2);
    expect(b.memory.readByte(0x0000)).toBe(0xA2);
  });

  it('saves only as .szx (no .z80 export, which has no Scorpion paging)', () => {
    expect(scorpion().descriptor.ui.saveMenu).not.toContain('snapshot-z80');
    expect(scorpion().descriptor.ui.saveMenu).toContain('snapshot-szx');
  });
});

describe('Library auto-boot trap for the clones', () => {
  it('waits at the 128K menu key-wait (their ROM 0 is the 128K menu ROM), not the 48K editor', () => {
    const rom0 = new Uint8Array(16384);
    for (const m of ['pentagon128', 'pentagon512', 'pentagon1024', 'scorpion256'] as const) {
      expect(bootWaitPc(m, rom0)).toBe(0x0E65);
    }
  });
});

describe('Scorpion — registry and menu', () => {
  it('is owned by the Spectrum machine entry and boots from the hosted ZS-256 ROM', () => {
    expect(entryForModel('scorpion256').kind).toBe('spectrum');
    expect(entryForModel('scorpion256').romSources('scorpion256')).toEqual(['clones/scorpion-zs256-v25c.rom']);
  });

  it('is listed in the Sinclair Clones group', () => {
    const clones = MODEL_MENU.find(g => g.label === 'Sinclair Clones');
    expect((clones!.children ?? []).map(i => i.value)).toContain('scorpion256');
  });

  it('a 64K ROM dropped on the ROM pane keeps the Scorpion model', () => {
    const entry = entryForModel('scorpion256');
    expect(entry.detectModelForRom?.(new Uint8Array(65536), 'scorpion256')).toBe('scorpion256');
    expect(entry.detectModelForRom?.(new Uint8Array(65536), '128k')).toBe('+2A');
  });
});
