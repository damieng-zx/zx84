/**
 * CpcMemory — ROM image accessors used by the memory viewer.
 *
 * loadROM() splits a combined image into the lower (OS) ROM and the upper ROMs
 * (BASIC = select 0, AMSDOS = select 7). getLowerRom()/getUpperRom() expose
 * those images for the debug UI. Expectations are derived from the documented
 * CPC layout (32KB = OS+BASIC, 48KB = +AMSDOS), each ROM exactly 16KB.
 */

import { describe, it, expect } from 'vitest';
import { CpcMemory } from '@/cpc/cpc-memory.ts';
import { createCpcConfig } from '@/cpc/config.ts';

const SLOT = 0x4000;

/** Build a 48KB image whose three 16KB ROMs are filled with distinct bytes. */
function makeImage(lowerByte: number, basicByte: number, amsdosByte: number): Uint8Array {
  const img = new Uint8Array(SLOT * 3);
  img.fill(lowerByte, 0, SLOT);
  img.fill(basicByte, SLOT, SLOT * 2);
  img.fill(amsdosByte, SLOT * 2, SLOT * 3);
  return img;
}

describe('CpcMemory ROM accessors', () => {
  it('splits a 48KB image into lower/BASIC/AMSDOS, each 16KB', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33));

    const lower = mem.getLowerRom();
    const basic = mem.getUpperRom(0);
    const amsdos = mem.getUpperRom(7);

    expect(lower.length).toBe(SLOT);
    expect(basic?.length).toBe(SLOT);
    expect(amsdos?.length).toBe(SLOT);

    // Each ROM holds its own fill byte — proves the split offsets are right.
    expect(lower[0]).toBe(0x11);
    expect(lower[SLOT - 1]).toBe(0x11);
    expect(basic![0]).toBe(0x22);
    expect(amsdos![SLOT - 1]).toBe(0x33);
  });

  it('omits AMSDOS when only a 32KB image is supplied', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33).subarray(0, SLOT * 2));

    expect(mem.getLowerRom()[0]).toBe(0x11);
    expect(mem.getUpperRom(0)?.[0]).toBe(0x22);
    // No upper ROM 7 was loaded.
    expect(mem.getUpperRom(7)).toBeUndefined();
  });

  it('rejects an undersized image (< 32KB)', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    expect(() => mem.loadROM(new Uint8Array(SLOT))).toThrow(/too small/);
  });

  it('getLowerRom returns a live view that reflects the mapped OS ROM byte', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    mem.loadROM(makeImage(0xAB, 0x00, 0x00));
    // Lower ROM is enabled at reset and overlays slot 0, so readByte(0) hits it.
    expect(mem.readByte(0x0000)).toBe(0xAB);
    expect(mem.getLowerRom()[0]).toBe(mem.readByte(0x0000));
  });
});
