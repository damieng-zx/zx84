import { describe, expect, it } from 'vitest';
import { romPageSlotCount, romSlotSize, defaultRomPageLabel } from '@/models.ts';

/**
 * The MTX firmware is five separate 8K ROMs fetched individually from the CDN
 * (os / basic / assem / boot-type07 / sdx-type07) and concatenated in that
 * order for MtxMemory.loadRom. The ROM pane should surface them as five
 * independently-overridable slots, reusing the Spectrum multi-slot mechanism
 * at an 8K stride rather than the Spectrum's 16K.
 */
describe('MTX ROM slot layout', () => {
  it('exposes five 8K ROM slots for every MTX model', () => {
    for (const model of ['mtx500', 'mtx512', 'rs128'] as const) {
      expect(romPageSlotCount(model)).toBe(5);
      expect(romSlotSize(model)).toBe(0x2000);
    }
  });

  it('names each default slot by its ROM identity in loadRom order', () => {
    expect(defaultRomPageLabel('mtx512', 0)).toBe('MTX OS');
    expect(defaultRomPageLabel('mtx512', 1)).toBe('MTX BASIC');
    expect(defaultRomPageLabel('mtx512', 2)).toBe('MTX ASSEM');
    expect(defaultRomPageLabel('mtx512', 3)).toBe('CP/M Bootstrap');
    expect(defaultRomPageLabel('mtx512', 4)).toBe('FDX Disk BASIC');
  });

  it('leaves the Spectrum 16K slot geometry unchanged', () => {
    expect(romSlotSize('128k')).toBe(16384);
    expect(romSlotSize('+3')).toBe(16384);
    expect(romPageSlotCount('128k')).toBe(2);
    expect(romPageSlotCount('+3')).toBe(4);
    expect(defaultRomPageLabel('+3', 2)).toBe('+3DOS');
  });

  it('reports a single combined slot for machines without ROM pages', () => {
    expect(romPageSlotCount('48k')).toBe(0);
    expect(romSlotSize('48k')).toBe(16384);
  });
});
