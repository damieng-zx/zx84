import { describe, it, expect } from 'vitest';
import { isTd0, parseTd0, lzhufDecode, td0Crc } from '@/media/floppy/td0.ts';
import { parseFloppyImage } from '@/media/floppy/hfe.ts';

// ── Synthetic TD0 builder ───────────────────────────────────────────────────
//
// Teledisk's own encoder is not reimplemented here, so these build the plain
// 'TD' variant byte by byte — enough to drive every part of the parser except
// the decompressor, which is covered separately against a real captured image.

interface SectorSpec {
  c?: number; h?: number; r: number; n?: number;
  flags?: number;
  /** Payload; padded with 0xE5 to the size implied by `n`. */
  data?: Uint8Array;
  /** Which of Teledisk's three data encodings to store it with. */
  encoding?: 0 | 1 | 2;
  /** Corrupt the stored CRC so the parser sees a data error. */
  breakCrc?: boolean;
}

function sizeOf(n: number): number { return 128 << n; }

function padded(spec: SectorSpec): Uint8Array {
  const size = sizeOf(spec.n ?? 2);
  const out = new Uint8Array(size).fill(0xE5);
  if (spec.data) out.set(spec.data.subarray(0, size));
  return out;
}

/** Store `data` in the requested encoding, returning the stored block body. */
function encodeSector(data: Uint8Array, encoding: 0 | 1 | 2): number[] {
  if (encoding === 0) return [...data];
  if (encoding === 1) {
    // Whole sector as one repeated 2-byte pattern.
    const count = data.length >> 1;
    return [count & 0xFF, (count >> 8) & 0xFF, data[0], data[1]];
  }
  // RLE: one literal run of the whole sector (kind 0 blocks cap at 255 bytes).
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const n = Math.min(255, data.length - i);
    out.push(0, n, ...data.subarray(i, i + n));
  }
  return out;
}

interface TrackSpec { cyl: number; head: number; sectors: SectorSpec[] }

function buildTd0(tracks: TrackSpec[], opts: { comment?: string; sequence?: number } = {}): Uint8Array {
  const out: number[] = [];

  // 12-byte header.
  const head = [
    0x54, 0x44,               // 'TD' — stored plain
    opts.sequence ?? 0, 0x00, // sequence, check sequence
    21,                       // version 2.1
    0x00, 0x01,               // data rate, drive type
    opts.comment ? 0x80 : 0,  // stepping: bit 7 = comment present
    0x00, 0x01,               // DOS alloc flag, sides
  ];
  const hcrc = td0Crc(Uint8Array.from(head));
  out.push(...head, hcrc & 0xFF, (hcrc >> 8) & 0xFF);

  if (opts.comment) {
    const text = [...opts.comment].map(ch => ch.charCodeAt(0) & 0xFF);
    const rec = [text.length & 0xFF, (text.length >> 8) & 0xFF, 96, 3, 29, 20, 28, 37, ...text];
    const ccrc = td0Crc(Uint8Array.from(rec));
    out.push(ccrc & 0xFF, (ccrc >> 8) & 0xFF, ...rec);
  }

  for (const t of tracks) {
    const th = [t.sectors.length, t.cyl, t.head];
    out.push(...th, td0Crc(Uint8Array.from(th)) & 0xFF);
    for (const s of t.sectors) {
      const n = s.n ?? 2;
      const flags = s.flags ?? 0;
      const data = padded(s);
      const crc = s.breakCrc ? (td0Crc(data) ^ 0xFF) & 0xFF : td0Crc(data) & 0xFF;
      out.push(s.c ?? t.cyl, s.h ?? t.head, s.r, n, flags, crc);
      if ((flags & 0x30) === 0) {
        const enc = s.encoding ?? 0;
        const body = encodeSector(data, enc);
        const len = body.length + 1;   // the stored length counts the encoding byte
        out.push(len & 0xFF, (len >> 8) & 0xFF, enc, ...body);
      }
    }
  }

  out.push(0xFF);   // end-of-file marker
  return Uint8Array.from(out);
}

/** A PCW-shaped track: nine 512-byte sectors numbered 1..9. */
function pcwTrack(cyl: number, fill = 0x00): TrackSpec {
  return {
    cyl, head: 0,
    sectors: Array.from({ length: 9 }, (_, i) => ({
      r: i + 1,
      data: new Uint8Array(512).fill(fill + i),
    })),
  };
}

// ── Signature ───────────────────────────────────────────────────────────────

describe('isTd0', () => {
  it('accepts both the plain and the compressed signature', () => {
    expect(isTd0(Uint8Array.from([0x54, 0x44, ...new Array(10).fill(0)]))).toBe(true);
    expect(isTd0(Uint8Array.from([0x74, 0x64, ...new Array(10).fill(0)]))).toBe(true);
  });

  it('rejects other formats and short buffers', () => {
    expect(isTd0(Uint8Array.from([0x4D, 0x56, ...new Array(10).fill(0)]))).toBe(false);
    expect(isTd0(Uint8Array.from([0x54, 0x44]))).toBe(false);
  });
});

// ── CRC ─────────────────────────────────────────────────────────────────────

describe('td0Crc', () => {
  it('is zero over empty and all-zero input', () => {
    expect(td0Crc(new Uint8Array(0))).toBe(0);
    expect(td0Crc(new Uint8Array(16))).toBe(0);
  });

  it('matches the header CRC of a real Teledisk image', () => {
    // First 10 header bytes of the captured PCW CP/M disc, whose stored CRC is
    // 0x5D66 — a fixed point for the polynomial, bit order and seed together.
    const header = Uint8Array.from([0x74, 0x64, 0x00, 0x41, 0x15, 0x00, 0x01, 0x80, 0x00, 0x01]);
    expect(td0Crc(header)).toBe(0x5D66);
  });
});

// ── LZHUF ───────────────────────────────────────────────────────────────────

describe('lzhufDecode', () => {
  // The opening 128 compressed bytes of a real Teledisk 2.1 image (an Amstrad
  // PCW CP/M-3 boot disc). Decoding stops when the input runs out, so a prefix
  // of the stream decodes to a prefix of the output — which keeps the fixture
  // small while still exercising the adaptive tree and the position code.
  const SLICE =
    'WTXpYz2Y/U6DUbHn9zd9nc7/dbzWf8FsgD4/mz+H1qfep8v3/qnNrqthSe2tl4m+4PCwp/e0E3us' +
    'ZNfNDB98uljbiadt+LINi8Z9AoIAysRngOQY3HQxKxANa9pBP8BgL9t3qAG8hFrVf5TpHiE6xZg6' +
    '61KYDnWuWSdlQ0pzmdY=';

  function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    return Uint8Array.from(bin, ch => ch.charCodeAt(0));
  }

  it('decodes a real Teledisk LZHUF stream', () => {
    const out = lzhufDecode(fromBase64(SLICE));

    // What the stream opens with is the image's comment block: a CRC, the
    // text length, a six-byte timestamp, then the text itself.
    expect(out[0] | (out[1] << 8)).toBe(0xA9CD);
    expect(out[2] | (out[3] << 8)).toBe(70);
    expect([...out.subarray(4, 10)]).toEqual([96, 3, 29, 20, 28, 37]);
    expect(String.fromCharCode(...out.subarray(10, 47)))
      .toBe('CP/M-3.0 system disk for Amstrad 8256');
  });

  it('stops cleanly at the end of the input rather than looping', () => {
    const out = lzhufDecode(fromBase64(SLICE));
    expect(out.length).toBeGreaterThan(64);
    expect(out.length).toBeLessThan(4096);
  });
});

// ── Parsing ─────────────────────────────────────────────────────────────────

describe('parseTd0', () => {
  it('parses geometry, CHRN and sector data', () => {
    const img = parseTd0(buildTd0([pcwTrack(0), pcwTrack(1)]));

    expect(img.numTracks).toBe(2);
    expect(img.numSides).toBe(1);
    expect(img.format).toBe('extended');

    const t0 = img.tracks[0][0]!;
    expect(t0.sectors).toHaveLength(9);
    expect(t0.sectors.map(s => s.r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(t0.sectors.every(s => s.n === 2 && s.data.length === 512)).toBe(true);
    expect(t0.sectors[0].data[0]).toBe(0x00);
    expect(t0.sectors[3].data[0]).toBe(0x03);
    expect(t0.sectors.every(s => s.st1 === 0 && s.st2 === 0)).toBe(true);
  });

  it('classifies a 40-track single-sided 9×512 image as a PCW disc', () => {
    const tracks = Array.from({ length: 40 }, (_, c) => pcwTrack(c));
    const img = parseTd0(buildTd0(tracks));
    expect(img.numTracks).toBe(40);
    expect(img.diskFormat).toBe('PCW/+3 Single');
  });

  it('builds a sector map that resolves IDs to indices', () => {
    const img = parseTd0(buildTd0([pcwTrack(0)]));
    const t0 = img.tracks[0][0]!;
    expect(t0.sectorMap.get(1)).toBe(0);
    expect(t0.sectorMap.get(9)).toBe(8);
  });

  it('leaves unrecorded cylinders null and sizes the image to the highest seen', () => {
    const img = parseTd0(buildTd0([pcwTrack(0), pcwTrack(3)]));
    expect(img.numTracks).toBe(4);
    expect(img.tracks[1][0]).toBeNull();
    expect(img.tracks[2][0]).toBeNull();
    expect(img.tracks[3][0]).not.toBeNull();
  });

  it('reads a double-sided image', () => {
    const img = parseTd0(buildTd0([
      { cyl: 0, head: 0, sectors: [{ r: 1 }] },
      { cyl: 0, head: 1, sectors: [{ r: 1, h: 1 }] },
    ]));
    expect(img.numSides).toBe(2);
    expect(img.tracks[0][1]!.sectors[0].h).toBe(1);
  });

  it('skips the comment block when one is present', () => {
    const img = parseTd0(buildTd0([pcwTrack(0)], { comment: 'CP/M-3.0 system disk' }));
    expect(img.tracks[0][0]!.sectors).toHaveLength(9);
  });
});

// ── Data encodings ──────────────────────────────────────────────────────────

describe('parseTd0 sector encodings', () => {
  const pattern = new Uint8Array(512);
  for (let i = 0; i < 512; i++) pattern[i] = i & 0xFF;

  it('reads a raw-copied sector', () => {
    const img = parseTd0(buildTd0([{ cyl: 0, head: 0, sectors: [{ r: 1, data: pattern, encoding: 0 }] }]));
    expect([...img.tracks[0][0]!.sectors[0].data]).toEqual([...pattern]);
  });

  it('expands a repeated 2-byte pattern', () => {
    const two = new Uint8Array(512);
    for (let i = 0; i < 512; i += 2) { two[i] = 0xAB; two[i + 1] = 0xCD; }
    const img = parseTd0(buildTd0([{ cyl: 0, head: 0, sectors: [{ r: 1, data: two, encoding: 1 }] }]));
    expect([...img.tracks[0][0]!.sectors[0].data]).toEqual([...two]);
  });

  it('expands run-length encoded data', () => {
    const img = parseTd0(buildTd0([{ cyl: 0, head: 0, sectors: [{ r: 1, data: pattern, encoding: 2 }] }]));
    expect([...img.tracks[0][0]!.sectors[0].data]).toEqual([...pattern]);
  });

  it('handles sector sizes other than 512', () => {
    for (const n of [0, 1, 3]) {
      const img = parseTd0(buildTd0([{ cyl: 0, head: 0, sectors: [{ r: 1, n }] }]));
      expect(img.tracks[0][0]!.sectors[0].data.length).toBe(128 << n);
    }
  });
});

// ── Sector flags → FDC status ───────────────────────────────────────────────

describe('parseTd0 sector flags', () => {
  function firstSector(flags: number, extra: Partial<SectorSpec> = {}) {
    const img = parseTd0(buildTd0([{ cyl: 0, head: 0, sectors: [{ r: 1, flags, ...extra }] }]));
    return img.tracks[0][0]!.sectors[0];
  }

  it('maps a deleted-data mark to ST2 control mark', () => {
    expect(firstSector(0x04).st2 & 0x40).toBe(0x40);
  });

  it('maps a recorded CRC error to ST1/ST2 data error', () => {
    const s = firstSector(0x02);
    expect(s.st1 & 0x20).toBe(0x20);
    expect(s.st2 & 0x20).toBe(0x20);
  });

  it('maps a missing data address mark to ST1/ST2 missing-mark bits', () => {
    const s = firstSector(0x20);
    expect(s.st1 & 0x01).toBe(0x01);
    expect(s.st2 & 0x01).toBe(0x01);
  });

  it('fills a skipped sector with the format filler and stores no data', () => {
    const s = firstSector(0x10);
    expect(s.data.length).toBe(512);
    expect(s.data.every(b => b === 0xE5)).toBe(true);
  });

  it('flags a sector whose stored CRC does not match the decoded data', () => {
    const s = firstSector(0, { breakCrc: true });
    expect(s.st1 & 0x20).toBe(0x20);
    expect(s.st2 & 0x20).toBe(0x20);
  });

  it('leaves a sector whose CRC matches clean', () => {
    const s = firstSector(0);
    expect(s.st1).toBe(0);
    expect(s.st2).toBe(0);
  });
});

// ── Malformed input ─────────────────────────────────────────────────────────

describe('parseTd0 rejects malformed images', () => {
  it('rejects a non-Teledisk file', () => {
    expect(() => parseTd0(new Uint8Array(32))).toThrow(/Not a Teledisk/);
  });

  it('rejects a bad header CRC', () => {
    const img = buildTd0([pcwTrack(0)]);
    img[10] ^= 0xFF;
    expect(() => parseTd0(img)).toThrow(/header CRC/);
  });

  it('rejects a multi-volume image', () => {
    expect(() => parseTd0(buildTd0([pcwTrack(0)], { sequence: 1 }))).toThrow(/multi-volume/);
  });

  it('rejects a file that runs out before the end marker', () => {
    const img = buildTd0([pcwTrack(0)]);
    expect(() => parseTd0(img.subarray(0, img.length - 1))).toThrow(/end-of-file marker/);
  });

  it('rejects an image with no tracks at all', () => {
    expect(() => parseTd0(buildTd0([]))).toThrow(/no tracks/);
  });
});

// ── Dispatcher ──────────────────────────────────────────────────────────────

describe('parseFloppyImage', () => {
  it('routes a Teledisk image to the TD0 parser', () => {
    const img = parseFloppyImage(buildTd0([pcwTrack(0), pcwTrack(1)]));
    expect(img.numTracks).toBe(2);
    expect(img.tracks[0][0]!.sectors).toHaveLength(9);
  });
});
