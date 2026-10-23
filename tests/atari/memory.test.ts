/**
 * Atari 400/800 memory-map tests.
 *
 * The 400 fits 16K at $0000-$3FFF; the 800 fits 48K at $0000-$BFFF. An 8K
 * cartridge overlays $A000-$BFFF, a 16K cartridge overlays $8000-$BFFF and a
 * 4K cartridge mirrors across the 8K window. The 10K OS image lives at $D800
 * (2K floating point) and $E000 (8K OS). Everything else reads $FF.
 */

import { describe, it, expect } from 'vitest';
import { AtariMemory } from '@/machines/atari/memory.ts';
import { ATARI_OS_SIZE } from '@/machines/atari/models.ts';

describe('atari memory sizes', () => {
  it('maps 16K RAM on the 400 and open bus above it', () => {
    const mem = new AtariMemory(0x4000);
    mem.ram[0x3fff] = 0xaa;
    expect(mem.readByte(0x3fff)).toBe(0xaa);
    expect(mem.readByte(0x4000)).toBe(0xff);
    mem.writeByte(0x4000, 0x55);
    expect(mem.readByte(0x4000)).toBe(0xff);
    expect(mem.ramBankCount).toBe(1);
  });

  it('maps 48K RAM on the 800, with $C000-$CFFF still open bus', () => {
    const mem = new AtariMemory(0xc000);
    mem.ram[0xbfff] = 0x12;
    expect(mem.readByte(0xbfff)).toBe(0x12);
    expect(mem.readByte(0xc000)).toBe(0xff);
    expect(mem.ramBankCount).toBe(3);
    mem.ram[0x4000] = 0x34;
    expect(mem.getRamBank(1)[0]).toBe(0x34);
  });
});

describe('atari OS ROM', () => {
  it('installs the 10K image at $D800', () => {
    const mem = new AtariMemory(0xc000);
    const rom = new Uint8Array(ATARI_OS_SIZE);
    rom[0] = 0x20;               // $D800
    rom[0x7ff] = 0x99;           // $DFFF
    rom[0x800] = 0x41;           // $E000 (font/OS)
    rom[ATARI_OS_SIZE - 1] = 0xee; // $FFFF
    expect(mem.loadRom(rom)).toBe(true);
    expect(mem.readByte(0xd800)).toBe(0x20);
    expect(mem.readByte(0xdfff)).toBe(0x99);
    expect(mem.readByte(0xe000)).toBe(0x41);
    expect(mem.readByte(0xffff)).toBe(0xee);
  });

  it('rejects an 8K image (that size is a BASIC cartridge, not the OS)', () => {
    const mem = new AtariMemory(0xc000);
    expect(mem.loadRom(new Uint8Array(0x2000))).toBe(false);
  });

  it('ignores writes to the OS window', () => {
    const mem = new AtariMemory(0xc000);
    mem.writeByte(0xe000, 0x55);
    expect(mem.readByte(0xe000)).toBe(0x00);
  });
});

describe('atari cartridges', () => {
  it('overlays 8K at $A000 and leaves $8000-$9FFF as RAM', () => {
    const mem = new AtariMemory(0xc000);
    mem.ram[0xa000] = 0x11;
    mem.ram[0x8000] = 0x77;
    const cart = new Uint8Array(0x2000).fill(0x5a);
    expect(mem.insertCart(cart)).toBe(true);
    expect(mem.readByte(0xa000)).toBe(0x5a);
    expect(mem.readByte(0xbfff)).toBe(0x5a);
    expect(mem.readByte(0x8000)).toBe(0x77);
    // ROM: the RAM underneath is not writable through the CPU.
    mem.writeByte(0xa000, 0x22);
    expect(mem.readByte(0xa000)).toBe(0x5a);
    expect(mem.ram[0xa000]).toBe(0x11);
  });

  it('overlays 16K at $8000', () => {
    const mem = new AtariMemory(0xc000);
    const cart = new Uint8Array(0x4000);
    cart[0] = 0xa0;
    cart[0x3fff] = 0xb0;
    expect(mem.insertCart(cart)).toBe(true);
    expect(mem.readByte(0x8000)).toBe(0xa0);
    expect(mem.readByte(0xbfff)).toBe(0xb0);
  });

  it('puts a 4K cartridge in the top of the 8K window, the half below reading $FF', () => {
    const mem = new AtariMemory(0x4000);
    const cart = new Uint8Array(0x1000);
    cart[0] = 0xde;
    cart[0xfff] = 0xad;
    expect(mem.insertCart(cart)).toBe(true);
    expect(mem.readByte(0xa000)).toBe(0xff);
    expect(mem.readByte(0xafff)).toBe(0xff);
    expect(mem.readByte(0xb000)).toBe(0xde);
    expect(mem.readByte(0xbfff)).toBe(0xad);
  });

  /** A 16K OSS dump of three chips with distinct fill and the bank ids that
   *  let the board be recognised, then the fixed 4K. */
  function ossImage(ids: [number, number, number]): Uint8Array {
    const d = new Uint8Array(0x4000);
    d.fill(0xf0, 0x0000, 0x1000);
    d.fill(0x3c, 0x1000, 0x2000);
    d.fill(0xcf, 0x2000, 0x3000);
    d.fill(0xaa, 0x3000, 0x4000);
    [d[0x0fff], d[0x1fff], d[0x2fff]] = ids;
    return d;
  }

  it('reads the 034M banks $x1 and $x5 as two chips driving the bus together (wired-AND)', () => {
    const mem = new AtariMemory(0xc000);
    expect(mem.insertCart(ossImage([0, 3, 4]))).toBe(true);
    expect(mem.cart!.type).toBe('oss-034m');
    expect(mem.readByte(0xb000)).toBe(0xaa);          // the fixed bank
    mem.readByte(0xd500); expect(mem.readByte(0xa000)).toBe(0xf0);
    mem.readByte(0xd503); expect(mem.readByte(0xa000)).toBe(0x3c);
    mem.readByte(0xd504); expect(mem.readByte(0xa000)).toBe(0xcf);
    mem.readByte(0xd501); expect(mem.readByte(0xa000)).toBe(0xf0 & 0x3c);
    mem.readByte(0xd505); expect(mem.readByte(0xa123)).toBe(0xcf & 0x3c);
    mem.readByte(0xd502); expect(mem.readByte(0xa000)).toBe(0xff);
    mem.readByte(0xd506); expect(mem.readByte(0xa000)).toBe(0xff);
    mem.readByte(0xd508); expect(mem.cart!.enabled).toBe(false);
  });

  it('reads the 043M banks $x1 and $x5 as their wired-AND of the chips it selects', () => {
    const mem = new AtariMemory(0xc000);
    expect(mem.insertCart(ossImage([0, 4, 3]))).toBe(true);
    expect(mem.cart!.type).toBe('oss-043m');
    mem.readByte(0xd503); expect(mem.readByte(0xa000)).toBe(0xcf);
    mem.readByte(0xd504); expect(mem.readByte(0xa000)).toBe(0x3c);
    mem.readByte(0xd501); expect(mem.readByte(0xa000)).toBe(0xf0 & 0xcf);
    mem.readByte(0xd505); expect(mem.readByte(0xa000)).toBe(0xcf & 0x3c);
  });

  it('tells an 8K OSS dump (vectors only in its first 4K) from a standard 8K cartridge', () => {
    const vectors = (d: Uint8Array, end: number) => {
      d[end - 4] = 0;                                  // cartridge present
      d[end - 2] = 0x00; d[end - 1] = 0xa0;            // INIT at $A000
    };
    const oss = new Uint8Array(0x2000);
    vectors(oss, 0x1000);
    oss[0x1ffc] = 1;                                   // nothing like vectors at the top
    const std = new Uint8Array(0x2000);
    vectors(std, 0x2000);
    const mem = new AtariMemory(0xc000);
    expect(mem.insertCart(oss)).toBe(true);
    expect(mem.cart!.type).toBe('oss8');
    expect(mem.insertCart(std)).toBe(true);
    expect(mem.cart!.type).toBe('std8');
  });

  it('ejects cleanly and keeps the old RAM underneath intact', () => {
    const mem = new AtariMemory(0xc000);
    mem.ram[0xa000] = 0x42;
    mem.insertCart(new Uint8Array(0x2000).fill(0xff));
    expect(mem.readByte(0xa000)).toBe(0xff);
    mem.ejectCart();
    expect(mem.readByte(0xa000)).toBe(0x42);
  });

  it('rejects sizes it cannot decode', () => {
    const mem = new AtariMemory(0xc000);
    expect(mem.insertCart(new Uint8Array(0x1800))).toBe(false);
    expect(mem.cart).toBeNull();
  });
});

describe('atari hardware window', () => {
  it('routes $D000-$D7FF to the machine, and other pages float high', () => {
    const mem = new AtariMemory(0xc000);
    const written: [number, number][] = [];
    mem.ioRead = (addr) => (addr === 0xd01a ? 0x3c : -1);
    mem.ioWrite = (addr, value) => { written.push([addr, value]); };

    expect(mem.readByte(0xd01a)).toBe(0x3c);
    expect(mem.readByte(0xd100)).toBe(0xff);
    expect(mem.readByte(0xd7ff)).toBe(0xff);
    mem.writeByte(0xd400, 0x22);
    expect(written).toEqual([[0xd400, 0x22]]);
  });

  it('readRam never triggers the hardware (ANTIC fetches no registers)', () => {
    const mem = new AtariMemory(0xc000);
    mem.ioRead = () => { throw new Error('hardware must not be touched'); };
    expect(mem.readRam(0xd400)).toBe(0xff);
    expect(mem.readRam(0x1000)).toBe(0x00);
  });
});
