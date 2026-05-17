import { describe, it, expect } from 'vitest';
import { detectDiskFormat, detectProtection } from '@/plus3/disk-detect.ts';
import type { DskImage, DskTrack, DskSector } from '@/plus3/dsk.ts';

// ── Synthetic DskImage builders ───────────────────────────────────────────
//
// These tests target the pure detection logic — they don't need a real
// parsed DSK file. Constructing `DskImage` objects in memory gives precise
// control over every byte that a detector might inspect (sector counts,
// CHRN, FDC status registers, sector data) and makes failures easy to read.

interface SectorOpts {
  c?: number; h?: number; r?: number; n?: number;
  st1?: number; st2?: number;
  data?: Uint8Array | string;
  /** Override sector data length (data is padded / truncated to fit). */
  size?: number;
}

function sector(o: SectorOpts = {}): DskSector {
  const n = o.n ?? 2;
  const size = o.size ?? (n <= 5 ? (128 << n) : n === 6 ? 6144 : 128 << n);
  const data = new Uint8Array(size);
  if (typeof o.data === 'string') {
    for (let i = 0; i < o.data.length && i < size; i++) data[i] = o.data.charCodeAt(i);
  } else if (o.data) {
    data.set(o.data.subarray(0, size));
  }
  return {
    c: o.c ?? 0, h: o.h ?? 0, r: o.r ?? 0xC1, n,
    st1: o.st1 ?? 0, st2: o.st2 ?? 0,
    data,
  };
}

function track(sectors: DskSector[], gap3 = 0x4E, filler = 0xE5): DskTrack {
  const sectorMap = new Map<number, number>();
  sectors.forEach((s, i) => sectorMap.set(s.r, i));
  return { sectors, sectorMap, gap3, filler };
}

function image(tracksBySide0: (DskTrack | null)[], numSides = 1): DskImage {
  const tracks = tracksBySide0.map((t) => {
    const sides: (DskTrack | null)[] = [t];
    for (let s = 1; s < numSides; s++) sides.push(t);
    return sides;
  });
  return {
    format: 'extended',
    numTracks: tracksBySide0.length,
    numSides,
    tracks,
    diskFormat: '',
    protection: '',
  };
}

/** Standard clean uniform 9-sector PCW disk — a "None" baseline. */
function cleanDisk(numTracks = 40, firstR = 0x01): DskImage {
  const tracks: DskTrack[] = [];
  for (let t = 0; t < numTracks; t++) {
    const sectors: DskSector[] = [];
    for (let i = 0; i < 9; i++) sectors.push(sector({ c: t, r: firstR + i, n: 2 }));
    tracks.push(track(sectors));
  }
  return image(tracks);
}

// ── detectDiskFormat ──────────────────────────────────────────────────────

describe('detectDiskFormat', () => {
  it('reports "Empty" when track 0 / side 0 is missing', () => {
    const img = image([null, track([sector()])]);
    expect(detectDiskFormat(img)).toBe('Empty');
  });

  it('reports "Empty" when T0/S0 has zero sectors', () => {
    const img = image([track([])]);
    expect(detectDiskFormat(img)).toBe('Empty');
  });

  it('PCW/+3 Single: 9 sectors, N=2, minR=0x01, 1 side', () => {
    const img = image([track(Array.from({ length: 9 }, (_, i) => sector({ r: i + 1, n: 2 })))]);
    expect(detectDiskFormat(img)).toBe('PCW/+3 Single');
  });

  it('PCW Double: 9 sectors, N=2, minR=0x01, 2 sides', () => {
    const img = image([track(Array.from({ length: 9 }, (_, i) => sector({ r: i + 1, n: 2 })))], 2);
    expect(detectDiskFormat(img)).toBe('PCW Double');
  });

  it('CPC Data (SS): 9 sectors, N=2, minR=0xC1, 1 side', () => {
    const img = image([track(Array.from({ length: 9 }, (_, i) => sector({ r: 0xC1 + i, n: 2 })))]);
    expect(detectDiskFormat(img)).toBe('CPC Data');
  });

  it('CPC Data DS: same layout, 2 sides → " DS" suffix', () => {
    const img = image([track(Array.from({ length: 9 }, (_, i) => sector({ r: 0xC1 + i, n: 2 })))], 2);
    expect(detectDiskFormat(img)).toBe('CPC Data DS');
  });

  it('CPC System (SS): minR=0x41', () => {
    const img = image([track(Array.from({ length: 9 }, (_, i) => sector({ r: 0x41 + i, n: 2 })))]);
    expect(detectDiskFormat(img)).toBe('CPC System');
  });

  it('CPC System DS: same layout, 2 sides → " DS" suffix', () => {
    const img = image([track(Array.from({ length: 9 }, (_, i) => sector({ r: 0x41 + i, n: 2 })))], 2);
    expect(detectDiskFormat(img)).toBe('CPC System DS');
  });

  it('classifies by minR not by sector index — unsorted sector list still works', () => {
    const sorted = [0xC5, 0xC1, 0xC9, 0xC3, 0xC7, 0xC2, 0xC8, 0xC4, 0xC6];
    const img = image([track(sorted.map((r) => sector({ r, n: 2 })))]);
    expect(detectDiskFormat(img)).toBe('CPC Data');
  });

  it('rejects PCW/CPC label when sector count is not 9 (falls to generic)', () => {
    const img = image([track(Array.from({ length: 8 }, (_, i) => sector({ r: i + 1, n: 2 })))]);
    expect(detectDiskFormat(img)).toBe('8×512b');
  });

  it('rejects PCW/CPC label when N is not 2 (falls to generic)', () => {
    const img = image([track(Array.from({ length: 9 }, (_, i) => sector({ r: i + 1, n: 1 })))]);
    expect(detectDiskFormat(img)).toBe('9×256b');
  });

  it('rejects PCW/CPC label when minR is none of {1, 0xC1, 0x41} (falls to generic)', () => {
    const img = image([track(Array.from({ length: 9 }, (_, i) => sector({ r: 0x10 + i, n: 2 })))]);
    expect(detectDiskFormat(img)).toBe('9×512b');
  });

  it.each([
    [0, 128], [1, 256], [2, 512], [3, 1024],
    [4, 2048], [5, 4096], [6, 8192], [7, 16384],
  ])('generic fallback formats N=%i as %i bytes', (n, bytes) => {
    const img = image([track([sector({ r: 0xE0, n })])]);
    expect(detectDiskFormat(img)).toBe(`1×${bytes}b`);
  });

  it('generic fallback emits 0-byte size for N=9+ (n <= 8 guard)', () => {
    // N=9 is non-standard. The "bytes = n <= 8 ? 128<<n : 0" branch keeps
    // the result label finite for malformed N values.
    const img = image([track([sector({ r: 0xE0, n: 9, size: 128 })])]);
    expect(detectDiskFormat(img)).toBe('1×0b');
  });
});

// ── detectProtection — boundary / shortcut behaviour ─────────────────────

describe('detectProtection — shortcuts and guards', () => {
  it('returns "" for numTracks < 2', () => {
    const img = image([track([sector({ r: 0xC1, n: 2 })])]);
    expect(detectProtection(img)).toBe('');
  });

  it('returns "" when T0 has zero sectors', () => {
    const img = image([track([]), track([sector()])]);
    expect(detectProtection(img)).toBe('');
  });

  it('returns "" when T0 first sector has length < 128', () => {
    const img = image([
      track([sector({ r: 0xC1, n: 0, size: 64 })]),
      track([sector({ r: 0xC1, n: 2 })]),
    ]);
    expect(detectProtection(img)).toBe('');
  });

  it('returns "None" for a uniform clean disk with no FDC errors', () => {
    expect(detectProtection(cleanDisk(40))).toBe('None');
  });

  it('returns "Unknown" for a non-uniform disk with ST1/ST2 errors that match no detector', () => {
    const img = cleanDisk(40);
    // Trim T39 to fewer sectors → non-uniform; flag CRC error.
    img.tracks[39][0] = track([
      sector({ c: 39, r: 0xC1, n: 2, st1: 0x20 }),
      sector({ c: 39, r: 0xC2, n: 2 }),
    ]);
    expect(detectProtection(img)).toBe('Unknown');
  });

  it('returns "" for a non-uniform disk with NO FDC errors and no detector match', () => {
    // Non-uniform but error-free is rare — the function returns the empty
    // string rather than "Unknown". Test pins down this branch.
    const img = cleanDisk(40);
    img.tracks[39][0] = track([sector({ c: 39, r: 0xC1, n: 2 })]); // 1 sector, no errors
    expect(detectProtection(img)).toBe('');
  });
});

// ── Speedlock — all 10 signed variants + 3 unsigned ───────────────────────

const SPEEDLOCK_SIGS: [string, string][] = [
  ['Speedlock 1985', 'SPEEDLOCK PROTECTION SYSTEM (C) 1985 '],
  ['Speedlock 1986', 'SPEEDLOCK PROTECTION SYSTEM (C) 1986 '],
  ['Speedlock disc 1987', 'SPEEDLOCK DISC PROTECTION SYSTEMS COPYRIGHT 1987 '],
  ['Speedlock 1987 v2.1', 'SPEEDLOCK PROTECTION SYSTEM (C) 1987 D.LOOKER & D.AUBREY JONES : VERSION D/2.1'],
  ['Speedlock 1987', 'SPEEDLOCK PROTECTION SYSTEM (C) 1987 '],
  ['Speedlock +3 1987', 'SPEEDLOCK +3 DISC PROTECTION SYSTEM COPYRIGHT 1987 SPEEDLOCK ASSOCIATES'],
  ['Speedlock +3 1988', 'SPEEDLOCK +3 DISC PROTECTION SYSTEM COPYRIGHT 1988 SPEEDLOCK ASSOCIATES'],
  ['Speedlock 1988', 'SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1988 SPEEDLOCK ASSOCIATES'],
  ['Speedlock 1989', 'SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1989 SPEEDLOCK ASSOCIATES'],
  ['Speedlock 1990', 'SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1990 SPEEDLOCK ASSOCIATES'],
];

describe('detectProtection — Speedlock signed variants', () => {
  // Note: order-sensitive signatures. "SPEEDLOCK PROTECTION SYSTEM (C) 1987 "
  // is the prefix of the v2.1 string, so the table puts v2.1 first. Building
  // a disk containing the 1987 plain signature must NOT also match v2.1.
  it.each(SPEEDLOCK_SIGS)('detects %s', (label, sig) => {
    const img = cleanDisk(40);
    // Plant the signature on T5/S0 with a CRC error to force non-uniform.
    img.tracks[5][0] = track([
      sector({ c: 5, r: 0xC1, n: 2, st1: 0x20, data: sig }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 5, r: 0xC2 + i, n: 2 })),
    ]);
    const result = detectProtection(img);
    expect(result.startsWith(label + ' ')).toBe(true);
  });

  it('reports the location string T#/S# +offset', () => {
    const sig = 'SPEEDLOCK DISC PROTECTION SYSTEMS (C) 1990 SPEEDLOCK ASSOCIATES';
    const img = cleanDisk(40);
    const data = new Uint8Array(512);
    for (let i = 0; i < sig.length; i++) data[42 + i] = sig.charCodeAt(i);
    img.tracks[3][0] = track([
      sector({ c: 3, r: 0xC1, n: 2, st1: 0x20, data }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 3, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe('Speedlock 1990 (T3/S0 +42)');
  });
});

describe('detectProtection — Speedlock unsigned layouts', () => {
  function speedlockPlus3Base(s6st2: number, s8st2: number): DskImage {
    const t0sectors: DskSector[] = [];
    for (let i = 0; i < 9; i++) {
      t0sectors.push(sector({
        c: 0, r: 0xC1 + i, n: 2,
        st2: i === 6 ? s6st2 : i === 8 ? s8st2 : 0,
      }));
    }
    const t1sectors = Array.from({ length: 5 }, (_, i) => sector({ c: 1, r: 0xD0 + i, n: 3 }));
    const rest = Array.from({ length: 38 }, (_, t) => track(
      Array.from({ length: 9 }, (_, i) => sector({ c: t + 2, r: 0xC1 + i, n: 2 }))
    ));
    return image([track(t0sectors), track(t1sectors), ...rest]);
  }

  it('unsigned Speedlock +3 1987: T0=9, T1=5×1024, s6 ST2=0x40, s8 ST2=0', () => {
    expect(detectProtection(speedlockPlus3Base(0x40, 0x00))).toBe('Speedlock +3 1987');
  });

  it('unsigned Speedlock +3 1988: same but s8 ST2=0x40', () => {
    expect(detectProtection(speedlockPlus3Base(0x40, 0x40))).toBe('Speedlock +3 1988');
  });

  it('rejects unsigned Speedlock +3 layout when s6 ST2 is not 0x40', () => {
    expect(detectProtection(speedlockPlus3Base(0x00, 0x40))).not.toContain('Speedlock');
  });

  it('rejects unsigned Speedlock +3 layout when T1 sector size is not 1024', () => {
    const img = speedlockPlus3Base(0x40, 0x00);
    img.tracks[1][0] = track([sector({ c: 1, r: 0xD0, n: 2 })]); // 512 bytes, not 1024
    expect(detectProtection(img)).not.toContain('Speedlock');
  });

  it('unsigned Speedlock 1989/1990: numTracks>40, T1 has 1 sector R=0xC1 ST1=0x20', () => {
    const t0sectors = Array.from({ length: 9 }, (_, i) => sector({ c: 0, r: 0xC1 + i, n: 2 }));
    const t1sectors = [sector({ c: 1, r: 0xC1, n: 2, st1: 0x20 })];
    const rest = Array.from({ length: 39 }, (_, t) => track(
      Array.from({ length: 9 }, (_, i) => sector({ c: t + 2, r: 0xC1 + i, n: 2 }))
    ));
    const img = image([track(t0sectors), track(t1sectors), ...rest]);
    expect(detectProtection(img)).toBe('Speedlock 1989/1990');
  });

  it('rejects unsigned Speedlock 1989/1990 when numTracks <= 40', () => {
    const t0sectors = Array.from({ length: 9 }, (_, i) => sector({ c: 0, r: 0xC1 + i, n: 2 }));
    const t1sectors = [sector({ c: 1, r: 0xC1, n: 2, st1: 0x20 })];
    const rest = Array.from({ length: 38 }, (_, t) => track(
      Array.from({ length: 9 }, (_, i) => sector({ c: t + 2, r: 0xC1 + i, n: 2 }))
    ));
    const img = image([track(t0sectors), track(t1sectors), ...rest]);
    // numTracks = 40 exactly → guard "image.numTracks > 40" fails.
    expect(detectProtection(img)).not.toContain('Speedlock 1989/1990');
  });
});

// ── Alkatraz ──────────────────────────────────────────────────────────────

describe('detectProtection — Alkatraz', () => {
  it('signed +3: signature " THE ALKATRAZ PROTECTION SYSTEM" on T0/S0', () => {
    const img = cleanDisk(40);
    img.tracks[0][0] = track([
      sector({ c: 0, r: 0xC1, n: 2, st1: 0x20, data: ' THE ALKATRAZ PROTECTION SYSTEM' }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 0, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe('Alkatraz +3');
  });

  it('CPC: any track with 18 sectors of 256 bytes triggers Alkatraz CPC', () => {
    const img = cleanDisk(40);
    img.tracks[5][0] = track(Array.from({ length: 18 }, (_, i) => sector({
      c: 5, r: 0xC1 + i, n: 1, st1: i === 0 ? 0x20 : 0,
    })));
    expect(detectProtection(img)).toBe('Alkatraz CPC');
  });

  it('Alkatraz CPC loop skips the final track (t < numTracks - 1)', () => {
    // Put the 18×256 pattern only on the LAST track. The guard skips it,
    // so this disk must NOT be tagged as Alkatraz CPC.
    const img = cleanDisk(40);
    img.tracks[39][0] = track(Array.from({ length: 18 }, (_, i) => sector({
      c: 39, r: 0xC1 + i, n: 1, st1: i === 0 ? 0x20 : 0,
    })));
    expect(detectProtection(img)).not.toContain('Alkatraz');
  });
});

// ── Hexagon ───────────────────────────────────────────────────────────────

describe('detectProtection — Hexagon', () => {
  function hexT0(signature?: string): DskTrack {
    const sectors = Array.from({ length: 10 }, (_, i) => sector({
      c: 0, r: 0xC1 + i, n: 2,
      st1: i === 0 ? 0x20 : 0,
      data: i === 0 ? signature : undefined,
    }));
    return track(sectors);
  }

  it.each([
    'HEXAGON DISK PROTECTION c 1989',
    'HEXAGON Disk Protection c 1989',
  ])('signed: detects "%s"', (sig) => {
    const img = cleanDisk(10);
    img.tracks[0][0] = hexT0(sig);
    expect(detectProtection(img)).toMatch(/^Hexagon \(T\d+\/S\d+\)$/);
  });

  it('unsigned: single-sector track with N=6, ST1=0x20, ST2=0x60', () => {
    const img = cleanDisk(10);
    img.tracks[0][0] = hexT0();
    img.tracks[2][0] = track([sector({ c: 2, r: 0xC1, n: 6, st1: 0x20, st2: 0x60 })]);
    expect(detectProtection(img)).toBe('Hexagon (unsigned)');
  });

  it('rejects when T0 has fewer than 10 sectors', () => {
    const img = cleanDisk(10);
    img.tracks[0][0] = track([
      sector({ c: 0, r: 0xC1, n: 2, st1: 0x20, data: 'HEXAGON DISK PROTECTION c 1989' }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 0, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).not.toContain('Hexagon');
  });

  it('rejects when T0 has more than 10 sectors (exact-count guard)', () => {
    const img = cleanDisk(10);
    img.tracks[0][0] = track([
      sector({ c: 0, r: 0xC1, n: 2, st1: 0x20, data: 'HEXAGON DISK PROTECTION c 1989' }),
      ...Array.from({ length: 10 }, (_, i) => sector({ c: 0, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).not.toContain('Hexagon');
  });

  it('rejects when 9th sector (index 8) is not 512 bytes', () => {
    const img = cleanDisk(10);
    const sectors = Array.from({ length: 10 }, (_, i) => sector({
      c: 0, r: 0xC1 + i, n: i === 8 ? 1 : 2, // index 8 is 256b
      st1: i === 0 ? 0x20 : 0,
      data: i === 0 ? 'HEXAGON DISK PROTECTION c 1989' : undefined,
    }));
    img.tracks[0][0] = track(sectors);
    expect(detectProtection(img)).not.toContain('Hexagon');
  });

  it('only scans the first 4 tracks for the signature', () => {
    const img = cleanDisk(10);
    img.tracks[0][0] = hexT0();
    // Signature on T4 (beyond scan window of Math.min(4, numTracks)) → no match.
    img.tracks[4][0] = track([
      sector({ c: 4, r: 0xC1, n: 2, st1: 0x20, data: 'HEXAGON DISK PROTECTION c 1989' }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 4, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).not.toContain('Hexagon (T');
  });
});

// ── Paul Owens ────────────────────────────────────────────────────────────

describe('detectProtection — Paul Owens', () => {
  function paulOwensBase(): DskImage {
    const t0sectors = Array.from({ length: 9 }, (_, i) => sector({
      c: 0, r: 0xC1 + i, n: 2, st1: i === 0 ? 0x20 : 0,
    }));
    const rest = Array.from({ length: 18 }, (_, t) => track(
      Array.from({ length: 9 }, (_, i) => sector({ c: t + 2, r: 0xC1 + i, n: 2 }))
    ));
    return image([track(t0sectors), null, ...rest]); // T1 unformatted
  }

  it('signed: signature on T0 sector index 2', () => {
    const img = paulOwensBase();
    // The signature contains a literal 0x80 byte — write it byte-by-byte
    // to avoid TextEncoder's UTF-8 multi-byte expansion.
    const sig = 'PAUL OWENS\x80PROTECTION SYS';
    const data = img.tracks[0][0]!.sectors[2].data;
    for (let i = 0; i < sig.length; i++) data[10 + i] = sig.charCodeAt(i);
    expect(detectProtection(img)).toBe('Paul Owens');
  });

  it('unsigned: T2 = 6 sectors × 256 bytes', () => {
    const img = paulOwensBase();
    img.tracks[2][0] = track(Array.from({ length: 6 }, (_, i) => sector({
      c: 2, r: 0xC1 + i, n: 1,
    })));
    expect(detectProtection(img)).toBe('Paul Owens (unsigned)');
  });

  it('rejects when T0 has != 9 sectors', () => {
    const img = paulOwensBase();
    img.tracks[0][0]!.sectors.pop();
    expect(detectProtection(img)).not.toContain('Paul Owens');
  });

  it('rejects when T1 is formatted (must be unformatted)', () => {
    const img = paulOwensBase();
    img.tracks[1][0] = track([sector({ c: 1, r: 0xC1, n: 2 })]);
    expect(detectProtection(img)).not.toContain('Paul Owens');
  });

  it('rejects when numTracks <= 10', () => {
    const t0sectors = Array.from({ length: 9 }, (_, i) => sector({
      c: 0, r: 0xC1 + i, n: 2, st1: i === 0 ? 0x20 : 0,
    }));
    const img = image([track(t0sectors), null, track([sector({ c: 2, r: 0xC1, n: 1 })])]);
    // numTracks = 3 → guard "> 10" fails.
    expect(detectProtection(img)).not.toContain('Paul Owens');
  });

  it('passes all guards but matches neither signature nor T2 layout (null fall-through)', () => {
    // Guards pass: T0=9 sectors, numTracks>10, T1 unformatted.
    // No signature on T0[2]; T2 has 5 sectors (not 6) so unsigned layout rejected.
    // Detector returns null and the result falls through to "Unknown".
    const img = paulOwensBase();
    img.tracks[2][0] = track(Array.from({ length: 5 }, (_, i) => sector({
      c: 2, r: 0xC1 + i, n: 1,
    })));
    expect(detectProtection(img)).not.toContain('Paul Owens');
  });
});

// ── Three Inch ────────────────────────────────────────────────────────────

describe('detectProtection — Three Inch Loader', () => {
  it('detects signature on any track / sector and reports location', () => {
    const img = cleanDisk(40);
    img.tracks[7][0] = track([
      sector({ c: 7, r: 0xC1, n: 2, st1: 0x20 }),
      sector({ c: 7, r: 0xC2, n: 2, data: 'Loader Copyright Three Inch Software 1988' }),
      ...Array.from({ length: 7 }, (_, i) => sector({ c: 7, r: 0xC3 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe('Three Inch Loader (T7/S1 +0)');
  });
});

// ── Frontier ──────────────────────────────────────────────────────────────

describe('detectProtection — Frontier', () => {
  // Real Frontier layout (confirmed from a CPDRead dump of an actual
  // protected disk): T0 is a normal PCW track of 9 × 512b sectors with
  // IDs 1-9; T1 through Tn-1 each contain exactly one 4096-byte sector
  // with ID=1. The published signature is "NEW DISK PROTECTION SYSTEM.
  // (C) 1990 BY NEW FRONTIER SOFT." — the previous detector's "W DISK
  // PROTECTION" was a typo that only worked as an accidental substring
  // match of "NEW".

  function frontierDisk(numTracks = 40): DskImage {
    const t0 = track(Array.from({ length: 9 }, (_, i) => sector({ c: 0, r: i + 1, n: 2 })));
    const rest = Array.from({ length: numTracks - 1 }, (_, i) => track([
      sector({ c: i + 1, r: 1, n: 5, size: 4096 }),
    ]));
    return image([t0, ...rest]);
  }

  it('unsigned: 40-track disk with T0=9×512b + T1..T39 each single 4096b R=1 (real disk layout)', () => {
    expect(detectProtection(frontierDisk(40))).toBe('Frontier (unsigned)');
  });

  it('signed: full "NEW DISK PROTECTION SYSTEM..." signature anywhere on disk', () => {
    const img = frontierDisk(40);
    const sig = 'NEW DISK PROTECTION SYSTEM. (C) 1990 BY NEW FRONTIER SOFT.';
    const data = img.tracks[15][0]!.sectors[0].data;
    for (let i = 0; i < sig.length; i++) data[100 + i] = sig.charCodeAt(i);
    expect(detectProtection(img)).toBe('Frontier (T15/S0 +100)');
  });

  it('rejects when numTracks <= 10', () => {
    expect(detectProtection(frontierDisk(10))).not.toContain('Frontier');
  });

  it('rejects when T0 is not a standard 9×512b PCW track', () => {
    const img = frontierDisk(40);
    img.tracks[0][0] = track(Array.from({ length: 9 }, (_, i) => sector({ c: 0, r: 0xC1 + i, n: 1 })));
    expect(detectProtection(img)).not.toContain('Frontier');
  });

  it('rejects when fewer than 10 tracks have the 1×4096b R=1 shape', () => {
    const t0 = track(Array.from({ length: 9 }, (_, i) => sector({ c: 0, r: i + 1, n: 2 })));
    const frontier = Array.from({ length: 9 }, (_, i) => track([
      sector({ c: i + 1, r: 1, n: 5, size: 4096 }),
    ]));
    const rest = Array.from({ length: 30 }, (_, i) => track(
      Array.from({ length: 9 }, (_, j) => sector({ c: i + 10, r: j + 1, n: 2 })),
    ));
    const img = image([t0, ...frontier, ...rest]);
    expect(detectProtection(img)).not.toContain('Frontier');
  });

  it('rejects when one of the protection tracks has wrong R (chain breaks)', () => {
    const img = frontierDisk(40);
    // T5's only sector becomes R=2. The chain counter breaks at 4 tracks,
    // below the threshold of 10.
    img.tracks[5][0]!.sectors[0].r = 2;
    img.tracks[5][0]!.sectorMap.clear();
    img.tracks[5][0]!.sectorMap.set(2, 0);
    expect(detectProtection(img)).not.toContain('Frontier');
  });

  it('does NOT misidentify a clean PCW disk that happens to have one 4096-byte sector elsewhere', () => {
    // This is the false-positive case the OLD heuristic was vulnerable to:
    // T0/S0 = 4096b plus a 1-sector T9. The new detector requires the
    // sustained T1..Tn pattern instead and must reject this disk.
    const t0 = track([
      sector({ c: 0, r: 0xC1, n: 5, size: 4096, st1: 0 }),
      sector({ c: 0, r: 0xC2, n: 2 }),
    ]);
    const t9 = track([sector({ c: 9, r: 0xC1, n: 2, st1: 0x20 })]);
    const others = Array.from({ length: 38 }, (_, i) => {
      const c = i < 8 ? i + 1 : i + 2;
      return track(Array.from({ length: 9 }, (_, j) => sector({ c, r: 0xC1 + j, n: 2 })));
    });
    const img = image([t0, ...others.slice(0, 8), t9, ...others.slice(8)]);
    expect(detectProtection(img)).not.toContain('Frontier');
  });
});

// ── P.M.S. ────────────────────────────────────────────────────────────────

describe('detectProtection — P.M.S.', () => {
  it.each([
    ['P.M.S. 1986',            '[C] P.M.S. 1986'],
    ['P.M.S. Loader 1986 v1',  'P.M.S. LOADER [C]1986'],
    ['P.M.S. Loader 1986 v2',  'P.M.S.LOADER [C]1986'],
    ['P.M.S. 1987',            'P.M.S.LOADER [C]1987'],
  ])('detects signed %s', (label, sig) => {
    const img = cleanDisk(40);
    img.tracks[0][0] = track([
      sector({ c: 0, r: 0xC1, n: 2, st1: 0x20, data: sig }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 0, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe(label);
  });

  it('unsigned: T0 formatted, T1 unformatted, T2 formatted, numTracks > 2', () => {
    const t0 = track(Array.from({ length: 9 }, (_, i) => sector({
      c: 0, r: 0xC1 + i, n: 2, st1: i === 0 ? 0x20 : 0,
    })));
    const t2 = track([sector({ c: 2, r: 0xC1, n: 2 })]);
    const img = image([t0, null, t2]);
    expect(detectProtection(img)).toBe('P.M.S. (unsigned)');
  });
});

// ── W.R.M ─────────────────────────────────────────────────────────────────

describe('detectProtection — W.R.M Disc Protection', () => {
  it('detects when T8 sector index 9 starts with "W.R.M Disc" and contains "Protection"', () => {
    const img = cleanDisk(40);
    const wrm = new Uint8Array(512);
    const sig = 'W.R.M Disc        Protection';
    for (let i = 0; i < sig.length; i++) wrm[i] = sig.charCodeAt(i);
    img.tracks[8][0] = track([
      ...Array.from({ length: 9 }, (_, i) => sector({ c: 8, r: 0xC1 + i, n: 2, st1: i === 0 ? 0x20 : 0 })),
      sector({ c: 8, r: 0xCA, n: 2, data: wrm }), // index 9
    ]);
    expect(detectProtection(img)).toBe('W.R.M Disc Protection');
  });

  it('requires "W.R.M Disc" at offset 0 exactly (not anywhere)', () => {
    const img = cleanDisk(40);
    const wrm = new Uint8Array(512);
    const sig = 'W.R.M Disc Protection';
    for (let i = 0; i < sig.length; i++) wrm[10 + i] = sig.charCodeAt(i); // shifted!
    img.tracks[8][0] = track([
      ...Array.from({ length: 9 }, (_, i) => sector({ c: 8, r: 0xC1 + i, n: 2, st1: i === 0 ? 0x20 : 0 })),
      sector({ c: 8, r: 0xCA, n: 2, data: wrm }),
    ]);
    expect(detectProtection(img)).not.toContain('W.R.M');
  });
});

// ── Amsoft / EXOPAL ───────────────────────────────────────────────────────

describe('detectProtection — Amsoft/EXOPAL', () => {
  it('detects when T3/S0 has 512-byte data containing both "Amsoft disc protection system" (offset > 1) and "EXOPAL"', () => {
    const img = cleanDisk(40);
    const data = new Uint8Array(512);
    const sig = 'Amsoft disc protection system EXOPAL';
    for (let i = 0; i < sig.length; i++) data[10 + i] = sig.charCodeAt(i);
    img.tracks[3][0] = track([
      sector({ c: 3, r: 0xC1, n: 2, st1: 0x20, data }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 3, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe('Amsoft/EXOPAL');
  });

  it('rejects when "Amsoft disc protection system" is at offset <= 1', () => {
    const img = cleanDisk(40);
    const data = new Uint8Array(512);
    const sig = 'Amsoft disc protection system EXOPAL';
    for (let i = 0; i < sig.length; i++) data[i] = sig.charCodeAt(i); // offset 0!
    img.tracks[3][0] = track([
      sector({ c: 3, r: 0xC1, n: 2, st1: 0x20, data }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 3, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).not.toContain('Amsoft');
  });

  it('rejects when T3/S0 is not 512 bytes', () => {
    const img = cleanDisk(40);
    const data = new Uint8Array(1024);
    const sig = 'Amsoft disc protection system EXOPAL';
    for (let i = 0; i < sig.length; i++) data[10 + i] = sig.charCodeAt(i);
    img.tracks[3][0] = track([
      sector({ c: 3, r: 0xC1, n: 3, st1: 0x20, data }),
      ...Array.from({ length: 4 }, (_, i) => sector({ c: 3, r: 0xC2 + i, n: 3 })),
    ]);
    expect(detectProtection(img)).not.toContain('Amsoft');
  });
});

// ── Studio B / DiscLoc ────────────────────────────────────────────────────

describe('detectProtection — Studio B / DiscLoc', () => {
  function studioBBase(t0sig?: string, t2sig?: string): DskImage {
    const t0 = track([
      sector({ c: 0, r: 0xC1, n: 2, st1: 0x20, data: t0sig }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 0, r: 0xC2 + i, n: 2 })),
    ]);
    const t2 = track([
      sector({ c: 2, r: 0xC1, n: 2, data: t2sig }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 2, r: 0xC2 + i, n: 2 })),
    ]);
    return image([t0, null, t2]); // numTracks=3, T1 unformatted
  }

  it('Studio B: T0 has "Disc format (c) 1986 Studio B Ltd."', () => {
    const img = studioBBase('Disc format (c) 1986 Studio B Ltd.');
    // numTracks must be > 3 per guard — extend.
    img.tracks.push([track([sector({ c: 3, r: 0xC1, n: 2 })])]);
    img.numTracks = 4;
    expect(detectProtection(img)).toBe('Studio B');
  });

  it('DiscLoc/Oddball: T2 has "DISCLOC"', () => {
    const img = studioBBase(undefined, 'DISCLOC magic stuff');
    img.tracks.push([track([sector({ c: 3, r: 0xC1, n: 2 })])]);
    img.numTracks = 4;
    expect(detectProtection(img)).toBe('DiscLoc/Oddball');
  });

  it('rejects when T1 is formatted (guard requires unformatted T1)', () => {
    const img = studioBBase('Disc format (c) 1986 Studio B Ltd.');
    img.tracks[1][0] = track([sector({ c: 1, r: 0xC1, n: 2 })]);
    img.tracks.push([track([sector({ c: 3, r: 0xC1, n: 2 })])]);
    img.numTracks = 4;
    expect(detectProtection(img)).not.toContain('Studio B');
  });
});

// ── ARMOURLOC ─────────────────────────────────────────────────────────────

describe('detectProtection — ARMOURLOC', () => {
  it('detects "0K free" at offset 2 of T0/S0 with 9-sector T0', () => {
    const img = cleanDisk(40);
    const data = new Uint8Array(512);
    data[0] = 0x20; data[1] = 0x20; // padding so '0K free' starts at offset 2
    const sig = '0K free';
    for (let i = 0; i < sig.length; i++) data[2 + i] = sig.charCodeAt(i);
    img.tracks[0][0] = track([
      sector({ c: 0, r: 0xC1, n: 2, st1: 0x20, data }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 0, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe('ARMOURLOC');
  });

  it('rejects when "0K free" is NOT at offset exactly 2', () => {
    const img = cleanDisk(40);
    const data = new Uint8Array(512);
    const sig = '0K free';
    for (let i = 0; i < sig.length; i++) data[5 + i] = sig.charCodeAt(i); // offset 5
    img.tracks[0][0] = track([
      sector({ c: 0, r: 0xC1, n: 2, st1: 0x20, data }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 0, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).not.toContain('ARMOURLOC');
  });
});

// ── Players / Infogrames / Rainbow Arts / DiscSYS ─────────────────────────

describe('detectProtection — Players', () => {
  it('detects 16 sectors with r===i && n===i', () => {
    const img = cleanDisk(40);
    img.tracks[5][0] = track(Array.from({ length: 16 }, (_, i) => sector({
      c: 5, r: i, n: i,
      size: i <= 7 ? 128 << i : 16384, st1: i === 0 ? 0x20 : 0,
    })));
    expect(detectProtection(img)).toBe('Players');
  });

  it('rejects when sector count is 15 (exact-16 guard)', () => {
    const img = cleanDisk(40);
    img.tracks[5][0] = track(Array.from({ length: 15 }, (_, i) => sector({
      c: 5, r: i, n: i, size: i <= 7 ? 128 << i : 16384, st1: i === 0 ? 0x20 : 0,
    })));
    expect(detectProtection(img)).not.toContain('Players');
  });
});

describe('detectProtection — DiscSYS', () => {
  it('detects 16 sectors with c, h, r, n all equal index', () => {
    const img = cleanDisk(40);
    img.tracks[5][0] = track(Array.from({ length: 16 }, (_, i) => sector({
      c: i, h: i, r: i, n: i,
      size: i <= 7 ? 128 << i : 16384, st1: i === 0 ? 0x20 : 0,
    })));
    expect(detectProtection(img)).toBe('DiscSYS');
  });

  it('a CHRN-all-equal-index disk reports DiscSYS, NOT Players (ordering regression)', () => {
    // DiscSYS is a strict superset of Players' check; without correct
    // ordering this disk would be misreported as "Players".
    const img = cleanDisk(40);
    img.tracks[5][0] = track(Array.from({ length: 16 }, (_, i) => sector({
      c: i, h: i, r: i, n: i,
      size: i <= 7 ? 128 << i : 16384, st1: i === 0 ? 0x20 : 0,
    })));
    expect(detectProtection(img)).toBe('DiscSYS');
  });
});

describe('detectProtection — Infogrames/Logiciel', () => {
  it('detects T39 having 9 sectors with a 540-byte N=2 sector', () => {
    const img = cleanDisk(45);
    img.tracks[39][0] = track([
      sector({ c: 39, r: 0xC1, n: 2, st1: 0x20 }),
      sector({ c: 39, r: 0xC2, n: 2, size: 540 }), // oversized
      ...Array.from({ length: 7 }, (_, i) => sector({ c: 39, r: 0xC3 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe('Infogrames/Logiciel');
  });

  it('rejects when numTracks <= 39 (guard)', () => {
    const img = cleanDisk(40);
    // numTracks=40 means index 39 exists; guard wants > 39 → 40 passes. So
    // test with 39 tracks explicitly.
    img.tracks.pop();
    img.numTracks = 39;
    expect(detectProtection(img)).not.toContain('Infogrames');
  });

  it('rejects when T39 has a non-540 N=2 sector', () => {
    const img = cleanDisk(45);
    img.tracks[39][0] = track([
      sector({ c: 39, r: 0xC1, n: 2, st1: 0x20 }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 39, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).not.toContain('Infogrames');
  });
});

describe('detectProtection — Rainbow Arts', () => {
  it('detects T40 having 9 sectors, one with R=0xC6 ST1=0x20 ST2=0x20', () => {
    const img = cleanDisk(45);
    img.tracks[40][0] = track([
      sector({ c: 40, r: 0xC1, n: 2 }),
      sector({ c: 40, r: 0xC6, n: 2, st1: 0x20, st2: 0x20 }),
      ...Array.from({ length: 7 }, (_, i) => sector({ c: 40, r: 0xC7 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe('Rainbow Arts');
  });

  it('rejects when numTracks <= 40', () => {
    const img = cleanDisk(40);
    expect(detectProtection(img)).not.toContain('Rainbow Arts');
  });
});

// ── Herbulot + KBI (non-exclusive combining) ─────────────────────────────

describe('detectProtection — Herbulot and KBI combinations', () => {
  function withHerbulot(img: DskImage) {
    const data = new Uint8Array(512);
    const sig = 'PROTECTION ... Remi HERBULOT';
    for (let i = 0; i < sig.length; i++) data[10 + i] = sig.charCodeAt(i);
    img.tracks[0][0]!.sectors[3].data = data;
  }

  it('Herbulot alone: signature anywhere on T0', () => {
    const img = cleanDisk(40);
    img.tracks[0][0]!.sectors[0].st1 = 0x20; // force non-uniform
    withHerbulot(img);
    expect(detectProtection(img)).toBe('ERE/Remi HERBULOT');
  });

  it('KBI-19 alone: any track with 19 sectors', () => {
    const img = cleanDisk(40);
    img.tracks[5][0] = track(Array.from({ length: 19 }, (_, i) => sector({
      c: 5, r: 0xC1 + i, n: 1, st1: i === 0 ? 0x20 : 0,
    })));
    expect(detectProtection(img)).toBe('KBI-19');
  });

  it('KBI-10: numTracks>=40, T38=9 sectors, T39=10 sectors, T39 s9 ST1=0x20 ST2=0x20', () => {
    const img = cleanDisk(40);
    img.tracks[38][0] = track(Array.from({ length: 9 }, (_, i) => sector({
      c: 38, r: 0xC1 + i, n: 2,
    })));
    img.tracks[39][0] = track([
      ...Array.from({ length: 9 }, (_, i) => sector({ c: 39, r: 0xC1 + i, n: 2, st1: i === 0 ? 0x20 : 0 })),
      sector({ c: 39, r: 0xCA, n: 2, st1: 0x20, st2: 0x20 }), // index 9
    ]);
    expect(detectProtection(img)).toBe('KBI-10');
  });

  it('combined: "KBI-19 + ERE/Remi HERBULOT" when both present', () => {
    const img = cleanDisk(40);
    withHerbulot(img);
    img.tracks[0][0]!.sectors[0].st1 = 0x20;
    img.tracks[5][0] = track(Array.from({ length: 19 }, (_, i) => sector({
      c: 5, r: 0xC1 + i, n: 1,
    })));
    expect(detectProtection(img)).toBe('KBI-19 + ERE/Remi HERBULOT');
  });
});
