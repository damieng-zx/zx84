import { describe, it, expect } from 'vitest';
import { parseScl, isScl } from '@/plus3/scl-image.ts';
import { TRD_SECTOR_BYTES } from '@/plus3/trd-image.ts';

/** Assemble an SCL archive from file descriptors (name, type, sectors, fill). */
function makeScl(files: { name: string; type: string; sectors: number; fill: number }[]): Uint8Array {
  const parts: number[] = [];
  for (const c of 'SINCLAIR') parts.push(c.charCodeAt(0));
  parts.push(files.length);
  for (const f of files) {
    const name = f.name.padEnd(8, ' ').slice(0, 8);
    for (let i = 0; i < 8; i++) parts.push(name.charCodeAt(i));
    parts.push(f.type.charCodeAt(0)); // type
    parts.push(0x00, 0x80);           // start address (LE) — arbitrary
    parts.push(0x00, 0x01);           // length in bytes (LE) — arbitrary
    parts.push(f.sectors);            // length in sectors
  }
  for (const f of files) {
    for (let s = 0; s < f.sectors * TRD_SECTOR_BYTES; s++) parts.push(f.fill);
  }
  parts.push(0, 0, 0, 0); // checksum (ignored)
  return Uint8Array.from(parts);
}

describe('isScl', () => {
  it('recognises the SINCLAIR signature', () => {
    expect(isScl(makeScl([{ name: 'X', type: 'C', sectors: 1, fill: 1 }]))).toBe(true);
    expect(isScl(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('parseScl', () => {
  it('returns null when the signature is missing', () => {
    expect(parseScl(new Uint8Array(20))).toBeNull();
  });

  it('lays a single file into the catalog and data area', () => {
    const scl = makeScl([{ name: 'TESTFILE', type: 'B', sectors: 2, fill: 0x5A }]);
    const img = parseScl(scl)!;
    expect(img).not.toBeNull();
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(2);
    expect(img.diskFormat).toBe('TR-DOS (SCL)');

    // Catalog entry 0 lives at the start of track 0, sector 1 (16 bytes).
    const cat = img.tracks[0]![0]!.sectors[0].data;
    expect(String.fromCharCode(...cat.subarray(0, 8))).toBe('TESTFILE');
    expect(cat[8]).toBe('B'.charCodeAt(0)); // file type
    expect(cat[13]).toBe(2);                // length in sectors
    expect(cat[14]).toBe(0);                // start sector (0)
    expect(cat[15]).toBe(1);                // start track (1 — after the catalog track)

    // The file's first data sector is TR-DOS logical (track 1, sector 0), which
    // is cylinder 0 / side 1 / sector 1 in the interleaved layout.
    expect(img.tracks[0]![1]!.sectors[0].data.every(b => b === 0x5A)).toBe(true);

    // Info sector (track 0, sector 9): 1 file, first free = track 1 sector 2.
    const info = img.tracks[0]![0]!.sectors[8].data;
    expect(info[0xE4]).toBe(1);   // file count
    expect(info[0xE2]).toBe(1);   // first free track
    expect(info[0xE1]).toBe(2);   // first free sector (2 sectors used)
    expect(info[0xE7]).toBe(0x10); // TR-DOS ID
  });

  it('places a second file immediately after the first', () => {
    const scl = makeScl([
      { name: 'FIRST', type: 'C', sectors: 3, fill: 0x11 },
      { name: 'SECOND', type: 'C', sectors: 1, fill: 0x22 },
    ]);
    const img = parseScl(scl)!;

    const cat0 = img.tracks[0]![0]!.sectors[0].data;
    const cat1 = img.tracks[0]![0]!.sectors[0].data.subarray(16, 32);
    expect(cat0[15]).toBe(1); expect(cat0[14]).toBe(0); // first: track1 sector0
    // 3 sectors used → second starts at logical sector 3 → track1 sector3.
    expect(cat1[15]).toBe(1); expect(cat1[14]).toBe(3);
    expect(String.fromCharCode(...cat1.subarray(0, 6))).toBe('SECOND');

    // Second file's data at logical (track1, sector3): cyl0/side1/sector 4.
    expect(img.tracks[0]![1]!.sectors[3].data.every(b => b === 0x22)).toBe(true);

    const info = img.tracks[0]![0]!.sectors[8].data;
    expect(info[0xE4]).toBe(2);   // two files
    expect(info[0xE1]).toBe(4);   // first free sector = 4 (4 sectors used)
  });
});
