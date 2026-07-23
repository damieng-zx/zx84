import { describe, expect, it } from 'vitest';
import {
  MTX_TYPE07_SECTOR_SIZE,
  MTX_TYPE07_SIZE,
  parseMtxMfloppy,
  serializeMtxMfloppy,
} from '@/media/floppy/mtx-mfloppy.ts';

describe('Memotech Type 07 .mfloppy images', () => {
  it('maps raw sectors in cylinder-side-sector physical order', () => {
    const raw = new Uint8Array(MTX_TYPE07_SIZE);
    raw[0] = 0x10;
    raw[15 * MTX_TYPE07_SECTOR_SIZE] = 0x1F;
    raw[16 * MTX_TYPE07_SECTOR_SIZE] = 0x20;
    raw[32 * MTX_TYPE07_SECTOR_SIZE] = 0x30;

    const disk = parseMtxMfloppy(raw);

    expect(disk.diskFormat).toBe('Memotech Type 07');
    expect([disk.numTracks, disk.numSides]).toEqual([80, 2]);
    expect(disk.tracks[0][0]!.sectors[0].data[0]).toBe(0x10);
    expect(disk.tracks[0][0]!.sectors[15].data[0]).toBe(0x1F);
    expect(disk.tracks[0][1]!.sectors[0].data[0]).toBe(0x20);
    expect(disk.tracks[1][0]!.sectors[0].data[0]).toBe(0x30);
  });

  it('serializes sector writes back to the raw Type 07 location', () => {
    const disk = parseMtxMfloppy(new Uint8Array(MTX_TYPE07_SIZE));
    disk.tracks[7][1]!.sectors[12].data[9] = 0xA5;

    const saved = serializeMtxMfloppy(disk);
    const offset = ((7 * 2 + 1) * 16 + 12) * 256 + 9;

    expect(saved[offset]).toBe(0xA5);
    expect(saved.length).toBe(MTX_TYPE07_SIZE);
  });

  it('rejects headerless images whose size is not Type 07 geometry', () => {
    expect(() => parseMtxMfloppy(new Uint8Array(MTX_TYPE07_SIZE - 1)))
      .toThrow(/655360 bytes/);
  });
});
