import { describe, it, expect } from 'vitest';
import {
  parseTrd, serializeTrd, blankTrdDisk, resolveTrdGeometry, isTrdSize,
  TRD_SECTOR_BYTES, TRD_SPT,
} from '@/plus3/trd-image.ts';

const FULL_DS = 80 * 2 * TRD_SPT * TRD_SECTOR_BYTES; // 655360

/** A flat 80×2 image whose every byte encodes its own offset (mod 256). */
function patternedImage(diskType = 0x16): Uint8Array {
  const data = new Uint8Array(FULL_DS);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xFF;
  data[8 * TRD_SECTOR_BYTES + 0xE3] = diskType; // disk-type byte
  return data;
}

describe('resolveTrdGeometry', () => {
  it('uses the disk-type byte over the file length', () => {
    // A 327680-byte file is ambiguous by size (80×1 vs 40×2); the disk-type
    // byte decides. 0x17 = 40-track double-sided.
    const data = new Uint8Array(327680);
    data[8 * TRD_SECTOR_BYTES + 0xE3] = 0x17;
    expect(resolveTrdGeometry(data)).toEqual({ tracks: 40, sides: 2 });
  });

  it('reads 0x18 as 80-track single-sided', () => {
    const data = new Uint8Array(327680);
    data[8 * TRD_SECTOR_BYTES + 0xE3] = 0x18;
    expect(resolveTrdGeometry(data)).toEqual({ tracks: 80, sides: 1 });
  });

  it('falls back to 80×2 for a truncated file with no valid disk-type byte', () => {
    const data = new Uint8Array(4 * TRD_SPT * TRD_SECTOR_BYTES); // 4 tracks only
    data[8 * TRD_SECTOR_BYTES + 0xE3] = 0x00; // not a valid disk type
    expect(resolveTrdGeometry(data)).toEqual({ tracks: 80, sides: 2 });
  });
});

describe('parseTrd geometry & sector IDs', () => {
  it('materialises 16 sectors per track, r=1..16, n=1', () => {
    const img = parseTrd(patternedImage());
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(2);
    const track = img.tracks[0]![0]!;
    expect(track.sectors.length).toBe(16);
    expect(track.sectors.map(s => s.r)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1));
    expect(track.sectors.every(s => s.n === 1)).toBe(true);
    expect(track.sectors.every(s => s.data.length === 256)).toBe(true);
  });

  it('lays tracks cylinder-major with sides interleaved', () => {
    // Cyl0/side1 (the 2nd block) begins at byte offset 16*256 = 4096; its
    // sector 1 byte 0 therefore reads (4096 & 0xFF) = 0.
    const img = parseTrd(patternedImage());
    const c0h1 = img.tracks[0]![1]!;
    expect(c0h1.sectors[0].data[0]).toBe(4096 & 0xFF); // = 0
    // Cyl1/side0 (the 3rd block) begins at 2*16*256 = 8192.
    const c1h0 = img.tracks[1]![0]!;
    expect(c1h0.sectors[0].data[0]).toBe(8192 & 0xFF); // = 0
    // Distinguish them by a mid-sector byte that differs per block.
    expect(c0h1.sectors[0].data[3]).toBe((4096 + 3) & 0xFF);
    expect(c1h0.sectors[0].data[3]).toBe((8192 + 3) & 0xFF);
  });
});

describe('parseTrd truncated-image padding', () => {
  it('zero-fills sectors beyond the end of a short file', () => {
    // One track of real data, disk-type says 80×2 — the rest must be zeros.
    const oneTrack = new Uint8Array(TRD_SPT * TRD_SECTOR_BYTES);
    oneTrack.fill(0xAB);
    oneTrack[8 * TRD_SECTOR_BYTES + 0xE3] = 0x16;
    const img = parseTrd(oneTrack);
    expect(img.numTracks).toBe(80);
    // First block present…
    expect(img.tracks[0]![0]!.sectors[0].data[0]).toBe(0xAB);
    // …a later cylinder zero-filled.
    expect(img.tracks[5]![0]!.sectors[0].data.every(b => b === 0)).toBe(true);
  });
});

describe('serializeTrd round-trip', () => {
  it('parseTrd → serializeTrd reproduces the original bytes', () => {
    const original = patternedImage();
    const round = serializeTrd(parseTrd(original));
    expect(round.length).toBe(original.length);
    expect(round).toEqual(original);
  });
});

describe('blankTrdDisk', () => {
  it('writes a valid empty TR-DOS info sector', () => {
    const img = blankTrdDisk();
    const info = img.tracks[0]![0]!.sectors[8].data; // sector r=9
    expect(info[0xE3]).toBe(0x16);   // disk type 80×2
    expect(info[0xE4]).toBe(0);      // 0 files
    expect(info[0xE7]).toBe(0x10);   // TR-DOS ID
    expect(info[0xE2]).toBe(1);      // first free track = 1 (track 0 reserved)
    // Free sectors = 80*2*16 - 16 = 2544 = 0x09F0.
    expect(info[0xE5] | (info[0xE6] << 8)).toBe(2544);
  });
});

describe('isTrdSize', () => {
  it('accepts whole-sector sizes up to an 80×2 disk and rejects others', () => {
    expect(isTrdSize(FULL_DS)).toBe(true);
    expect(isTrdSize(TRD_SPT * TRD_SECTOR_BYTES)).toBe(true); // one track
    expect(isTrdSize(FULL_DS + 256)).toBe(false); // too big
    expect(isTrdSize(255)).toBe(false);           // not a whole sector
    expect(isTrdSize(0)).toBe(false);
  });
});
