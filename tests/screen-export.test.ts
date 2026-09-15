import { describe, it, expect } from 'vitest';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';

describe('Spectrum screen export', () => {
  it('exports bank 7 when shadow display is selected, then bank 5 when restored', () => {
    const m = new Spectrum('128k');
    try {
      m.memory.getRamBank(5).fill(0x55);
      m.memory.getRamBank(7).fill(0xaa);
      m.memory.bankSwitch(8);
      const shadow = m.services.debug.screenExport()!;
      expect(shadow).toEqual(new Uint8Array(6912).fill(0xaa));
      m.memory.bankSwitch(0);
      expect(m.services.debug.screenExport()).toEqual(new Uint8Array(6912).fill(0x55));
      m.memory.getRamBank(7).fill(0);
      expect(shadow[0]).toBe(0xaa);
    } finally { m.destroy(); }
  });
});
