/**
 * Pentagon 128 — the Russian 128K clone.
 *
 * Expected values are derived from the clone's published characteristics, not
 * from the implementation: a 3.5 MHz Z80, 224 T-states per line × 320 lines =
 * 71680 T-states per frame, no ULA contention, no floating bus, 128K banking
 * via the Sinclair-style 7FFD port, and a Beta Disk (TR-DOS) fitted on the board.
 */

import { describe, it, expect } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { buildSpectrumAuxRoms } from '@/machines/spectrum/aux-roms.ts';
import { entryForModel } from '@/machines/registry.ts';
import { MODEL_MENU, MODEL_LABELS, menuModels } from '@/ui/panes/model-menu.ts';
import {
  is128kClass, isPlus2AClass, isPlusDCapable, isInterface1Capable, isInterface2Capable,
  isBetaDiskCapable, hasBuiltinBetaDisk, isPentagonClass, romPageSlotCount,
  defaultRomPageLabel,
} from '@/models.ts';
import type { SettingsView } from '@/machines/machine.ts';

function pentagon(): Spectrum {
  const s = new Spectrum('pentagon128', null);
  // Two 16K pages, each tagged in its first byte, to tell them apart.
  const rom = new Uint8Array(32768);
  rom[0] = 0xA0;
  rom[16384] = 0xA1;
  s.loadROM(rom);
  return s;
}

function settings(values: Record<string, boolean>): SettingsView {
  return { get: <T>(key: string, fallback: T): T => (key in values ? (values[key] as unknown as T) : fallback) };
}

describe('Pentagon 128 — timing', () => {
  const t = pentagon().contention.timing;

  it('runs a 3.5 MHz Z80 (not the 128K 3.5469 MHz)', () => {
    expect(t.cpuClock).toBe(3_500_000);
  });

  it('has 224 T-states per line and 320 lines: 71680 T-states per frame', () => {
    expect(t.tStatesPerLine).toBe(224);
    expect(t.tStatesPerFrame).toBe(224 * 320);
    expect(t.tStatesPerFrame).toBe(71_680);
  });

  it('holds INT for 32 T-states', () => {
    expect(t.intLength).toBe(32);
  });
});

describe('Pentagon 128 — no contention, no floating bus', () => {
  const s = pentagon();
  const v = s.variant;

  it('never contends any address in any bank', () => {
    for (const addr of [0x0000, 0x4000, 0x7FFF, 0x8000, 0xC000, 0xFFFF]) {
      for (const bank of [-1, 0, 1, 2, 3, 4, 5, 6, 7]) {
        expect(v.isContended(addr, bank)).toBe(false);
      }
    }
    expect(v.hasIOContention).toBe(false);
  });

  it('adds no wait states in the middle of the display, where a 128K would stall', () => {
    const beam = s.contention.timing.displayOrigin + 100 * 224;
    for (let phase = 0; phase < 8; phase++) {
      expect(s.contention.contentionDelay(beam + phase)).toBe(0);
    }
  });

  it('reads 0xFF from an unattached port instead of the ULA fetch byte', () => {
    // A floating bus would leak this non-0xFF pattern from the screen bank.
    s.memory.getRamBank(5).fill(0x55);
    s.cpu.tStates = s.contention.timing.displayOrigin + 100 * 224 + 3;
    expect(s.cpu.portIn(0x40FF) & 0xFF).toBe(0xFF);
  });
});

describe('Pentagon 128 — 128K banking', () => {
  const s = pentagon();

  it('is a 128K-class machine with AY, two ROM pages and no +2A/+3 hardware', () => {
    expect(is128kClass('pentagon128')).toBe(true);
    expect(isPlus2AClass('pentagon128')).toBe(false);
    expect(s.variant.hasAY).toBe(true);
    expect(s.variant.hasBanking).toBe(true);
    expect(s.variant.romPageCount).toBe(2);
    expect(s.variant.hasFDC).toBe(false);
    expect(s.variant.hasSpecialPaging).toBe(false);
    expect(romPageSlotCount('pentagon128')).toBe(2);
  });

  it('decodes 7FFD when A15 and A1 are low, like the Sinclair 128K', () => {
    const v = s.variant;
    expect(v.decodes7FFD(0x7FFD)).toBe(true);
    expect(v.decodes7FFD(0x7FFF)).toBe(false); // A1 set
    expect(v.decodes7FFD(0xFFFD)).toBe(false); // A15 set (the AY register port)
    expect(v.decodes1FFD(0x1FFD)).toBe(false);
  });

  it('pages RAM bank 3 into 0xC000 and ROM 1 into 0x0000 on a 7FFD write', () => {
    s.cpu.portOut(0x7FFD, 0x13); // bank 3, ROM select bit set
    expect(s.memory.currentROM).toBe(1);
    expect(s.memory.readByte(0x0000)).toBe(0xA1);
    s.memory.writeByte(0xC000, 0x77);
    expect(s.memory.getRamBank(3)[0]).toBe(0x77);
  });

  it('labels its ROM pages as the Pentagon 128K and 48K BASIC', () => {
    expect(defaultRomPageLabel('pentagon128', 0)).toBe('Pentagon 128K BASIC');
    expect(defaultRomPageLabel('pentagon128', 1)).toBe('Pentagon 48K BASIC');
  });
});

describe('Pentagon 128 — built-in Beta Disk', () => {
  it('is classed as Pentagon with a built-in Beta Disk', () => {
    expect(isPentagonClass('pentagon128')).toBe(true);
    expect(hasBuiltinBetaDisk('pentagon128')).toBe(true);
    expect(isBetaDiskCapable('pentagon128')).toBe(true);
  });

  it('no Sinclair model has a built-in Beta Disk', () => {
    for (const m of ['zx16k', 'zx48k', 'zx128k', 'zx128kplus2', 'zx128kplus2a', 'zx128kplus3'] as const) {
      expect(hasBuiltinBetaDisk(m)).toBe(false);
    }
  });

  it('fits the Beta Disk even when the Hardware setting is off, and requests the TR-DOS ROM', () => {
    const s = new Spectrum('pentagon128', null);
    const reqs = buildSpectrumAuxRoms(s, settings({}));
    expect(s.betaDisk.enabled).toBe(true);
    expect(reqs.map(r => r.cacheKey)).toEqual(['betadisk-rom']);
  });

  it('keeps the +D and Interface 1 out, since they would fight over slot 0', () => {
    const s = new Spectrum('pentagon128', null);
    buildSpectrumAuxRoms(s, settings({ plusd: true, interface1: true }));
    expect(s.mgtPlusD.enabled).toBe(false);
    expect(s.interface1.enabled).toBe(false);
    expect(isPlusDCapable('pentagon128')).toBe(false);
    expect(isInterface1Capable('pentagon128')).toBe(false);
    expect(isInterface2Capable('pentagon128')).toBe(false);
  });

  it('does not fit a Beta Disk to a plain 128K unless asked', () => {
    const s = new Spectrum('zx128k', null);
    buildSpectrumAuxRoms(s, settings({}));
    expect(s.betaDisk.enabled).toBe(false);
  });
});

describe('Pentagon 128 — registry and menu', () => {
  it('is owned by the Spectrum machine entry', () => {
    expect(entryForModel('pentagon128').kind).toBe('spectrum');
  });

  it('is listed under a Sinclair Clones group, not under Sinclair', () => {
    const clones = MODEL_MENU.find(g => g.label === 'Sinclair Clones');
    expect(clones).toBeDefined();
    expect((clones!.children ?? []).map(i => i.value)).toEqual(['pentagon128', 'pentagon512', 'pentagon1024', 'scorpion256']);
    const sinclair = MODEL_MENU.find(g => g.label === 'Sinclair');
    expect((sinclair!.children ?? []).map(i => i.value)).not.toContain('pentagon128');
    expect(menuModels()).toContain('pentagon128');
    expect(MODEL_LABELS.pentagon128).toBe('Pentagon 128');
  });

  it('boots from the 128K ROM pair until a Pentagon ROM is hosted', () => {
    expect(entryForModel('pentagon128').romSources('pentagon128')).toEqual([
      'sinclair/128-0.rom', 'sinclair/128-1.rom',
    ]);
  });
});
