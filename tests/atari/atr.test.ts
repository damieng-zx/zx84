/**
 * ATR/XFD codec tests.
 *
 * Expectations are the published ATR layout: 16-byte header, first three
 * sectors stored as 128 bytes even in a 256-byte image, and a linear 1-based
 * sector number. XFD has no header; its length selects the geometry.
 */

import { describe, it, expect } from 'vitest';
import {
  ATR_HEADER_SIZE, ATR_MAGIC, atrFromDskImage, parseAtr, parseAtariDisk, parseXfd,
} from '@/media/floppy/atr.ts';

/** Build a standard 90K ATR (720 x 128). */
function make90k(): Uint8Array {
  const sectors = 720;
  const atr = new Uint8Array(ATR_HEADER_SIZE + sectors * 128);
  atr[0] = ATR_MAGIC & 0xff;
  atr[1] = ATR_MAGIC >> 8;
  const paragraphs = (sectors * 128) >> 4;
  atr[2] = paragraphs & 0xff;
  atr[3] = (paragraphs >> 8) & 0xff;
  atr[4] = 128;
  atr[5] = 0;
  for (let n = 1; n <= sectors; n++) {
    atr.fill(n & 0xff, ATR_HEADER_SIZE + (n - 1) * 128, ATR_HEADER_SIZE + n * 128);
  }
  return atr;
}

/** Build a standard 180K ATR (720 x 256, first three sectors 128). */
function make180k(): Uint8Array {
  const sectors = 720;
  const payload = 3 * 128 + (sectors - 3) * 256;
  const atr = new Uint8Array(ATR_HEADER_SIZE + payload);
  atr[0] = ATR_MAGIC & 0xff;
  atr[1] = ATR_MAGIC >> 8;
  const paragraphs = payload >> 4;
  atr[2] = paragraphs & 0xff;
  atr[3] = (paragraphs >> 8) & 0xff;
  atr[4] = 0;
  atr[5] = 1; // 256
  for (let n = 1; n <= sectors; n++) {
    const off = n <= 3
      ? ATR_HEADER_SIZE + (n - 1) * 128
      : ATR_HEADER_SIZE + 3 * 128 + (n - 4) * 256;
    atr.fill(n & 0xff, off, off + (n <= 3 ? 128 : 256));
  }
  return atr;
}

describe('ATR parsing', () => {
  it('reads 128-byte sectors and rejects out-of-range numbers', () => {
    const disk = parseAtr(make90k());
    expect(disk).not.toBeNull();
    expect(disk!.sectorSize).toBe(128);
    expect(disk!.sectorCount).toBe(720);
    expect(disk!.sectorsPerTrack).toBe(18);
    expect(disk!.trackCount).toBe(40);
    expect(disk!.sectorLength(1)).toBe(128);
    expect(disk!.readSector(1)![0]).toBe(1);
    expect(disk!.readSector(720)![0]).toBe(720 & 0xff);
    expect(disk!.readSector(0)).toBeNull();
    expect(disk!.readSector(721)).toBeNull();
  });

  it('stores the first three 180K sectors as 128 bytes', () => {
    const disk = parseAtr(make180k());
    expect(disk).not.toBeNull();
    expect(disk!.sectorSize).toBe(256);
    expect(disk!.sectorCount).toBe(720);
    expect(disk!.sectorLength(1)).toBe(128);
    expect(disk!.sectorLength(3)).toBe(128);
    expect(disk!.sectorLength(4)).toBe(256);
    expect(disk!.readSector(1)![0]).toBe(1);
    expect(disk!.readSector(4)![0]).toBe(4);
  });

  it('writes sectors in place and tolerates short writes by zero-filling', () => {
    const disk = parseAtr(make90k())!;
    expect(disk.writeSector(2, new Uint8Array(128).fill(0x77))).toBe(true);
    expect(disk.readSector(2)![127]).toBe(0x77);
    expect(disk.writeSector(2, Uint8Array.from([1, 2]))).toBe(true);
    const after = disk.readSector(2)!;
    expect(Array.from(after.subarray(0, 4))).toEqual([1, 2, 0, 0]);
    expect(disk.writeSector(721, new Uint8Array(128))).toBe(false);
  });

  it('rejects a bad magic and a bad sector size', () => {
    const bad = make90k();
    bad[0] = 0;
    expect(parseAtr(bad)).toBeNull();

    const badSize = make90k();
    badSize[4] = 0x40;
    badSize[5] = 0;
    expect(parseAtr(badSize)).toBeNull();
  });
});

describe('ATR layouts beyond the standard two', () => {
  function header(size: number, payload: number): Uint8Array {
    const atr = new Uint8Array(ATR_HEADER_SIZE + payload);
    atr[0] = ATR_MAGIC & 0xff;
    atr[1] = ATR_MAGIC >> 8;
    atr[2] = (payload >> 4) & 0xff;
    atr[3] = (payload >> 12) & 0xff;
    atr[4] = size & 0xff;
    atr[5] = size >> 8;
    return atr;
  }

  it('reads a 256-byte ATR whose whole data is 256-byte sectors as having 256-byte boot sectors', () => {
    const atr = header(256, 720 * 256);
    for (let n = 1; n <= 720; n++) atr.fill(n & 0xff, ATR_HEADER_SIZE + (n - 1) * 256, ATR_HEADER_SIZE + n * 256);
    const disk = parseAtr(atr)!;
    expect(disk.sectorCount).toBe(720);
    expect(disk.readSector(2)![0]).toBe(2);
    expect(disk.readSector(4)![0]).toBe(4);
    expect(disk.readSector(720)![0]).toBe(720 & 0xff);
    // The drive still sends the first three as 128 bytes.
    expect(disk.readSector(3)!.length).toBe(128);
    expect(disk.readSector(4)!.length).toBe(256);
    // And it is saved as it came, not rearranged.
    expect(Array.from(disk.toBytes())).toEqual(Array.from(atr));
  });

  it('writes a boot sector of a uniform ATR without disturbing the rest of its slot', () => {
    const atr = header(256, 10 * 256);
    atr.fill(0xee, ATR_HEADER_SIZE + 128, ATR_HEADER_SIZE + 256);
    const disk = parseAtr(atr)!;
    expect(disk.writeSector(1, new Uint8Array(128).fill(0x11))).toBe(true);
    expect(disk.readSector(1)![127]).toBe(0x11);
    expect(disk.toBytes()[ATR_HEADER_SIZE + 200]).toBe(0xee);
  });

  it('pads a last sector the file cuts short with zeros', () => {
    const atr = header(128, 10 * 128 - 40);
    atr.fill(0xaa, ATR_HEADER_SIZE);
    const disk = parseAtr(atr)!;
    expect(disk.sectorCount).toBe(10);
    const last = disk.readSector(10)!;
    expect(last.length).toBe(128);
    expect(last[0]).toBe(0xaa);
    expect(last[127]).toBe(0);

    const std = header(256, 3 * 128 + 5 * 256 - 100);
    std.fill(0xbb, ATR_HEADER_SIZE);
    const disk256 = parseAtr(std)!;
    expect(disk256.sectorCount).toBe(8);
    expect(disk256.readSector(8)!.length).toBe(256);
    expect(disk256.readSector(8)![255]).toBe(0);
  });

  it('accepts sector sizes up to 8192 with no boot-sector split', () => {
    for (const size of [512, 1024, 8192]) {
      const atr = header(size, 4 * size);
      atr.fill(0x42, ATR_HEADER_SIZE + size, ATR_HEADER_SIZE + 2 * size);
      const disk = parseAtr(atr)!;
      expect(disk.sectorSize).toBe(size);
      expect(disk.sectorCount).toBe(4);
      expect(disk.sectorLength(1)).toBe(size);
      expect(disk.readSector(2)![size - 1]).toBe(0x42);
      expect(disk.readSector(2)![0]).toBe(0x42);
      expect(disk.toDskImage().tracks[0][0]!.sectors[0].n).toBe(Math.log2(size) - 7);
    }
    expect(parseAtr(header(300, 3000))).toBeNull();
    expect(parseAtr(header(16384, 4 * 16384))).toBeNull();
  });
});

describe('XFD parsing', () => {
  it('recognises a 90K raw sector dump', () => {
    const raw = new Uint8Array(92_160);
    raw[0] = 0xaa;
    const disk = parseXfd(raw)!;
    expect(disk.sectorSize).toBe(128);
    expect(disk.sectorCount).toBe(720);
    expect(disk.sectorsPerTrack).toBe(18);
    expect(disk.readSector(1)![0]).toBe(0xaa);
    // Saving produces a standard ATR with a 16-byte header.
    const atr = disk.toBytes();
    expect(atr.length).toBe(ATR_HEADER_SIZE + 92_160);
    expect(atr[0]).toBe(0x96);
    expect(atr[4]).toBe(128);
  });

  it('recognises a 130K raw sector dump as 26 sectors per track', () => {
    const disk = parseXfd(new Uint8Array(133_120))!;
    expect(disk.sectorCount).toBe(1040);
    expect(disk.sectorsPerTrack).toBe(26);
    expect(disk.trackCount).toBe(40);
  });

  it('keeps a 180K raw dump uniform and converts it on save', () => {
    const raw = new Uint8Array(184_320);
    raw.fill(0x55, 0, 256);
    raw[3 * 256] = 0x66; // first byte of sector 4
    const disk = parseXfd(raw)!;
    expect(disk.sectorSize).toBe(256);
    // Stored at 256 bytes, but the drive still transfers 128 for sectors 1-3.
    expect(disk.sectorLength(1)).toBe(128);
    expect(disk.readSector(1)!.length).toBe(128);
    expect(disk.sectorLength(4)).toBe(256);
    expect(disk.readSector(1)![0]).toBe(0x55);
    expect(disk.readSector(4)![0]).toBe(0x66);
    const atr = disk.toBytes();
    expect(atr.length).toBe(ATR_HEADER_SIZE + 3 * 128 + 717 * 256);
    expect(atr[4]).toBe(0);
    expect(atr[5]).toBe(1);
  });

  it('reads 266,240 bytes as 1040 sectors of 256, not 2080 of 128', () => {
    const disk = parseXfd(new Uint8Array(266_240))!;
    expect(disk.sectorSize).toBe(256);
    expect(disk.sectorCount).toBe(1040);
    expect(disk.sectorsPerTrack).toBe(26);
  });

  it('takes any other whole number of 128-byte sectors as a single-density style dump', () => {
    const disk = parseXfd(new Uint8Array(500 * 128))!;
    expect(disk.sectorSize).toBe(128);
    expect(disk.sectorCount).toBe(500);
    expect(disk.sectorsPerTrack).toBe(18);
    expect(parseXfd(new Uint8Array(26 * 128 * 10))!.sectorsPerTrack).toBe(26);
  });

  it('rejects a size it does not know', () => {
    expect(parseXfd(new Uint8Array(1000))).toBeNull();
    expect(parseXfd(new Uint8Array(0))).toBeNull();
  });
});

describe('Atari disk views and round-trips', () => {
  it('groups linear sectors into 18-sector tracks for the Drive pane', () => {
    const disk = parseAtr(make90k())!;
    const image = disk.toDskImage();
    expect(image.numTracks).toBe(40);
    expect(image.numSides).toBe(1);
    expect(image.tracks[0][0]!.sectors.length).toBe(18);
    expect(image.tracks[0][0]!.sectors[0].r).toBe(1);
    expect(image.tracks[0][0]!.sectors[0].data[0]).toBe(1);
    expect(image.tracks[1][0]!.sectors[0].data[0]).toBe(19);
  });

  it('rebuilds an equivalent ATR from the generic DskImage', () => {
    const original = parseAtr(make90k())!;
    const round = atrFromDskImage(original.toDskImage())!;
    expect(round.sectorSize).toBe(128);
    expect(round.sectorCount).toBe(720);
    expect(Array.from(round.readSector(19)!)).toEqual(Array.from(original.readSector(19)!));
  });

  it('round-trips a 180K image through DskImage', () => {
    const original = parseAtr(make180k())!;
    const round = atrFromDskImage(original.toDskImage())!;
    expect(round.sectorSize).toBe(256);
    expect(Array.from(round.readSector(4)!)).toEqual(Array.from(original.readSector(4)!));
  });

  it('accepts either container by content', () => {
    expect(parseAtariDisk(make90k())).not.toBeNull();
    expect(parseAtariDisk(new Uint8Array(92_160))).not.toBeNull();
    expect(parseAtariDisk(new Uint8Array(1234))).toBeNull();
  });
});
