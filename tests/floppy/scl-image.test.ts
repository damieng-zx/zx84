import { describe, it, expect } from 'vitest';
import { parseScl, serializeScl, isScl } from '@/media/floppy/scl-image.ts';
import { TRD_SECTOR_BYTES, blankTrdDisk } from '@/media/floppy/trd-image.ts';

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
  it('reports only successfully imported files in the TR-DOS info sector', () => {
    const data = new Uint8Array(9 + 14 * 2 + 256);
    data.set(new TextEncoder().encode('SINCLAIR'), 0);
    data[8] = 2;
    data[9 + 13] = 1;
    data[23 + 13] = 1;
    data.fill(0xAA, 9 + 28);
    const image = parseScl(data)!;
    const info = image.tracks[0][0]!.sectors[8].data;
    expect(info[0xE4]).toBe(1);
  });

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

  it('caps the catalog at 128 entries instead of overrunning into the info sector', () => {
    // 130 valid one-sector files: entries 128+ would land at track 0 sector 8
    // (the disk-info sector) and beyond, corrupting the disk.
    const scl = makeScl(
      Array.from({ length: 130 }, (_, i) =>
        ({ name: `F${i}`, type: 'C', sectors: 1, fill: 0x30 + (i % 10) })));
    const img = parseScl(scl)!;

    const info = img.tracks[0]![0]!.sectors[8].data;
    expect(info[0xE4]).toBe(128);  // 128th entry (index 127) is the last import
    expect(info[0xE7]).toBe(0x10); // TR-DOS ID survived — no catalog overrun
    // Catalog entry 127 (last legal slot) exists and is the 128th file.
    const cat127 = img.tracks[0]![0]!.sectors[7].data.subarray(112, 128);
    expect(cat127[13]).toBe(1);
    expect(cat127[15]).toBe(8);    // file 128 starts at track 8 (127 sectors after track 1 sector 0)
  });

  it('rejects file headers that run past EOF instead of letting NaN defeat the guards', () => {
    // Count claims 5 files but the archive ends before the first header is
    // complete: data[h+13] reads undefined, undefined * 256 = NaN, and every
    // NaN `>` comparison is false — the old parser "imported" all 5 phantom
    // files. The bound check must stop it at zero.
    const scl = new Uint8Array(20);
    scl.set(new TextEncoder().encode('SINCLAIR'), 0);
    scl[8] = 5;
    const img = parseScl(scl)!;

    const info = img.tracks[0]![0]!.sectors[8].data;
    expect(info[0xE4]).toBe(0); // nothing imported
  });
});

describe('serializeScl', () => {
  it('round-trips files (name, type, sector count and data) through parse→serialize→parse', () => {
    const src = makeScl([
      { name: 'FIRST', type: 'B', sectors: 3, fill: 0x11 },
      { name: 'SECOND', type: 'C', sectors: 2, fill: 0x22 },
    ]);
    const img1 = parseScl(src)!;
    const scl = serializeScl(img1);
    expect(isScl(scl)).toBe(true);
    expect(scl[8]).toBe(2); // file count preserved

    const img2 = parseScl(scl)!;
    // Both files land back with identical catalog metadata and data.
    for (const [i, name, type, sectors, fill] of [[0, 'FIRST', 'B', 3, 0x11], [1, 'SECOND', 'C', 2, 0x22]] as const) {
      const e = img2.tracks[0]![0]!.sectors[0].data.subarray(i * 16, i * 16 + 16);
      expect(String.fromCharCode(...e.subarray(0, name.length))).toBe(name);
      expect(e[8]).toBe(type.charCodeAt(0));
      expect(e[13]).toBe(sectors);
      // Data sector at the file's start location matches the original fill.
      const lin = e[15] * 16 + e[14];
      const sec = img2.tracks[Math.floor(lin / 16 / img2.numSides)]![(Math.floor(lin / 16)) % img2.numSides]!.sectors[lin % 16].data;
      expect(sec.every(b => b === fill)).toBe(true);
    }
  });

  it('serializes a blank (zero-file) disk to a minimal valid SCL', () => {
    const blank = blankTrdDisk(80, 2);
    const scl = serializeScl(blank);
    expect(isScl(scl)).toBe(true);
    expect(scl[8]).toBe(0);         // no files
    expect(scl.length).toBe(9 + 4); // magic + count + checksum
    expect(parseScl(scl)!.tracks[0]![0]!.sectors[8].data[0xE4]).toBe(0);
  });
});
