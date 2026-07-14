/**
 * SuperCard Pro (.scp) flux disk images for the +3/CPC (uPD765A) and the Beta
 * Disk / +D (WD179x).
 *
 * SCP is a *flux* format — one level below HFE. Instead of MFM bit-cells it
 * stores the raw timing between magnetic flux reversals (in 25ns ticks), for one
 * or more revolutions of each track. We recover the bit-cells with a software
 * data separator (a PLL), then reuse the exact MFM decoder the HFE path uses
 * (`decodeHfeTrack`) to turn cells into sectors.
 *
 * The point of flux (vs HFE's single deterministic revolution) is fidelity for
 * copy protection: weak/fuzzy sectors read differently each revolution. When a
 * sector's data differs across revolutions we attach every reading as a weak
 * `DskSector.copies[]`, which the uPD765A already picks from at random.
 *
 * Read-only: flux cannot be meaningfully re-encoded from sectors, so there is no
 * serialize/write-back path (unlike HFE).
 *
 * Format reference: the SuperCard Pro image spec (Jim Drew). Header at 0x00,
 * a 168-entry LE track-offset table at 0x10, each track a "TRK" data header with
 * per-revolution (index-time, flux-count, data-offset) triplets, then 16-bit
 * big-endian flux intervals (0x0000 = +65536 tick overflow into the next value).
 */

import type { DskImage, DskTrack, DskSector } from './dsk.ts';
import { decodeHfeTrack } from './hfe.ts';

const TRACK_TABLE = 0x10;
const MAX_TRACKS = 168;

/** True if the bytes start with the "SCP" signature. */
export function isScp(data: Uint8Array): boolean {
  return data.length >= 0x10
    && data[0] === 0x53 && data[1] === 0x43 && data[2] === 0x50; // "SCP"
}

function u32le(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

function gcd(a: number, b: number): number {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

// ── Flux → MFM bit-cells (software data separator / PLL) ────────────────────
//
// Emit one cell per nominal bit-cell time, setting a "1" cell at each flux
// reversal and "0" cells in the gaps, packed LSB-first (bit 0 = first cell in
// time) to match the layout decodeHfeTrack expects. A PLL nudges the running
// cell estimate toward the observed flux so disk-speed variation doesn't drift
// the byte phase. `cellTicks` is the nominal half-bit-cell in resolution ticks
// (DD MFM ≈ 2µs).

function fluxToCells(flux: number[], cellTicks: number): Uint8Array {
  const bits: number[] = [];
  let cell = cellTicks;
  const gain = 0.10; // PLL adaptation rate
  for (const t of flux) {
    // Number of cells this interval spans (at least 1); the transition lands in
    // the final cell, so emit (n-1) empty cells then one flux cell.
    let n = Math.round(t / cell);
    if (n < 1) n = 1;
    for (let i = 0; i < n - 1; i++) bits.push(0);
    bits.push(1);
    // Adapt the cell estimate toward this interval's per-cell time.
    cell += ((t / n) - cell) * gain;
  }
  const out = new Uint8Array((bits.length + 7) >> 3);
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}

/** Decode a track's raw flux (16-bit BE, 0 = +0x10000 overflow) into intervals. */
function readFlux(data: Uint8Array, base: number, count: number): number[] {
  const flux: number[] = [];
  let carry = 0;
  let o = base;
  for (let i = 0; i < count; i++, o += 2) {
    const v = (data[o] << 8) | data[o + 1];
    if (v === 0) { carry += 0x10000; continue; }
    flux.push(carry + v);
    carry = 0;
  }
  return flux;
}

/**
 * Auto-detect the nominal cell time from the flux histogram: the shortest
 * common interval is ~2 cells of MFM, so half of it is one cell. Falls back to
 * the DD default when the flux is too sparse to measure.
 */
function estimateCellTicks(flux: number[], resTicks: number): number {
  const ddCell = 2000 / (resTicks * 25); // 2µs in resolution ticks (80 @ 25ns)
  if (flux.length < 100) return ddCell;
  // Shortest intervals cluster at the 2-cell peak; take a robust low percentile.
  const sorted = [...flux].sort((a, b) => a - b);
  const shortPeak = sorted[Math.floor(sorted.length * 0.05)];
  const cell = shortPeak / 2;
  // Guard against garbage: keep within a sane band around the DD nominal.
  return (cell > ddCell * 0.5 && cell < ddCell * 2) ? cell : ddCell;
}

/** Merge per-revolution decodes of one physical track into a single DskTrack,
 *  attaching weak `copies[]` for any sector whose data varies across reads. */
function mergeRevolutions(tracks: DskTrack[]): DskTrack | null {
  const good = tracks.filter((t): t is DskTrack => t !== null);
  if (good.length === 0) return null;

  // Union of every sector R seen, in first-seen physical order.
  const order: number[] = [];
  const byR = new Map<number, DskSector[]>();
  for (const t of good) {
    for (const s of t.sectors) {
      if (!byR.has(s.r)) { byR.set(s.r, []); order.push(s.r); }
      byR.get(s.r)!.push(s);
    }
  }

  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  for (const r of order) {
    const reads = byR.get(r)!;
    // Prefer a good-CRC reading as the primary; else the first.
    const primary = reads.find(s => (s.st1 & 0x20) === 0 && (s.st2 & 0x20) === 0) ?? reads[0];
    const distinct = new Set(reads.map(s => bytesKey(s.data)));
    const sector: DskSector = { ...primary, data: primary.data };
    if (distinct.size > 1) {
      // Weak/fuzzy sector: keep every distinct reading for the FDC to pick from.
      const seen = new Set<string>();
      const copies: Uint8Array[] = [];
      for (const s of reads) {
        const k = bytesKey(s.data);
        if (!seen.has(k)) { seen.add(k); copies.push(s.data); }
      }
      sector.copies = copies;
      sector.st2 |= 0x20; // ST2 DD — flag as a weak/data-varying sector
    }
    const idx = sectors.push(sector) - 1;
    if (!sectorMap.has(r)) sectorMap.set(r, idx);
  }
  return { sectors, sectorMap, gap3: good[0].gap3, filler: good[0].filler };
}

function bytesKey(d: Uint8Array): string {
  // Cheap content key; length + a rolling checksum avoids huge string joins.
  let h = d.length;
  for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) | 0;
  return `${d.length}:${h}`;
}

export function parseSCP(data: Uint8Array): DskImage {
  if (!isScp(data)) throw new Error('Not an SCP image (missing "SCP" signature)');

  const numRevs = data[0x05];
  const startTrack = data[0x06];
  const endTrack = data[0x07];
  const heads = data[0x0A];        // 0 = both sides interleaved, 1 = side0, 2 = side1
  const resByte = data[0x0B];      // 0 = 25ns ticks, else (resByte+1)*25ns
  const resTicks = resByte + 1;

  // Pass 1: decode and merge every present physical track, indexed by its SCP
  // track number.
  const phys: (DskTrack | null)[] = [];
  for (let t = startTrack; t <= endTrack && t < MAX_TRACKS; t++) {
    const tdhOff = u32le(data, TRACK_TABLE + t * 4);
    if (tdhOff === 0 || tdhOff + 4 > data.length) { phys[t] = null; continue; }
    if (!(data[tdhOff] === 0x54 && data[tdhOff + 1] === 0x52 && data[tdhOff + 2] === 0x4B)) { phys[t] = null; continue; } // "TRK"

    // Per-revolution triplets follow the 4-byte "TRK"+num header.
    const revTracks: DskTrack[] = [];
    let cellTicks = 0;
    for (let r = 0; r < numRevs; r++) {
      const o = tdhOff + 4 + r * 12;
      const fluxCount = u32le(data, o + 4);
      const dataOffset = u32le(data, o + 8);
      if (fluxCount === 0) continue;
      const flux = readFlux(data, tdhOff + dataOffset, fluxCount);
      if (cellTicks === 0) cellTicks = estimateCellTicks(flux, resTicks);
      const dec = decodeHfeTrack(fluxToCells(flux, cellTicks));
      if (dec) revTracks.push(dec);
    }
    phys[t] = mergeRevolutions(revTracks);
  }

  // Physical tracks are stored at the head's step positions, which may be spaced
  // (e.g. a 40-cylinder disk recorded at even physical tracks 0,2,4,…). Recover
  // the spacing as the gcd of the gaps between present single-sided tracks, so
  // logical cylinder = (track - start) / step regardless of the imaging step.
  const presentSingle: number[] = [];
  for (let t = startTrack; t <= endTrack; t++) if (phys[t] && (heads !== 0)) presentSingle.push(t);
  let step = 1;
  if (presentSingle.length >= 2) {
    step = presentSingle[1] - presentSingle[0];
    for (let i = 2; i < presentSingle.length; i++) step = gcd(step, presentSingle[i] - presentSingle[i - 1]);
  }
  if (step < 1) step = 1;

  // Pass 2: map physical tracks to (cylinder, side).
  const tracks: (DskTrack | null)[][] = [];
  const numSides = heads === 0 ? 2 : 1;
  const put = (cyl: number, side: number, track: DskTrack | null) => {
    while (tracks.length <= cyl) tracks.push(Array.from({ length: numSides }, () => null));
    tracks[cyl][side] = track;
  };
  for (let t = startTrack; t <= endTrack; t++) {
    if (!phys[t]) continue;
    if (heads === 0) { put(t >> 1, t & 1, phys[t]); continue; } // interleaved DS
    const rel = t - startTrack;
    if (rel % step === 0) put(rel / step, 0, phys[t]);          // spaced single-side
  }

  return {
    format: 'extended',
    numTracks: tracks.length,
    numSides,
    tracks,
    diskFormat: 'SCP (flux)',
    protection: '',
  };
}
