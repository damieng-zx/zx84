/**
 * Commodore 1541 disk images: GCR coding, D64 layout, G64, and reading the
 * sectors back out of the bits.
 *
 * Expectations come from the 1541's format: 21/19/18/17 sectors on tracks
 * 1-17/18-24/25-30/31-35 at four bit rates, every sector a sync, an 8-byte
 * header (marker $08, checksum, sector, track, id, $0F $0F), a gap, a sync
 * and a 260-byte data block (marker $07, 256 bytes, checksum, two zeros),
 * the blocks GCR coded 4 bytes to 5.
 */

import { describe, it, expect } from 'vitest';
import {
  blankC64Disk, blankD64, c64DiskImage, decodeTrackSectors, exportD64, isD64, isG64,
  parseC64Disk, parseD64, parseG64, readC64Disk, sectorsOnTrack, serializeC64Disk, serializeG64,
  speedZone, TRACK_BYTES_BY_ZONE, writeC64Disk,
} from '@/media/floppy/c64-disk.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

const SECTORS = 683;

/** A D64 with a different, known byte pattern in every sector. */
function patterned(): Uint8Array {
  const d = blankD64();
  const bam = 357 * 256;
  const keep = new Set<number>();
  for (let i = 0; i < 256; i++) { keep.add(bam + i); keep.add(bam + 256 + i); }
  for (let i = 0; i < d.length; i++) if (!keep.has(i)) d[i] = (i * 7 + (i >> 8) * 13) & 0xFF;
  return d;
}

describe('C64 disk geometry', () => {
  it('has the standard sectors and speed zone on each track', () => {
    expect([1, 17, 18, 24, 25, 30, 31, 35].map(sectorsOnTrack)).toEqual([21, 21, 19, 19, 18, 18, 17, 17]);
    expect([1, 17, 18, 24, 25, 30, 31, 35].map(speedZone)).toEqual([3, 3, 2, 2, 1, 1, 0, 0]);
    expect(SECTORS).toBe(Array.from({ length: 35 }, (_, i) => sectorsOnTrack(i + 1)).reduce((a, b) => a + b));
  });

  it('recognises the formats by size and signature', () => {
    expect(isD64(blankD64())).toBe(true);
    expect(isD64(new Uint8Array(1000))).toBe(false);
    expect(isG64(serializeG64(blankC64Disk()))).toBe(true);
    expect(isG64(blankD64())).toBe(false);
    expect(() => parseC64Disk(new Uint8Array(1000))).toThrow();
  });
});

describe('D64 as GCR', () => {
  it('lays a track out at its zone\'s length, 35 tracks on whole-track slots', () => {
    const disk = parseD64(blankD64());
    expect(disk.source).toBe('d64');
    for (let t = 1; t <= 35; t++) {
      const track = disk.tracks[(t - 1) * 2]!;
      expect(track.length, `track ${t}`).toBe(TRACK_BYTES_BY_ZONE[speedZone(t)] * 8);
      expect(track.zone).toBe(speedZone(t));
      expect(disk.tracks[(t - 1) * 2 + 1]).toBeNull();
    }
    expect(disk.tracks[70]).toBeNull();
  });

  it('writes sync, a header and a data block for every sector', () => {
    const disk = parseD64(patterned());
    const track = disk.tracks[0]!;
    // Starts with five bytes of sync, then the header block ($08 -> GCR $52 $54 ...).
    expect(Array.from(track.bits.subarray(0, 5))).toEqual([0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    expect(track.bits[5]).toBe(0x52);
    const sectors = decodeTrackSectors(track);
    expect(sectors.map(s => s.sector)).toEqual(Array.from({ length: 21 }, (_, i) => i));
    for (const s of sectors) {
      expect(s.track).toBe(1);
      expect(s.headerOk && s.dataOk).toBe(true);
    }
    // Sector 3 starts 768 bytes in; the pattern is (i * 7 + (i >> 8) * 13) & 0xFF.
    expect(sectors[3].data![0]).toBe((768 * 7 + 3 * 13) & 0xFF);
  });

  it('uses the BAM\'s disk id in every header', () => {
    const d = blankD64('GAME', 'AB');
    const track = parseD64(d).tracks[2 * 4]!;
    const sector = decodeTrackSectors(track)[0];
    expect(sector.headerOk).toBe(true);
    // The header check includes the id, so a wrong id would not match.
    const other = parseD64(blankD64('GAME', 'CD')).tracks[2 * 4]!;
    expect(Array.from(other.bits.subarray(0, 40))).not.toEqual(Array.from(track.bits.subarray(0, 40)));
  });

  it('gives the same .d64 back', () => {
    const d = patterned();
    expect(exportD64(parseD64(d))).toEqual(d);
  });

  it('round-trips the 40 and 42 track sizes', () => {
    for (const tracks of [40, 42]) {
      let sectors = 0;
      for (let t = 1; t <= tracks; t++) sectors += sectorsOnTrack(t);
      const d = new Uint8Array(sectors * 256);
      d.set(blankD64().subarray(0, 174_848));
      for (let i = 174_848; i < d.length; i++) d[i] = i & 0xFF;
      const disk = parseD64(d);
      expect(disk.d64Tracks).toBe(tracks);
      expect(exportD64(disk)).toEqual(d);
    }
  });

  it('keeps deliberate errors from the error bytes, and so cannot export clean', () => {
    const d = patterned();
    const errors = new Uint8Array(SECTORS).fill(1);
    errors[2] = 5;     // data checksum, track 1 sector 2
    errors[4] = 2;     // no header, sector 4
    errors[6] = 4;     // no data block, sector 6
    errors[8] = 8;     // header checksum, sector 8
    const withErrors = new Uint8Array(d.length + SECTORS);
    withErrors.set(d);
    withErrors.set(errors, d.length);
    const disk = parseD64(withErrors);
    const sectors = decodeTrackSectors(disk.tracks[0]!);
    const by = (s: number) => sectors.find(x => x.sector === s);
    expect(by(2)).toMatchObject({ headerOk: true, dataOk: false });
    expect(by(4)).toBeUndefined();
    expect(by(6)?.data ?? null).toBeNull();
    expect(by(8)).toMatchObject({ headerOk: false });
    expect(by(0)).toMatchObject({ headerOk: true, dataOk: true });
    expect(exportD64(disk)).toBeNull();
    expect(serializeC64Disk(disk).ext).toBe('.g64');
  });
});

describe('G64', () => {
  it('round-trips the tracks bit for bit, with their speed zones', () => {
    const disk = parseD64(patterned());
    const g = parseG64(serializeG64(disk));
    expect(g.source).toBe('g64');
    for (let h = 0; h < 84; h++) {
      const a = disk.tracks[h], b = g.tracks[h];
      if (!a) { expect(b, `half-track ${h}`).toBeNull(); continue; }
      expect(b!.length).toBe(a.length);
      expect(b!.zone).toBe(a.zone);
      expect(b!.bits.subarray(0, a.bits.length)).toEqual(a.bits);
    }
  });

  it('keeps half-tracks, and so saves as G64', () => {
    const disk = parseD64(patterned());
    disk.tracks[1] = { bits: new Uint8Array(6000).fill(0x55), length: 48_000, zone: 3 };
    const g = parseG64(serializeG64(disk));
    expect(g.tracks[1]?.length).toBe(48_000);
    expect(exportD64(disk)).toBeNull();
    expect(serializeC64Disk(disk).ext).toBe('.g64');
  });

  it('saves a G64 as a G64 and a D64 as a D64', () => {
    expect(serializeC64Disk(parseD64(blankD64())).ext).toBe('.d64');
    expect(serializeC64Disk(parseG64(serializeG64(parseD64(blankD64())))).ext).toBe('.g64');
  });

  it('reads a track whose speed entry points at a per-byte map as its first byte\'s speed', () => {
    const plain = serializeG64(parseD64(blankD64()));
    const trackBytes = TRACK_BYTES_BY_ZONE[3];
    // A map of one speed per byte of track 1, appended to the file.
    const g = new Uint8Array(plain.length + trackBytes);
    g.set(plain);
    g.fill(2, plain.length);
    const view = new DataView(g.buffer);
    view.setUint32(12 + g[9] * 4, plain.length, true);      // track 1's speed -> the map
    expect(parseG64(g).tracks[0]!.zone).toBe(2);
  });
});

describe('a blank disk', () => {
  it('is a formatted .d64 with an empty directory and the BAM counting its free sectors', () => {
    const d = blankD64('HELLO', '77');
    const bam = 357 * 256;
    expect(Array.from(d.subarray(bam, bam + 3))).toEqual([18, 1, 0x41]);
    expect(Array.from(d.subarray(bam + 0x90, bam + 0x95))).toEqual(Array.from('HELLO', c => c.charCodeAt(0)));
    expect(Array.from(d.subarray(bam + 0xA2, bam + 0xA4))).toEqual([0x37, 0x37]);
    // Free sectors: 21 on track 1, 17 on track 18 (its BAM and directory are taken).
    expect(d[bam + 4]).toBe(21);
    expect(d[bam + 4 * 18]).toBe(17);
    expect(d[bam + 4 * 35]).toBe(17);
    expect(d[(357 + 1) * 256 + 1]).toBe(0xFF);
    expect(exportD64(blankC64Disk('HELLO', '77'))).toEqual(d);
  });

  it('describes itself for the Drives pane', () => {
    const image = c64DiskImage(blankC64Disk());
    expect(image.diskFormat).toBe('D64 (35 tracks, 171 KB)');
    expect(image.c64.source).toBe('d64');
    expect(image.tracks).toEqual([]);
  });
});

describe('C64 disk state', () => {
  it('writes and reads a disk back, writes to the bits included', () => {
    const disk = parseD64(patterned());
    disk.tracks[0]!.bits[100] ^= 0x10;
    const w = new StateWriter();
    writeC64Disk(w, disk);
    const back = readC64Disk(new StateReader(w.finish()));
    expect(back.source).toBe('d64');
    expect(back.d64Tracks).toBe(35);
    expect(back.tracks[0]!.bits).toEqual(disk.tracks[0]!.bits);
    expect(back.tracks[70]).toBeNull();
  });
});
