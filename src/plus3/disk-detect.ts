/**
 * Disk format and copy-protection detection for parsed DSK images.
 *
 * Both detectors operate on an already-parsed `DskImage`. `detectDiskFormat`
 * classifies the layout (PCW/+3, CPC, generic, etc.); `detectProtection`
 * identifies known +3/CPC copy-protection schemes by signature, layout
 * heuristic, or FDC error pattern. Ported from dskmanager-rust.
 */

import type { DskImage, DskTrack } from './dsk.ts';

// ── Format detection ────────────────────────────────────────────────────────

export function detectDiskFormat(image: DskImage): string {
  const t0 = image.tracks[0]?.[0];
  if (!t0 || t0.sectors.length === 0) return 'Empty';

  const count = t0.sectors.length;
  const n = t0.sectors[0].n;
  const minR = Math.min(...t0.sectors.map(s => s.r));
  const ds = image.numSides === 2 ? ' DS' : '';

  if (count === 9 && n === 2) {
    if (minR === 0x01) return image.numSides === 2 ? 'PCW Double' : 'PCW/+3 Single';
    if (minR === 0xC1) return 'CPC Data' + ds;
    if (minR === 0x41) return 'CPC System' + ds;
  }

  const bytes = n <= 8 ? 128 << n : 0;
  return `${count}×${bytes}b` + ds;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Get track from side 0 by cylinder index. */
function trk(image: DskImage, cyl: number): DskTrack | null {
  return image.tracks[cyl]?.[0] ?? null;
}

/** Search for an ASCII pattern in a Uint8Array. */
function findPattern(data: Uint8Array, pattern: string): number {
  const pLen = pattern.length;
  if (pLen === 0 || data.length < pLen) return -1;
  outer: for (let i = 0; i <= data.length - pLen; i++) {
    for (let j = 0; j < pLen; j++) {
      if (data[i + j] !== pattern.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/** Search for a pattern across all sectors on side 0. */
function findSignatureInDisk(image: DskImage, pattern: string): string | null {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (!track) continue;
    for (let s = 0; s < track.sectors.length; s++) {
      const off = findPattern(track.sectors[s].data, pattern);
      if (off >= 0) return `T${t}/S${s} +${off}`;
    }
  }
  return null;
}

function isUniform(image: DskImage): boolean {
  const t0 = trk(image, 0);
  if (!t0) return true;
  const count = t0.sectors.length;
  const size = t0.sectors[0]?.data.length ?? 0;
  for (let t = 1; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (!track) continue;
    if (track.sectors.length !== count) return false;
    if (track.sectors[0]?.data.length !== size) return false;
  }
  return true;
}

function hasFdcErrors(image: DskImage): boolean {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (!track) continue;
    for (const s of track.sectors) {
      if (s.st1 !== 0 || s.st2 !== 0) return true;
    }
  }
  return false;
}

// ── Individual detectors ────────────────────────────────────────────────────

type Detector = (image: DskImage) => string | null;

const detectSpeedlock: Detector = (image) => {
  const sigs: [string, string][] = [
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
  for (const [name, pat] of sigs) {
    const loc = findSignatureInDisk(image, pat);
    if (loc) return `${name} (${loc})`;
  }
  // Unsigned Speedlock +3: T0=9 sectors, T1=5×1024b
  const t0 = trk(image, 0), t1 = trk(image, 1);
  if (t0?.sectors.length === 9 && t1?.sectors.length === 5 && t1.sectors[0]?.data.length === 1024) {
    const s6 = t0.sectors[6], s8 = t0.sectors[8];
    if (s6?.st2 === 0x40 && s8?.st2 === 0) return 'Speedlock +3 1987';
    if (s6?.st2 === 0x40 && s8?.st2 === 0x40) return 'Speedlock +3 1988';
  }
  // Unsigned Speedlock 1989/1990
  if (t0 && t0.sectors.length > 7 && image.numTracks > 40 && t1?.sectors.length === 1) {
    const s = t1.sectors[0];
    if (s.r === 0xC1 && s.st1 === 0x20) return 'Speedlock 1989/1990';
  }
  return null;
};

const detectAlkatraz: Detector = (image) => {
  const t0 = trk(image, 0);
  if (!t0?.sectors[0]) return null;
  if (findPattern(t0.sectors[0].data, ' THE ALKATRAZ PROTECTION SYSTEM') >= 0) return 'Alkatraz +3';
  for (let t = 0; t < image.numTracks - 1; t++) {
    const track = trk(image, t);
    if (track?.sectors.length === 18 && track.sectors[0].data.length === 256) return 'Alkatraz CPC';
  }
  return null;
};

const detectHexagon: Detector = (image) => {
  const t0 = trk(image, 0);
  // Guard: T0 must have 10 sectors, 9th sector (index 8) must be 512 bytes, and disk must have > 2 tracks
  if (!t0 || t0.sectors.length !== 10 || image.numTracks <= 2) return null;
  if (t0.sectors[8]?.data.length !== 512) return null;
  let unsigned: string | null = null;
  for (let t = 0; t < Math.min(4, image.numTracks); t++) {
    const track = trk(image, t);
    if (!track) continue;
    for (let s = 0; s < track.sectors.length; s++) {
      const sec = track.sectors[s];
      if (findPattern(sec.data, 'HEXAGON DISK PROTECTION c 1989') >= 0) return `Hexagon (T${t}/S${s})`;
      if (findPattern(sec.data, 'HEXAGON Disk Protection c 1989') >= 0) return `Hexagon (T${t}/S${s})`;
    }
    // Unsigned: single-sector track with N=6, ST1=0x20, ST2=0x60
    if (track.sectors.length === 1) {
      const s = track.sectors[0];
      if (s.n === 6 && s.st1 === 0x20 && s.st2 === 0x60) unsigned = 'Hexagon (unsigned)';
    }
  }
  return unsigned;
};

const detectPaulOwens: Detector = (image) => {
  const t0 = trk(image, 0);
  // Guard: T0 must have 9 sectors, disk must have > 10 tracks, T1 must be unformatted
  if (!t0 || t0.sectors.length !== 9 || image.numTracks <= 10) return null;
  if (trk(image, 1) !== null) return null;
  if (t0.sectors[2] && findPattern(t0.sectors[2].data, 'PAUL OWENS\x80PROTECTION SYS') >= 0) return 'Paul Owens';
  const t2 = trk(image, 2);
  if (t2?.sectors.length === 6 && t2.sectors[0]?.data.length === 256) return 'Paul Owens (unsigned)';
  return null;
};

const detectThreeInch: Detector = (image) => {
  const sig = 'Loader Copyright Three Inch Software 1988';
  const loc = findSignatureInDisk(image, sig);
  if (loc) return `Three Inch Loader (${loc})`;
  return null;
};

const detectFrontier: Detector = (image) => {
  if (image.numTracks <= 10) return null;

  // Signed: signature appears somewhere on the disk. The full string is
  // "NEW DISK PROTECTION SYSTEM. (C) 1990 BY NEW FRONTIER SOFT." — search
  // the whole side rather than only T1, since the protection code lands on
  // whichever track the game's loader put it on.
  const sigLoc = findSignatureInDisk(image, 'NEW DISK PROTECTION SYSTEM. (C) 1990 BY NEW FRONTIER SOFT.');
  if (sigLoc) return `Frontier (${sigLoc})`;

  // Unsigned: T0 is a normal PCW track (9 × 512b sectors), and every
  // subsequent track is a single 4096-byte sector with R=1. We require
  // a substantial run (>= 10 tracks) of that shape to avoid matching
  // one-off oversized sectors used for incidental copy protection on
  // disks that aren't actually Frontier-protected.
  const t0 = trk(image, 0);
  if (!t0 || t0.sectors.length !== 9) return null;
  if (t0.sectors.some(s => s.n !== 2 || s.data.length !== 512)) return null;

  let frontierTracks = 0;
  for (let t = 1; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (!track || track.sectors.length !== 1) break;
    const s = track.sectors[0];
    if (s.r !== 1 || s.n !== 5 || s.data.length !== 4096) break;
    frontierTracks++;
  }
  if (frontierTracks >= 10) return 'Frontier (unsigned)';
  return null;
};

const detectPms: Detector = (image) => {
  const t0s0 = trk(image, 0)?.sectors[0];
  if (!t0s0) return null;
  const sigs: [string, string][] = [
    ['P.M.S. 1986',          '[C] P.M.S. 1986'],
    ['P.M.S. Loader 1986 v1', 'P.M.S. LOADER [C]1986'],   // with space
    ['P.M.S. Loader 1986 v2', 'P.M.S.LOADER [C]1986'],    // no space
    ['P.M.S. 1987',           'P.M.S.LOADER [C]1987'],
  ];
  for (const [name, pat] of sigs) {
    if (findPattern(t0s0.data, pat) >= 0) return name;
  }
  // Unsigned: T0 formatted, T1 unformatted, T2 formatted
  if (image.numTracks > 2 && trk(image, 1) === null && trk(image, 2) !== null) return 'P.M.S. (unsigned)';
  return null;
};

const detectWrm: Detector = (image) => {
  const t8 = trk(image, 8);
  if (!t8 || t8.sectors.length <= 9) return null;
  const s9 = t8.sectors[9];
  if (!s9 || s9.data.length <= 128) return null;
  if (findPattern(s9.data, 'W.R.M Disc') === 0 && findPattern(s9.data, 'Protection') >= 0) return 'W.R.M Disc Protection';
  return null;
};

const detectAmsoft: Detector = (image) => {
  if (image.numTracks <= 3) return null;
  const t3 = trk(image, 3);
  if (!t3 || t3.sectors.length === 0 || t3.sectors[0].data.length !== 512) return null;
  const data = t3.sectors[0].data;
  if (findPattern(data, 'Amsoft disc protection system') > 1 && findPattern(data, 'EXOPAL') >= 0) return 'Amsoft/EXOPAL';
  return null;
};

const detectStudioB: Detector = (image) => {
  if (image.numTracks <= 3) return null;
  const t0 = trk(image, 0), t2 = trk(image, 2);
  // T0 must be formatted, T1 must be unformatted, T2 must be formatted
  if (!t0 || t0.sectors.length === 0 || trk(image, 1) !== null || !t2) return null;
  if (t0.sectors[0] && findPattern(t0.sectors[0].data, 'Disc format (c) 1986 Studio B Ltd.') >= 0) return 'Studio B';
  if (t2.sectors[0] && findPattern(t2.sectors[0].data, 'DISCLOC') >= 0) return 'DiscLoc/Oddball';
  return null;
};

const detectHerbulot: Detector = (image) => {
  const t0 = trk(image, 0);
  if (!t0) return null;
  for (const s of t0.sectors) {
    if (findPattern(s.data, 'PROTECTION') >= 0 && findPattern(s.data, 'Remi HERBULOT') >= 0) return 'ERE/Remi HERBULOT';
  }
  return null;
};

const detectKbi: Detector = (image) => {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (track?.sectors.length === 19) return 'KBI-19';
  }
  if (image.numTracks >= 40) {
    const t38 = trk(image, 38), t39 = trk(image, 39);
    if (t38?.sectors.length === 9 && t39?.sectors.length === 10) {
      const s9 = t39.sectors[9];
      if (s9?.st1 === 0x20 && s9.st2 === 0x20) return 'KBI-10';
    }
  }
  return null;
};

const detectPlayers: Detector = (image) => {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (track?.sectors.length !== 16) continue;
    if (track.sectors.every((s, i) => s.r === i && s.n === i)) return 'Players';
  }
  return null;
};

const detectInfogrames: Detector = (image) => {
  if (image.numTracks <= 39) return null;
  const t39 = trk(image, 39);
  if (t39?.sectors.length !== 9) return null;
  for (const s of t39.sectors) {
    if (s.n === 2 && s.data.length === 540) return 'Infogrames/Logiciel';
  }
  return null;
};

const detectRainbowArts: Detector = (image) => {
  if (image.numTracks <= 40) return null;
  const t40 = trk(image, 40);
  if (t40?.sectors.length !== 9) return null;
  for (const s of t40.sectors) {
    if (s.r === 0xC6 && s.st1 === 0x20 && s.st2 === 0x20) return 'Rainbow Arts';
  }
  return null;
};

const detectDiscsys: Detector = (image) => {
  for (let t = 0; t < image.numTracks; t++) {
    const track = trk(image, t);
    if (track?.sectors.length !== 16) continue;
    if (track.sectors.every((s, i) => s.c === i && s.h === i && s.r === i && s.n === i)) return 'DiscSYS';
  }
  return null;
};

const detectArmourloc: Detector = (image) => {
  const t0 = trk(image, 0);
  if (t0?.sectors.length !== 9) return null;
  if (t0.sectors[0] && findPattern(t0.sectors[0].data, '0K free') === 2) return 'ARMOURLOC';
  return null;
};

// Ordering matters — earlier detectors win.
//   • detectHerbulot and detectKbi are handled separately below: their
//     results can combine into one string.
//   • detectDiscsys must precede detectPlayers: DiscSYS's CHRN-all-equal-
//     index pattern is a strict superset of Players' r-and-n-equal-index
//     pattern, so the reverse order would label every DiscSYS as Players.
//   • detectStudioB must precede detectPms: PMS's unsigned layout (T0
//     formatted, T1 unformatted, T2 formatted) is also Studio B's exact
//     layout. Studio B has a specific signature; checking it first lets
//     truly unsigned disks fall through to the PMS catch-all.
const DETECTORS: Detector[] = [
  detectAlkatraz, detectFrontier, detectHexagon, detectPaulOwens,
  detectSpeedlock, detectThreeInch, detectWrm, detectStudioB, detectPms,
  detectDiscsys, detectPlayers, detectInfogrames, detectRainbowArts,
  detectAmsoft, detectArmourloc,
];

export function detectProtection(image: DskImage): string {
  if (image.numTracks < 2) return '';
  const t0 = trk(image, 0);
  if (!t0 || t0.sectors.length < 1 || t0.sectors[0].data.length < 128) return '';

  const uniform = isUniform(image);
  const errors = hasFdcErrors(image);
  if (uniform && !errors) return 'None';

  for (const detect of DETECTORS) {
    const result = detect(image);
    if (result) return result;
  }

  // Herbulot and KBI are non-exclusive: both can be present on the same disk.
  const kbi = detectKbi(image);
  const herbulot = detectHerbulot(image);
  if (kbi && herbulot) return `${kbi} + ${herbulot}`;
  if (kbi) return kbi;
  if (herbulot) return herbulot;

  if (errors) return 'Unknown';
  return '';
}
