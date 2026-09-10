/**
 * The Lynx 128K's banking is the 48K's idea with every field moved: the port is
 * 0x82 rather than 0x7F, the write and read nibbles swap ends, each nibble is
 * bit-reversed, port 0x80 no longer joins the decode, and there is a fourth
 * bank of RAM. All of it from MAME's `port82_w`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxMemory } from '@/machines/lynx/lynx-memory.ts';

const PAGE = 0x2000;
const BANK1 = 0x10000, BANK2 = 0x20000, BANK3 = 0x30000, BANK4 = 0x40000;

/** Port 0x82 as the ROM would write it, from what you want enabled.
 *  `write` is banks 1-4 in that order; `read` is banks 0, 1, 2, 4. */
function port82(write: readonly number[], read: readonly number[]): number {
  let data = 0;
  write.forEach((on, i) => { if (on) data |= 0x80 >> i; });   // d7..d4 = banks 1..4
  read.forEach((on, i) => { if (on) data |= 0x08 >> i; });    // d3..d0 = banks 0,1,2,4
  return data ^ 0x8c;                                         // d7, d3 and d2 are active low
}

describe('Lynx 128K banking', () => {
  let mem: LynxMemory;
  beforeEach(() => {
    mem = new LynxMemory('lynx128');
    mem.loadRoms([
      new Uint8Array(PAGE).fill(0x11),
      new Uint8Array(PAGE).fill(0x22),
      new Uint8Array(PAGE).fill(0x33),
    ]);
  });

  it('has the fourth bank of RAM the 48K has not', () => {
    expect(mem.ram.length).toBe(40 * PAGE);
    expect(new LynxMemory('lynx48').ram.length).toBe(32 * PAGE);
  });

  it('resets with the ROM under the CPU, all three images in a row', () => {
    expect(mem.readByte(0x0000)).toBe(0x11);
    expect(mem.readByte(0x2000)).toBe(0x22);
    expect(mem.readByte(0x4000)).toBe(0x33);
  });

  it('reads user RAM throughout once bank 1 alone is read-enabled', () => {
    mem.ram[BANK1] = 0x99;
    mem.writeBankPort(port82([1, 0, 0, 0], [0, 1, 0, 0]));
    expect(mem.readByte(0x0000)).toBe(0x99);
  });

  it('writes one address per bank, without the 48K mirroring', () => {
    mem.writeBankPort(port82([1, 1, 1, 1], [0, 1, 0, 0]));
    mem.writeByte(0x1234, 0xa5);
    expect(mem.ram[BANK1 + 0x1234]).toBe(0xa5);
    expect(mem.ram[BANK2 + 0x1234]).toBe(0xa5);
    expect(mem.ram[BANK3 + 0x1234]).toBe(0xa5);
    expect(mem.ram[BANK4 + 0x1234]).toBe(0xa5);
    // The 48K would also have painted these; the 128K decodes in full.
    expect(mem.ram[0x22000 + 0x1234]).toBe(0x00);
    expect(mem.ram[0x28000 + 0x1234]).toBe(0x00);
  });

  it('ignores port 0x80, which on the 48K would re-decode the banks', () => {
    mem.writeBankPort(port82([1, 1, 1, 0], [0, 1, 0, 0]));
    mem.setPort80(0x0c);          // both video vetoes, were this a 48K
    mem.writeByte(0x0010, 0x3c);
    expect(mem.ram[BANK2 + 0x0010]).toBe(0x3c);
    expect(mem.ram[BANK3 + 0x0010]).toBe(0x3c);
  });

  it('drops bank 4 from the read when bank 2 is selected (the AND gate in IC82)', () => {
    mem.ram[16 * PAGE] = 0xb2;    // bank 2, page 16
    mem.ram[32 * PAGE] = 0xb4;    // bank 4, page 32
    // Asking for both gives bank 2's layout, not bank 4's.
    mem.writeBankPort(port82([0, 0, 0, 0], [0, 0, 1, 1]));
    expect(mem.readByte(0x0000)).toBe(0xb2);
    // Bank 4 alone still reaches it.
    mem.writeBankPort(port82([0, 0, 0, 0], [0, 0, 0, 1]));
    expect(mem.readByte(0x0000)).toBe(0xb4);
  });

  it('keeps the ROM low while paging RAM high, DOS slot and all', () => {
    mem.loadRoms(
      [new Uint8Array(PAGE).fill(0x11), new Uint8Array(PAGE).fill(0x22),
        new Uint8Array(PAGE).fill(0x33)],
      new Uint8Array(PAGE).fill(0xd0),
    );
    mem.ram[15 * PAGE] = 0x77;
    // ROM + user RAM together: the ROM keeps the bottom 24K, RAM the rest.
    mem.writeBankPort(port82([1, 0, 0, 0], [1, 1, 0, 0]));
    expect(mem.readByte(0x0000)).toBe(0x11);
    expect(mem.readByte(0x6000)).toBe(0x00);   // page 11, user RAM
    expect(mem.readByte(0xe000)).toBe(0xd0);   // the DOS ROM
    mem.setPort58(0x10);
    expect(mem.readByte(0xe000)).toBe(0x77);   // ...until the FDC latch says otherwise
  });
});
