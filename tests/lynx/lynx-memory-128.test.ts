/**
 * The Lynx 128K's banking is the 48K's idea with every field moved: the port is
 * 0x82 rather than 0x7F, the write and read nibbles swap ends, each nibble is
 * bit-reversed, port 0x80 no longer joins the decode, and there is a fourth
 * bank of RAM.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LynxMemory } from '@/machines/lynx/lynx-memory.ts';

const PAGE = 0x2000;

/** Port 0x82 as the ROM would write it, from what you want enabled.
 *  `write` is user RAM, video, the unused bank 3 and extra RAM in that order;
 *  `read` is ROM, user RAM, video and extra RAM. */
function port82(write: readonly number[], read: readonly number[]): number {
  let data = 0;
  write.forEach((on, i) => { if (on) data |= 0x80 >> i; });   // d7..d4
  read.forEach((on, i) => { if (on) data |= 0x08 >> i; });    // d3..d0
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

  it('has the extra bank of RAM and a larger video store than the 48K', () => {
    expect(mem.extraRam?.length).toBe(0x10000);
    expect(mem.videoRam.length).toBe(0x10000);
    const small = new LynxMemory('lynx48');
    expect(small.extraRam).toBeNull();
    expect(small.videoRam.length).toBe(0x8000);
  });

  it('resets with the ROM under the CPU, all three images in a row', () => {
    expect(mem.readByte(0x0000)).toBe(0x11);
    expect(mem.readByte(0x2000)).toBe(0x22);
    expect(mem.readByte(0x4000)).toBe(0x33);
  });

  it('reads user RAM throughout once it alone is read-enabled', () => {
    mem.userRam[0] = 0x99;
    mem.userRam[7 * PAGE] = 0x98;
    mem.writeBankPort(port82([1, 0, 0, 0], [0, 1, 0, 0]));
    expect(mem.readByte(0x0000)).toBe(0x99);
    expect(mem.readByte(0xe000)).toBe(0x98);   // no DOS ROM on top, unlike the 48K
  });

  it('writes one address per bank, without the 48K plane mirroring', () => {
    mem.writeBankPort(port82([1, 1, 0, 1], [0, 1, 0, 0]));
    mem.writeByte(0x1234, 0xa5);
    expect(mem.userRam[0x1234]).toBe(0xa5);
    expect(mem.videoRam[0x1234]).toBe(0xa5);
    expect(mem.extraRam![0x1234]).toBe(0xa5);
    expect(mem.videoRam[0x1234 + PAGE]).toBe(0x00);   // the 48K would repeat it every 8K
  });

  it('puts the four video planes side by side in one 64K store', () => {
    mem.writeBankPort(port82([0, 1, 0, 0], [0, 1, 0, 0]));
    for (const [at, plane] of [
      [0x0000, mem.planes.red], [0x4000, mem.planes.blue],
      [0x8000, mem.planes.green], [0xc000, mem.planes.altGreen],
    ] as const) {
      mem.writeByte(at + 5, 0xe1);
      expect(plane[5]).toBe(0xe1);
    }
  });

  it('ignores port 0x80, which on the 48K would re-decode the banks', () => {
    mem.writeBankPort(port82([1, 1, 0, 0], [0, 1, 0, 0]));
    mem.setPort80(0x0c);          // both video vetoes, were this a 48K
    mem.writeByte(0x0010, 0x3c);
    expect(mem.userRam[0x0010]).toBe(0x3c);
    expect(mem.videoRam[0x0010]).toBe(0x3c);
  });

  it('drops extra RAM from the read when user RAM is selected (the AND gate in IC82)', () => {
    mem.userRam[0] = 0xb2;
    mem.extraRam![0] = 0xb4;
    // Asking for both gives user RAM's layout, not the extra bank's.
    mem.writeBankPort(port82([0, 0, 0, 0], [0, 1, 0, 1]));
    expect(mem.readByte(0x0000)).toBe(0xb2);
    // Extra RAM alone still reaches it.
    mem.writeBankPort(port82([0, 0, 0, 0], [0, 0, 0, 1]));
    expect(mem.readByte(0x0000)).toBe(0xb4);
  });

  it('prefers video to user RAM when both are asked for without the ROM', () => {
    mem.userRam[0] = 0xb2;
    mem.videoRam[0] = 0xb6;
    mem.writeBankPort(port82([0, 0, 0, 0], [0, 1, 1, 0]));
    expect(mem.readByte(0x0000)).toBe(0xb6);
    // With the ROM along for the ride the ROM keeps the bottom and user RAM wins the rest.
    mem.userRam[3 * PAGE] = 0xb8;
    mem.writeBankPort(port82([0, 0, 0, 0], [1, 1, 1, 0]));
    expect(mem.readByte(0x0000)).toBe(0x11);
    expect(mem.readByte(3 * PAGE)).toBe(0xb8);
  });

  it('keeps the ROM low while paging RAM high, DOS slot and all', () => {
    mem.loadRoms(
      [new Uint8Array(PAGE).fill(0x11), new Uint8Array(PAGE).fill(0x22),
        new Uint8Array(PAGE).fill(0x33)],
      new Uint8Array(PAGE).fill(0xd0),
    );
    mem.userRam[7 * PAGE] = 0x77;
    // ROM + user RAM together: the ROM keeps the bottom 24K, RAM the rest.
    mem.writeBankPort(port82([1, 0, 0, 0], [1, 1, 0, 0]));
    expect(mem.readByte(0x0000)).toBe(0x11);
    expect(mem.readByte(0x6000)).toBe(0x00);   // user RAM page 3
    expect(mem.readByte(0xe000)).toBe(0xd0);   // the DOS ROM
    mem.setPort58(0x10);
    expect(mem.readByte(0xe000)).toBe(0x77);   // ...until the FDC latch says otherwise
  });
});
