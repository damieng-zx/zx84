import { describe, it, expect } from 'vitest';
import { detectDiskFormat, detectProtection, isFlippyDisk } from '@/media/floppy/disk-detect.ts';
import type { DskImage, DskTrack, DskSector } from '@/media/floppy/disk-image.ts';

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
    for (let i = 0; i < o.data.length && i < size; i++) data[i] = o.data.charCodeAt(i) & 0xFF;
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

/** Clone a track with every sector's CHRN head byte set to `h`. */
function withHead(t: DskTrack | null, h: number): DskTrack | null {
  if (!t) return null;
  const sectors = t.sectors.map((s) => ({ ...s, h }));
  const sectorMap = new Map<number, number>();
  sectors.forEach((s, i) => sectorMap.set(s.r, i));
  return { ...t, sectors, sectorMap };
}

// A realistic multi-sided image: side s is formatted with CHRN head byte s, as a
// genuine double-sided disk records it. (Flippy disks differ — see flippyImage.)
function image(tracksBySide0: (DskTrack | null)[], numSides = 1): DskImage {
  const tracks = tracksBySide0.map((t) => {
    const sides: (DskTrack | null)[] = [t];
    for (let s = 1; s < numSides; s++) sides.push(withHead(t, s));
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

// A flippy image: two independent single-sided volumes, so BOTH sides keep
// CHRN head 0 (each side was formatted on its own as a head-0 disk).
function flippyImage(tracksBySide0: (DskTrack | null)[]): DskImage {
  return {
    format: 'extended',
    numTracks: tracksBySide0.length,
    numSides: 2,
    tracks: tracksBySide0.map((t) => [t, withHead(t, 0)]),
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

  it('PCW Double: genuine double-sided disk (side 1 uses head 1)', () => {
    // A real double-sided PCW disk is one interleaved filesystem, NOT a flippy.
    // The side-1 CHRN head byte (1, set by image()) is what separates them.
    const cyl = () => track(Array.from({ length: 9 }, (_, i) => sector({ r: i + 1, n: 2 })));
    const img = image(Array.from({ length: 80 }, cyl), 2);
    expect(detectDiskFormat(img)).toBe('PCW Double');
  });

  it('PCW/+3 two sides: 2-sided flippy disk (side 1 uses head 0)', () => {
    // Two independent single-sided sides packed into one DSK (a 3" disk turned
    // over). Both sides 9×512 from sector 1, side 1 formatted as head 0.
    const cyl = () => track(Array.from({ length: 9 }, (_, i) => sector({ r: i + 1, n: 2 })));
    const img = flippyImage(Array.from({ length: 40 }, cyl));
    expect(detectDiskFormat(img)).toBe('PCW/+3 two sides');
  });

  it('CPC Data two sides: flippy is not PCW-only — CPC per-side format too', () => {
    const cyl = () => track(Array.from({ length: 9 }, (_, i) => sector({ r: 0xC1 + i, n: 2 })));
    const img = flippyImage(Array.from({ length: 42 }, cyl));
    expect(detectDiskFormat(img)).toBe('CPC Data two sides');
  });

  it('10×512b two sides: flippy with a non-standard 10-sector per-side format', () => {
    const cyl = () => track(Array.from({ length: 10 }, (_, i) => sector({ r: i + 1, n: 2 })));
    const img = flippyImage(Array.from({ length: 42 }, cyl));
    expect(detectDiskFormat(img)).toBe('10×512b two sides');
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

  it('CPC IBM (SS): 8 sectors, N=2, minR=0x01 → CPC IBM', () => {
    const img = image([track(Array.from({ length: 8 }, (_, i) => sector({ r: 0x01 + i, n: 2 })))]);
    expect(detectDiskFormat(img)).toBe('CPC IBM');
  });

  it('CPC IBM DS: same layout, 2 sides → " DS" suffix', () => {
    const img = image([track(Array.from({ length: 8 }, (_, i) => sector({ r: 0x01 + i, n: 2 })))], 2);
    expect(detectDiskFormat(img)).toBe('CPC IBM DS');
  });

  it('rejects PCW/CPC label when sector count is not 9 and not IBM (falls to generic)', () => {
    const img = image([track(Array.from({ length: 8 }, (_, i) => sector({ r: 0x10 + i, n: 2 })))]);
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
    const img = image([track([sector({ r: 0xE0, n: 9, size: 128 })])]);
    expect(detectDiskFormat(img)).toBe('1×0b');
  });
});

// ── isFlippyDisk ──────────────────────────────────────────────────────────

describe('isFlippyDisk', () => {
  // The discriminator is the side-1 CHRN head byte: a flippy's second side was
  // formatted on its own as a head-0 disk (head 0); a genuine double-sided disk
  // records side 1 as head 1.
  const pcwCyl = () => track(Array.from({ length: 9 }, (_, i) => sector({ r: i + 1, n: 2 })));

  it('true when side 1 uses head 0 (two independent volumes)', () => {
    expect(isFlippyDisk(flippyImage(Array.from({ length: 40 }, pcwCyl)))).toBe(true);
  });

  it('true regardless of per-side format — CPC sides with head 0 are flippy', () => {
    const cpcCyl = () => track(Array.from({ length: 9 }, (_, i) => sector({ r: 0xC1 + i, n: 2 })));
    expect(isFlippyDisk(flippyImage(Array.from({ length: 42 }, cpcCyl)))).toBe(true);
  });

  it('false for a single-sided disk (only one side to read)', () => {
    expect(isFlippyDisk(image(Array.from({ length: 40 }, pcwCyl), 1))).toBe(false);
  });

  it('false for a genuine double-sided disk (side 1 uses head 1)', () => {
    expect(isFlippyDisk(image(Array.from({ length: 80 }, pcwCyl), 2))).toBe(false);
  });

  it('false when any side-1 sector still carries head 1', () => {
    // One stray head-1 sector on side 1 means it is not an independent head-0
    // volume — treat the whole disk as genuine double-sided.
    const img = flippyImage(Array.from({ length: 40 }, pcwCyl));
    img.tracks[0][1]!.sectors[3].h = 1;
    expect(isFlippyDisk(img)).toBe(false);
  });

  it('false when the second side is missing', () => {
    const img = flippyImage(Array.from({ length: 40 }, pcwCyl));
    for (const cyl of img.tracks) cyl[1] = null;
    expect(isFlippyDisk(img)).toBe(false);
  });
});

// ── detectProtection — guards / clean disks ──────────────────────────────

describe('detectProtection — guards and clean disks', () => {
  it('returns "" for numTracks < 2', () => {
    expect(detectProtection(image([track([sector({ r: 0xC1, n: 2 })])]))).toBe('');
  });

  it('returns "" when T0 has zero sectors', () => {
    expect(detectProtection(image([track([]), track([sector()])]))).toBe('');
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
});

// ── Step 1a: T0 ASCII signatures ─────────────────────────────────────────
//
// The uniform+clean short-circuit returns "None" before the signature scan, so
// these disks carry an FDC error on the signed sector to reach the scan.

/** cleanDisk(40) with `sig` planted (at byte 0) in T0 sector `idx`, flagged. */
function t0SigDisk(sig: string, idx = 0): DskImage {
  const img = cleanDisk(40);
  img.tracks[0][0]!.sectors[idx] = sector({ c: 0, r: 0x01 + idx, n: 2, st1: 0x20, data: sig });
  return img;
}

describe('detectProtection — T0 signatures', () => {
  it('Alkatraz +3: full signed T0/S0 string', () => {
    expect(detectProtection(t0SigDisk(' THE ALKATRAZ PROTECTION SYSTEM   (C) 1987  Appleby Associates')))
      .toBe('Alkatraz +3');
  });

  it('Three Inch Loader type 1: address signature on T0/S0', () => {
    const sig = '***Loader Copyright Three Inch Software 1988, All Rights Reserved. Three Inch Software, 73 Surbiton Road, Kingston upon Thames, KT1 2HG***';
    expect(detectProtection(t0SigDisk(sig))).toBe('Three Inch Loader type 1');
  });

  it('Three Inch Loader type 1-0-7: address signature on T0/S7 only', () => {
    const sig = '***Loader Copyright Three Inch Software 1988, All Rights Reserved. Three Inch Software, 73 Surbiton Road, Kingston upon Thames, KT1 2HG***';
    expect(detectProtection(t0SigDisk(sig, 7))).toBe('Three Inch Loader type 1-0-7');
  });

  it('Three Inch Loader type 2: phone signature on T0/S0', () => {
    const sig = '***Loader Copyright Three Inch Software 1988, All Rights Reserved. 01-546 2754';
    expect(detectProtection(t0SigDisk(sig))).toBe('Three Inch Loader type 2');
  });

  it('Laser Load: signature on T0/S2', () => {
    expect(detectProtection(t0SigDisk('Laser Load   By C.J.Pink For Consult Computer    Systems', 2)))
      .toBe('Laser Load by C.J. Pink');
  });

  it.each([
    ['P.M.S. 1986', '[C] P.M.S. 1986'],
    ['P.M.S. Loader 1986 v1', 'P.M.S. LOADER [C]1986'],
    ['P.M.S. Loader 1986 v2', 'P.M.S.LOADER [C]1986'],
    ['P.M.S. 1987', 'P.M.S.LOADER [C]1987'],
  ])('P.M.S. signature %s', (name, sig) => {
    expect(detectProtection(t0SigDisk(sig))).toBe(name);
  });

  it('ERE/Remi HERBULOT: signature anywhere on T0 (>6 sectors)', () => {
    expect(detectProtection(t0SigDisk('PROTECTION      Remi HERBULOT', 3))).toBe('ERE/Remi HERBULOT');
  });

  it('ARMOURLOC: "0K free" at offset 2 of T0/S0 (9-sector T0)', () => {
    const img = cleanDisk(40);
    const data = new Uint8Array(512);
    data[0] = 0x20; data[1] = 0x20;
    '0K free'.split('').forEach((ch, i) => { data[2 + i] = ch.charCodeAt(0); });
    img.tracks[0][0]!.sectors[0] = sector({ c: 0, r: 0x01, n: 2, st1: 0x20, data });
    expect(detectProtection(img)).toBe('ARMOURLOC');
  });

  it('Studio B Disc format: signature on T0/S0', () => {
    expect(detectProtection(t0SigDisk('Disc format (c) 1986 Studio B Ltd.'))).toBe('Studio B Disc format');
  });
});

// ── Step 1b: geometry resolvers ──────────────────────────────────────────

describe('detectProtection — Speedlock +3 (T0 DDAM + 5×1024 T1)', () => {
  function speedlockPlus3(s6st2: number, s8st2: number, t1n = 3): DskImage {
    const t0 = track(Array.from({ length: 9 }, (_, i) => sector({
      c: 0, r: 0xC1 + i, n: 2, st2: i === 6 ? s6st2 : i === 8 ? s8st2 : 0,
    })));
    const t1 = track(Array.from({ length: 5 }, (_, i) => sector({ c: 1, r: 0xD0 + i, n: t1n })));
    const rest = Array.from({ length: 38 }, (_, t) => track(
      Array.from({ length: 9 }, (_, i) => sector({ c: t + 2, r: 0xC1 + i, n: 2 }))));
    return image([t0, t1, ...rest]);
  }

  it('1987: s6 ST2=0x40, s8 ST2=0', () => {
    expect(detectProtection(speedlockPlus3(0x40, 0x00))).toBe('Speedlock +3 1987');
  });

  it('1988: s6 ST2=0x40, s8 ST2=0x40', () => {
    expect(detectProtection(speedlockPlus3(0x40, 0x40))).toBe('Speedlock +3 1988');
  });

  it('generic 1987/1988 when only s8 carries the DDAM', () => {
    expect(detectProtection(speedlockPlus3(0x00, 0x40))).toBe('Speedlock +3 1987/1988');
  });

  it('not Speedlock when T1 is not 1024-byte sectors', () => {
    // DDAM still classifies SpeedlockPlus3, but the 5×512 T1 fails the resolver;
    // the disk falls through to the unknown-error fallback (DDAM = FDC error on T0).
    expect(detectProtection(speedlockPlus3(0x40, 0x00, 2))).not.toContain('Speedlock +3 1987');
  });
});

describe('detectProtection — Speedlock data side (5×1024, no DDAM)', () => {
  it('+3: uniform 5×1024 T0 and T1', () => {
    const t = (c: number) => track(Array.from({ length: 5 }, (_, i) => sector({ c, r: 0x01 + i, n: 3 })));
    const img = image(Array.from({ length: 10 }, (_, c) => t(c)));
    expect(detectProtection(img)).toBe('Speedlock +3 1987/1988');
  });

  it('CPC: same layout but CPC sector IDs', () => {
    const t = (c: number) => track(Array.from({ length: 5 }, (_, i) => sector({ c, r: 0xC1 + i, n: 3 })));
    const img = image(Array.from({ length: 10 }, (_, c) => t(c)));
    expect(detectProtection(img)).toBe('Speedlock (CPC)');
  });
});

describe('detectProtection — Speedlock 1989/1990 (big weak T1)', () => {
  it('+3: standard T0 (PCW IDs) + single weak big sector on T1', () => {
    const t0 = track(Array.from({ length: 9 }, (_, i) => sector({ c: 0, r: 0x01 + i, n: 2 })));
    const t1 = track([sector({ c: 1, r: 0x01, n: 6, st1: 0x20 })]);
    const rest = Array.from({ length: 39 }, (_, t) => track(
      Array.from({ length: 9 }, (_, i) => sector({ c: t + 2, r: 0x01 + i, n: 2 }))));
    expect(detectProtection(image([t0, t1, ...rest]))).toBe('Speedlock 1989/1990');
  });

  it('CPC: a 9×512 + big-weak-T1 layout reports Hexagon, not Speedlock', () => {
    const t0 = track(Array.from({ length: 9 }, (_, i) => sector({ c: 0, r: 0xC1 + i, n: 2 })));
    const t1 = track([sector({ c: 1, r: 0xC1, n: 6, st1: 0x20 })]);
    const rest = Array.from({ length: 39 }, (_, t) => track(
      Array.from({ length: 9 }, (_, i) => sector({ c: t + 2, r: 0xC1 + i, n: 2 }))));
    expect(detectProtection(image([t0, t1, ...rest]))).toBe('Hexagon');
  });
});

describe('detectProtection — Hexagon', () => {
  function hexT0(sig?: string): DskTrack {
    return track(Array.from({ length: 10 }, (_, i) => sector({
      c: 0, r: 0xC1 + i, n: 2, st1: i === 0 ? 0x20 : 0, data: i === 0 ? sig : undefined,
    })));
  }

  it.each([
    'HEXAGON DISK PROTECTION c 1989',
    'HEXAGON Disk Protection c 1989',
  ])('signed: %s on a 10-sector T0', (sig) => {
    const img = cleanDisk(10);
    img.tracks[0][0] = hexT0(sig);
    expect(detectProtection(img)).toBe('Hexagon');
  });

  it('unsigned: 10-sector T0, plus a single N=6 weak sector (ST1=0x20 ST2=0x60)', () => {
    const img = cleanDisk(10);
    img.tracks[0][0] = hexT0();
    img.tracks[2][0] = track([sector({ c: 2, r: 0xC1, n: 6, st1: 0x20, st2: 0x60 })]);
    expect(detectProtection(img)).toBe('Hexagon');
  });
});

describe('detectProtection — Speedlock 1989 (10-sector DDAM, CPC)', () => {
  it('CPC 10-sector T0 with a deleted-data sector', () => {
    const t0 = track(Array.from({ length: 10 }, (_, i) => sector({
      c: 0, r: 0xC1 + i, n: 2, st2: i === 5 ? 0x40 : 0, size: 512,
    })));
    const rest = Array.from({ length: 5 }, (_, t) => track(
      Array.from({ length: 9 }, (_, i) => sector({ c: t + 1, r: 0xC1 + i, n: 2 }))));
    expect(detectProtection(image([t0, ...rest]))).toBe('Speedlock 1989');
  });
});

describe('detectProtection — Alkatraz (geometry)', () => {
  it('18-sector T0 with 256-byte sectors → Alkatraz CPC', () => {
    const img = cleanDisk(40, 0xC1);
    img.tracks[0][0] = track(Array.from({ length: 18 }, (_, i) => sector({ c: 0, r: 0xC1 + i, n: 1 })));
    expect(detectProtection(img)).toBe('Alkatraz CPC');
  });

  it('8×512 data + 18×256 protection track later → Alkatraz +3', () => {
    const t0 = track(Array.from({ length: 8 }, (_, i) => sector({ c: 0, r: 0x01 + i, n: 2 })));
    const t1 = track(Array.from({ length: 8 }, (_, i) => sector({ c: 1, r: 0x01 + i, n: 2 })));
    const prot = track(Array.from({ length: 18 }, (_, i) => sector({ c: 5, r: 0x01 + i, n: 1 })));
    const data = (c: number) => track(Array.from({ length: 8 }, (_, i) => sector({ c, r: 0x01 + i, n: 2 })));
    const img = image([t0, t1, data(2), data(3), data(4), prot, data(6), data(7), data(8), data(9)]);
    expect(detectProtection(img)).toBe('Alkatraz +3');
  });

  it('mid-disk 18×256 on a CPC disk → Alkatraz CPC', () => {
    const img = cleanDisk(40, 0xC1);
    img.tracks[5][0] = track(Array.from({ length: 18 }, (_, i) => sector({ c: 5, r: 0xC1 + i, n: 1 })));
    expect(detectProtection(img)).toBe('Alkatraz CPC');
  });
});

describe('detectProtection — DiscSYS / Players / Mean', () => {
  function ramp16(): DskTrack {
    return track(Array.from({ length: 16 }, (_, i) => sector({
      c: i, h: i, r: i, n: i, size: i <= 7 ? 128 << i : 16384,
    })));
  }

  it('DiscSYS: 16-sector CHRN ramp on T0', () => {
    const img = cleanDisk(40);
    img.tracks[0][0] = ramp16();
    expect(detectProtection(img)).toBe('DiscSYS');
  });

  it('Mean Protection System: DiscSYS ramp + "MEAN PROTECTION SYSTEM" on T0', () => {
    const t0 = ramp16();
    t0.sectors[2] = sector({ c: 2, h: 2, r: 2, n: 2, size: 512, data: 'MEAN PROTECTION SYSTEM' });
    const img = cleanDisk(40);
    img.tracks[0][0] = t0;
    // ramp must stay valid for r/c/h/n==index — keep sector 2's CHRN.
    expect(detectProtection(img)).toBe('Mean Protection System');
  });

  it('Players: 16 sectors with R==N==index (not full CHRN ramp)', () => {
    const img = cleanDisk(40);
    img.tracks[5][0] = track(Array.from({ length: 16 }, (_, i) => sector({
      c: 5, r: i, n: i, size: i <= 7 ? 128 << i : 16384,
    })));
    expect(detectProtection(img)).toBe('Players');
  });
});

describe('detectProtection — KBI / CAAV (19-sector)', () => {
  it('KBI-19 signature on a 19-sector T0', () => {
    const sectors = Array.from({ length: 19 }, (_, i) => sector({ c: 0, r: 0xC1 + i, n: 1 }));
    sectors[1] = sector({ c: 0, r: 0xC2, n: 1, data: '(c) 1986 for KBI ' });
    const img = image([track(sectors), track([sector({ c: 1, r: 0xC1, n: 2 })])]);
    expect(detectProtection(img)).toBe('KBI-19');
  });

  it('CAAV signature on a 19-sector T0', () => {
    const sectors = Array.from({ length: 19 }, (_, i) => sector({ c: 0, r: 0xC1 + i, n: 1 }));
    sectors[0] = sector({ c: 0, r: 0xC1, n: 1, data: 'ALAIN LAURENT GENERATION 5 1989' });
    const img = image([track(sectors), track([sector({ c: 1, r: 0xC1, n: 2 })])]);
    expect(detectProtection(img)).toBe('CAAV');
  });

  it('unsigned 19-sector T0 → "KBI-19 or CAAV"', () => {
    const sectors = Array.from({ length: 19 }, (_, i) => sector({ c: 0, r: 0xC1 + i, n: 1 }));
    const img = image([track(sectors), track([sector({ c: 1, r: 0xC1, n: 2 })])]);
    expect(detectProtection(img)).toBe('KBI-19 or CAAV');
  });
});

// ── Step 2: Track 1 family ───────────────────────────────────────────────

describe('detectProtection — empty-T1 family', () => {
  function emptyT1Base(): DskImage {
    const t0 = track(Array.from({ length: 9 }, (_, i) => sector({ c: 0, r: 0xC1 + i, n: 2, st1: i === 0 ? 0x20 : 0 })));
    const rest = Array.from({ length: 18 }, (_, t) => track(
      Array.from({ length: 9 }, (_, i) => sector({ c: t + 2, r: 0xC1 + i, n: 2 }))));
    return image([t0, null, ...rest]); // T1 unformatted
  }

  it('Paul Owens: signature on T0/S2', () => {
    const img = emptyT1Base();
    const data = img.tracks[0][0]!.sectors[2].data;
    const sig = 'PAUL OWENS\x80PROTECTION SYS';
    for (let i = 0; i < sig.length; i++) data[10 + i] = sig.charCodeAt(i) & 0xFF;
    expect(detectProtection(img)).toBe('Paul Owens');
  });

  it('Paul Owens unsigned: T2 = 6×256', () => {
    const img = emptyT1Base();
    img.tracks[2][0] = track(Array.from({ length: 6 }, (_, i) => sector({ c: 2, r: 0xC1 + i, n: 1 })));
    expect(detectProtection(img)).toBe('Paul Owens');
  });

  it('DiscLoc/Oddball: "DISCLOC" on T2/S0', () => {
    const img = emptyT1Base();
    img.tracks[2][0]!.sectors[0] = sector({ c: 2, r: 0xC1, n: 2, data: 'DISCLOC magic' });
    expect(detectProtection(img)).toBe('DiscLoc/Oddball');
  });

  it('falls back to P.M.S. Loader 1986/1987 when nothing else matches', () => {
    expect(detectProtection(emptyT1Base())).toBe('P.M.S. Loader 1986/1987');
  });
});

// ── Step 3: high-track probes ────────────────────────────────────────────

describe('detectProtection — high-track probes', () => {
  it('Amsoft/EXOPAL: T3/S0 with both signatures (offset > 1)', () => {
    const img = cleanDisk(40);
    const data = new Uint8Array(512);
    'Amsoft disc protection system EXOPAL'.split('').forEach((ch, i) => { data[10 + i] = ch.charCodeAt(0); });
    img.tracks[3][0] = track([
      sector({ c: 3, r: 0xC1, n: 2, st1: 0x20, data }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 3, r: 0xC2 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe('Amsoft/EXOPAL');
  });

  it('W.R.M Disc Protection: T8/S9 starts with "W.R.M Disc" + markers', () => {
    const img = cleanDisk(40);
    const wrm = new Uint8Array(512);
    'W.R.M Disc Protection System (c) 1987'.split('').forEach((ch, i) => { wrm[i] = ch.charCodeAt(0); });
    img.tracks[8][0] = track([
      ...Array.from({ length: 9 }, (_, i) => sector({ c: 8, r: 0xC1 + i, n: 2, st1: i === 0 ? 0x20 : 0 })),
      sector({ c: 8, r: 0xCA, n: 2, data: wrm }),
    ]);
    expect(detectProtection(img)).toBe('W.R.M Disc Protection');
  });

  it('Frontier: signed "NEW DISK PROTECTION SYSTEM..." on a normal-geometry T1', () => {
    // A 1-sector weak T1 would be caught as Speedlock in Step 2; the Frontier
    // signature scan (Step 3) only reaches a T1 that passes through Step 2, so
    // give T1 a normal 9-sector geometry with the signature in one sector.
    const t0 = track(Array.from({ length: 9 }, (_, i) => sector({ c: 0, r: i + 1, n: 2 })));
    const t1 = track([
      sector({ c: 1, r: 1, n: 2, st1: 0x20, data: 'NEW DISK PROTECTION SYSTEM. (C) 1990 BY NEW FRONTIER SOFT.' }),
      ...Array.from({ length: 8 }, (_, i) => sector({ c: 1, r: 2 + i, n: 2 })),
    ]);
    const rest = Array.from({ length: 18 }, (_, t) => track(
      Array.from({ length: 9 }, (_, i) => sector({ c: t + 2, r: i + 1, n: 2 }))));
    expect(detectProtection(image([t0, t1, ...rest]))).toBe('Frontier');
  });

  it('Frontier: unsigned T0=4096 single sector + T9 single-sector', () => {
    const t0 = track([sector({ c: 0, r: 0x01, n: 5, size: 4096, st1: 0 })]);
    const filler = (c: number) => track(Array.from({ length: 9 }, (_, i) => sector({ c, r: 0xC1 + i, n: 2 })));
    const tracks: (DskTrack | null)[] = [t0];
    for (let t = 1; t < 11; t++) tracks.push(t === 9 ? track([sector({ c: 9, r: 0x01, n: 2 })]) : filler(t));
    expect(detectProtection(image(tracks))).toBe('Frontier');
  });

  it('KBI-10: T38=9 sectors, T39=10 sectors with weak S9 (ST1=ST2=0x20)', () => {
    const img = cleanDisk(40);
    img.tracks[38][0] = track(Array.from({ length: 9 }, (_, i) => sector({ c: 38, r: 0xC1 + i, n: 2 })));
    img.tracks[39][0] = track([
      ...Array.from({ length: 9 }, (_, i) => sector({ c: 39, r: 0xC1 + i, n: 2, st1: i === 0 ? 0x20 : 0 })),
      sector({ c: 39, r: 0xCA, n: 2, st1: 0x20, st2: 0x20 }),
    ]);
    expect(detectProtection(img)).toBe('KBI-10');
  });

  it('Infogrames/Logiciel: T39 9 sectors with a 540-byte N=2 sector', () => {
    const img = cleanDisk(45);
    img.tracks[39][0] = track([
      sector({ c: 39, r: 0xC1, n: 2, st1: 0x20 }),
      sector({ c: 39, r: 0xC2, n: 2, size: 540 }),
      ...Array.from({ length: 7 }, (_, i) => sector({ c: 39, r: 0xC3 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe('Infogrames/Logiciel');
  });

  it('Rainbow Arts: T40 with a weak sector R=198 (ST1=ST2=0x20)', () => {
    const img = cleanDisk(45);
    img.tracks[40][0] = track([
      sector({ c: 40, r: 0xC1, n: 2 }),
      sector({ c: 40, r: 198, n: 2, st1: 0x20, st2: 0x20 }),
      ...Array.from({ length: 7 }, (_, i) => sector({ c: 40, r: 0xC7 + i, n: 2 })),
    ]);
    expect(detectProtection(img)).toBe('Rainbow Arts');
  });
});

// ── Unknown-protection fallback ──────────────────────────────────────────

describe('detectProtection — unknown fallback', () => {
  it('"Unknown" for a non-uniform disk with an FDC error on a low track', () => {
    const img = cleanDisk(40);
    // Error on T2 (well below the high-track lone-error window) + odd geometry.
    img.tracks[2][0] = track([
      sector({ c: 2, r: 0xC1, n: 2, st1: 0x20 }),
      sector({ c: 2, r: 0xC2, n: 2 }),
    ]);
    expect(detectProtection(img)).toBe('Unknown');
  });

  it('"" for a non-uniform disk with NO FDC errors and no detector match', () => {
    const img = cleanDisk(40);
    img.tracks[39][0] = track([sector({ c: 39, r: 0xC1, n: 2 })]); // 1 sector, no errors
    expect(detectProtection(img)).toBe('');
  });

  it('"" for a lone error on a high track of an otherwise-clean disk (dump noise)', () => {
    const img = cleanDisk(40);
    img.tracks[39][0] = track([
      sector({ c: 39, r: 0xC1, n: 2, st1: 0x20 }),
      sector({ c: 39, r: 0xC2, n: 2 }),
    ]);
    expect(detectProtection(img)).toBe('');
  });
});
