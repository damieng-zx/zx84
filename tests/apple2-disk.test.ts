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
  APPLE2_SECTOR_SIZE, APPLE2_SECTORS_PER_TRACK, DOS_SKEW, GCR_WRITE_TABLE,
  decodeSector6and2, decodeTrack, encodeSector6and2, encodeTrack,
  detectApple2DiskOrder, fourAndFour, fourAndFourDecode, gcr6, gcrRead, parseApple2Disk,
  serializeApple2Disk,
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

  it('reads ProDOS order as physical order', () => {
    const raw = new Uint8Array(35 * APPLE2_SECTORS_PER_TRACK * APPLE2_SECTOR_SIZE);
    raw[0] = 0x11;
    const image = parseApple2Disk(raw, 'prodos');
    expect(image.tracks[0]![0]!.sectorMap.get(0)).toBe(0);
    expect(image.tracks[0]![0]!.sectors[0].data[0]).toBe(0x11);
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

describe('sector order detection', () => {
  const IMAGE = 35 * 16 * 256;
  const prodos = () => {
    const raw = new Uint8Array(IMAGE);
    raw.set([0x00, 0x00, 0x03, 0x00, 0xF5], 0x400);   // block 2: volume directory key block
    return raw;
  };

  it('trusts the .po and .do extensions', () => {
    expect(detectApple2DiskOrder(new Uint8Array(IMAGE), 'a.po')).toBe('prodos');
    expect(detectApple2DiskOrder(prodos(), 'a.do')).toBe('dos');
  });

  it('recognises a ProDOS volume header in a .dsk', () => {
    expect(detectApple2DiskOrder(prodos(), 'game.dsk')).toBe('prodos');
  });

  it('treats a .dsk without the header as DOS 3.3', () => {
    const raw = new Uint8Array(IMAGE);
    raw[0x11000 + 3] = 0x03;                          // DOS VTOC release byte
    expect(detectApple2DiskOrder(raw, 'game.dsk')).toBe('dos');
  });
});

