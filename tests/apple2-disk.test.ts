/**
 * Apple II floppy codec tests.
 *
 * The expected values here are derived from the 16-sector 6-and-2 / 4-and-4
 * definitions (Beneath Apple DOS / the Disk II boot ROM), not from the codec
 * itself: the GCR code table is the 64 byte values with the high bit set, no
 * three consecutive zeros, and two adjacent ones below bit 7, in ascending
 * order; 4-and-4 packs a byte into two disk bytes with 0xAA fill.
 */

import { describe, expect, it } from 'vitest';
import {
  APPLE2_SECTOR_SIZE, APPLE2_SECTORS_PER_TRACK, DOS_SKEW, GCR_WRITE_TABLE, PRODOS_SKEW,
  decodeSector6and2, decodeTrack, encodeSector6and2, encodeTrack,
  apple2VolumeNumber, detectApple2DiskOrder, fourAndFour, fourAndFourDecode, gcr6, gcrRead, parseApple2Disk,
  serializeApple2Disk, unwrapApple2Image,
} from '@/media/floppy/apple2.ts';

describe('GCR 6-and-2 code table', () => {
  it('holds exactly the 64 valid disk bytes in ascending order', () => {
    expect(GCR_WRITE_TABLE.length).toBe(64);
    for (let i = 1; i < GCR_WRITE_TABLE.length; i++) {
      expect(GCR_WRITE_TABLE[i]).toBeGreaterThan(GCR_WRITE_TABLE[i - 1]);
    }
    for (const code of GCR_WRITE_TABLE) {
      expect(code & 0x80).toBe(0x80);
      const x = code & 0x7F;
      // Two adjacent one bits.
      expect((x << 1) & x).not.toBe(0);
      // The adjacent-zero-pair mask has at most one bit set (no run of three 0s).
      const gaps = ~((x << 1) | x) & 0x7E;
      expect(gaps & (gaps - 1)).toBe(0);
    }
  });

  it('maps value 0 to 0x96 and value 63 to 0xFF', () => {
    expect(GCR_WRITE_TABLE[0]).toBe(0x96);
    expect(GCR_WRITE_TABLE[63]).toBe(0xFF);
  });

  it('round-trips every value through the read table', () => {
    for (let v = 0; v < 64; v++) expect(gcrRead(gcr6(v))).toBe(v);
  });
});

describe('4-and-4 encoding', () => {
  it('round-trips the boundaries and a typical address byte', () => {
    for (const v of [0x00, 0x01, 0x7F, 0x80, 0xD5, 0xFE, 0xFF]) {
      const [a, b] = fourAndFour(v);
      expect(a & 0xAA).toBe(0xAA);
      expect(b & 0xAA).toBe(0xAA);
      expect(fourAndFourDecode(a, b)).toBe(v);
    }
  });

  it('encodes 0xD5 as the canonical EA/FF pair', () => {
    expect(fourAndFour(0xD5)).toEqual([0xEA, 0xFF]);
  });
});

describe('6-and-2 sector encoding', () => {
  it('round-trips a full sector of distinct bytes', () => {
    const sector = new Uint8Array(APPLE2_SECTOR_SIZE);
    for (let i = 0; i < sector.length; i++) sector[i] = (i * 7 + 3) & 0xFF;
    const encoded = encodeSector6and2(sector);
    expect(encoded.length).toBe(343);
    // The running XOR over all 343 values closes at zero (the reader's check).
    let acc = 0;
    for (let k = 0; k < 343; k++) acc ^= encoded[k];
    expect(acc).toBe(0);
    expect(decodeSector6and2(encoded)).toEqual(sector);
  });

  it('spreads each byte\'s low two bits across the three passes', () => {
    const sector = new Uint8Array(APPLE2_SECTOR_SIZE);
    sector[0] = 0x03;    // pass 0 -> bits 0,1
    sector[86] = 0x02;   // pass 1 -> bits 2,3
    sector[172] = 0x01;  // pass 2 -> bits 4,5
    const encoded = encodeSector6and2(sector);
    // Bit 2p is bit 1 of the byte and bit 2p+1 is bit 0, so:
    //   0x03 -> 1,1 in bits 0,1 | 0x02 -> 1,0 in bits 2,3 | 0x01 -> 0,1 in bits 4,5
    expect(encoded[0]).toBe(1 | (1 << 1) | (1 << 2) | (0 << 3) | (0 << 4) | (1 << 5));
    // The high six bits of byte 0 (0) follow at raw index 86.
    expect(encoded[86]).toBe(0);
  });

  it('stores the running XOR of the raw values', () => {
    const sector = new Uint8Array(APPLE2_SECTOR_SIZE);
    sector[0] = 0xFF;             // raw[0] = 3, raw[86] = 0x3F
    sector[85] = 0x02;            // raw[85] = 1
    const encoded = encodeSector6and2(sector);
    expect(encoded[0]).toBe(3);
    expect(encoded[85]).toBe(1);              // raw[85] ^ raw[84] (0)
    expect(encoded[86]).toBe(0x3F ^ 1);       // raw[86] ^ raw[85]
  });
});

describe('track encode/decode', () => {
  it('round-trips all sixteen sectors', () => {
    const sectors: Uint8Array[] = [];
    for (let s = 0; s < APPLE2_SECTORS_PER_TRACK; s++) {
      const d = new Uint8Array(APPLE2_SECTOR_SIZE);
      for (let i = 0; i < d.length; i++) d[i] = (i + s * 31) & 0xFF;
      sectors.push(d);
    }
    const nibbles = encodeTrack(sectors, 7, 254);
    const back = decodeTrack(nibbles);
    for (let s = 0; s < APPLE2_SECTORS_PER_TRACK; s++) {
      expect(back[s]).toEqual(sectors[s]);
    }
  });

  it('starts the first sector with an address prologue', () => {
    const sectors = new Array(APPLE2_SECTORS_PER_TRACK)
      .fill(null).map(() => new Uint8Array(APPLE2_SECTOR_SIZE));
    const nibbles = encodeTrack(sectors, 3, 254);
    // Skip the leading gap, then D5 AA 96.
    let at = 0;
    while (nibbles[at] === 0xFF) at++;
    expect([nibbles[at], nibbles[at + 1], nibbles[at + 2]]).toEqual([0xD5, 0xAA, 0x96]);
  });
});

describe('DOS image round-trip', () => {
  it('skews DOS logical sectors onto physical sectors', () => {
    expect(DOS_SKEW[13]).toBe(1);   // physical 13 holds logical 1
    expect(DOS_SKEW[1]).toBe(7);    // physical 1 holds logical 7
    const tracks = 35;
    const raw = new Uint8Array(tracks * APPLE2_SECTORS_PER_TRACK * APPLE2_SECTOR_SIZE);
    // Mark DOS logical sector 1 (file offset 256) with a recognisable pattern.
    for (let i = 0; i < APPLE2_SECTOR_SIZE; i++) raw[APPLE2_SECTOR_SIZE + i] = 0xA5;
    const image = parseApple2Disk(raw, 'dos');
    const phys13 = image.tracks[0]![0]!.sectorMap.get(13)!;
    expect(image.tracks[0]![0]!.sectors[phys13].data[0]).toBe(0xA5);
    expect(image.numTracks).toBe(35);
    const back = serializeApple2Disk(image, 'dos');
    expect(back).toEqual(raw);
  });

  it('skews ProDOS logical sectors onto physical sectors', () => {
    // ProDOS block 0 is physical sectors 0 and 2, block 1 is 4 and 6, ... block 4
    // is 1 and 3: the 256-byte file sector n sits at physical sector PRODOS_SKEW^-1[n].
    expect(PRODOS_SKEW[2]).toBe(1);   // physical 2 holds file sector 1 (block 0's second half)
    expect(PRODOS_SKEW[4]).toBe(2);   // physical 4 holds file sector 2 (block 1's first half)
    expect(PRODOS_SKEW[1]).toBe(8);   // physical 1 holds file sector 8 (block 4's first half)
    const raw = new Uint8Array(35 * APPLE2_SECTORS_PER_TRACK * APPLE2_SECTOR_SIZE);
    raw[0] = 0x11;                            // file sector 0 -> physical 0
    raw[APPLE2_SECTOR_SIZE] = 0x22;           // file sector 1 -> physical 2
    raw[8 * APPLE2_SECTOR_SIZE] = 0x33;       // file sector 8 -> physical 1
    const image = parseApple2Disk(raw, 'prodos');
    const sector = (phys: number) => image.tracks[0]![0]!.sectors[image.tracks[0]![0]!.sectorMap.get(phys)!];
    expect(sector(0).data[0]).toBe(0x11);
    expect(sector(2).data[0]).toBe(0x22);
    expect(sector(1).data[0]).toBe(0x33);
    expect(serializeApple2Disk(image, 'prodos')).toEqual(raw);
  });
});

describe('image length tolerance', () => {
  it('trims stray trailing bytes and pads a slightly short image', () => {
    for (const size of [35 * 4096 + 3, 35 * 4096 + 256, 35 * 4096 - 2, 35 * 4096 - 645]) {
      const raw = new Uint8Array(size);
      raw[0] = 0x5A;
      const image = parseApple2Disk(raw, 'dos');
      expect(image.numTracks, `${size} bytes`).toBe(35);
      // Physical sector 0 of track 0 is DOS file sector 0, so the marker survives.
      expect(image.tracks[0][0]!.sectors[0].data[0]).toBe(0x5A);
    }
  });

  it('still rejects data that is not close to a whole number of tracks', () => {
    expect(() => parseApple2Disk(new Uint8Array(35 * 4096 + 2000), 'dos')).toThrow(/Not an Apple II disk/);
    expect(() => parseApple2Disk(new Uint8Array(100), 'dos')).toThrow(/Not an Apple II disk/);
  });
});

describe('container headers', () => {
  const macBinary = (name: string, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(128 + Math.ceil(payload.length / 128) * 128);
    out[1] = name.length;
    for (let i = 0; i < name.length; i++) out[2 + i] = name.charCodeAt(i);
    out[83] = (payload.length >>> 24) & 0xFF; out[84] = (payload.length >>> 16) & 0xFF;
    out[85] = (payload.length >>> 8) & 0xFF; out[86] = payload.length & 0xFF;
    out.set(payload, 128);
    return out;
  };

  it('reads through a MacBinary header to the real boot sector', () => {
    const disk = new Uint8Array(35 * 4096);
    disk.set([0x01, 0xA5, 0x27, 0xC9], 0);          // boot sector
    const image = parseApple2Disk(macBinary('GAME', disk), 'dos');
    expect(image.numTracks).toBe(35);
    expect(Array.from(image.tracks[0][0]!.sectors[0].data.subarray(0, 4))).toEqual([0x01, 0xA5, 0x27, 0xC9]);
  });

  it('reads through a SIMSYSTEM_IIE prefix', () => {
    const disk = new Uint8Array(35 * 4096);
    disk.set([0x01, 0x38, 0xB0, 0x03], 0);
    const wrapped = new Uint8Array(30 + disk.length);
    wrapped.set(Array.from('SIMSYSTEM_IIE').map(c => c.charCodeAt(0)), 0);
    wrapped.set(disk, 30);
    const image = parseApple2Disk(wrapped, 'dos');
    expect(Array.from(image.tracks[0][0]!.sectors[0].data.subarray(0, 4))).toEqual([0x01, 0x38, 0xB0, 0x03]);
  });

  it('leaves an ordinary image alone', () => {
    const disk = new Uint8Array(35 * 4096);
    disk[1] = 5;                                      // looks a bit like a name length, nothing else does
    expect(unwrapApple2Image(disk)).toBe(disk);
  });
});

describe('sector order detection', () => {
  const IMAGE = 35 * 16 * 256;
  const prodos = () => {
    const raw = new Uint8Array(IMAGE);
    raw.set([0x00, 0x00, 0x03, 0x00, 0xF5], 0x400);   // block 2: volume directory key block
    return raw;
  };

  /** A DOS 3.3 disk's VTOC and catalog chain (sectors 15 down to 1), laid out
   *  in the given file order. */
  const dosCatalog = (order: 'dos' | 'prodos') => {
    const raw = new Uint8Array(IMAGE);
    // Catalog links are DOS logical sectors; where one sits in the file depends on the order.
    const dosPhysical = (l: number) => (DOS_SKEW as readonly number[]).indexOf(l);
    const at = (s: number) => 17 * 4096 + (order === 'dos' ? s : PRODOS_SKEW[dosPhysical(s)]) * 256;
    raw[at(0) + 1] = 17; raw[at(0) + 2] = 15; raw[at(0) + 3] = 3;
    for (let s = 15; s >= 1; s--) {
      raw[at(s) + 1] = s > 1 ? 17 : 0;
      raw[at(s) + 2] = s > 1 ? s - 1 : 0;
    }
    return raw;
  };

  it('recognises a ProDOS volume header', () => {
    expect(detectApple2DiskOrder(prodos())).toBe('prodos');
  });

  it('reads an image with no ProDOS header or catalog as DOS order', () => {
    // Custom-format boot disks (and plenty of mislabelled DOS dumps) carry the
    // .po extension without being ProDOS volumes; they boot with the DOS skew.
    expect(detectApple2DiskOrder(new Uint8Array(IMAGE))).toBe('dos');
  });

  it('decides a DOS 3.3 disk by which skew makes its catalog chain readable', () => {
    expect(detectApple2DiskOrder(dosCatalog('dos'))).toBe('dos');
    expect(detectApple2DiskOrder(dosCatalog('prodos'))).toBe('prodos');
  });

  it('is not swayed by a catalog that was edited away from the canonical chain', () => {
    // Cracked disks sometimes re-link the catalog (15 -> 14 -> 7 -> end). Only
    // the standard downward chain counts as evidence, so this stays DOS order.
    const raw = dosCatalog('dos');
    raw[17 * 4096 + 14 * 256 + 2] = 7;          // logical sector 14 is file sector 14 in DOS order
    expect(detectApple2DiskOrder(raw)).toBe('dos');
  });

  it('treats an image with only a VTOC release byte as DOS 3.3', () => {
    const raw = new Uint8Array(IMAGE);
    raw[0x11000 + 3] = 0x03;                          // DOS VTOC release byte
    expect(detectApple2DiskOrder(raw)).toBe('dos');
  });
});

describe('disk volume number', () => {
  const withVtoc = (volume: number, release = 3) => {
    const raw = new Uint8Array(35 * 4096);
    const at = 17 * 4096;                        // track 17, sector 0 (DOS order: file sector 0)
    raw[at + 1] = 17; raw[at + 2] = 15; raw[at + 3] = release; raw[at + 6] = volume;
    return parseApple2Disk(raw, 'dos');
  };

  it('is read from the DOS 3.3 VTOC', () => {
    expect(apple2VolumeNumber(withVtoc(61))).toBe(61);
    expect(apple2VolumeNumber(withVtoc(1))).toBe(1);
  });

  it('prefers the volume the DOS boot IOB asks for', () => {
    // Dark Crystal's VTOC byte says 6 but its loader requests volume 254.
    const raw = new Uint8Array(35 * 4096);
    const at = 17 * 4096;
    raw[at + 1] = 17; raw[at + 3] = 3; raw[at + 6] = 6;
    // Boot IOB in a track 0 sector (file sector 3 = physical 3 in DOS order is irrelevant: any track 0-2 sector).
    raw.set([0x01, 0x60, 0x01, 0xFE, 0x02, 0x04, 0xFB, 0xB7, 0x00, 0xB5], 0x2E8);
    expect(apple2VolumeNumber(parseApple2Disk(raw, 'dos'))).toBe(254);
    raw.set([0x01, 0x60, 0x01, 0x3D, 0x02, 0x04, 0xFB, 0xB7], 0x2E8);
    expect(apple2VolumeNumber(parseApple2Disk(raw, 'dos'))).toBe(61);
  });

  it('defaults to 254 without a recognisable VTOC', () => {
    expect(apple2VolumeNumber(parseApple2Disk(new Uint8Array(35 * 4096), 'dos'))).toBe(254);
    expect(apple2VolumeNumber(withVtoc(61, 9))).toBe(254);    // not a DOS release byte
    expect(apple2VolumeNumber(withVtoc(0))).toBe(254);        // 0 means "any"
  });
});
