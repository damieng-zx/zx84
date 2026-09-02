/**
 * CpcMemory — ROM image accessors used by the memory viewer.
 *
 * loadROM() splits a combined image into the lower (OS) ROM and the upper ROMs
 * (BASIC = select 0, AMSDOS = select 7). getLowerRom()/getUpperRom() expose
 * those images for the debug UI. Expectations are derived from the documented
 * CPC layout (32KB = OS+BASIC, 48KB = +AMSDOS), each ROM exactly 16KB.
 */

import { describe, it, expect } from 'vitest';
import { CpcMemory } from '@/machines/cpc/cpc-memory.ts';
import { createCpcConfig } from '@/machines/cpc/config.ts';

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

  it('setUpperRom(7) overlays ParaDOS over AMSDOS without touching BASIC', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33)); // lower=0x11, BASIC=0x22, AMSDOS=0x33

    // Swap AMSDOS (ROM 7) for a ParaDOS image filled with 0x99.
    const parados = new Uint8Array(SLOT).fill(0x99);
    mem.setUpperRom(7, parados);

    // Selecting + enabling ROM 7 makes the CPU see ParaDOS at 0xC000.
    mem.selectUpperRom(7);
    expect(mem.readByte(0xC000)).toBe(0x99);
    expect(mem.getUpperRom(7)?.[0]).toBe(0x99);

    // BASIC (upper ROM 0) is unchanged.
    expect(mem.getUpperRom(0)?.[0]).toBe(0x22);
    mem.selectUpperRom(0);
    expect(mem.readByte(0xC000)).toBe(0x22);
  });

  it('setUpperRom pads a short ParaDOS image to a full 16KB bank', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33));
    mem.setUpperRom(7, new Uint8Array(100).fill(0x5A)); // undersized
    expect(mem.getUpperRom(7)?.length).toBe(SLOT);
    expect(mem.getUpperRom(7)?.[0]).toBe(0x5A);
    expect(mem.getUpperRom(7)?.[SLOT - 1]).toBe(0x00); // padded tail
  });
});

describe('CpcMemory pagingState (memory-layout pane)', () => {
  it('reports the reset configuration', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    const p = mem.pagingState();
    // At reset: standard config 0, both ROMs enabled, BASIC (0) selected upper.
    expect(p.ramConfig).toBe(0);
    expect(p.ram64kBlock).toBe(0);
    expect(p.slotBanks).toEqual([0, 1, 2, 3]);
    expect(p.lowerRomEnabled).toBe(true);
    expect(p.upperRomEnabled).toBe(true);
    expect(p.selectedUpperRom).toBe(0);
  });

  it('resolves RAM config 2 to the all-expansion bank set', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    // Gate-Array %11xxx010 — config 2 maps the four expansion banks (Dk'tronics).
    mem.setRamConfig(2);
    expect(mem.pagingState().slotBanks).toEqual([4, 5, 6, 7]);
  });

  it('resolves RAM config 3 (mixed base/expansion banks)', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    mem.setRamConfig(3);
    expect(mem.pagingState().slotBanks).toEqual([0, 3, 2, 7]);
  });

  it('tracks ROM enable bits and the selected upper ROM', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    mem.setLowerRomEnabled(false);
    mem.setUpperRomEnabled(false);
    mem.selectUpperRom(7);
    const p = mem.pagingState();
    expect(p.lowerRomEnabled).toBe(false);
    expect(p.upperRomEnabled).toBe(false);
    expect(p.selectedUpperRom).toBe(7);
  });
});

describe('CPC config (464/664)', () => {
  // Spec: both 64KB models have four 16KB banks; only the 664 carries a uPD765A.
  it('describes the 464 as 64KB, 4 banks, no disk controller', () => {
    const c = createCpcConfig('cpc464');
    expect(c.ramKB).toBe(64);
    expect(c.ramBanks).toBe(4);
    expect(c.hasFDC).toBe(false);
  });

  it('describes the 664 as 64KB, 4 banks, with a disk controller', () => {
    const c = createCpcConfig('cpc664');
    expect(c.ramKB).toBe(64);
    expect(c.ramBanks).toBe(4);
    expect(c.hasFDC).toBe(true);
  });
});

describe('CPC Plus config (6128Plus / GX4000)', () => {
  // Spec: both Plus models use the Amstrad 40489 ASIC (type-4 CRTC), 128KB
  // (8 banks), and the same Dk'tronics banking scheme as the 6128.
  it('describes the 6128Plus as ASIC-based, 128KB, with disk + tape', () => {
    const c = createCpcConfig('cpc6128plus');
    expect(c.isPlus).toBe(true);
    expect(c.crtcType).toBe(4);
    expect(c.ramKB).toBe(128);
    expect(c.ramBanks).toBe(8);
    expect(c.hasFDC).toBe(true);
    expect(c.hasTape).toBe(true);
  });

  it('describes the GX4000 as ASIC-based, 128KB, no disk and no tape', () => {
    const c = createCpcConfig('gx4000');
    expect(c.isPlus).toBe(true);
    expect(c.crtcType).toBe(4);
    expect(c.ramKB).toBe(128);
    expect(c.ramBanks).toBe(8);
    expect(c.hasFDC).toBe(false);
    expect(c.hasTape).toBe(false);
  });

  it('leaves non-Plus models on the discrete gate array', () => {
    expect(createCpcConfig('cpc6128').isPlus).toBe(false);
    expect(createCpcConfig('cpc664').isPlus).toBe(false);
    expect(createCpcConfig('cpc464').isPlus).toBe(false);
  });
});

describe('CpcMemory Plus ROM-select (logical → physical mapping)', () => {
  // Spec: the Plus's ROM-select byte uses bit 7 to distinguish logical (0)
  // from physical (0x80 | n). Logical 0 = BASIC (physical 1), logical 7 =
  // AMSDOS (physical 3) — the Burnin' Rubber cartridge layout.
  it('maps logical 0 to physical page 1 (BASIC)', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128plus'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33));   // OS=0x11, BASIC=0x22, AMSDOS=0x33
    // After loadROM, BASIC is mirrored to physical slot 1.
    expect(mem.getUpperRom(1)?.[0]).toBe(0x22);
    mem.selectUpperRom(0);   // logical 0
    expect(mem.readByte(0xC000)).toBe(0x22);
  });

  it('maps logical 7 to physical page 3 (AMSDOS)', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128plus'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33));
    expect(mem.getUpperRom(3)?.[0]).toBe(0x33);
    mem.selectUpperRom(7);   // logical 7
    expect(mem.readByte(0xC000)).toBe(0x33);
  });

  it('addresses a cartridge page directly with the 0x80 bit set', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128plus'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33));
    // Load a 5-page cartridge where page 5 is filled with 0x55.
    const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
    pages[5] = new Uint8Array(SLOT).fill(0x55);
    mem.loadCartridge(pages);
    mem.selectUpperRom(0x80 | 5);   // direct physical
    expect(mem.readByte(0xC000)).toBe(0x55);
  });

  it('non-Plus models pass the select byte through unchanged', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33));
    mem.selectUpperRom(0);
    expect(mem.readByte(0xC000)).toBe(0x22);   // BASIC at upper ROM 0
    mem.selectUpperRom(7);
    expect(mem.readByte(0xC000)).toBe(0x33);   // AMSDOS at upper ROM 7
  });

  it('selecting an unmapped upper ROM number falls back to on-board BASIC, not open bus', () => {
    // Real hardware's ROM-select routine relies on an out-of-range number
    // recovering to the on-board firmware rather than reading open bus.
    const mem = new CpcMemory(createCpcConfig('cpc6128'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33)); // only ROM 0 (BASIC) and 7 (AMSDOS) exist
    mem.selectUpperRom(3); // never loaded
    expect(mem.readByte(0xC000)).toBe(0x22); // BASIC, not 0xFF
  });

  it('loadCartridge replaces the lower ROM with cartridge page 0', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128plus'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33));
    expect(mem.readByte(0x0000)).toBe(0x11);   // OS lower ROM
    const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
    pages[0] = new Uint8Array(SLOT).fill(0x77);
    mem.loadCartridge(pages);
    expect(mem.readByte(0x0000)).toBe(0x77);
  });

  it('ejectCartridge clears upper-ROM slots 1..31', () => {
    const mem = new CpcMemory(createCpcConfig('cpc6128plus'));
    const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
    pages[1] = new Uint8Array(SLOT).fill(0xBB);
    pages[5] = new Uint8Array(SLOT).fill(0x55);
    mem.loadCartridge(pages);
    expect(mem.getUpperRom(1)?.[0]).toBe(0xBB);
    mem.ejectCartridge();
    expect(mem.getUpperRom(1)).toBeUndefined();
    expect(mem.getUpperRom(5)).toBeUndefined();
  });

  it('ejectCartridge drops the lower ROM to open bus (0xFF) immediately', () => {
    // Ejecting the cartridge physically removes all ROM access — the lower ROM
    // must not keep serving the ejected cartridge's page 0.
    const mem = new CpcMemory(createCpcConfig('cpc6128plus'));
    const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
    pages[0] = new Uint8Array(SLOT).fill(0x77);
    mem.loadCartridge(pages);
    expect(mem.readByte(0x0000)).toBe(0x77);
    mem.ejectCartridge();
    expect(mem.readByte(0x0000)).toBe(0xFF);
  });

  it('reset after ejectCartridge boots to open bus, not the stale cartridge', () => {
    // reset() re-maps cartPages[0] as the lower ROM; if eject left cartPages
    // populated, the machine would boot the just-ejected firmware.
    const mem = new CpcMemory(createCpcConfig('cpc6128plus'));
    const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
    pages[0] = new Uint8Array(SLOT).fill(0x77);
    mem.loadCartridge(pages);
    mem.ejectCartridge();
    mem.reset();
    expect(mem.readByte(0x0000)).toBe(0xFF);
  });

  it('an unmapped upper ROM stays open bus on GX4000/Plus after a system cartridge load', () => {
    // A system cartridge (page 0 present) clears every upper-ROM slot,
    // including 0 -- a console cartridge may supply no BASIC at all, so
    // unlike the classic CPC there's no on-board firmware to fall back to.
    const mem = new CpcMemory(createCpcConfig('cpc6128plus'));
    mem.loadROM(makeImage(0x11, 0x22, 0x33)); // BASIC loaded initially...
    const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
    pages[0] = new Uint8Array(SLOT).fill(0x77); // system cartridge
    mem.loadCartridge(pages);
    expect(mem.getUpperRom(0)).toBeUndefined(); // ...cleared by the load
    mem.selectUpperRom(0x80 | 9); // direct physical page 9, never provided
    expect(mem.readByte(0xC000)).toBe(0xFF);
  });
});

describe('CpcMemory on a 64KB machine (464/664)', () => {
  it('allocates only four RAM banks', () => {
    const mem = new CpcMemory(createCpcConfig('cpc464'));
    // Banks 4-7 don't physically exist; getRamBank falls back to bank 0.
    expect(mem.getRamBank(4)).toBe(mem.getRamBank(0));
  });

  it('wraps expansion RAM-config banks into the base 64KB (no banks 4-7)', () => {
    const mem = new CpcMemory(createCpcConfig('cpc464'));
    // RAM config 2 selects [4,5,6,7] on a 6128; with only 4 banks each wraps
    // mod 4, so a 64KB machine sees the base banks instead.
    mem.setRamConfig(2);
    expect(mem.pagingState().slotBanks).toEqual([0, 1, 2, 3]);
  });

  it('boots the 464 ROM set with no AMSDOS (upper ROM 7 absent)', () => {
    const mem = new CpcMemory(createCpcConfig('cpc464'));
    // 32KB image: OS + BASIC only, like the real 464.
    mem.loadROM(makeImage(0x11, 0x22, 0x33).subarray(0, SLOT * 2));
    expect(mem.getUpperRom(0)?.[0]).toBe(0x22); // BASIC present
    expect(mem.getUpperRom(7)).toBeUndefined(); // AMSDOS absent
  });
});
