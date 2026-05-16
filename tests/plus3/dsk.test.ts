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
