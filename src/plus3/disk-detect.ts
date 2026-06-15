/**
 * Disk format and copy-protection detection for parsed DSK images.
 *
 * `detectDiskFormat` classifies the layout (PCW/+3, CPC, generic, etc.).
 *
 * `detectProtection` is a fingerprinting *flow* ported from dskmanager-rust
 * (src/protection.rs): it identifies every known CPC / ZX Spectrum +3
 * copy-protection scheme with the minimum number of reads, starting at track 0
 * and branching out only as far as needed:
 *
 *   T0 ASCII signatures → T0 geometry classification → per-class resolver →
 *   Track 1 checks → high-track probes → mid-disk sweep → stripped-FDC fallbacks.
 *
 * Speedlock is recognised by disk *geometry* (deleted-data marks, the 5×1024
 * data side, big weak sectors), not by an ASCII signature. Output is the bare
 * scheme name; CPC vs +3 is distinguished by the track-0 sector-ID base.
 */

import type { DskImage, DskTrack, DskSector } from './dsk.ts';

// ── Format detection ────────────────────────────────────────────────────────

export function detectDiskFormat(image: DskImage): string {
  const t0 = image.tracks[0]?.[0];
  if (!t0 || t0.sectors.length === 0) return 'Empty';

  const count = t0.sectors.length;
  const n = t0.sectors[0].n;
  const minR = Math.min(...t0.sectors.map(s => s.r));
  const ds = image.numSides === 2 ? ' DS' : '';

  // A flippy is two independent single-sided volumes merged into one image, so
  // classify it by a single side and tag it "two sides" rather than using the
  // double-sided " DS" suffix. Works for any per-side format (PCW/+3, CPC, …).
  if (isFlippyDisk(image)) {
    const sides = ' two sides';
    if (count === 9 && n === 2) {
      if (minR === 0x01) return 'PCW/+3' + sides;
      if (minR === 0xC1) return 'CPC Data' + sides;
      if (minR === 0x41) return 'CPC System' + sides;
    }
    if (count === 8 && n === 2 && minR === 0x01) return 'CPC IBM' + sides;
    const bytes = n <= 8 ? 128 << n : 0;
    return `${count}×${bytes}b` + sides;
  }

  if (count === 9 && n === 2) {
    if (minR === 0x01) return image.numSides === 2 ? 'PCW Double' : 'PCW/+3 Single';
    if (minR === 0xC1) return 'CPC Data' + ds;
    if (minR === 0x41) return 'CPC System' + ds;
  }

  // CPC IBM (CP/M 2.2 compatible): 8 sectors of 512b, IDs &01..&08.
  if (count === 8 && n === 2 && minR === 0x01) return 'CPC IBM' + ds;

  const bytes = n <= 8 ? 128 << n : 0;
  return `${count}×${bytes}b` + ds;
}

/**
 * A combined "flippy" disk: two independent single-sided volumes stored as
 * side 0 ("Side A") and side 1 ("Side B") of one DSK — a 3" disk you physically
 * turn over. Each side was formatted on its own as a head-0 disk, so EVERY
 * side-1 sector carries CHRN head byte 0. A genuine double-sided disk (one
 * filesystem interleaved across both heads, e.g. a 720K PCW or a +3DOS DS game)
 * instead formats side 1 with head byte 1. That per-sector head byte — not the
 * geometry or the +3DOS spec block — is the reliable signal, and it holds for
 * any per-side format (PCW/+3, CPC, 10×512, …).
 */
export function isFlippyDisk(image: DskImage): boolean {
  if (image.numSides !== 2) return false;
  const side0 = image.tracks[0]?.[0];
  const side1 = image.tracks[0]?.[1];
  if (!side0 || side0.sectors.length === 0) return false;
  if (!side1 || side1.sectors.length === 0) return false;
  return side1.sectors.every(sec => sec.h === 0);
}

// ── Sector / track helpers ──────────────────────────────────────────────────

/** Track from side 0 by cylinder index (null when unformatted/missing). */
function trk(image: DskImage, cyl: number): DskTrack | null {
  return image.tracks[cyl]?.[0] ?? null;
}

/** Stored sector size in bytes. */
function actualSize(s: DskSector): number {
  return s.data.length;
}

/** Size the CHRN advertises (128 << N). */
function advertisedSize(s: DskSector): number {
  return 128 << s.n;
}

/** Deleted-data address mark — FDC ST2 bit 6 (Control Mark). */
function isDeleted(s: DskSector): boolean {
  return (s.st2 & 0x40) !== 0;
}

/** Any non-zero FDC status = a read error / weak sector. */
function hasError(s: DskSector): boolean {
  return s.st1 !== 0 || s.st2 !== 0;
}

/** CPC disks number their sectors from &41 (System) or &C1 (Data); +3/PCW
 *  disks start at &01. */
function isCpcDisk(t0: DskTrack): boolean {
  const s0 = t0.sectors[0];
  return s0 ? s0.r >= 65 : false;
}

/** Common stored size if every sector matches, else null. */
function uniformSectorSize(track: DskTrack): number | null {
  if (track.sectors.length === 0) return null;
  const sz = track.sectors[0].data.length;
  return track.sectors.every(s => s.data.length === sz) ? sz : null;
}

/** Search for an ASCII pattern in a sector's data; -1 when absent. */
function findPattern(data: Uint8Array, pattern: string): number {
  const pLen = pattern.length;
  if (pLen === 0 || data.length < pLen) return -1;
  outer: for (let i = 0; i <= data.length - pLen; i++) {
    for (let j = 0; j < pLen; j++) {
      if (data[i + j] !== (pattern.charCodeAt(j) & 0xFF)) continue outer;
    }
    return i;
  }
  return -1;
}

function sectorContains(s: DskSector, pattern: string): boolean {
  return findPattern(s.data, pattern) >= 0;
}

/** First sector index on `track` whose data contains `pattern`, else -1. */
function contains(track: DskTrack, pattern: string): number {
  for (let i = 0; i < track.sectors.length; i++) {
    if (findPattern(track.sectors[i].data, pattern) >= 0) return i;
  }
  return -1;
}

function isUniform(image: DskImage): boolean {
  const t0 = trk(image, 0);
  if (!t0) return true;
  const sc = t0.sectors.length;
  const sz = uniformSectorSize(t0);
  for (let t = 1; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (!track) continue;
    if (track.sectors.length !== sc || uniformSectorSize(track) !== sz) return false;
  }
  return true;
}

function hasFdcErrors(image: DskImage): boolean {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (!track) continue;
    if (track.sectors.some(hasError)) return true;
  }
  return false;
}

/** 16 sectors whose C/H/R/N each equal the sector index (DiscSYS CHRN ramp). */
function isDiscsysTrack(track: DskTrack): boolean {
  if (track.sectors.length !== 16) return false;
  return track.sectors.every((s, i) => s.r === i && s.c === i && s.h === i && s.n === i);
}

/** 16 sectors whose R and N each equal the sector index (Players). */
function isPlayersTrack(track: DskTrack): boolean {
  if (track.sectors.length !== 16) return false;
  return track.sectors.every((s, i) => s.r === i && s.n === i);
}

// ── Step 1a: T0 signature scan ──────────────────────────────────────────────

function scanT0Signatures(t0: DskTrack): string | null {
  const s0 = t0.sectors[0];
  if (!s0) return null;

  if (sectorContains(s0, ' THE ALKATRAZ PROTECTION SYSTEM   (C) 1987  Appleby Associates')) {
    return 'Alkatraz +3';
  }

  const tiAddr = '***Loader Copyright Three Inch Software 1988, All Rights Reserved. Three Inch Software, 73 Surbiton Road, Kingston upon Thames, KT1 2HG***';
  const tiPhone = '***Loader Copyright Three Inch Software 1988, All Rights Reserved. 01-546 2754';

  if (sectorContains(s0, tiAddr)) return 'Three Inch Loader type 1';
  if (t0.sectors.length > 7 && t0.sectors[7] && sectorContains(t0.sectors[7], tiAddr)) {
    return 'Three Inch Loader type 1-0-7';
  }
  if (sectorContains(s0, tiPhone)) return 'Three Inch Loader type 2';

  if (t0.sectors.length > 2 && t0.sectors[2] &&
      sectorContains(t0.sectors[2], 'Laser Load   By C.J.Pink For Consult Computer    Systems')) {
    return 'Laser Load by C.J. Pink';
  }

  const pmsSigs: [string, string][] = [
    ['P.M.S. 1986', '[C] P.M.S. 1986'],
    ['P.M.S. Loader 1986 v1', 'P.M.S. LOADER [C]1986'],
    ['P.M.S. Loader 1986 v2', 'P.M.S.LOADER [C]1986'],
    ['P.M.S. 1987', 'P.M.S.LOADER [C]1987'],
  ];
  for (const [name, sig] of pmsSigs) {
    if (sectorContains(s0, sig)) return name;
  }

  if (t0.sectors.length > 6) {
    for (const s of t0.sectors) {
      if (sectorContains(s, 'PROTECTION      Remi HERBULOT')) return 'ERE/Remi HERBULOT';
      if (sectorContains(s, 'PROTECTION  V2.1Remi HERBULOT')) return 'ERE/Remi HERBULOT 2.1';
    }
  }

  if (t0.sectors.length === 9 && findPattern(s0.data, '0K free') === 2) {
    return 'ARMOURLOC';
  }

  if (sectorContains(s0, 'Disc format (c) 1986 Studio B Ltd.')) return 'Studio B Disc format';

  return null;
}

// ── Step 1b: T0 geometry classification ─────────────────────────────────────

type T0Class =
  | 'SpeedlockPlus3' | 'BigSector' | 'TenSector' | 'TenSectorDDAM'
  | 'EighteenSector' | 'SixteenSector' | 'NineteenSector' | 'EightSector'
  | 'FiveSector' | 'Speedlock9x512' | 'Standard';

function classifyT0(t0: DskTrack): T0Class {
  const sc = t0.sectors.length;

  // 10-sector cases first — more specific than the ≥7 + DDAM check below.
  if (sc === 10) {
    const s8 = t0.sectors[8];
    if (s8 && actualSize(s8) === 512) {
      return t0.sectors.some(isDeleted) ? 'TenSectorDDAM' : 'TenSector';
    }
  }

  if (sc >= 7 && t0.sectors.some(isDeleted)) return 'SpeedlockPlus3';

  if (sc === 1) {
    const s0 = t0.sectors[0];
    if (s0 && s0.n === 6 && s0.st1 === 0x20) return 'BigSector';
  }

  if (sc === 18) return 'EighteenSector';
  if (sc === 19) return 'NineteenSector';
  if (sc === 16) return 'SixteenSector';

  if (sc === 8 && t0.sectors.every(s => advertisedSize(s) === 512)) return 'EightSector';
  if (sc === 5 && t0.sectors.every(s => advertisedSize(s) === 1024)) return 'FiveSector';

  const hasHighIdFiller = t0.sectors.some(s => s.r >= 0x80 && s.r < 0xC1 && s.n === 2);
  const hasWeakUndersized = t0.sectors.some(s => s.n === 0 && ((s.st1 & 0x20) !== 0 || (s.st2 & 0x20) !== 0));
  if (hasHighIdFiller && hasWeakUndersized) return 'Speedlock9x512';

  return 'Standard';
}

// ── Step 1 resolvers ────────────────────────────────────────────────────────

/** T0 has deleted marks (Speedlock +3). */
function resolveSpeedlockPlus3(image: DskImage, t0: DskTrack): string | null {
  const t1 = trk(image, 1);
  if (t1 && t1.sectors.length === 5) {
    const t1s0 = t1.sectors[0];
    if (t1s0 && advertisedSize(t1s0) === 1024) {
      if (t0.sectors.length === 9) {
        const s6 = t0.sectors[6], s8 = t0.sectors[8];
        if (s6 && s8) {
          if (s6.st2 === 0x40 && s8.st2 === 0x00) return 'Speedlock +3 1987';
          if (s6.st2 === 0x40 && s8.st2 === 0x40) return 'Speedlock +3 1988';
        }
      }
      return 'Speedlock +3 1987/1988';
    }
  }
  return null;
}

/** T0 is 1 giant weak sector. */
function resolveBigSector(image: DskImage, t0: DskTrack): string {
  const cpc = isCpcDisk(t0);
  const t1 = trk(image, 1);
  if (t1 && t1.sectors.length === 1 && t1.sectors[0]?.st1 === 0x20) {
    return cpc ? 'Hexagon' : 'Speedlock 1989/1990';
  }
  return cpc ? 'Hexagon' : 'Speedlock 1989/1990';
}

/** T0 has 10 clean 512b sectors, no DDAM (Hexagon). */
function resolveHexagon(image: DskImage, t0: DskTrack): string | null {
  void t0;
  const limit = Math.min(4, image.numTracks);
  for (let t = 0; t < limit; t++) {
    const track = trk(image, t);
    if (!track) continue;
    for (const pattern of ['HEXAGON DISK PROTECTION c 1989', 'HEXAGON Disk Protection c 1989']) {
      if (contains(track, pattern) >= 0) return 'Hexagon';
    }
    if (track.sectors.length === 1) {
      const s0 = track.sectors[0];
      if (s0 && s0.n === 6 && s0.st1 === 0x20 && s0.st2 === 0x60) return 'Hexagon';
    }
  }
  return null;
}

/** T0 has 10 sectors with DDAM (Speedlock 1989 CPC). */
function resolveSpeedlock1989Cpc(image: DskImage, t0: DskTrack): string | null {
  const cpc = isCpcDisk(t0);
  const t1 = trk(image, 1);
  const bigT1 = !!(t1 && t1.sectors.length === 1 && t1.sectors[0]?.st1 === 0x20);
  if (cpc) return 'Speedlock 1989';
  if (bigT1) return 'Speedlock 1989/1990';
  return null;
}

/** T0 has 18 sectors (Alkatraz CPC). */
function resolve18sector(image: DskImage, t0: DskTrack): string {
  const s0 = t0.sectors[0];
  if (s0 && (actualSize(s0) === 256 || advertisedSize(s0) === 256)) return 'Alkatraz CPC';
  const t1 = trk(image, 1);
  if (t1 && t1.sectors[0]?.st2 === 0x40) return 'Alkatraz CPC';
  return '18-sector track';
}

/** T0 has 16 sectors (DiscSYS / Players / Mean PS). */
function resolve16sector(disk: DskImage, t0: DskTrack): string | null {
  if (isDiscsysTrack(t0)) {
    if (t0.sectors.some(s => sectorContains(s, 'MEAN PROTECTION SYSTEM'))) return 'Mean Protection System';
    return 'DiscSYS';
  }
  if (isPlayersTrack(t0)) {
    void disk;
    return 'Players';
  }
  return null;
}

/** T0 has 19 sectors (KBI-19 / CAAV). */
function resolve19sector(t0: DskTrack): string {
  if (t0.sectors.length > 1 && t0.sectors[1] && sectorContains(t0.sectors[1], '(c) 1986 for KBI ')) {
    return 'KBI-19';
  }
  if (t0.sectors[0] && sectorContains(t0.sectors[0], 'ALAIN LAURENT GENERATION 5 1989')) return 'CAAV';
  return 'KBI-19 or CAAV';
}

/** T0 has 8×512b sectors (unsigned Alkatraz +3 or CPC). */
function resolve8sector(image: DskImage, t0: DskTrack): string | null {
  const cpc = isCpcDisk(t0);
  const t1 = trk(image, 1);
  if (!t1) return null;

  if (t1.sectors.length === 8 && t1.sectors[0] && advertisedSize(t1.sectors[0]) === 512) {
    const limit = Math.min(image.numTracks, 42);
    for (let t = 2; t < limit; t++) {
      const ht = trk(image, t);
      if (!ht) continue;
      if (ht.sectors.length === 18) {
        const hs0 = ht.sectors[0];
        if (hs0 && (advertisedSize(hs0) === 256 || actualSize(hs0) === 256)) {
          return cpc ? 'Alkatraz CPC' : 'Alkatraz +3';
        }
        break;
      }
      if (ht.sectors.length === 8) continue;
      if (ht.sectors.length === 9) break;
    }
    if (cpc) return null;
    return 'Alkatraz +3';
  }
  return null;
}

/** T0 has 5×1024b sectors (unsigned Speedlock data side). */
function resolve5sector(image: DskImage, t0: DskTrack): string | null {
  const cpc = isCpcDisk(t0);
  const t1 = trk(image, 1);
  if (t1 && t1.sectors.length === 5 && t1.sectors[0] && advertisedSize(t1.sectors[0]) === 1024) {
    return cpc ? 'Speedlock (CPC)' : 'Speedlock +3 1987/1988';
  }
  return null;
}

/** Speedlock 9×512 variant: high-ID fillers + weak N=0 sector + DDAM payload. */
function resolveSpeedlock9x512(image: DskImage): string | null {
  const limit = Math.min(image.numTracks, 40);
  for (let t = 4; t < limit; t++) {
    const track = trk(image, t);
    if (track && track.sectors.some(isDeleted)) return 'Speedlock +3 1987';
  }
  return null;
}

// ── Step 2: Track 1 ─────────────────────────────────────────────────────────

/** T1 is empty (track-1-gap family). */
function resolveEmptyT1Family(image: DskImage, t0: DskTrack): string {
  const t2 = trk(image, 2);
  if (!t2) return 'P.M.S. Loader 1986/1987';

  const paulOwensSig = 'PAUL OWENS\x80PROTECTION SYS';
  if (t0.sectors.length === 9 && t0.sectors[2] && sectorContains(t0.sectors[2], paulOwensSig)) {
    return 'Paul Owens';
  }
  if (t2.sectors[0] && sectorContains(t2.sectors[0], 'DISCLOC')) return 'DiscLoc/Oddball';

  if (isDiscsysTrack(t2) && t0.sectors.some(s => sectorContains(s, 'MEAN PROTECTION SYSTEM'))) {
    return 'Mean Protection System';
  }

  if (t2.sectors.length === 6 && t2.sectors[0] && actualSize(t2.sectors[0]) === 256) {
    return 'Paul Owens';
  }

  return 'P.M.S. Loader 1986/1987';
}

/** T1 is 5×1024, T0 has no DDAM (Speedlock data side). */
function resolveSpeedlock5x1024(t0: DskTrack): string | null {
  if (t0.sectors.some(isDeleted)) return null;
  return isCpcDisk(t0) ? 'Speedlock (CPC)' : 'Speedlock +3 1987/1988';
}

/** T1 is 1 weak big sector. */
function resolveSpeedlock1989(t0: DskTrack): string {
  return isCpcDisk(t0) ? 'Hexagon' : 'Speedlock 1989/1990';
}

// ── Step 3: High-track probes ───────────────────────────────────────────────

function scanHighTracks(image: DskImage, t0: DskTrack): string | null {
  const tc = image.numTracks;

  if (tc > 3) {
    const t3s0 = trk(image, 3)?.sectors[0];
    if (t3s0 && actualSize(t3s0) === 512) {
      const off = findPattern(t3s0.data, 'Amsoft disc protection system');
      if (off > 1 && sectorContains(t3s0, 'EXOPAL')) return 'Amsoft/EXOPAL';
    }
  }

  if (tc > 9) {
    const t8 = trk(image, 8);
    const s9 = t8 && t8.sectors.length > 9 ? t8.sectors[9] : null;
    if (s9 && actualSize(s9) > 128 &&
        findPattern(s9.data, 'W.R.M Disc') === 0 &&
        sectorContains(s9, 'Protection') &&
        sectorContains(s9, 'System (c) 1987')) {
      return 'W.R.M Disc Protection';
    }
  }

  if (tc > 10) {
    const t9 = trk(image, 9);
    const t0s0 = t0.sectors[0];
    if (t9 && t9.sectors.length === 1 && t0s0 && actualSize(t0s0) === 4096 && t0s0.st1 === 0) {
      return 'Frontier';
    }
  }

  if (tc > 1) {
    const t1 = trk(image, 1);
    if (t1) {
      for (const s of t1.sectors) {
        if (sectorContains(s, 'NEW DISK PROTECTION SYSTEM. (C) 1990 BY NEW FRONTIER SOFT.')) {
          return 'Frontier';
        }
      }
      if (t1.sectors.length > 4 && t1.sectors[4] &&
          sectorContains(t1.sectors[4], 'Loader \x7F1988 Three Inch Software')) {
        return 'Three Inch Loader type 3-1-4';
      }
    }
  }

  if (tc >= 40) {
    const t38 = trk(image, 38), t39 = trk(image, 39);
    if (t39 && t38 && t39.sectors.length === 10 && t38.sectors.length === 9) {
      const s9 = t39.sectors[9];
      if (s9 && s9.st1 === 0x20 && s9.st2 === 0x20) return 'KBI-10';
    }
  }

  if (tc > 39) {
    const t39 = trk(image, 39);
    if (t39 && t39.sectors.length === 9) {
      for (const s of t39.sectors) {
        if (s.n === 2 && actualSize(s) === 540) return 'Infogrames/Logiciel';
      }
    }
  }

  if (tc > 40) {
    const t40 = trk(image, 40);
    if (t40 && t40.sectors.length === 9) {
      for (const s of t40.sectors) {
        if (s.r === 198 && s.st1 === 0x20 && s.st2 === 0x20) return 'Rainbow Arts';
      }
    }
  }

  return null;
}

// ── Step 4: Mid-disk sweep ──────────────────────────────────────────────────

function sweepMidDisk(image: DskImage, t0: DskTrack): string | null {
  const cpc = isCpcDisk(t0);
  const limit = Math.min(image.numTracks, 42);
  for (let t = 2; t < limit; t++) {
    const ht = trk(image, t);
    if (!ht || ht.sectors.length === 0 || ht.sectors.length === 9) continue;

    if (ht.sectors.length === 18) {
      const hs0 = ht.sectors[0];
      if (hs0 && (actualSize(hs0) === 256 || advertisedSize(hs0) === 256)) return 'Alkatraz CPC';
    }

    if (ht.sectors.length === 16) {
      if (isDiscsysTrack(ht)) return 'DiscSYS';
      if (isPlayersTrack(ht)) return 'Players';
    }

    if (ht.sectors.length === 19) {
      if (ht.sectors.length > 1 && ht.sectors[1] && sectorContains(ht.sectors[1], '(c) 1986 for KBI ')) {
        return 'KBI-19';
      }
      if (ht.sectors[0] && sectorContains(ht.sectors[0], 'ALAIN LAURENT GENERATION 5 1989')) return 'CAAV';
      return 'KBI-19 or CAAV';
    }

    if (ht.sectors.length === 5 && ht.sectors[0] && advertisedSize(ht.sectors[0]) === 1024) {
      return cpc ? 'Speedlock (CPC)' : 'Speedlock +3 1987/1988';
    }

    if (ht.sectors.length === 8 && ht.sectors[0] && advertisedSize(ht.sectors[0]) === 512 && !cpc) {
      return 'Alkatraz +3';
    }

    if (ht.sectors.length === 1) {
      const hs0 = ht.sectors[0];
      if (hs0 && hs0.n === 6 && hs0.st1 === 0x20) {
        return cpc ? 'Hexagon' : 'Speedlock 1989/1990';
      }
    }
  }
  return null;
}

// ── Stripped-FDC fallbacks ──────────────────────────────────────────────────

function strippedFdcFallbacks(image: DskImage, t0: DskTrack): string | null {
  if (hasFdcErrors(image)) return null;

  if (t0.sectors.length >= 8) {
    const t1 = trk(image, 1);
    if (t1 && t1.sectors.length === 5 && t1.sectors[0] && advertisedSize(t1.sectors[0]) === 1024) {
      return isCpcDisk(t0) ? 'Speedlock (CPC)' : 'Speedlock +3 1987/1988';
    }
  }

  if (t0.sectors.length >= 8 && image.numTracks > 40) {
    const t1 = trk(image, 1);
    if (t1 && t1.sectors.length === 1 && t1.sectors[0]?.n === 6) {
      return isCpcDisk(t0) ? 'Hexagon' : 'Speedlock 1989/1990';
    }
  }

  return null;
}

// ── Unknown-protection fallback ─────────────────────────────────────────────

function unknownFallback(image: DskImage): string | null {
  if (isUniform(image)) return null;

  let usedTracks = 0;
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (track && track.sectors.length > 0) usedTracks++;
  }
  const maxValid = Math.min(usedTracks, 40);
  const errorTracks: number[] = [];
  for (let t = 0; t < maxValid; t++) {
    const track = trk(image, t);
    if (track && track.sectors.some(hasError)) errorTracks.push(t);
  }
  if (errorTracks.length === 0) return null;

  // A lone error or two on the very last tracks of an otherwise-clean 9×512
  // disk is usually just dump noise, not a protection scheme.
  const loneHighError = errorTracks.length <= 2
    && errorTracks.every(t => t >= 35)
    && Array.from({ length: image.numTracks }, (_, i) => i).every(i => {
      const track = trk(image, i);
      if (!track || track.sectors.length === 0) return true;
      if (errorTracks.includes(i)) return true;
      return track.sectors.length === 9
        && uniformSectorSize(track) === 512
        && !track.sectors.some(isDeleted);
    });

  return loneHighError ? null : 'Unknown';
}

// ── Main detection ──────────────────────────────────────────────────────────

export function detectProtection(image: DskImage): string {
  if (image.numTracks < 2) return '';

  const t0 = trk(image, 0);
  if (!t0 || t0.sectors.length < 1) return '';
  const t0s0 = t0.sectors[0];
  if (actualSize(t0s0) < 128) return '';

  // A fully uniform, error-free disk is unprotected — unless its geometry is
  // exactly the unsigned Speedlock data side (5×1024) or unsigned Alkatraz +3
  // (8×512), which carry no FDC errors but still want resolving.
  if (isUniform(image) && !hasFdcErrors(image)) {
    const sc = t0.sectors.length;
    const sz = uniformSectorSize(t0);
    if (!((sc === 5 && sz === 1024) || (sc === 8 && sz === 512))) return 'None';
  }

  // ── Step 1a: T0 ASCII signatures ──
  const sig = scanT0Signatures(t0);
  if (sig) return sig;

  // ── Step 1b: classify T0 geometry → resolver ──
  switch (classifyT0(t0)) {
    case 'SpeedlockPlus3': { const r = resolveSpeedlockPlus3(image, t0); if (r) return r; break; }
    case 'BigSector':      return resolveBigSector(image, t0);
    case 'TenSector':      { const r = resolveHexagon(image, t0); if (r) return r; break; }
    case 'TenSectorDDAM':  { const r = resolveSpeedlock1989Cpc(image, t0); if (r) return r; break; }
    case 'EighteenSector': return resolve18sector(image, t0);
    case 'SixteenSector':  { const r = resolve16sector(image, t0); if (r) return r; break; }
    case 'NineteenSector': return resolve19sector(t0);
    case 'EightSector':    { const r = resolve8sector(image, t0); if (r) return r; break; }
    case 'FiveSector':     { const r = resolve5sector(image, t0); if (r) return r; break; }
    case 'Speedlock9x512': { const r = resolveSpeedlock9x512(image); if (r) return r; break; }
    case 'Standard':       break;
  }

  // ── Step 2: Track 1 ──
  const t1 = trk(image, 1);
  if (t1 === null || t1.sectors.length === 0) {
    return resolveEmptyT1Family(image, t0);
  }
  if (t1.sectors.length === 5 && t1.sectors[0] && advertisedSize(t1.sectors[0]) === 1024) {
    const r = resolveSpeedlock5x1024(t0);
    if (r) return r;
  }
  if (t1.sectors.length === 1 && t1.sectors[0]?.st1 === 0x20) {
    return resolveSpeedlock1989(t0);
  }
  if (t1.sectors.length === 16) {
    if (isDiscsysTrack(t1)) {
      if (t0.sectors.some(s => sectorContains(s, 'MEAN PROTECTION SYSTEM'))) return 'Mean Protection System';
      return 'DiscSYS';
    }
    if (isPlayersTrack(t1)) return 'Players';
  }

  // ── Step 3: High-track probes ──
  const high = scanHighTracks(image, t0);
  if (high) return high;

  // ── Step 4: Mid-disk sweep ──
  const mid = sweepMidDisk(image, t0);
  if (mid) return mid;

  // ── Stripped-FDC fallbacks ──
  const stripped = strippedFdcFallbacks(image, t0);
  if (stripped) return stripped;

  // ── Unknown-protection fallback ──
  return unknownFallback(image) ?? '';
}
