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
