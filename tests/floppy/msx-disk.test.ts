/**
 * MSX-DOS floppy images: raw .dsk / .img dumps, DMK, and the blank formatter.
 *
 * Geometry expectations come from the MSX-DOS 1 media-descriptor table (the
 * descriptor byte alone defines the disk), not from the parser: F8 = 80T SS 9s
 * 360K, F9 = 80T DS 9s 720K, FC = 40T SS 9s 180K, FD = 40T DS 9s 360K, and so
 * on. Logical sector order on a dump is cylinder-major, head-minor.
 */

import { describe, expect, it } from 'vitest';
import {
  MSX_GEOMETRIES, blankMsxDisk, detectMsxGeometry, isDmk, isMsxImg, isMsxRawSize,
  isRegularMsxImage, parseDmk, parseMsxFloppy, parseMsxRaw, serializeMsxRaw,
} from '@/media/floppy/msx-disk.ts';
import { blankMsxDisk as blank } from '@/media/floppy/msx-disk.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';

const SB = 512;

/** A dump of `total` sectors where sector L starts with L (lo, hi) and 0xA5. */
function dump(total: number, descriptor: number | null): Uint8Array {
  const out = new Uint8Array(total * SB);
  for (let l = 0; l < total; l++) {
    out[l * SB] = l & 0xFF;
    out[l * SB + 1] = l >> 8;
    out[l * SB + 2] = 0xA5;
  }
  if (descriptor !== null) { out[SB] = descriptor; out[0x15] = descriptor; }
  return out;
}

describe('MSX raw geometry', () => {
  it('reads a 720K dump as 80 tracks, 2 sides, 9 sectors numbered from 1', () => {
    const img = parseMsxRaw(dump(1440, 0xF9));
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(2);
    const t = img.tracks[5][1]!;
    expect(t.sectors.map(s => s.r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(t.sectors.every(s => s.n === 2 && s.data.length === 512)).toBe(true);
  });

  it('places logical sector L at cylinder L/(sides*9), head (L/9)%sides', () => {
    const img = parseMsxRaw(dump(1440, 0xF9));
    // Cylinder 3, head 1, sector 4 → L = (3*2+1)*9 + 3 = 66
    const sec = img.tracks[3][1]!.sectors[3];
    expect(sec.c).toBe(3);
    expect(sec.h).toBe(1);
    expect(sec.r).toBe(4);
    expect(sec.data[0]).toBe(66);
    expect(sec.data[2]).toBe(0xA5);
  });

  it('uses the FAT media descriptor to split the two 360K layouts', () => {
    const ss80 = parseMsxRaw(dump(720, 0xF8));
    expect([ss80.numTracks, ss80.numSides]).toEqual([80, 1]);
    const ds40 = parseMsxRaw(dump(720, 0xFD));
    expect([ds40.numTracks, ds40.numSides]).toEqual([40, 2]);
  });

  it('splits the two 320K layouts the same way (FA vs FF)', () => {
    const ss80 = parseMsxRaw(dump(640, 0xFA));
    expect([ss80.numTracks, ss80.numSides, ss80.tracks[0][0]!.sectors.length]).toEqual([80, 1, 8]);
    const ds40 = parseMsxRaw(dump(640, 0xFF));
    expect([ds40.numTracks, ds40.numSides, ds40.tracks[0][0]!.sectors.length]).toEqual([40, 2, 8]);
  });

  it('falls back to the BPB copy when the FAT byte is not a descriptor', () => {
    const d = dump(720, null);
    d[0x15] = 0xFD;
    expect(detectMsxGeometry(d)?.id).toBe(0xFD);
  });

  it('keeps a bigger descriptor for a truncated dump and pads the missing tail', () => {
    // F9 describes 720K DS but the file is only the first 360K (a common
    // truncated dump): MSX-DOS would still treat it as double sided.
    const half = dump(720, 0xF9);
    half[0x0B] = 0x00; half[0x0C] = 0x02;          // a real 512-byte-sector BPB
    expect(detectMsxGeometry(half)?.id).toBe(0xF9);
    const img = parseMsxRaw(half);
    expect([img.numTracks, img.numSides]).toEqual([80, 2]);
    // Logical sector 20 = cylinder 1, head 0, sector 3 survives in place.
    expect(img.tracks[1][0]!.sectors[2].data[0]).toBe(20);
    // Cylinder 40 onward is beyond the dump: unformatted filler.
    expect(img.tracks[45][0]!.sectors[0].data.every(v => v === 0xE5)).toBe(true);
  });

  it('pads a ragged, heavily trimmed dump (cut after the last used sector)', () => {
    const d = dump(1440, 0xF9).slice(0, 70604);   // not a multiple of 512
    d[0x0B] = 0x00; d[0x0C] = 0x02;
    const img = parseMsxRaw(d);
    expect([img.numTracks, img.numSides]).toEqual([80, 2]);
    expect(img.tracks[0][0]!.sectors[2].data[0]).toBe(2);
    expect(img.tracks[79][1]!.sectors[8].data.every(v => v === 0xE5)).toBe(true);
  });

  it('ignores a few spare sectors appended to a full dump', () => {
    const d = new Uint8Array(737280 + 4096);
    d.set(dump(1440, 0xF9));
    d.fill(0x99, 737280);
    d[0x0B] = 0x00; d[0x0C] = 0x02;
    const img = parseMsxRaw(d);
    expect(serializeMsxRaw(img).length).toBe(737280);
    expect(img.tracks[79][1]!.sectors[8].data[0]).not.toBe(0x99);
  });

  it('does not take an unrelated file for a trimmed disk without a 512-byte BPB', () => {
    const d = dump(1440, 0xF9).slice(0, 70604);
    d[0x0B] = 0; d[0x0C] = 0;
    expect(() => parseMsxRaw(d)).toThrow(/not an MSX disk size/);
  });

  it('ignores a descriptor that is not a real MSX one', () => {
    expect(detectMsxGeometry(dump(720, 0xF0))?.id).toBe(0xF8);
  });

  it('defaults an undescribed 360K image to the 3.5-inch single-sided disk', () => {
    expect(detectMsxGeometry(dump(720, null))?.id).toBe(0xF8);
    expect(detectMsxGeometry(dump(1440, null))?.id).toBe(0xF9);
  });

  it('covers every descriptor in the table with a consistent byte size', () => {
    const sizes = MSX_GEOMETRIES.map(g => g.tracks * g.sides * g.sectorsPerTrack * 512);
    expect(sizes.sort((a, b) => a - b)).toEqual(
      [163840, 184320, 327680, 327680, 368640, 368640, 655360, 737280]);
  });

  it('rejects sizes that are not MSX disks, naming the high-density case', () => {
    expect(isMsxRawSize(12345)).toBe(false);
    expect(() => parseMsxRaw(new Uint8Array(12345))).toThrow(/not an MSX disk size/);
    expect(() => parseMsxRaw(new Uint8Array(1474560))).toThrow(/high-density/i);
  });

  it('round-trips a dump through the image model unchanged', () => {
    for (const total of [1440, 720, 360]) {
      const src = dump(total, total === 1440 ? 0xF9 : total === 720 ? 0xF8 : 0xFC);
      expect(serializeMsxRaw(parseMsxRaw(src))).toEqual(src);
    }
  });

  it('flags an image with an erroring sector as not regular', () => {
    const img = parseMsxRaw(dump(720, 0xF8));
    expect(isRegularMsxImage(img)).toBe(true);
    img.tracks[10][0]!.sectors[2].st2 = 0x20;
    expect(isRegularMsxImage(img)).toBe(false);
  });
});

describe('MSX .img (one header byte)', () => {
  it('accepts 1 + 360K and 2 + 720K only', () => {
    const body = dump(720, 0xF8);
    const img = new Uint8Array(1 + body.length);
    img[0] = 1; img.set(body, 1);
    expect(isMsxImg(img)).toBe(true);
    img[0] = 2;
    expect(isMsxImg(img)).toBe(false);   // header says DS but the body is 360K
    const big = new Uint8Array(1 + 737280); big[0] = 2;
    expect(isMsxImg(big)).toBe(true);
  });

  it('parseMsxFloppy strips the header byte', () => {
    const body = dump(720, 0xF8);
    const img = new Uint8Array(1 + body.length);
    img[0] = 1; img.set(body, 1);
    const parsed = parseMsxFloppy(img);
    expect(parsed.tracks[0][0]!.sectors[0].data[2]).toBe(0xA5);
    expect(parsed.numTracks).toBe(80);
  });
});

describe('blank MSX-DOS disk', () => {
  it('lays down a valid 720K boot sector and FAT12 volume', () => {
    const raw = serializeMsxRaw(blankMsxDisk(0xF9));
    expect(raw.length).toBe(737280);
    const b = raw.subarray(0, 512);
    expect(Array.from(b.subarray(0, 3))).toEqual([0xEB, 0xFE, 0x90]);
    expect(b[0x0B] | (b[0x0C] << 8)).toBe(512);       // bytes per sector
    expect(b[0x0D]).toBe(2);                           // sectors per cluster
    expect(b[0x0E] | (b[0x0F] << 8)).toBe(1);          // reserved sectors
    expect(b[0x10]).toBe(2);                           // FATs
    expect(b[0x11] | (b[0x12] << 8)).toBe(112);        // root entries
    expect(b[0x13] | (b[0x14] << 8)).toBe(1440);       // total sectors
    expect(b[0x15]).toBe(0xF9);                        // media descriptor
    expect(b[0x16] | (b[0x17] << 8)).toBe(3);          // sectors per FAT
    expect(b[0x18] | (b[0x19] << 8)).toBe(9);          // sectors per track
    expect(b[0x1A] | (b[0x1B] << 8)).toBe(2);          // heads
    expect(b[0x1E]).toBe(0xD0);                        // RET NC boot stub
  });

  it('puts the descriptor at the head of both FATs and leaves the rest empty', () => {
    const raw = serializeMsxRaw(blankMsxDisk(0xF9));
    const sector = (n: number) => raw.subarray(n * 512, (n + 1) * 512);
    expect(Array.from(sector(1).subarray(0, 4))).toEqual([0xF9, 0xFF, 0xFF, 0x00]);   // FAT 1
    expect(Array.from(sector(4).subarray(0, 4))).toEqual([0xF9, 0xFF, 0xFF, 0x00]);   // FAT 2 (1+3)
    for (let s = 7; s < 14; s++) expect(sector(s).every(v => v === 0)).toBe(true);    // root dir
    expect(sector(14).every(v => v === 0xE5)).toBe(true);                             // data area
    expect(sector(1439).every(v => v === 0xE5)).toBe(true);
  });

  it('builds 360K single-sided with the matching table values', () => {
    const raw = serializeMsxRaw(blank(0xF8));
    expect(raw.length).toBe(368640);
    expect(raw[0x13] | (raw[0x14] << 8)).toBe(720);
    expect(raw[0x16]).toBe(2);
    expect(detectMsxGeometry(raw)?.id).toBe(0xF8);
  });

  it('rejects an unknown descriptor', () => {
    expect(() => blankMsxDisk(0xF0)).toThrow(/Unknown MSX media descriptor/);
  });
});

// ── DMK ───────────────────────────────────────────────────────────────────────

/** Reference CRC-16/CCITT-FALSE, written out bitwise: init FFFF, poly 1021. */
function crc16(bytes: number[]): number {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

interface DmkSector { c: number; h: number; r: number; n: number; mark?: number; data: number[]; badIdCrc?: boolean; badDataCrc?: boolean; }

/** Build a one-track, single-sided DMK holding `sectors` in MFM. */
function makeDmk(sectors: DmkSector[], trackLen = 0x1900): Uint8Array {
  const out = new Uint8Array(16 + trackLen);
  out[0] = 0; out[1] = 1; out[2] = trackLen & 0xFF; out[3] = trackLen >> 8;
  out[4] = 0x10;   // single sided
  const track = out.subarray(16);
  let pos = 128;
  sectors.forEach((s, i) => {
    pos += 16;   // gap 1 / gap 3 padding
    const idam = pos;
    const id = [0xFE, s.c, s.h, s.r, s.n];
    const idCrc = crc16([0xA1, 0xA1, 0xA1, ...id]) ^ (s.badIdCrc ? 0xFFFF : 0);
    track.set([...id, idCrc >> 8, idCrc & 0xFF], pos); pos += 7;
    pos += 22;                                  // gap 2 (4E)
    pos += 12;                                  // sync zeros
    track.set([0xA1, 0xA1, 0xA1], pos); pos += 3;
    const mark = s.mark ?? 0xFB;
    track[pos++] = mark;
    track.set(s.data, pos); pos += s.data.length;
    const dCrc = crc16([0xA1, 0xA1, 0xA1, mark, ...s.data]) ^ (s.badDataCrc ? 0xFFFF : 0);
    track.set([dCrc >> 8, dCrc & 0xFF], pos); pos += 2;
    track[i * 2] = (idam | 0x8000) & 0xFF;
    track[i * 2 + 1] = ((idam | 0x8000) >> 8) & 0xFF;
  });
  return out;
}

const pattern = (n: number, seed: number) => Array.from({ length: n }, (_, i) => (seed + i) & 0xFF);

describe('DMK images', () => {
  it('the CRC seed the decoder uses equals CRC-CCITT of three A1 sync bytes', () => {
    expect(crc16([0xA1, 0xA1, 0xA1])).toBe(0xCDB4);
  });

  it('decodes ID fields and sector data', () => {
    const dmk = makeDmk([
      { c: 0, h: 0, r: 1, n: 1, data: pattern(256, 1) },
      { c: 0, h: 0, r: 2, n: 1, data: pattern(256, 77) },
    ]);
    expect(isDmk(dmk)).toBe(true);
    const img = parseDmk(dmk);
    expect([img.numTracks, img.numSides]).toEqual([1, 1]);
    const t = img.tracks[0][0]!;
    expect(t.sectors.map(s => [s.c, s.h, s.r, s.n])).toEqual([[0, 0, 1, 1], [0, 0, 2, 1]]);
    expect(Array.from(t.sectors[1].data)).toEqual(pattern(256, 77));
    expect(t.sectors.every(s => s.st1 === 0 && s.st2 === 0)).toBe(true);
    expect(t.sectorMap.get(2)).toBe(1);
  });

  it('keeps a data CRC error as ST1 DE + ST2 DD, but the data intact', () => {
    const img = parseDmk(makeDmk([{ c: 0, h: 0, r: 1, n: 1, data: pattern(256, 9), badDataCrc: true }]));
    const s = img.tracks[0][0]!.sectors[0];
    expect(s.st1 & 0x20).toBe(0x20);
    expect(s.st2 & 0x20).toBe(0x20);
    expect(Array.from(s.data)).toEqual(pattern(256, 9));
  });

  it('keeps an ID CRC error as ST1 DE without ST2 DD', () => {
    const img = parseDmk(makeDmk([{ c: 0, h: 0, r: 1, n: 1, data: pattern(256, 3), badIdCrc: true }]));
    const s = img.tracks[0][0]!.sectors[0];
    expect(s.st1 & 0x20).toBe(0x20);
    expect(s.st2 & 0x20).toBe(0);
  });

  it('marks a deleted-data sector (F8) with ST2 control mark', () => {
    const img = parseDmk(makeDmk([{ c: 0, h: 0, r: 1, n: 1, mark: 0xF8, data: pattern(256, 5) }]));
    expect(img.tracks[0][0]!.sectors[0].st2 & 0x40).toBe(0x40);
  });

  it('preserves duplicate sector numbers, resolving to the first occurrence', () => {
    const img = parseDmk(makeDmk([
      { c: 0, h: 0, r: 1, n: 1, data: pattern(256, 10) },
      { c: 0, h: 0, r: 1, n: 1, data: pattern(256, 99) },
    ]));
    const t = img.tracks[0][0]!;
    expect(t.sectors.length).toBe(2);
    expect(t.sectors[t.sectorMap.get(1)!].data[0]).toBe(10);
  });

  it('rejects a header whose length does not fit the file', () => {
    const dmk = makeDmk([{ c: 0, h: 0, r: 1, n: 1, data: pattern(256, 1) }]);
    expect(isDmk(dmk.subarray(0, dmk.length - 1))).toBe(false);
    expect(() => parseDmk(dmk.subarray(0, 100))).toThrow(/DMK/);
  });

  it('is routed by parseMsxFloppy', () => {
    const dmk = makeDmk([{ c: 0, h: 0, r: 1, n: 1, data: pattern(256, 1) }]);
    expect(parseMsxFloppy(dmk).tracks[0][0]!.sectors.length).toBe(1);
  });
});

describe('parseMsxFloppy routing', () => {
  it('hands an extended CPC DSK to the DSK parser', () => {
    const edsk = serializeDSK(blankMsxDisk(0xF8));
    const img = parseMsxFloppy(edsk);
    expect(img.numTracks).toBe(80);
    expect(img.tracks[0][0]!.sectors.length).toBe(9);
  });

  it('reads a raw dump when nothing else matches', () => {
    expect(parseMsxFloppy(dump(1440, 0xF9)).numSides).toBe(2);
  });
});
