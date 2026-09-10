/**
 * The Lynx's banking, against MAME's camplynx.cpp. Two things make it unlike
 * any other machine here: a write lands in every enabled bank at once, and a
 * read comes from the lowest enabled one.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxMemory } from '@/machines/lynx/lynx-memory.ts';

const PAGE = 0x2000;
/** Where each bank starts in the flat page array. */
const BANK1 = 0x10000, BANK2 = 0x20000, BANK3 = 0x30000;

describe('Lynx memory banking', () => {
  let mem: LynxMemory;
  beforeEach(() => {
    mem = new LynxMemory('lynx48');
    // A recognisable ROM: the first image reads 0x11, the second 0x22.
    mem.loadRoms([new Uint8Array(PAGE).fill(0x11), new Uint8Array(PAGE).fill(0x22)]);
  });

  it('resets with the ROM in the bottom of the map, which is where the CPU starts', () => {
    expect(mem.readByte(0x0000)).toBe(0x11);
    expect(mem.readByte(0x2000)).toBe(0x22);
    // No third image on a 48K, so that slot decodes to nothing.
    expect(mem.readByte(0x4000)).toBe(0xff);
  });

  it('writes to user RAM even while reading ROM', () => {
    mem.writeByte(0x0000, 0x5a);
    expect(mem.ram[BANK1 + 0x0000]).toBe(0x5a);
    expect(mem.readByte(0x0000)).toBe(0x11);   // still the ROM underneath
  });

  it('paints one store into both video banks at once', () => {
    // Enable writes to banks 1-4; port 0x80 clear, so neither video veto.
    mem.writeBankPort(0x0f ^ 0x31);
    mem.writeByte(0x1234, 0xa5);
    expect(mem.ram[BANK1 + 0x1234]).toBe(0xa5);
    expect(mem.ram[BANK2 + 0x1234]).toBe(0xa5);
    expect(mem.ram[BANK3 + 0x1234]).toBe(0xa5);
  });

  it('lets port 0x80 veto each video bank on its own', () => {
    mem.writeBankPort(0x0f ^ 0x31);
    mem.setPort80(0x04);                        // veto bank 2
    mem.writeByte(0x0010, 0x3c);
    expect(mem.ram[BANK2 + 0x0010]).toBe(0x00);
    expect(mem.ram[BANK3 + 0x0010]).toBe(0x3c);

    mem.setPort80(0x08);                        // veto bank 3 instead
    mem.writeByte(0x0020, 0x7e);
    expect(mem.ram[BANK2 + 0x0020]).toBe(0x7e);
    expect(mem.ram[BANK3 + 0x0020]).toBe(0x00);
  });

  it('swaps the whole map over to user RAM when bank 1 alone is read-enabled', () => {
    mem.ram[BANK1] = 0x99;
    // rbyte 0x20: read bank 1 only.
    mem.writeBankPort((0x20 | 0x0f) ^ 0x31);
    expect(mem.readByte(0x0000)).toBe(0x99);
  });

  it('pages RAM over the DOS ROM slot when the FDC latch says so', () => {
    mem.ram[15 * PAGE] = 0x77;                  // page 15 = user RAM at 0xe000
    mem.writeBankPort((0x20 | 0x0f) ^ 0x31);
    expect(mem.readByte(0xe000)).toBe(0xff);    // the empty DOS slot
    mem.setPort58(0x10);
    expect(mem.readByte(0xe000)).toBe(0x77);
  });

  it('loads a DOS ROM high in bank 0 where XROM expects it', () => {
    mem.loadRoms(
      [new Uint8Array(PAGE).fill(0x11), new Uint8Array(PAGE).fill(0x22)],
      new Uint8Array(PAGE).fill(0xd0),
    );
    mem.writeBankPort((0x20 | 0x0f) ^ 0x31);
    expect(mem.readByte(0xe000)).toBe(0xd0);
  });

  it('dumps the whole physical RAM store for the raw .bin save', () => {
    // MAME's RAM device: 256K on the 48K/96K, 320K on the 128K.
    expect(mem.ramSnapshot().length).toBe(256 * 1024);
    expect(new LynxMemory('lynx128').ramSnapshot().length).toBe(320 * 1024);
    // A copy, not the live store: writing the dump must not touch the machine.
    const dump = mem.ramSnapshot();
    dump[BANK1] = 0x5a;
    expect(mem.ram[BANK1]).not.toBe(0x5a);
  });
});
