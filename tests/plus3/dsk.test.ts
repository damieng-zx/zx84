import { describe, it, expect } from 'vitest';
import { parseDSK, createBlankDisk, serializeDSK, DISK_FORMATS, refreshDiskMetadata } from '@/plus3/dsk.ts';

function makeMinimalStandardDSK(): Uint8Array {
  const tracks = 1;
  const sides = 1;
  const sectorsPerTrack = 9;
  const sectorSize = 512;
  const trackSize = 0x100 + sectorsPerTrack * sectorSize;

  const buf = new Uint8Array(0x100 + trackSize);

  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
  };

  writeAscii(0, 'MV - CPC');
  buf[0x30] = tracks;
  buf[0x31] = sides;
  buf[0x32] = trackSize & 0xFF;
  buf[0x33] = (trackSize >> 8) & 0xFF;

  const trackOff = 0x100;
  writeAscii(trackOff, 'Track-Info\r\n');
  buf[trackOff + 0x15] = sectorsPerTrack;
  buf[trackOff + 0x16] = 0x4E;
  buf[trackOff + 0x17] = 0xE5;

  for (let i = 0; i < sectorsPerTrack; i++) {
    const sib = trackOff + 0x18 + i * 8;
    buf[sib] = 0;
    buf[sib + 1] = 0;
    buf[sib + 2] = 0xC1 + i;
    buf[sib + 3] = 2;
    buf[sib + 4] = 0;
    buf[sib + 5] = 0;
    buf[sib + 6] = sectorSize & 0xFF;
    buf[sib + 7] = (sectorSize >> 8) & 0xFF;
  }

  return buf;
}

describe('parseDSK — standard format', () => {
  it('parses a minimal standard DSK', () => {
    const data = makeMinimalStandardDSK();
    const img = parseDSK(data);

    expect(img.format).toBe('standard');
    expect(img.numTracks).toBe(1);
    expect(img.numSides).toBe(1);
  });

  it('parses sectors correctly', () => {
    const data = makeMinimalStandardDSK();
    const img = parseDSK(data);
    const t0 = img.tracks[0][0]!;

    expect(t0.sectors).toHaveLength(9);
    expect(t0.sectors[0].r).toBe(0xC1);
    expect(t0.sectors[0].n).toBe(2);
    expect(t0.sectors[0].data.length).toBe(512);
  });

  it('builds sector map', () => {
    const data = makeMinimalStandardDSK();
    const img = parseDSK(data);
    const t0 = img.tracks[0][0]!;

    expect(t0.sectorMap.has(0xC1)).toBe(true);
    expect(t0.sectorMap.get(0xC1)).toBe(0);
    expect(t0.sectorMap.has(0xC9)).toBe(true);
    expect(t0.sectorMap.get(0xC9)).toBe(8);
  });
});

describe('parseDSK — validation', () => {
  it('throws on too-small file', () => {
    expect(() => parseDSK(new Uint8Array(10))).toThrow('too small');
  });

  it('throws on invalid magic', () => {
    const buf = new Uint8Array(256);
    buf[0] = 0x00;
    expect(() => parseDSK(buf)).toThrow('Not a valid DSK');
  });

  it('throws on zero tracks', () => {
    const buf = new Uint8Array(256);
    const writeAscii = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
    };
    writeAscii(0, 'MV - CPC');
    buf[0x30] = 0;
    buf[0x31] = 1;
    expect(() => parseDSK(buf)).toThrow('no tracks');
  });
});

describe('parseDSK — extended format', () => {
  it('recognizes EXTENDED magic', () => {
    const buf = new Uint8Array(256);
    const writeAscii = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
    };
    writeAscii(0, 'EXTENDED');
    buf[0x30] = 1;
    buf[0x31] = 1;
    buf[0x34] = 1;
    const img = parseDSK(buf);
    expect(img.format).toBe('extended');
  });
});

describe('createBlankDisk', () => {
  it('creates a valid PCW/+3 single-sided disk', () => {
    const fmt = DISK_FORMATS[0];
    const img = createBlankDisk(fmt);

    expect(img.numTracks).toBe(40);
    expect(img.numSides).toBe(1);
    expect(img.tracks).toHaveLength(40);
    expect(img.tracks[0][0]!.sectors).toHaveLength(9);
    expect(img.tracks[0][0]!.sectors[0].data.length).toBe(512);
  });

  it('fills sectors with filler byte (except boot sector header)', () => {
    const fmt = DISK_FORMATS[0];
    const img = createBlankDisk(fmt);
    const sector = img.tracks[0][0]!.sectors[1].data;
    expect(sector.every(b => b === 0xE5)).toBe(true);
  });

  it('creates a valid double-sided disk', () => {
    const fmt = DISK_FORMATS[1];
    const img = createBlankDisk(fmt);

    expect(img.numSides).toBe(2);
    expect(img.tracks[0]).toHaveLength(2);
    expect(img.tracks[0][0]!.sectors).toHaveLength(9);
    expect(img.tracks[0][1]!.sectors).toHaveLength(9);
  });
});

describe('serializeDSK', () => {
  it('round-trips a blank disk through serialize → parse', () => {
    const fmt = DISK_FORMATS[0];
    const original = createBlankDisk(fmt);
    const bytes = serializeDSK(original);
    const restored = parseDSK(bytes);

    expect(restored.format).toBe('extended');
    expect(restored.numTracks).toBe(original.numTracks);
    expect(restored.numSides).toBe(original.numSides);

    const origT0 = original.tracks[0][0]!;
    const restT0 = restored.tracks[0][0]!;
    expect(restT0.sectors).toHaveLength(origT0.sectors.length);

    for (let i = 0; i < origT0.sectors.length; i++) {
      expect(restT0.sectors[i].r).toBe(origT0.sectors[i].r);
      expect(restT0.sectors[i].data.length).toBe(origT0.sectors[i].data.length);
    }
  });
});

describe('refreshDiskMetadata', () => {
  it('updates diskFormat after in-place modification', () => {
    const fmt = DISK_FORMATS[0];
    const img = createBlankDisk(fmt);
    const original = img.diskFormat;
    expect(original).toBeTruthy();

    img.tracks[0][0]!.sectors[0].data[0] = 0xFF;
    refreshDiskMetadata(img);
    expect(typeof img.diskFormat).toBe('string');
  });
});

describe('detectDiskFormat', () => {
  it('detects PCW/+3 Single for standard +3 format', () => {
    const fmt = DISK_FORMATS[0];
    const img = createBlankDisk(fmt);
    expect(img.diskFormat).toContain('PCW');
  });

  it('detects PCW Double for double-sided format', () => {
    const fmt = DISK_FORMATS[1];
    const img = createBlankDisk(fmt);
    expect(img.diskFormat).toContain('PCW Double');
  });
});

// ── Standard DSK (MV - CPC) — comprehensive coverage ───────────────────────

/**
 * Standard DSK builder. Per CPCWiki + Sinclair Wiki:
 *  - DIB at offset 0 (256 bytes): magic, numTracks, numSides, fixed track size
 *  - Each track is `fixedTrackSize` bytes: 256-byte TIB header + sector data
 *  - All sectors in a track are (128 << N) bytes (sibDataLen reserved = 0)
 */
interface SectorSpec {
  c?: number;     // cylinder, defaults to track number
  h?: number;     // head, defaults to side number
  r: number;      // sector ID
  n?: number;     // size code; defaults to 2 (512 bytes)
  st1?: number;
  st2?: number;
  data?: Uint8Array; // if undefined, filled with `filler`
}

interface TrackSpec {
  cyl: number;
  side: number;
  sectors: SectorSpec[];
  gap3?: number;
  filler?: number;
  /** If true, do not emit a TIB header — produces an unformatted track. */
  unformatted?: boolean;
}

function buildStandardDSK(opts: {
  numTracks: number;
  numSides: number;
  trackSize: number;
  tracks: TrackSpec[];
  creator?: string;
  /** Optional: full DIB magic instead of just "MV - CPC". */
  fullMagic?: boolean;
}): Uint8Array {
  const writeAscii = (buf: Uint8Array, off: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
  };

  const totalTracks = opts.numTracks * opts.numSides;
  const fileSize = 256 + totalTracks * opts.trackSize;
  const buf = new Uint8Array(fileSize);

  // Disk Information Block
  if (opts.fullMagic) {
    writeAscii(buf, 0, 'MV - CPCEMU Disk-File\r\nDisk-Info\r\n');
  } else {
    writeAscii(buf, 0, 'MV - CPC');
  }
  if (opts.creator) writeAscii(buf, 0x22, opts.creator.slice(0, 14));
  buf[0x30] = opts.numTracks;
  buf[0x31] = opts.numSides;
  buf[0x32] = opts.trackSize & 0xFF;
  buf[0x33] = (opts.trackSize >> 8) & 0xFF;

  // Track Information Blocks (in physical order: cyl 0 side 0, cyl 0 side 1, ...)
  for (let t = 0; t < opts.numTracks; t++) {
    for (let s = 0; s < opts.numSides; s++) {
      const idx = t * opts.numSides + s;
      const trackOff = 256 + idx * opts.trackSize;
      const spec = opts.tracks.find((tr) => tr.cyl === t && tr.side === s);
      if (!spec || spec.unformatted) continue;

      writeAscii(buf, trackOff, 'Track-Info\r\n');
      buf[trackOff + 0x10] = spec.cyl;
      buf[trackOff + 0x11] = spec.side;
      buf[trackOff + 0x14] = spec.sectors[0]?.n ?? 2;
      buf[trackOff + 0x15] = spec.sectors.length;
      buf[trackOff + 0x16] = spec.gap3 ?? 0x4E;
      buf[trackOff + 0x17] = spec.filler ?? 0xE5;

      // Sector Information List + data.
      const filler = spec.filler ?? 0xE5;
      let dataOff = trackOff + 0x100;
      for (let i = 0; i < spec.sectors.length; i++) {
        const sec = spec.sectors[i];
        const sib = trackOff + 0x18 + i * 8;
        const n = sec.n ?? 2;
        buf[sib + 0] = sec.c ?? spec.cyl;
        buf[sib + 1] = sec.h ?? spec.side;
        buf[sib + 2] = sec.r;
        buf[sib + 3] = n;
        buf[sib + 4] = sec.st1 ?? 0;
        buf[sib + 5] = sec.st2 ?? 0;
        // Bytes 6-7 are reserved in STANDARD format — leave at 0.

        const size = 128 << n;
        if (sec.data) {
          buf.set(sec.data.subarray(0, size), dataOff);
          if (sec.data.length < size) buf.fill(filler, dataOff + sec.data.length, dataOff + size);
        } else {
          buf.fill(filler, dataOff, dataOff + size);
        }
        dataOff += size;
      }
    }
  }

  return buf;
}

describe('parseDSK — standard DIB header', () => {
  it('accepts the full "MV - CPCEMU Disk-File" magic', () => {
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: [{ cyl: 0, side: 0, sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i })) }],
      fullMagic: true,
    });
    const img = parseDSK(data);
    expect(img.format).toBe('standard');
    expect(img.numTracks).toBe(1);
  });

  it('accepts the short "MV - CPC" magic (lenient prefix)', () => {
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: [{ cyl: 0, side: 0, sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i })) }],
    });
    const img = parseDSK(data);
    expect(img.format).toBe('standard');
  });

  it('reads numTracks from DIB byte 0x30 and numSides from 0x31', () => {
    const data = buildStandardDSK({
      numTracks: 5, numSides: 2, trackSize: 0x100 + 9 * 512,
      tracks: Array.from({ length: 10 }, (_, i) => ({
        cyl: i >> 1, side: i & 1,
        sectors: Array.from({ length: 9 }, (_, j) => ({ r: 0xC1 + j })),
      })),
    });
    const img = parseDSK(data);
    expect(img.numTracks).toBe(5);
    expect(img.numSides).toBe(2);
    expect(img.tracks.length).toBe(5);
    expect(img.tracks[0].length).toBe(2);
  });

  it('reads the fixed track size as a little-endian word at DIB 0x32', () => {
    // Use 256-byte sectors (N=1, 256 bytes each) × 10 → 0x100 + 2560 = 2816 = 0x0B00.
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x0B00,
      tracks: [{
        cyl: 0, side: 0,
        sectors: Array.from({ length: 10 }, (_, i) => ({ r: i + 1, n: 1 })),
      }],
    });
    expect(data[0x32]).toBe(0x00);
    expect(data[0x33]).toBe(0x0B);
    const img = parseDSK(data);
    expect(img.tracks[0][0]?.sectors.length).toBe(10);
    expect(img.tracks[0][0]?.sectors[0].data.length).toBe(256);
  });

  it('ignores the creator string at DIB 0x22-0x2F', () => {
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: [{ cyl: 0, side: 0, sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i })) }],
      creator: 'CustomTool   ',
    });
    expect(() => parseDSK(data)).not.toThrow();
  });
});

describe('parseDSK — standard TIB and sector parsing', () => {
  it('reads track/side/gap3/filler from the TIB', () => {
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: [{
        cyl: 0, side: 0,
        gap3: 0x52, filler: 0xAA,
        sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i })),
      }],
    });
    const img = parseDSK(data);
    const t = img.tracks[0][0]!;
    expect(t.gap3).toBe(0x52);
    expect(t.filler).toBe(0xAA);
  });

  it('parses all 6 CHRN/ST1/ST2 fields from each 8-byte SIL entry', () => {
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 4 * 512,
      tracks: [{
        cyl: 7, side: 1,
        sectors: [
          { c: 7, h: 1, r: 0xC1, n: 2, st1: 0x00, st2: 0x00 },
          { c: 7, h: 1, r: 0xC2, n: 2, st1: 0x20, st2: 0x40 },
          { c: 7, h: 1, r: 0xC3, n: 2, st1: 0x80, st2: 0x80 },
          { c: 7, h: 1, r: 0xC4, n: 2, st1: 0x04, st2: 0x20 },
        ],
      }],
    });
    // Tracks at cyl 0 are unspec'd; cyl 7 has the data — but we only set
    // numTracks=1 so cyl 0 is the only slot. Rebuild correctly:
    const fixed = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 4 * 512,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [
          { c: 0, h: 0, r: 0xC1, n: 2, st1: 0x00, st2: 0x00 },
          { c: 0, h: 0, r: 0xC2, n: 2, st1: 0x20, st2: 0x40 },
          { c: 0, h: 0, r: 0xC3, n: 2, st1: 0x80, st2: 0x80 },
          { c: 0, h: 0, r: 0xC4, n: 2, st1: 0x04, st2: 0x20 },
        ],
      }],
    });
    void data;
    const img = parseDSK(fixed);
    const sectors = img.tracks[0][0]!.sectors;
    expect(sectors[1].r).toBe(0xC2);
    expect(sectors[1].st1).toBe(0x20);
    expect(sectors[1].st2).toBe(0x40);
    expect(sectors[2].st1).toBe(0x80);
    expect(sectors[2].st2).toBe(0x80);
    expect(sectors[3].st1).toBe(0x04);
    expect(sectors[3].st2).toBe(0x20);
  });

  it.each([
    [0, 128],
    [1, 256],
    [2, 512],
    [3, 1024],
    [4, 2048],
    [5, 4096],
  ])('size code N=%i produces sectors of %i bytes', (n, expectedSize) => {
    const trackSize = 0x100 + 1 * expectedSize;
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize,
      tracks: [{ cyl: 0, side: 0, sectors: [{ r: 0xC1, n }] }],
    });
    const img = parseDSK(data);
    expect(img.tracks[0][0]?.sectors[0].data.length).toBe(expectedSize);
    expect(img.tracks[0][0]?.sectors[0].n).toBe(n);
  });

  it('builds sectorMap from R value to SIL index', () => {
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 9 * 512,
      // Non-sequential R values to ensure the map honours R, not position.
      tracks: [{
        cyl: 0, side: 0,
        sectors: [0xC5, 0xC1, 0xC9, 0xC3, 0xC7, 0xC2, 0xC8, 0xC4, 0xC6].map((r) => ({ r })),
      }],
    });
    const img = parseDSK(data);
    const t = img.tracks[0][0]!;
    expect(t.sectorMap.get(0xC5)).toBe(0);
    expect(t.sectorMap.get(0xC1)).toBe(1);
    expect(t.sectorMap.get(0xC6)).toBe(8);
  });

  it('preserves sector data byte-for-byte', () => {
    const sectorData = new Uint8Array(512);
    for (let i = 0; i < 512; i++) sectorData[i] = (i * 7 + 13) & 0xFF;
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [
          { r: 0xC1, data: sectorData },
          ...Array.from({ length: 8 }, (_, i) => ({ r: 0xC2 + i })),
        ],
      }],
    });
    const img = parseDSK(data);
    const loaded = img.tracks[0][0]!.sectors[0].data;
    for (let i = 0; i < 512; i++) expect(loaded[i]).toBe((i * 7 + 13) & 0xFF);
  });
});

describe('parseDSK — standard multi-track / multi-side', () => {
  it('parses tracks in physical order: cyl 0 side 0, cyl 0 side 1, cyl 1 side 0, ...', () => {
    const data = buildStandardDSK({
      numTracks: 2, numSides: 2, trackSize: 0x100 + 9 * 512,
      tracks: [
        { cyl: 0, side: 0, sectors: [{ r: 0xA0 }, ...Array.from({ length: 8 }, (_, i) => ({ r: 0xC2 + i }))] },
        { cyl: 0, side: 1, sectors: [{ r: 0xA1 }, ...Array.from({ length: 8 }, (_, i) => ({ r: 0xC2 + i }))] },
        { cyl: 1, side: 0, sectors: [{ r: 0xA2 }, ...Array.from({ length: 8 }, (_, i) => ({ r: 0xC2 + i }))] },
        { cyl: 1, side: 1, sectors: [{ r: 0xA3 }, ...Array.from({ length: 8 }, (_, i) => ({ r: 0xC2 + i }))] },
      ],
    });
    const img = parseDSK(data);
    expect(img.tracks[0][0]?.sectors[0].r).toBe(0xA0);
    expect(img.tracks[0][1]?.sectors[0].r).toBe(0xA1);
    expect(img.tracks[1][0]?.sectors[0].r).toBe(0xA2);
    expect(img.tracks[1][1]?.sectors[0].r).toBe(0xA3);
  });

  it('all tracks use the same fixed track size', () => {
    const data = buildStandardDSK({
      numTracks: 40, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: Array.from({ length: 40 }, (_, t) => ({
        cyl: t, side: 0,
        sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i })),
      })),
    });
    const img = parseDSK(data);
    expect(img.numTracks).toBe(40);
    // Spot-check the first, middle, and last tracks.
    expect(img.tracks[0][0]?.sectors.length).toBe(9);
    expect(img.tracks[20][0]?.sectors.length).toBe(9);
    expect(img.tracks[39][0]?.sectors.length).toBe(9);
  });
});

describe('parseDSK — standard edge cases', () => {
  it('returns null for a track with missing TIB magic (treated as unformatted)', () => {
    const data = buildStandardDSK({
      numTracks: 2, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: [
        { cyl: 0, side: 0, sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i })) },
        { cyl: 1, side: 0, sectors: [{ r: 0 }], unformatted: true }, // skip TIB write
      ],
    });
    // Wipe the second track's magic to simulate unformatted.
    const secondTrackOff = 256 + (0x100 + 9 * 512);
    for (let i = 0; i < 12; i++) data[secondTrackOff + i] = 0;

    const img = parseDSK(data);
    expect(img.tracks[0][0]).not.toBeNull();
    expect(img.tracks[1][0]).toBeNull();
  });

  it('handles a track with fewer sectors than the maximum (rest of track-area unused)', () => {
    // Track size accommodates 9 × 512, but we only emit 3 sectors.
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [{ r: 0xC1 }, { r: 0xC2 }, { r: 0xC3 }],
      }],
    });
    const img = parseDSK(data);
    expect(img.tracks[0][0]?.sectors.length).toBe(3);
    expect(img.tracks[0][0]?.sectorMap.size).toBe(3);
  });

  it('fills missing sector data with the filler byte when file is truncated', () => {
    const full = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: [{
        cyl: 0, side: 0,
        filler: 0xAB,
        sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i })),
      }],
    });
    // Lop off the last sector's worth of bytes.
    const truncated = full.slice(0, full.length - 512);
    const img = parseDSK(truncated);
    const lastSector = img.tracks[0][0]!.sectors[8];
    // The parser allocates a full 512-byte buffer and fills the
    // missing portion with the track filler byte.
    expect(lastSector.data.length).toBe(512);
    expect(lastSector.data.every((b) => b === 0xAB)).toBe(true);
  });

  it('reports format="standard"', () => {
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: [{ cyl: 0, side: 0, sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i })) }],
    });
    const img = parseDSK(data);
    expect(img.format).toBe('standard');
  });
});

// ── Format detection ───────────────────────────────────────────────────────

describe('parseDSK — diskFormat detection on standard images', () => {
  it('detects "PCW/+3 Single" (1 side, 9 sectors, N=2, R starts at 0x01)', () => {
    const data = buildStandardDSK({
      numTracks: 40, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: Array.from({ length: 40 }, (_, t) => ({
        cyl: t, side: 0,
        sectors: Array.from({ length: 9 }, (_, i) => ({ r: i + 1 })),
      })),
    });
    const img = parseDSK(data);
    expect(img.diskFormat).toBe('PCW/+3 Single');
  });

  it('detects "PCW Double" (2 sides, 9 sectors, N=2, R starts at 0x01)', () => {
    const data = buildStandardDSK({
      numTracks: 80, numSides: 2, trackSize: 0x100 + 9 * 512,
      tracks: Array.from({ length: 160 }, (_, idx) => ({
        cyl: idx >> 1, side: idx & 1,
        sectors: Array.from({ length: 9 }, (_, i) => ({ r: i + 1 })),
      })),
    });
    const img = parseDSK(data);
    expect(img.diskFormat).toBe('PCW Double');
  });

  it('detects "CPC Data" (9 sectors, N=2, R starts at 0xC1)', () => {
    const data = buildStandardDSK({
      numTracks: 40, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: Array.from({ length: 40 }, (_, t) => ({
        cyl: t, side: 0,
        sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i })),
      })),
    });
    const img = parseDSK(data);
    expect(img.diskFormat).toBe('CPC Data');
  });

  it('detects "CPC System" (9 sectors, N=2, R starts at 0x41)', () => {
    const data = buildStandardDSK({
      numTracks: 40, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: Array.from({ length: 40 }, (_, t) => ({
        cyl: t, side: 0,
        sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0x41 + i })),
      })),
    });
    const img = parseDSK(data);
    expect(img.diskFormat).toBe('CPC System');
  });

  it('falls back to a generic "count×bytes" label for unknown layouts', () => {
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 5 * 1024,
      tracks: [{
        cyl: 0, side: 0,
        sectors: Array.from({ length: 5 }, (_, i) => ({ r: 0xE0 + i, n: 3 })),
      }],
    });
    const img = parseDSK(data);
    expect(img.diskFormat).toBe('5×1024b');
  });

  it('reports "Empty" when track 0 side 0 has no sectors', () => {
    const data = buildStandardDSK({
      numTracks: 1, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: [{ cyl: 0, side: 0, sectors: [] }],
    });
    const img = parseDSK(data);
    expect(img.diskFormat).toBe('Empty');
  });
});

// ── Protection detection on standard images ────────────────────────────────

// ── Simon Owen v5 EDSK extensions (multi-copy weak sectors) ────────────────
//
// SAMdisk's v5 extension to EDSK records weak sectors as N consecutive
// real reads of the same sector, with sibDataLen = N × (128<<N). The
// parser splits these into the `copies` array; the FDC picks one at
// random on each read.

interface V5SectorSpec {
  c?: number;
  h?: number;
  r: number;
  n: number;
  st1?: number;
  st2?: number;
  /** Pre-built copies for v5 multi-copy weak sectors. */
  copies: Uint8Array[];
}

function buildEDSKWithCopies(opts: {
  numTracks: number;
  numSides: number;
  tracks: { cyl: number; side: number; gap3?: number; filler?: number; sectors: V5SectorSpec[] }[];
}): Uint8Array {
  const writeAscii = (buf: Uint8Array, off: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
  };

  const totalTracks = opts.numTracks * opts.numSides;
  const trackSizes: number[] = new Array(totalTracks).fill(0);
  for (const tr of opts.tracks) {
    const idx = tr.cyl * opts.numSides + tr.side;
    let dataBytes = 0;
    for (const s of tr.sectors) {
      for (const c of s.copies) dataBytes += c.length;
    }
    trackSizes[idx] = Math.ceil((256 + dataBytes) / 256) * 256;
  }

  const fileSize = 256 + trackSizes.reduce((a, b) => a + b, 0);
  const buf = new Uint8Array(fileSize);
  writeAscii(buf, 0, 'EXTENDED CPC DSK File\r\nDisk-Info\r\n');
  buf[0x30] = opts.numTracks;
  buf[0x31] = opts.numSides;
  for (let i = 0; i < totalTracks; i++) buf[0x34 + i] = trackSizes[i] / 256;

  let offset = 256;
  for (let t = 0; t < opts.numTracks; t++) {
    for (let s = 0; s < opts.numSides; s++) {
      const idx = t * opts.numSides + s;
      const size = trackSizes[idx];
      if (size === 0) continue;
      const spec = opts.tracks.find((tr) => tr.cyl === t && tr.side === s);
      if (!spec) { offset += size; continue; }

      writeAscii(buf, offset, 'Track-Info\r\n');
      buf[offset + 0x10] = spec.cyl;
      buf[offset + 0x11] = spec.side;
      buf[offset + 0x14] = spec.sectors[0]?.n ?? 2;
      buf[offset + 0x15] = spec.sectors.length;
      buf[offset + 0x16] = spec.gap3 ?? 0x4E;
      buf[offset + 0x17] = spec.filler ?? 0xE5;

      let dataOff = offset + 0x100;
      for (let i = 0; i < spec.sectors.length; i++) {
        const sec = spec.sectors[i];
        const sib = offset + 0x18 + i * 8;
        const totalLen = sec.copies.reduce((a, c) => a + c.length, 0);
        buf[sib + 0] = sec.c ?? spec.cyl;
        buf[sib + 1] = sec.h ?? spec.side;
        buf[sib + 2] = sec.r;
        buf[sib + 3] = sec.n;
        buf[sib + 4] = sec.st1 ?? 0;
        buf[sib + 5] = sec.st2 ?? 0;
        buf[sib + 6] = totalLen & 0xFF;
        buf[sib + 7] = (totalLen >> 8) & 0xFF;
        for (const c of sec.copies) {
          buf.set(c, dataOff);
          dataOff += c.length;
        }
      }
      offset += size;
    }
  }
  return buf;
}

describe('parseDSK — Simon Owen v5 multi-copy weak sectors', () => {
  it('splits sibDataLen = 2 × (128<<N) into 2 copies', () => {
    const copy0 = new Uint8Array(512).fill(0xAA);
    const copy1 = new Uint8Array(512).fill(0xBB);
    const data = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{ cyl: 0, side: 0, sectors: [{ r: 0xC1, n: 2, copies: [copy0, copy1] }] }],
    });
    const img = parseDSK(data);
    const s = img.tracks[0][0]!.sectors[0];
    expect(s.copies).toBeDefined();
    expect(s.copies!.length).toBe(2);
    expect(s.copies![0].length).toBe(512);
    expect(s.copies![1].length).toBe(512);
    expect(s.copies![0][0]).toBe(0xAA);
    expect(s.copies![1][0]).toBe(0xBB);
    // `data` aliases the first copy so single-copy consumers stay sane.
    expect(s.data).toBe(s.copies![0]);
  });

  it('splits sibDataLen = 3 × (128<<N) into 3 copies', () => {
    const cps = [0xA1, 0xA2, 0xA3].map((v) => new Uint8Array(256).fill(v));
    const data = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{ cyl: 0, side: 0, sectors: [{ r: 0xD1, n: 1, copies: cps }] }],
    });
    const img = parseDSK(data);
    const s = img.tracks[0][0]!.sectors[0];
    expect(s.copies!.length).toBe(3);
    expect(s.copies![0][0]).toBe(0xA1);
    expect(s.copies![1][0]).toBe(0xA2);
    expect(s.copies![2][0]).toBe(0xA3);
  });

  it('mixes v5 multi-copy and single-copy sectors on the same track', () => {
    const weak = [new Uint8Array(512).fill(0x11), new Uint8Array(512).fill(0x22)];
    const data = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [
          { r: 0xC1, n: 2, copies: [new Uint8Array(512).fill(0x99)] }, // single copy
          { r: 0xC2, n: 2, copies: weak },                              // multi-copy
          { r: 0xC3, n: 2, copies: [new Uint8Array(512).fill(0x77)] }, // single copy
        ],
      }],
    });
    const img = parseDSK(data);
    const s = img.tracks[0][0]!.sectors;
    expect(s[0].copies).toBeUndefined(); // single copy → no copies array
    expect(s[1].copies?.length).toBe(2);
    expect(s[2].copies).toBeUndefined();
    expect(s[0].data[0]).toBe(0x99);
    expect(s[1].data[0]).toBe(0x11);
    expect(s[2].data[0]).toBe(0x77);
  });

  it('does NOT mark single-copy sectors as multi-copy (no copies array)', () => {
    const data = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{ cyl: 0, side: 0, sectors: [{ r: 0xC1, n: 2, copies: [new Uint8Array(512)] }] }],
    });
    const img = parseDSK(data);
    expect(img.tracks[0][0]!.sectors[0].copies).toBeUndefined();
  });

  it('does NOT misidentify a short sector or non-multiple-length sector as multi-copy', () => {
    // sibDataLen = 768 with N=2 (physSize=512) is NOT a clean multiple,
    // so it's an oversized protection sector, not v5 multi-copy.
    const big = new Uint8Array(768).fill(0xEE);
    const data = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{ cyl: 0, side: 0, sectors: [{ r: 0xC1, n: 2, copies: [big] }] }],
    });
    const img = parseDSK(data);
    expect(img.tracks[0][0]!.sectors[0].copies).toBeUndefined();
    expect(img.tracks[0][0]!.sectors[0].data.length).toBe(768);
  });

  it('preserves byte-distinct copies through parse', () => {
    // Construct copies that differ in specific bytes — typical of weak bits.
    const c0 = new Uint8Array(512).fill(0xFF);
    const c1 = new Uint8Array(512).fill(0xFF);
    c0[100] = 0x00; c0[200] = 0x55; c0[300] = 0xAA;
    c1[100] = 0xFF; c1[200] = 0x00; c1[300] = 0xFF;
    const data = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{ cyl: 0, side: 0, sectors: [{ r: 0xC1, n: 2, copies: [c0, c1] }] }],
    });
    const img = parseDSK(data);
    const s = img.tracks[0][0]!.sectors[0];
    expect(s.copies![0][100]).toBe(0x00);
    expect(s.copies![1][100]).toBe(0xFF);
    expect(s.copies![0][200]).toBe(0x55);
    expect(s.copies![1][200]).toBe(0x00);
  });

  it('preserves ST1/ST2 weak-data flags alongside the copies', () => {
    const data = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [{
          r: 0xC1, n: 2,
          st1: 0x20, st2: 0x60, // CRC error + control mark (canonical weak flags)
          copies: [new Uint8Array(512).fill(0x11), new Uint8Array(512).fill(0x22)],
        }],
      }],
    });
    const img = parseDSK(data);
    const s = img.tracks[0][0]!.sectors[0];
    expect(s.st1).toBe(0x20);
    expect(s.st2).toBe(0x60);
    expect(s.copies!.length).toBe(2);
  });
});

describe('serializeDSK — Simon Owen v5 round-trip', () => {
  it('writes back every copy with the correct cumulative sibDataLen', () => {
    const original = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [
          { r: 0xC1, n: 2, copies: [new Uint8Array(512).fill(0xA1), new Uint8Array(512).fill(0xA2)] },
          { r: 0xC2, n: 2, copies: [new Uint8Array(512).fill(0xB0)] }, // single copy
        ],
      }],
    });
    const parsed = parseDSK(original);
    const reSerialised = serializeDSK(parsed);
    const round = parseDSK(reSerialised);

    const s0 = round.tracks[0][0]!.sectors[0];
    const s1 = round.tracks[0][0]!.sectors[1];
    expect(s0.copies?.length).toBe(2);
    expect(s0.copies![0][0]).toBe(0xA1);
    expect(s0.copies![1][0]).toBe(0xA2);
    expect(s1.copies).toBeUndefined();
    expect(s1.data[0]).toBe(0xB0);
  });

  it('a 3-copy weak sector round-trips with all 3 copies intact', () => {
    const cps = [0x11, 0x22, 0x33].map((v) => new Uint8Array(256).fill(v));
    const original = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{ cyl: 0, side: 0, sectors: [{ r: 0xC1, n: 1, copies: cps }] }],
    });
    const round = parseDSK(serializeDSK(parseDSK(original)));
    const s = round.tracks[0][0]!.sectors[0];
    expect(s.copies?.length).toBe(3);
    expect(s.copies![0][0]).toBe(0x11);
    expect(s.copies![1][0]).toBe(0x22);
    expect(s.copies![2][0]).toBe(0x33);
  });

  it('serialized sibDataLen equals the sum of all copy lengths', () => {
    const original = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [{ r: 0xC1, n: 2, copies: [new Uint8Array(512), new Uint8Array(512), new Uint8Array(512)] }],
      }],
    });
    const parsed = parseDSK(original);
    const reSerialised = serializeDSK(parsed);
    // Inspect the SIB bytes 6-7 in the serialised output.
    const sibOff = 256 + 0x18; // first track, first SIB
    const sibDataLen = reSerialised[sibOff + 6] | (reSerialised[sibOff + 7] << 8);
    expect(sibDataLen).toBe(3 * 512);
  });
});

// ── FDC integration with v5 weak sectors ──────────────────────────────────

import { UPD765A } from '@/cores/upd765a.ts';

describe('FDC + DSK — Simon Owen v5 weak sectors at read time', () => {
  /** Drive the FDC through a READ_DATA command and return the sector bytes. */
  function readSectorViaFdc(fdc: UPD765A, c: number, h: number, r: number, n: number): Uint8Array {
    // CMD_READ_DATA = 0x46 (with MT/MF/SK bits cleared) — actual opcode is
    // 0x06 with optional MT/MF/SK in the top 3 bits. Parameter sequence:
    // unit/head, C, H, R, N, EOT, GPL, DTL.
    const cmd = [0x46, h << 2, c, h, r, n, r, 0x2A, 0xFF];
    for (const b of cmd) fdc.writeData(b);

    const out: number[] = [];
    let safety = 65536;
    while (safety-- > 0) {
      const msr = fdc.readStatus();
      if ((msr & 0x20) === 0) break; // EXM cleared → execution done
      if ((msr & 0x80) === 0) continue; // RQM clear → wait
      if ((msr & 0x40) === 0) break; // DIO=0 means write; not for read
      out.push(fdc.readData());
    }
    // Drain the 7 result-phase bytes.
    let resultBudget = 16;
    while (resultBudget-- > 0) {
      const msr = fdc.readStatus();
      if ((msr & 0x10) === 0) break; // CB cleared → back to idle
      if ((msr & 0xC0) !== 0xC0) break;
      fdc.readData();
    }
    return new Uint8Array(out);
  }

  it('returns one of the stored copies on each read (eventually sees both)', () => {
    const c0 = new Uint8Array(512).fill(0xAA);
    const c1 = new Uint8Array(512).fill(0xBB);
    const dsk = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{ cyl: 0, side: 0, sectors: [{ r: 0xC1, n: 2, copies: [c0, c1] }] }],
    });
    const image = parseDSK(dsk);

    const fdc = new UPD765A();
    fdc.insertDisk(image, 0);

    let sawA = false, sawB = false;
    for (let attempt = 0; attempt < 50 && !(sawA && sawB); attempt++) {
      const buf = readSectorViaFdc(fdc, 0, 0, 0xC1, 2);
      if (buf.length === 0) continue;
      if (buf[0] === 0xAA) sawA = true;
      if (buf[0] === 0xBB) sawB = true;
    }
    // With 50 reads of a 2-copy sector at uniform random, P(missing one) ≈ 2^-49.
    expect(sawA).toBe(true);
    expect(sawB).toBe(true);
  });

  it('does not exhibit weak behaviour for single-copy sectors', () => {
    const dsk = buildEDSKWithCopies({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [{ r: 0xC1, n: 2, copies: [new Uint8Array(512).fill(0x42)] }],
      }],
    });
    const image = parseDSK(dsk);
    expect(image.tracks[0][0]!.sectors[0].copies).toBeUndefined();

    const fdc = new UPD765A();
    fdc.insertDisk(image, 0);

    for (let attempt = 0; attempt < 5; attempt++) {
      const buf = readSectorViaFdc(fdc, 0, 0, 0xC1, 2);
      expect(buf.length).toBeGreaterThan(0);
      // Single-copy non-weak sector must read back identically every time.
      for (let i = 0; i < buf.length; i++) expect(buf[i]).toBe(0x42);
    }
  });
});
//
// Original EDSK by John Elliott / CPCEMU. Differences from standard:
//   1. DIB magic is "EXTENDED CPC DSK File\\r\\nDisk-Info\\r\\n"
//   2. DIB 0x32-0x33 is unused; per-track size table at 0x34 (one byte per
//      track, multiplied by 256 = track size in bytes; zero = unformatted)
//   3. SIB bytes 6-7 (little-endian word) hold the ACTUAL sector data length,
//      authoritative when non-zero — this enables mixed sector sizes per
//      track and "short sectors" used by copy protection.
//
// This block does NOT cover Simon Owen's v5 weak-sector / multiple-copy
// extension (sibDataLen > 128<<N). That's handled separately.

interface ExtendedSectorSpec {
  c?: number;
  h?: number;
  r: number;
  n: number;           // size code (authoritative for SIB byte 3)
  dataLen?: number;    // actual stored length (bytes 6-7); 0 → fallback to 128<<N
  st1?: number;
  st2?: number;
  data?: Uint8Array;
}

interface ExtendedTrackSpec {
  cyl: number;
  side: number;
  sectors: ExtendedSectorSpec[];
  gap3?: number;
  filler?: number;
  /** Optional override: total track size in bytes (must be multiple of 256). */
  trackSizeBytes?: number;
  unformatted?: boolean;
}

function buildExtendedDSK(opts: {
  numTracks: number;
  numSides: number;
  tracks: ExtendedTrackSpec[];
  creator?: string;
}): Uint8Array {
  const writeAscii = (buf: Uint8Array, off: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
  };

  // Compute per-track size in bytes (rounded up to a 256-byte multiple).
  const totalTracks = opts.numTracks * opts.numSides;
  const trackSizes: number[] = new Array(totalTracks).fill(0);
  for (const tr of opts.tracks) {
    if (tr.unformatted) continue;
    const idx = tr.cyl * opts.numSides + tr.side;
    if (tr.trackSizeBytes !== undefined) {
      trackSizes[idx] = tr.trackSizeBytes;
    } else {
      let dataBytes = 0;
      for (const s of tr.sectors) {
        const actual = s.dataLen ?? (128 << s.n);
        dataBytes += actual;
      }
      trackSizes[idx] = Math.ceil((256 + dataBytes) / 256) * 256;
    }
  }

  const fileSize = 256 + trackSizes.reduce((a, b) => a + b, 0);
  const buf = new Uint8Array(fileSize);

  // Disk Information Block.
  writeAscii(buf, 0, 'EXTENDED CPC DSK File\r\nDisk-Info\r\n');
  if (opts.creator) writeAscii(buf, 0x22, opts.creator.slice(0, 14));
  buf[0x30] = opts.numTracks;
  buf[0x31] = opts.numSides;
  // 0x32-0x33 unused in extended format.
  for (let i = 0; i < totalTracks; i++) {
    buf[0x34 + i] = trackSizes[i] / 256;
  }

  // Tracks.
  let offset = 256;
  for (let t = 0; t < opts.numTracks; t++) {
    for (let s = 0; s < opts.numSides; s++) {
      const idx = t * opts.numSides + s;
      const size = trackSizes[idx];
      if (size === 0) continue;

      const spec = opts.tracks.find((tr) => tr.cyl === t && tr.side === s);
      if (!spec || spec.unformatted) { offset += size; continue; }

      writeAscii(buf, offset, 'Track-Info\r\n');
      buf[offset + 0x10] = spec.cyl;
      buf[offset + 0x11] = spec.side;
      buf[offset + 0x14] = spec.sectors[0]?.n ?? 2;
      buf[offset + 0x15] = spec.sectors.length;
      buf[offset + 0x16] = spec.gap3 ?? 0x4E;
      buf[offset + 0x17] = spec.filler ?? 0xE5;

      const filler = spec.filler ?? 0xE5;
      let dataOff = offset + 0x100;
      for (let i = 0; i < spec.sectors.length; i++) {
        const sec = spec.sectors[i];
        const sib = offset + 0x18 + i * 8;
        const actualLen = sec.dataLen ?? (128 << sec.n);
        buf[sib + 0] = sec.c ?? spec.cyl;
        buf[sib + 1] = sec.h ?? spec.side;
        buf[sib + 2] = sec.r;
        buf[sib + 3] = sec.n;
        buf[sib + 4] = sec.st1 ?? 0;
        buf[sib + 5] = sec.st2 ?? 0;
        buf[sib + 6] = actualLen & 0xFF;
        buf[sib + 7] = (actualLen >> 8) & 0xFF;

        if (sec.data) {
          buf.set(sec.data.subarray(0, actualLen), dataOff);
          if (sec.data.length < actualLen) buf.fill(filler, dataOff + sec.data.length, dataOff + actualLen);
        } else {
          buf.fill(filler, dataOff, dataOff + actualLen);
        }
        dataOff += actualLen;
      }
      offset += size;
    }
  }

  return buf;
}

describe('parseDSK — extended DIB header', () => {
  it('reports format="extended" for "EXTENDED CPC DSK File" magic', () => {
    const data = buildExtendedDSK({
      numTracks: 1, numSides: 1,
      tracks: [{ cyl: 0, side: 0, sectors: [{ r: 0xC1, n: 2 }] }],
    });
    const img = parseDSK(data);
    expect(img.format).toBe('extended');
  });

  it('reads numTracks and numSides from DIB 0x30/0x31', () => {
    const data = buildExtendedDSK({
      numTracks: 3, numSides: 2,
      tracks: Array.from({ length: 6 }, (_, i) => ({
        cyl: i >> 1, side: i & 1,
        sectors: Array.from({ length: 9 }, (_, j) => ({ r: 0xC1 + j, n: 2 })),
      })),
    });
    const img = parseDSK(data);
    expect(img.numTracks).toBe(3);
    expect(img.numSides).toBe(2);
  });

  it('ignores DIB 0x32-0x33 (unused in extended format)', () => {
    const data = buildExtendedDSK({
      numTracks: 1, numSides: 1,
      tracks: [{ cyl: 0, side: 0, sectors: [{ r: 0xC1, n: 2 }] }],
    });
    // Poison the unused bytes; the parser must rely on the 0x34 table.
    data[0x32] = 0xFF;
    data[0x33] = 0xFF;
    const img = parseDSK(data);
    expect(img.tracks[0][0]?.sectors[0].data.length).toBe(512);
  });
});

describe('parseDSK — extended per-track size table at 0x34', () => {
  it('reads each track size as (byte at 0x34+i) × 256', () => {
    // Track 0 sized for 9 × 512 = 4864 = 0x1300 (size byte 0x13)
    // Track 1 sized for 5 × 1024 = 5376 = 0x1500 (size byte 0x15)
    const data = buildExtendedDSK({
      numTracks: 2, numSides: 1,
      tracks: [
        { cyl: 0, side: 0, sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i, n: 2 })) },
        { cyl: 1, side: 0, sectors: Array.from({ length: 5 }, (_, i) => ({ r: 0xD0 + i, n: 3 })) },
      ],
    });
    expect(data[0x34]).toBe(0x13);
    expect(data[0x35]).toBe(0x15);
    const img = parseDSK(data);
    expect(img.tracks[0][0]?.sectors.length).toBe(9);
    expect(img.tracks[1][0]?.sectors.length).toBe(5);
    expect(img.tracks[0][0]?.sectors[0].data.length).toBe(512);
    expect(img.tracks[1][0]?.sectors[0].data.length).toBe(1024);
  });

  it('treats a track-size byte of 0 as an unformatted track', () => {
    const data = buildExtendedDSK({
      numTracks: 3, numSides: 1,
      tracks: [
        { cyl: 0, side: 0, sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i, n: 2 })) },
        { cyl: 1, side: 0, sectors: [], unformatted: true },
        { cyl: 2, side: 0, sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i, n: 2 })) },
      ],
    });
    expect(data[0x35]).toBe(0); // track 1's size byte
    const img = parseDSK(data);
    expect(img.tracks[0][0]).not.toBeNull();
    expect(img.tracks[1][0]).toBeNull();
    expect(img.tracks[2][0]).not.toBeNull();
  });

  it('per-side ordering: (cyl0,side0), (cyl0,side1), (cyl1,side0), ... in table', () => {
    const data = buildExtendedDSK({
      numTracks: 2, numSides: 2,
      tracks: [
        // Different sector counts per track/side so each has a distinct size.
        { cyl: 0, side: 0, sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i, n: 2 })) }, // 0x1300
        { cyl: 0, side: 1, sectors: Array.from({ length: 5 }, (_, i) => ({ r: 0xC1 + i, n: 2 })) }, // 0x0B00
        { cyl: 1, side: 0, sectors: Array.from({ length: 7 }, (_, i) => ({ r: 0xC1 + i, n: 2 })) }, // 0x0F00
        { cyl: 1, side: 1, sectors: Array.from({ length: 3 }, (_, i) => ({ r: 0xC1 + i, n: 2 })) }, // 0x0700
      ],
    });
    expect(data[0x34]).toBe(0x13);
    expect(data[0x35]).toBe(0x0B);
    expect(data[0x36]).toBe(0x0F);
    expect(data[0x37]).toBe(0x07);
    const img = parseDSK(data);
    expect(img.tracks[0][0]?.sectors.length).toBe(9);
    expect(img.tracks[0][1]?.sectors.length).toBe(5);
    expect(img.tracks[1][0]?.sectors.length).toBe(7);
    expect(img.tracks[1][1]?.sectors.length).toBe(3);
  });
});

describe('parseDSK — extended actual sector data length (SIB bytes 6-7)', () => {
  it('uses sibDataLen as authoritative when non-zero (mixed sizes within a track)', () => {
    const data = buildExtendedDSK({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [
          { r: 0xC1, n: 2, dataLen: 512 },   // standard
          { r: 0xC2, n: 3, dataLen: 1024 },  // larger
          { r: 0xC3, n: 1, dataLen: 256 },   // smaller
        ],
      }],
    });
    const img = parseDSK(data);
    const s = img.tracks[0][0]!.sectors;
    expect(s[0].data.length).toBe(512);
    expect(s[1].data.length).toBe(1024);
    expect(s[2].data.length).toBe(256);
  });

  it('reads a "short sector" where sibDataLen < (128 << N) — copy-protection pattern', () => {
    // A common protection pattern: declare N=2 (512 bytes) but only store
    // 128 bytes — the FDC reports a CRC error after 128 bytes.
    const data = buildExtendedDSK({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [
          { r: 0xC1, n: 2, dataLen: 128, st1: 0x20 }, // CRC error after 128
          { r: 0xC2, n: 2, dataLen: 512 },
        ],
      }],
    });
    const img = parseDSK(data);
    const s = img.tracks[0][0]!.sectors;
    expect(s[0].n).toBe(2);            // N still says "512"
    expect(s[0].data.length).toBe(128); // but only 128 bytes are stored
    expect(s[0].st1).toBe(0x20);       // CRC error preserved
    expect(s[1].data.length).toBe(512);
  });

  it('falls back to 128 << N when sibDataLen=0 (defensive against zeroed-out images)', () => {
    // Build a normal extended DSK then wipe the dataLen bytes of sector 0.
    const data = buildExtendedDSK({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [{ r: 0xC1, n: 2 }, { r: 0xC2, n: 2 }],
      }],
    });
    const sib0 = 256 + 0x18; // first track, first sector's SIB
    data[sib0 + 6] = 0;
    data[sib0 + 7] = 0;
    const img = parseDSK(data);
    // With sibDataLen=0, parser uses 128 << N = 512.
    expect(img.tracks[0][0]?.sectors[0].data.length).toBe(512);
  });

  it('packs sectors back-to-back in storage (sector 1 starts immediately after sector 0)', () => {
    // Verify the storage layout: sector data is concatenated in SIL order
    // with no padding between entries of different sizes.
    const dataA = new Uint8Array(128).fill(0xAA);
    const dataB = new Uint8Array(512).fill(0xBB);
    const dataC = new Uint8Array(256).fill(0xCC);
    const data = buildExtendedDSK({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [
          { r: 0xC1, n: 0, dataLen: 128, data: dataA },
          { r: 0xC2, n: 2, dataLen: 512, data: dataB },
          { r: 0xC3, n: 1, dataLen: 256, data: dataC },
        ],
      }],
    });
    const img = parseDSK(data);
    const s = img.tracks[0][0]!.sectors;
    expect(Array.from(s[0].data.slice(0, 4))).toEqual([0xAA, 0xAA, 0xAA, 0xAA]);
    expect(Array.from(s[1].data.slice(0, 4))).toEqual([0xBB, 0xBB, 0xBB, 0xBB]);
    expect(Array.from(s[2].data.slice(0, 4))).toEqual([0xCC, 0xCC, 0xCC, 0xCC]);
    // Verify last byte of each, confirming no overlap.
    expect(s[0].data[127]).toBe(0xAA);
    expect(s[1].data[511]).toBe(0xBB);
    expect(s[2].data[255]).toBe(0xCC);
  });
});

describe('parseDSK — extended mixed-size variation', () => {
  it('handles per-track size variation across many tracks', () => {
    // 5 tracks, each with a different sector count and size.
    const data = buildExtendedDSK({
      numTracks: 5, numSides: 1,
      tracks: [
        { cyl: 0, side: 0, sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i, n: 2 })) },
        { cyl: 1, side: 0, sectors: Array.from({ length: 5 }, (_, i) => ({ r: 0x01 + i, n: 3 })) },
        { cyl: 2, side: 0, sectors: [{ r: 0xC1, n: 6, dataLen: 6144 }] },
        { cyl: 3, side: 0, sectors: Array.from({ length: 16 }, (_, i) => ({ r: i + 1, n: 1 })) },
        { cyl: 4, side: 0, sectors: Array.from({ length: 18 }, (_, i) => ({ r: i + 1, n: 0 })) },
      ],
    });
    const img = parseDSK(data);
    expect(img.tracks[0][0]?.sectors.length).toBe(9);
    expect(img.tracks[1][0]?.sectors.length).toBe(5);
    expect(img.tracks[2][0]?.sectors.length).toBe(1);
    expect(img.tracks[3][0]?.sectors.length).toBe(16);
    expect(img.tracks[4][0]?.sectors.length).toBe(18);
    expect(img.tracks[0][0]?.sectors[0].data.length).toBe(512);
    expect(img.tracks[1][0]?.sectors[0].data.length).toBe(1024);
    expect(img.tracks[2][0]?.sectors[0].data.length).toBe(6144);
    expect(img.tracks[3][0]?.sectors[0].data.length).toBe(256);
    expect(img.tracks[4][0]?.sectors[0].data.length).toBe(128);
  });
});

describe('parseDSK — extended TIB fields and FDC error preservation', () => {
  it('preserves track/side/gap3/filler/CHRN/ST1/ST2 the same as standard format', () => {
    const data = buildExtendedDSK({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0, gap3: 0x52, filler: 0xAB,
        sectors: [
          { c: 0, h: 0, r: 0xC1, n: 2, st1: 0x20, st2: 0x40 },
          { c: 0, h: 0, r: 0xC2, n: 2, st1: 0x80, st2: 0x80 },
        ],
      }],
    });
    const img = parseDSK(data);
    const t = img.tracks[0][0]!;
    expect(t.gap3).toBe(0x52);
    expect(t.filler).toBe(0xAB);
    expect(t.sectors[0].st1).toBe(0x20);
    expect(t.sectors[0].st2).toBe(0x40);
    expect(t.sectors[1].st1).toBe(0x80);
    expect(t.sectors[1].st2).toBe(0x80);
  });
});

describe('parseDSK — extended round-trip via serializeDSK', () => {
  it('a mixed-size extended image round-trips through serializeDSK', () => {
    const original = buildExtendedDSK({
      numTracks: 2, numSides: 1,
      tracks: [
        { cyl: 0, side: 0, sectors: [
          { r: 0xC1, n: 2, dataLen: 512, data: new Uint8Array(512).fill(0x11) },
          { r: 0xC2, n: 1, dataLen: 256, data: new Uint8Array(256).fill(0x22) },
          { r: 0xC3, n: 2, dataLen: 512, data: new Uint8Array(512).fill(0x33) },
        ]},
        { cyl: 1, side: 0, sectors: [
          { r: 0xD1, n: 3, dataLen: 1024, data: new Uint8Array(1024).fill(0x44) },
        ]},
      ],
    });
    const parsedOriginal = parseDSK(original);
    const reSerialised = serializeDSK(parsedOriginal);
    const parsedAgain = parseDSK(reSerialised);

    expect(parsedAgain.format).toBe('extended');
    expect(parsedAgain.numTracks).toBe(2);
    expect(parsedAgain.numSides).toBe(1);

    const a = parsedAgain.tracks[0][0]!;
    expect(a.sectors[0].data.length).toBe(512);
    expect(a.sectors[1].data.length).toBe(256);
    expect(a.sectors[2].data.length).toBe(512);
    expect(a.sectors[0].data[0]).toBe(0x11);
    expect(a.sectors[1].data[0]).toBe(0x22);
    expect(a.sectors[2].data[0]).toBe(0x33);

    expect(parsedAgain.tracks[1][0]?.sectors[0].data.length).toBe(1024);
    expect(parsedAgain.tracks[1][0]?.sectors[0].data[0]).toBe(0x44);
  });

  it('preserves FDC ST1/ST2 across a serialize/parse round-trip', () => {
    const original = buildExtendedDSK({
      numTracks: 1, numSides: 1,
      tracks: [{
        cyl: 0, side: 0,
        sectors: [
          { r: 0xC1, n: 2, dataLen: 128, st1: 0x20, st2: 0x40 }, // short + CRC
          { r: 0xC2, n: 2, dataLen: 512, st1: 0x00, st2: 0x00 },
        ],
      }],
    });
    const parsed = parseDSK(original);
    const round = parseDSK(serializeDSK(parsed));
    expect(round.tracks[0][0]?.sectors[0].data.length).toBe(128);
    expect(round.tracks[0][0]?.sectors[0].st1).toBe(0x20);
    expect(round.tracks[0][0]?.sectors[0].st2).toBe(0x40);
  });
});

describe('parseDSK — protection detection on clean standard images', () => {
  it('reports "None" for a clean uniform disk with no FDC errors', () => {
    const data = buildStandardDSK({
      numTracks: 40, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: Array.from({ length: 40 }, (_, t) => ({
        cyl: t, side: 0,
        sectors: Array.from({ length: 9 }, (_, i) => ({ r: 0xC1 + i })),
      })),
    });
    const img = parseDSK(data);
    expect(img.protection).toBe('None');
  });

  it('reports "Unknown" for a non-uniform disk with FDC errors but no signature match', () => {
    const data = buildStandardDSK({
      numTracks: 40, numSides: 1, trackSize: 0x100 + 9 * 512,
      tracks: Array.from({ length: 40 }, (_, t) => ({
        cyl: t, side: 0,
        sectors: Array.from({ length: t === 0 ? 9 : 8 }, (_, i) => ({
          r: 0xC1 + i, st1: t === 0 ? 0x20 : 0, // CRC error on T0
        })),
      })),
    });
    const img = parseDSK(data);
    expect(img.protection).toBe('Unknown');
  });
});
