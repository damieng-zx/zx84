/**
 * The 48K/96K Lynx's banking. Two things make it unlike any other machine
 * here: a write lands in every bank enabled for writing, all at once, and a
 * read comes from whichever single source the read enables select.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxMemory } from '@/machines/lynx/lynx-memory.ts';

const PAGE = 0x2000;

/** The bank port as the ROM writes it: bits 0, 4 and 5 are active low. */
const bankPort = (enables: number): number => enables ^ 0x31;

/** Write enables for user RAM and both video pairs, no read enables. */
const WRITE_ALL = 0x0f;
/** Read enable for user RAM alone. */
const READ_USER = 0x20;

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

  it('resets with ROM low and user RAM above it, DOS ROM on top', () => {
    expect(mem.slotLabels).toEqual([
      'ROM 0', 'ROM 1', 'ROM 2', 'RAM 3', 'RAM 4', 'RAM 5', 'RAM 6', 'ROM 7',
    ]);
  });

  it('repeats the first three ROM pages over the middle of the map when no bank is read-enabled', () => {
    mem.writeBankPort(bankPort(0x00));
    expect(mem.slotLabels).toEqual([
      'ROM 0', 'ROM 1', 'ROM 2', 'ROM 3', 'ROM 0', 'ROM 1', 'ROM 2', 'ROM 7',
    ]);
  });

  it('writes to user RAM even while reading ROM', () => {
    mem.writeByte(0x0000, 0x5a);
    expect(mem.userRam[0x0000]).toBe(0x5a);
    expect(mem.readByte(0x0000)).toBe(0x11);   // still the ROM underneath
  });

  it('paints one store into every video plane pair at once', () => {
    mem.writeBankPort(bankPort(WRITE_ALL));
    mem.writeByte(0x1234, 0xa5);                // A14 clear: the first plane of each pair
    mem.writeByte(0x5678, 0x5a);                // A14 set: the second
    expect(mem.userRam[0x1234]).toBe(0xa5);
    expect(mem.planes.blue[0x1234]).toBe(0xa5);
    expect(mem.planes.altGreen[0x1234]).toBe(0xa5);
    expect(mem.planes.red[0x1678]).toBe(0x5a);
    expect(mem.planes.green[0x1678]).toBe(0x5a);
  });

  it('ignores A13 and A15 when picking a video plane', () => {
    mem.writeBankPort(bankPort(WRITE_ALL));
    mem.writeByte(0xa010, 0x3c);                // A15 and A13 set, A14 clear: still blue
    expect(mem.planes.blue[0x0010]).toBe(0x3c);
    expect(mem.planes.red[0x0010]).toBe(0x00);
  });

  it('lets port 0x80 veto each video pair on its own', () => {
    mem.writeBankPort(bankPort(WRITE_ALL));
    mem.setPort80(0x04);                        // veto the blue/red pair
    mem.writeByte(0x0010, 0x3c);
    expect(mem.planes.blue[0x0010]).toBe(0x00);
    expect(mem.planes.altGreen[0x0010]).toBe(0x3c);

    mem.setPort80(0x08);                        // veto the green pair instead
    mem.writeByte(0x0020, 0x7e);
    expect(mem.planes.blue[0x0020]).toBe(0x7e);
    expect(mem.planes.altGreen[0x0020]).toBe(0x00);
  });

  it('names the banks a store reaches', () => {
    mem.writeBankPort(bankPort(WRITE_ALL));
    expect(mem.writeTargets).toEqual(['RAM', 'blue/red', 'green']);
    mem.setPort80(0x0c);
    expect(mem.writeTargets).toEqual(['RAM']);
  });

  it('swaps the whole map over to user RAM when bank 1 alone is read-enabled', () => {
    mem.userRam[0] = 0x99;
    mem.writeBankPort(bankPort(READ_USER | WRITE_ALL));
    expect(mem.readByte(0x0000)).toBe(0x99);
  });

  it('keeps the ROM at the bottom when its read enable accompanies user RAM', () => {
    mem.userRam[3 * PAGE] = 0x66;
    mem.writeBankPort(bankPort(0x30 | WRITE_ALL));
    expect(mem.readByte(0x0000)).toBe(0x11);
    expect(mem.readByte(3 * PAGE)).toBe(0x66);
  });

  it('reads a video pair, picking the plane with A14', () => {
    mem.writeBankPort(bankPort(0x40 | 0x02));   // read video, write the blue/red pair
    mem.writeByte(0x0000, 0xb1);                // blue
    mem.writeByte(0x4000, 0xb2);                // red
    expect(mem.readByte(0x0000)).toBe(0xb1);
    expect(mem.readByte(0x4000)).toBe(0xb2);
    expect(mem.readByte(0x8000)).toBe(0xb1);    // A15 is not decoded
  });

  it('lets port 0x80 steer a video read to the other pair', () => {
    mem.writeBankPort(bankPort(0x40 | 0x04));   // read video, write the green pair
    mem.setPort80(0x04);                        // read the second pair
    mem.writeByte(0x0000, 0xa7);
    expect(mem.readByte(0x0000)).toBe(0xa7);
    expect(mem.planes.altGreen[0]).toBe(0xa7);
  });

  it('pages RAM over the DOS ROM slot when the FDC latch says so', () => {
    mem.userRam[7 * PAGE] = 0x77;               // user RAM at 0xe000
    mem.writeBankPort(bankPort(READ_USER | WRITE_ALL));
    expect(mem.readByte(0xe000)).toBe(0xff);    // the empty DOS slot
    mem.setPort58(0x10);
    expect(mem.readByte(0xe000)).toBe(0x77);
  });

  it('loads a DOS ROM high in the ROM store where XROM expects it', () => {
    mem.loadRoms(
      [new Uint8Array(PAGE).fill(0x11), new Uint8Array(PAGE).fill(0x22)],
      new Uint8Array(PAGE).fill(0xd0),
    );
    mem.writeBankPort(bankPort(READ_USER | WRITE_ALL));
    expect(mem.readByte(0xe000)).toBe(0xd0);
  });

  it('dumps every RAM chip for the raw .bin save, without the ROM', () => {
    // 64K of user RAM plus four 8K video planes.
    expect(mem.ramSnapshot().length).toBe(96 * 1024);
    expect(new LynxMemory('lynx128').ramSnapshot().length).toBe(192 * 1024);
    // A copy, not the live store: writing the dump must not touch the machine.
    const dump = mem.ramSnapshot();
    dump[0] = 0x5a;
    expect(mem.userRam[0]).not.toBe(0x5a);
  });

  it('offers its RAM as 16K views: user RAM, then video', () => {
    expect(mem.ramBankCount).toBe(6);
    mem.userRam[0x4000] = 0xc3;
    expect(mem.getRamBank(1)[0]).toBe(0xc3);
    mem.planes.red[0] = 0xd4;
    expect(mem.getRamBank(4)[0x2000]).toBe(0xd4);   // blue then red fill the first video bank
  });
});
