/**
 * PCW paging tests.
 *
 * Expectations come from the Amstrad PCW Hardware Reference, not from the
 * implementation: the reset block layout, the two meanings of a &F0-&F3 write,
 * and port &F4's deliberately out-of-order bit assignment.
 */

import { describe, expect, it } from 'vitest';
import { createPcwConfig } from '@/machines/pcw/config.ts';
import { PcwMemory, MEMCTL_BIT_FOR_BLOCK } from '@/machines/pcw/pcw-memory.ts';

function memory(model: 'pcw8256' | 'pcw8512' = 'pcw8256'): PcwMemory {
  return new PcwMemory(createPcwConfig(model));
}

/** Stamp each physical block with a distinguishable byte at offset 0. */
function stampBlocks(m: PcwMemory): void {
  for (let b = 0; b < m.blockCount; b++) m.getRamBank(b)[0] = 0xB0 + b;
}

describe('PCW memory paging', () => {
  it('maps blocks 0-3 in order at reset', () => {
    // "Block 80h at 0F0h, Block 81h at 0F1h, Block 82h at 0F2h, Block 83h at
    // 0F3h" — bit 7 set, block number in the low bits.
    const m = memory();
    stampBlocks(m);
    expect(m.readByte(0x0000)).toBe(0xB0);
    expect(m.readByte(0x4000)).toBe(0xB1);
    expect(m.readByte(0x8000)).toBe(0xB2);
    expect(m.readByte(0xC000)).toBe(0xB3);
  });

  it('selects one block for reads and writes when bit 7 is set', () => {
    // &87 is the reference's own example: "Select bank for &C000. Usually &87".
    const m = memory();
    stampBlocks(m);
    m.setBank(3, 0x87);
    expect(m.readByte(0xC000)).toBe(0xB7);
    m.writeByte(0xC001, 0x5A);
    expect(m.getRamBank(7)[1]).toBe(0x5A);
  });

  it('splits reads and writes across two blocks when bit 7 is clear', () => {
    // b0-2 = write block, b4-6 = read block. &21 therefore writes to block 1
    // and reads from block 2 — the CP/M bank-switching form.
    const m = memory();
    stampBlocks(m);
    m.setBank(0, 0x21);
    expect(m.readByte(0x0000)).toBe(0xB2);
    m.writeByte(0x0000, 0x99);
    expect(m.getRamBank(1)[0]).toBe(0x99);
    // The read block is untouched by the write.
    expect(m.getRamBank(2)[0]).toBe(0xB2);
    expect(m.readByte(0x0000)).toBe(0xB2);
  });

  it('assigns port &F4 bits to blocks in the documented, non-address order', () => {
    // "b7-b4: when set, force memory reads to access the same bank as writes
    // for &C000, &0000, &8000, and &4000 respectively." Each block is put in
    // split mode, then only its own bit should redirect its reads.
    expect(MEMCTL_BIT_FOR_BLOCK).toEqual([0x40, 0x10, 0x20, 0x80]);

    const addresses = [0x0000, 0x4000, 0x8000, 0xC000];
    for (let block = 0; block < 4; block++) {
      const m = memory();
      stampBlocks(m);
      // Write block 1, read block 2, for every one of the four blocks.
      for (let i = 0; i < 4; i++) m.setBank(i, 0x21);
      m.setMemCtl(MEMCTL_BIT_FOR_BLOCK[block]);

      for (let i = 0; i < 4; i++) {
        // The block whose bit is set now reads its write block (1); the others
        // still read block 2.
        expect(m.readByte(addresses[i])).toBe(i === block ? 0xB1 : 0xB2);
      }
    }
  });

  it('wraps a block number past the fitted RAM onto one that exists', () => {
    // The unfitted high bits of a block number are not wired, so on a 256K
    // machine (16 blocks) block 20 IS block 4. CP/M Plus sizes memory by
    // finding that wrap: with it the boot banner reports a 112K drive M: on an
    // 8256 and 368K on an 8512, exactly as the real machines do. Modelling the
    // block as open bus instead makes every candidate look distinct and CP/M
    // announces 624K and 1904K respectively.
    const small = memory('pcw8256');
    stampBlocks(small);
    small.setBank(0, 0x80 | 20);
    expect(small.readByte(0x0000)).toBe(0xB4);      // block 20 → block 4
    small.writeByte(0x0001, 0x42);
    expect(small.getRamBank(4)[1]).toBe(0x42);

    // A 512K machine has 32 blocks, so block 20 is its own.
    const large = memory('pcw8512');
    stampBlocks(large);
    large.setBank(0, 0x80 | 20);
    expect(large.readByte(0x0000)).toBe(0xB0 + 20);
    // …and its wrap is at 32: block 36 is block 4.
    large.setBank(0, 0x80 | 36);
    expect(large.readByte(0x0000)).toBe(0xB4);
  });

  it('addresses video memory by physical address, ignoring CPU paging', () => {
    // The display fetch never sees the &F0-&F3 mapping.
    const m = memory();
    m.getRamBank(2)[0x3600] = 0x7E;
    m.setBank(0, 0x80);
    m.setBank(1, 0x80);
    m.setBank(2, 0x80);
    m.setBank(3, 0x80); // every Z80 block now shows physical block 0
    expect(m.videoByte(2 * 0x4000 + 0x3600)).toBe(0x7E);
  });
});
