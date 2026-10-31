/**
 * Commodore 1541 disks, as the bits that turn under the head.
 *
 * A 1541 disk is GCR coded: every 4 bits are written as 5 so no more than two
 * zero bits ever run together, which lets a run of ten or more 1 bits stand
 * for sync. A track is a ring of such bits, written at one of four speeds
 * (the zones: the outer tracks hold more sectors, so they turn faster in
 * bits per second). The drive's electronics find sync, then cut the stream
 * into bytes eight bits at a time; everything above that, headers, sectors,
 * checksums, is the DOS ROM's work.
 *
 * Three file formats are read and written:
 *
 *  - `.d64`  the sectors only (35, 40 or 42 tracks, optionally followed by
 *            one error byte per sector). Mounting one lays the sectors out
 *            as the DOS formats them: sync, header, gap, sync, data, gap.
 *            Saving gives a `.d64` back while every sector can still be read.
 *  - `.g64`  the GCR bits of each half-track exactly (CCS64's format), so
 *            protections that rely on odd tracks, half-tracks, damaged
 *            sectors or non-standard speeds survive.
 *  - `.d71`  a double-sided `.d64` for the 1571: tracks 36-70 are the second
 *            side of the same 35 cylinders (`tracks1` below).
 *
 * Tracks are stored as packed bits (MSB first, the order they pass the head)
 * with their length in bits, so writes can be made bit by bit.
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';
import type { DskImage } from './disk-image.ts';

/** Half-tracks 0-83: index `2n` is track n+1, `2n+1` the half-track after it. */
export const C64_HALF_TRACKS = 84;

const GCR_ENCODE = [
  0x0A, 0x0B, 0x12, 0x13, 0x0E, 0x0F, 0x16, 0x17,
  0x09, 0x19, 0x1A, 0x1B, 0x0D, 0x1D, 0x1E, 0x15,
] as const;
const GCR_DECODE = new Int8Array(32).fill(-1);
GCR_ENCODE.forEach((code, nibble) => { GCR_DECODE[code] = nibble; });

/** Sectors on a track (1-based) of a standard 1541 disk. */
export function sectorsOnTrack(track: number): number {
  if (track <= 17) return 21;
  if (track <= 24) return 19;
  if (track <= 30) return 18;
  return 17;
}

/** The speed zone a track is written in: 3 is the fastest (tracks 1-17). */
export function speedZone(track: number): number {
  if (track <= 17) return 3;
  if (track <= 24) return 2;
  if (track <= 30) return 1;
  return 0;
}

/** Bytes of GCR a track holds at 300 rpm, by speed zone 0-3. */
export const TRACK_BYTES_BY_ZONE = [6250, 6666, 7142, 7692] as const;

/** One half-track's bits, MSB first, `length` of them in a ring. */
export interface C64Track {
  bits: Uint8Array;
  length: number;
  /** Speed zone 0-3 the bits were written at. */
  zone: number;
}

export type C64DiskSource = 'd64' | 'g64' | 'd71';

export interface C64Disk {
  /** 84 half-tracks; null is unformatted. */
  readonly tracks: (C64Track | null)[];
  /** The second side's half-tracks, for a 1571 (the 1541 has one head). Absent
   *  until the disk has a second side. */
  tracks1?: (C64Track | null)[];
  source: C64DiskSource;
  /** Tracks in the `.d64` it came from (35, 40 or 42); 35 for a `.g64`. */
  d64Tracks: number;
}

// ── GCR ─────────────────────────────────────────────────────────────────────

/** Four bytes as five bytes of GCR. */
function encodeGroup(out: number[], a: number, b: number, c: number, d: number): void {
  const n0 = GCR_ENCODE[a >> 4], n1 = GCR_ENCODE[a & 15];
  const n2 = GCR_ENCODE[b >> 4], n3 = GCR_ENCODE[b & 15];
  const n4 = GCR_ENCODE[c >> 4], n5 = GCR_ENCODE[c & 15];
  const n6 = GCR_ENCODE[d >> 4], n7 = GCR_ENCODE[d & 15];
  out.push(
    (n0 << 3) | (n1 >> 2),
    ((n1 & 3) << 6) | (n2 << 1) | (n3 >> 4),
    ((n3 & 15) << 4) | (n4 >> 1),
    ((n4 & 1) << 7) | (n5 << 2) | (n6 >> 3),
    ((n6 & 7) << 5) | n7,
  );
}

/** Five bytes of GCR as four bytes, or null if any 5-bit code is not valid. */
function decodeGroup(b: ArrayLike<number>, at: number): number[] | null {
  const codes = [
    b[at] >> 3,
    ((b[at] & 7) << 2) | (b[at + 1] >> 6),
    (b[at + 1] >> 1) & 31,
    ((b[at + 1] & 1) << 4) | (b[at + 2] >> 4),
    ((b[at + 2] & 15) << 1) | (b[at + 3] >> 7),
    (b[at + 3] >> 2) & 31,
    ((b[at + 3] & 3) << 3) | (b[at + 4] >> 5),
    b[at + 4] & 31,
  ];
  const n = codes.map(c => GCR_DECODE[c]);
  if (n.some(v => v < 0)) return null;
  return [(n[0] << 4) | n[1], (n[2] << 4) | n[3], (n[4] << 4) | n[5], (n[6] << 4) | n[7]];
}

function encodeBlock(out: number[], data: ArrayLike<number>): void {
  for (let i = 0; i < data.length; i += 4) encodeGroup(out, data[i], data[i + 1], data[i + 2], data[i + 3]);
}

// ── D64 ─────────────────────────────────────────────────────────────────────

const D64_SIZES = new Map<number, { tracks: number; errors: boolean }>([
  [174_848, { tracks: 35, errors: false }],
  [175_531, { tracks: 35, errors: true }],
  [196_608, { tracks: 40, errors: false }],
  [197_376, { tracks: 40, errors: true }],
  [205_312, { tracks: 42, errors: false }],
  [206_114, { tracks: 42, errors: true }],
]);

/** The sector index of the first sector of `track` (1-based) in a D64. */
function trackStart(track: number): number {
  let n = 0;
  for (let t = 1; t < track; t++) n += sectorsOnTrack(t);
  return n;
}

export function isD64(data: Uint8Array): boolean {
  return D64_SIZES.has(data.length);
}

export function isG64(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  return String.fromCharCode(...data.subarray(0, 8)) === 'GCR-1541';
}

/** Header sync and gap bytes around each sector, as the DOS writes them. */
const SYNC_BYTES = 5;
const HEADER_GAP_BYTES = 9;
const SECTOR_FIXED_BYTES = SYNC_BYTES + 10 + HEADER_GAP_BYTES + SYNC_BYTES + 325;

/**
 * One track of sectors as GCR bytes. `errors[s]` (a D64 error code) makes sector
 * `s` unreadable the way the code says, so a copy-protected image keeps its
 * deliberate faults: 2 no header, 3 no sync before the data, 4 no data block,
 * 5 data checksum, 8 header checksum, 10 disk id mismatch.
 */
function buildTrack(
  track: number, sectors: (Uint8Array | null)[], errors: ArrayLike<number> | null, id1: number, id2: number,
  physical = track,
): C64Track {
  const zone = speedZone(physical);
  const count = sectorsOnTrack(physical);
  const total = TRACK_BYTES_BY_ZONE[zone];
  const spare = total - count * SECTOR_FIXED_BYTES;
  const out: number[] = [];
  for (let s = 0; s < count; s++) {
    const err = errors?.[s] ?? 1;
    const data = sectors[s] ?? new Uint8Array(256);
    for (let i = 0; i < SYNC_BYTES; i++) out.push(0xFF);
    const hid2 = err === 10 ? id2 ^ 0xFF : id2;
    const hchk = s ^ track ^ hid2 ^ id1 ^ (err === 8 ? 0xFF : 0);
    encodeBlock(out, [err === 2 ? 0x00 : 0x08, hchk, s, track, hid2, id1, 0x0F, 0x0F]);
    for (let i = 0; i < HEADER_GAP_BYTES; i++) out.push(0x55);
    for (let i = 0; i < SYNC_BYTES; i++) out.push(err === 3 ? 0x55 : 0xFF);
    let chk = 0;
    for (let i = 0; i < 256; i++) chk ^= data[i];
    const block = new Uint8Array(260);
    block[0] = err === 4 ? 0x00 : 0x07;
    block.set(data.subarray(0, 256), 1);
    block[257] = chk ^ (err === 5 ? 0xFF : 0);
    encodeBlock(out, block);
    const gap = Math.floor(spare / count) + (s < spare % count ? 1 : 0);
    for (let i = 0; i < gap; i++) out.push(0x55);
  }
  return { bits: Uint8Array.from(out), length: out.length * 8, zone };
}

/** Lay a `.d64` out as GCR tracks. */
export function parseD64(data: Uint8Array): C64Disk {
  const info = D64_SIZES.get(data.length);
  if (!info) throw new Error(`not a D64 image (${data.length} bytes)`);
  const sectorTotal = trackStart(info.tracks + 1);
  const errorBytes = info.errors ? data.subarray(sectorTotal * 256) : null;
  // The disk id the DOS stamps in every header is the BAM's.
  const bam = trackStart(18) * 256;
  const id1 = data[bam + 0xA2], id2 = data[bam + 0xA3];
  const tracks: (C64Track | null)[] = new Array(C64_HALF_TRACKS).fill(null);
  for (let t = 1; t <= info.tracks; t++) {
    const first = trackStart(t);
    const count = sectorsOnTrack(t);
    const sectors: Uint8Array[] = [];
    for (let s = 0; s < count; s++) sectors.push(data.subarray((first + s) * 256, (first + s + 1) * 256));
    tracks[(t - 1) * 2] = buildTrack(t, sectors, errorBytes ? errorBytes.subarray(first, first + count) : null, id1, id2);
  }
  return { tracks, source: 'd64', d64Tracks: info.tracks };
}

// ── D71 ─────────────────────────────────────────────────────────────────────

/** Sectors on one side of a 1571 disk: the 35 tracks of a `.d64`. */
const D71_SIDE_SECTORS = 683;
const D71_SIZES = new Map<number, { errors: boolean }>([
  [D71_SIDE_SECTORS * 2 * 256, { errors: false }],
  [(D71_SIDE_SECTORS * 2 * 256) + D71_SIDE_SECTORS * 2, { errors: true }],
]);

export function isD71(data: Uint8Array): boolean {
  return D71_SIZES.has(data.length);
}

/** The sector index of the first sector of `track` (1-70) in a D71: tracks 36-70
 *  are the second side, laid out as tracks 1-35 are. */
function trackStart71(track: number): number {
  return track <= 35 ? trackStart(track) : D71_SIDE_SECTORS + trackStart(track - 35);
}

/** Lay a `.d71` out as GCR tracks: side 0 carries tracks 1-35, side 1 tracks 36-70. */
export function parseD71(data: Uint8Array): C64Disk {
  const info = D71_SIZES.get(data.length);
  if (!info) throw new Error(`not a D71 image (${data.length} bytes)`);
  const errorBytes = info.errors ? data.subarray(D71_SIDE_SECTORS * 2 * 256) : null;
  const bam = trackStart(18) * 256;
  const id1 = data[bam + 0xA2], id2 = data[bam + 0xA3];
  const sides: (C64Track | null)[][] = [new Array(C64_HALF_TRACKS).fill(null), new Array(C64_HALF_TRACKS).fill(null)];
  for (let t = 1; t <= 70; t++) {
    const side = t > 35 ? 1 : 0;
    const physical = t - side * 35;
    const first = trackStart71(t);
    const count = sectorsOnTrack(physical);
    const sectors: Uint8Array[] = [];
    for (let s = 0; s < count; s++) sectors.push(data.subarray((first + s) * 256, (first + s + 1) * 256));
    sides[side][(physical - 1) * 2] = buildTrack(
      t, sectors, errorBytes ? errorBytes.subarray(first, first + count) : null, id1, id2, physical,
    );
  }
  return { tracks: sides[0], tracks1: sides[1], source: 'd71', d64Tracks: 35 };
}

// ── Reading sectors back out of GCR ─────────────────────────────────────────

export interface DecodedSector {
  readonly track: number;
  readonly sector: number;
  readonly headerOk: boolean;
  /** The 256 bytes, or null if no data block followed the header. */
  readonly data: Uint8Array | null;
  readonly dataOk: boolean;
}

function bitAt(t: C64Track, i: number): number {
  const p = i % t.length;
  return (t.bits[p >> 3] >> (7 - (p & 7))) & 1;
}

function byteAt(t: C64Track, i: number): number {
  let v = 0;
  for (let k = 0; k < 8; k++) v = (v << 1) | bitAt(t, i + k);
  return v;
}

/** Read `count` bytes starting at bit `i`. */
function bytesAt(t: C64Track, i: number, count: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(byteAt(t, i + k * 8));
  return out;
}

function decodeBlock(gcr: number[]): number[] | null {
  const out: number[] = [];
  for (let i = 0; i + 4 < gcr.length; i += 5) {
    const g = decodeGroup(gcr, i);
    if (!g) return null;
    out.push(...g);
  }
  return out;
}

/** Find the sectors written on a track by following sync, header, sync, data. */
export function decodeTrackSectors(t: C64Track): DecodedSector[] {
  const found = new Map<number, DecodedSector>();
  let header: { track: number; sector: number; ok: boolean } | null = null;
  let ones = 0;
  for (let i = 0; i < t.length * 2; i++) {
    if (bitAt(t, i) === 1) { ones++; continue; }
    const sync = ones >= 10;
    ones = 0;
    if (!sync) continue;
    const first = decodeGroup(bytesAt(t, i, 5), 0);
    if (!first) continue;
    if (first[0] === 0x08) {
      const h = decodeBlock(bytesAt(t, i, 10));
      if (!h) { header = null; continue; }
      header = { track: h[3], sector: h[2], ok: (h[2] ^ h[3] ^ h[4] ^ h[5]) === h[1] };
    } else if (first[0] === 0x07 && header) {
      const d = decodeBlock(bytesAt(t, i, 325));
      if (!d) { header = null; continue; }
      const payload = Uint8Array.from(d.slice(1, 257));
      let chk = 0;
      for (const b of payload) chk ^= b;
      if (!found.has(header.sector)) {
        found.set(header.sector, {
          track: header.track, sector: header.sector, headerOk: header.ok, data: payload, dataOk: chk === d[257],
        });
      }
      header = null;
    }
  }
  return [...found.values()].sort((a, b) => a.sector - b.sector);
}

/**
 * The disk as a `.d64`, or null when it cannot be one: not every sector of
 * every track can be read cleanly (a protected or damaged disk, or one with a
 * half-track in use), or it holds more tracks than a `.d64` has.
 */
export function exportD64(disk: C64Disk): Uint8Array | null {
  if (disk.tracks1?.some(Boolean)) return null;
  const tracks = disk.d64Tracks;
  for (let h = 0; h < C64_HALF_TRACKS; h++) {
    if (disk.tracks[h] && (h & 1 || h / 2 + 1 > tracks)) return null;
  }
  const out = new Uint8Array(trackStart(tracks + 1) * 256);
  for (let t = 1; t <= tracks; t++) {
    const track = disk.tracks[(t - 1) * 2];
    if (!track) return null;
    const sectors = decodeTrackSectors(track);
    const count = sectorsOnTrack(t);
    const first = trackStart(t);
    for (let s = 0; s < count; s++) {
      const found = sectors.find(x => x.sector === s);
      if (!found || !found.data || !found.headerOk || !found.dataOk || found.track !== t) return null;
      out.set(found.data, (first + s) * 256);
    }
  }
  return out;
}

/**
 * The disk as a `.d71`, or null when it cannot be one: a track or sector that
 * cannot be read cleanly, a half-track in use, or more than 35 tracks a side.
 */
export function exportD71(disk: C64Disk): Uint8Array | null {
  const sides = [disk.tracks, disk.tracks1 ?? []];
  for (const side of sides) {
    for (let h = 0; h < side.length; h++) {
      if (side[h] && (h & 1 || h / 2 + 1 > 35)) return null;
    }
  }
  const out = new Uint8Array(D71_SIDE_SECTORS * 2 * 256);
  for (let t = 1; t <= 70; t++) {
    const side = t > 35 ? 1 : 0;
    const physical = t - side * 35;
    const track = sides[side][(physical - 1) * 2];
    if (!track) return null;
    const sectors = decodeTrackSectors(track);
    const first = trackStart71(t);
    for (let s = 0; s < sectorsOnTrack(physical); s++) {
      const found = sectors.find(x => x.sector === s);
      if (!found || !found.data || !found.headerOk || !found.dataOk || found.track !== t) return null;
      out.set(found.data, (first + s) * 256);
    }
  }
  return out;
}

// ── G64 ─────────────────────────────────────────────────────────────────────

/** A zone for a G64 track whose speed entry points at a per-byte map: the
 *  speed of its first byte (a map that varies within a track is not kept). */
function zoneFromMap(data: Uint8Array, offset: number, trackBytes: number, fallback: number): number {
  if (offset + trackBytes > data.length) return fallback;
  return data[offset] & 3;
}

export function parseG64(data: Uint8Array): C64Disk {
  if (!isG64(data)) throw new Error('not a G64 image');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = Math.min(data[9], C64_HALF_TRACKS);
  const tracks: (C64Track | null)[] = new Array(C64_HALF_TRACKS).fill(null);
  for (let h = 0; h < count; h++) {
    const at = 12 + h * 4;
    if (at + 4 > data.length) break;
    const offset = view.getUint32(at, true);
    if (offset === 0 || offset + 2 > data.length) continue;
    const bytes = view.getUint16(offset, true);
    if (bytes === 0 || offset + 2 + bytes > data.length) continue;
    const speedAt = 12 + count * 4 + h * 4;
    const speed = speedAt + 4 <= data.length ? view.getUint32(speedAt, true) : speedZone((h >> 1) + 1);
    const zone = speed <= 3 ? speed : zoneFromMap(data, speed, bytes, speedZone((h >> 1) + 1));
    tracks[h] = { bits: data.slice(offset + 2, offset + 2 + bytes), length: bytes * 8, zone };
  }
  return { tracks, source: 'g64', d64Tracks: 35 };
}

export function serializeG64(disk: C64Disk): Uint8Array {
  const used = disk.tracks.map(t => (t ? Math.ceil(t.length / 8) : 0));
  let count = C64_HALF_TRACKS;
  while (count > 2 && !disk.tracks[count - 1]) count--;
  const max = Math.max(7928, ...used);
  const table = 12 + count * 8;
  const total = table + used.reduce((n, b) => n + (b ? b + 2 : 0), 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(Array.from('GCR-1541', c => c.charCodeAt(0)), 0);
  out[8] = 0;
  out[9] = count;
  view.setUint16(10, max, true);
  let at = table;
  for (let h = 0; h < count; h++) {
    const t = disk.tracks[h];
    view.setUint32(12 + count * 4 + h * 4, t ? t.zone : speedZone((h >> 1) + 1), true);
    if (!t) continue;
    const bytes = used[h];
    view.setUint32(12 + h * 4, at, true);
    view.setUint16(at, bytes, true);
    out.set(t.bits.subarray(0, bytes), at + 2);
    at += bytes + 2;
  }
  return out;
}

// ── Any image ───────────────────────────────────────────────────────────────

/** Parse a `.d64` or `.g64`, whichever the contents are. */
export function parseC64Disk(data: Uint8Array): C64Disk {
  if (isG64(data)) return parseG64(data);
  if (isD64(data)) return parseD64(data);
  throw new Error('not a D64 or G64 disk image');
}

/** What a 1571 reads: a `.d71` as well as the 1541's `.d64` and `.g64`. */
export function parseC64Disk71(data: Uint8Array): C64Disk {
  return isD71(data) ? parseD71(data) : parseC64Disk(data);
}

/** The disk as a file in the format it came in, falling back to `.g64` when a
 *  `.d64` could not hold what is on it now. A disk with a second side can only
 *  be a `.d71`; if it no longer is one, saving it is an error. */
export function serializeC64Disk(disk: C64Disk): { data: Uint8Array; ext: '.d64' | '.g64' | '.d71' } {
  if (disk.source === 'd71' || disk.tracks1?.some(Boolean)) {
    const d71 = exportD71(disk);
    if (!d71) {
      throw new Error('this disk no longer has the 1571 layout (35 tracks of standard sectors on each side), so it cannot be saved as a .d71');
    }
    return { data: d71, ext: '.d71' };
  }
  if (disk.source === 'd64') {
    const d64 = exportD64(disk);
    if (d64) return { data: d64, ext: '.d64' };
  }
  return { data: serializeG64(disk), ext: '.g64' };
}

// ── A blank, formatted disk ─────────────────────────────────────────────────

const PETSCII_SHIFTED_SPACE = 0xA0;

/** A freshly formatted 35-track disk (an empty directory) as a `.d64`. */
export function blankD64(name = 'ZX84', id = '01'): Uint8Array {
  const out = new Uint8Array(174_848);
  const bam = trackStart(18) * 256;
  out[bam] = 18; out[bam + 1] = 1; out[bam + 2] = 0x41;
  for (let t = 1; t <= 35; t++) {
    const count = sectorsOnTrack(t);
    const at = bam + 4 * t;
    const free: boolean[] = new Array(count).fill(true);
    if (t === 18) { free[0] = false; free[1] = false; }
    out[at] = free.filter(Boolean).length;
    free.forEach((f, s) => { if (f) out[at + 1 + (s >> 3)] |= 1 << (s & 7); });
  }
  const text = (s: string, width: number): number[] => {
    const bytes = Array.from(s.toUpperCase().slice(0, width), c => c.charCodeAt(0));
    while (bytes.length < width) bytes.push(PETSCII_SHIFTED_SPACE);
    return bytes;
  };
  out.set(text(name, 16), bam + 0x90);
  out[bam + 0xA0] = out[bam + 0xA1] = PETSCII_SHIFTED_SPACE;
  out.set(text(id, 2), bam + 0xA2);
  out[bam + 0xA4] = PETSCII_SHIFTED_SPACE;
  out[bam + 0xA5] = 0x32; out[bam + 0xA6] = 0x41;       // "2A"
  out.fill(PETSCII_SHIFTED_SPACE, bam + 0xA7, bam + 0xAB);
  const dir = trackStart(18) * 256 + 256;
  out[dir] = 0x00; out[dir + 1] = 0xFF;
  return out;
}

export function blankC64Disk(name?: string, id?: string): C64Disk {
  return parseD64(blankD64(name, id));
}

/**
 * A freshly formatted double-sided disk (an empty directory) as a `.d71`. The
 * 1571's DOS keeps the second side's free-sector counts in the first BAM
 * sector ($DD-$FF of 18/0, with byte 3 set to $80 for "double sided") and
 * their bit maps in 53/0; track 53, the mirror of the directory track, is kept
 * out of use.
 */
export function blankD71(name = 'ZX84', id = '01'): Uint8Array {
  const out = new Uint8Array(D71_SIDE_SECTORS * 2 * 256);
  out.set(blankD64(name, id));
  const bam = trackStart(18) * 256;
  out[bam + 3] = 0x80;
  const bam2 = trackStart71(53) * 256;
  for (let t = 36; t <= 70; t++) {
    const count = sectorsOnTrack(t - 35);
    const free = t === 53 ? 0 : count;
    out[bam + 0xDD + (t - 36)] = free;
    if (free === 0) continue;
    const at = bam2 + 3 * (t - 36);
    for (let s = 0; s < count; s++) out[at + (s >> 3)] |= 1 << (s & 7);
  }
  return out;
}

export function blankC64Disk71(name?: string, id?: string): C64Disk {
  return parseD71(blankD71(name, id));
}

// ── What the Drives pane shows ──────────────────────────────────────────────

/** A mounted disk wrapped for the panes (which describe media as `DskImage`s). */
export interface C64DiskImage extends DskImage {
  readonly c64: C64Disk;
}

export function c64DiskImage(disk: C64Disk): C64DiskImage {
  const halves = disk.tracks.filter(Boolean).length;
  const twoSided = disk.tracks1?.some(Boolean) ?? false;
  const diskFormat = disk.source === 'g64'
    ? `G64 (${halves} half-tracks of GCR)`
    : disk.source === 'd71'
      ? `D71 (${disk.d64Tracks * 2} tracks, ${Math.round(D71_SIDE_SECTORS * 2 * 256 / 1024)} KB)`
      : `D64 (${disk.d64Tracks} tracks, ${Math.round(trackStart(disk.d64Tracks + 1) * 256 / 1024)} KB)`;
  return {
    format: 'standard', numTracks: disk.d64Tracks, numSides: twoSided ? 2 : 1, tracks: [], diskFormat,
    protection: '', c64: disk,
  };
}

export function isC64DiskImage(media: unknown): media is C64DiskImage {
  return typeof media === 'object' && media !== null && 'c64' in media;
}

// ── Snapshot state ──────────────────────────────────────────────────────────

function writeSide(w: StateSink, tracks: readonly (C64Track | null)[]): void {
  for (let h = 0; h < C64_HALF_TRACKS; h++) {
    const t = tracks[h] ?? null;
    w.bool(t !== null);
    if (!t) continue;
    w.u32(t.length);
    w.u8(t.zone);
    w.bytes(t.bits);
  }
}

function readSide(r: StateSource): (C64Track | null)[] {
  const tracks: (C64Track | null)[] = [];
  for (let h = 0; h < C64_HALF_TRACKS; h++) {
    if (!r.bool()) { tracks.push(null); continue; }
    const length = r.u32();
    const zone = r.u8() & 3;
    const bits = r.bytes(1 << 16);
    if (length > bits.length * 8) throw new Error('Snapshot is corrupt (C64 disk track)');
    tracks.push({ bits, length, zone });
  }
  return tracks;
}

/** A disk with a second side is written with `+1` after its format, and the
 *  second side's tracks after the first's; older snapshots have neither. */
export function writeC64Disk(w: StateSink, disk: C64Disk): void {
  w.str(disk.tracks1 ? `${disk.source}+1` : disk.source);
  w.u8(disk.d64Tracks);
  writeSide(w, disk.tracks);
  if (disk.tracks1) writeSide(w, disk.tracks1);
}

export function readC64Disk(r: StateSource): C64Disk {
  const named = r.str();
  const twoSided = named.endsWith('+1');
  const source = twoSided ? named.slice(0, -2) : named;
  if (source !== 'd64' && source !== 'g64' && source !== 'd71') throw new Error('Snapshot is corrupt (C64 disk format)');
  const d64Tracks = r.u8();
  const tracks = readSide(r);
  return twoSided ? { tracks, tracks1: readSide(r), source, d64Tracks } : { tracks, source, d64Tracks };
}
