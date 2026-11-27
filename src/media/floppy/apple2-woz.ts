/**
 * WOZ disk images (Applesauce's format): WOZ 1, WOZ 2 and WOZ 2.1, for 5.25"
 * Disk II disks.
 *
 * A WOZ file stores what the drive head sees — a bit-cell stream per track —
 * rather than sectors, so it carries copy protection (non-standard address
 * marks, half and quarter tracks, sync counting, timing bits) intact. Layout,
 * per the WOZ reference:
 *
 *   12-byte header  "WOZ1"/"WOZ2", FF 0A 0D 0A, CRC-32 of everything after it
 *   chunks          4-byte id, 4-byte little-endian size, data
 *     INFO  version, disk type (1 = 5.25"), write protected, synchronized,
 *           cleaned, creator; from v2 sides, boot sector format, optimal bit
 *           timing (125 ns units), compatible hardware, required RAM, largest
 *           track; from v3 (WOZ 2.1) the FLUX block and largest flux track
 *     TMAP  160 bytes: quarter track (0, 0.25, ... 39.75) → TRKS index, FF = none
 *     TRKS  WOZ 1: 6656 bytes per track (6646 of bits, bytes used, bit count,
 *           splice info); WOZ 2: 160 × 8-byte entries (start block, block
 *           count, bit count) with the bits in 512-byte blocks of the file
 *     FLUX  (2.1, optional) 160 bytes like TMAP, naming TRKS entries that hold
 *           flux timing instead of bits: one byte per transition interval in
 *           125 ns ticks, 255 meaning "255 and keep adding"
 *     META  tab-separated key/value text (kept, not interpreted)
 *
 * Bits are packed most significant first. Flux tracks are turned into bit cells
 * here (each interval rounded to whole cells at the disk's bit timing), so the
 * drive model only ever sees bits. Saving always writes WOZ 2.
 */

import { crc32 } from '@/utils/crc32.ts';
import {
  APPLE2_BIT_TIMING, APPLE2_NO_TRACK, APPLE2_QUARTER_TRACKS, type Apple2BitTrack,
} from './apple2-bitstream.ts';

const SIGNATURE_TAIL = [0xFF, 0x0A, 0x0D, 0x0A];
const BLOCK = 512;
const WOZ1_TRACK_SIZE = 6656;
const WOZ1_BITS_BYTES = 6646;
/** WOZ 2 track data starts at block 3: header 12 + INFO 68 + TMAP 168 + TRKS header 8 + 1280 = 1536. */
const WOZ2_FIRST_BLOCK = 3;

export interface WozImage {
  /** File format: 1 for "WOZ1", 2 for "WOZ2". */
  version: 1 | 2;
  /** INFO chunk version: 1, 2, or 3 (WOZ 2.1). */
  infoVersion: number;
  writeProtected: boolean;
  /** Tracks were imaged with cross-track synchronisation. */
  synchronized: boolean;
  /** MC3470 fake bits have been removed. */
  cleaned: boolean;
  creator: string;
  /** 0 unknown, 1 16-sector, 2 13-sector, 3 both. */
  bootSectorFormat: number;
  /** Bit-cell length in 125 ns units (32 = 4 µs). */
  bitTiming: number;
  /** Bitfield of the Apple II models the disk runs on (0 = unknown). */
  compatibleHardware: number;
  /** Minimum RAM in KB (0 = unknown). */
  requiredRam: number;
  tmap: Uint8Array;
  tracks: Apple2BitTrack[];
  /** Quarter tracks whose bits were decoded from the FLUX chunk. */
  fluxQuarterTracks: number;
  /** The META chunk's text, if any. */
  meta: string | null;
}

// ── CRC-32 (the zip/PNG polynomial, which WOZ uses) ───────────────────────

export function wozCrc32(data: Uint8Array): number {
  return crc32(data);
}

// ── Parse ──────────────────────────────────────────────────────────────────

/** Whether the bytes start with a WOZ 1 or WOZ 2 header. */
export function isWoz(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  return (magic === 'WOZ1' || magic === 'WOZ2') && SIGNATURE_TAIL.every((b, i) => data[4 + i] === b);
}

const ascii = (data: Uint8Array): string => new TextDecoder().decode(data);

/**
 * Turn a flux track (transition intervals in 125 ns ticks) into bit cells at
 * `bitTiming` ticks per cell. Each transition is placed in the cell that
 * contains it, by absolute time from the start of the revolution rather than
 * by rounding each gap — so jitter and sub-cell transitions keep their real
 * position. Two transitions in one cell (a flux event faster than the cell, as
 * a weak-bit region) cannot be represented as one bit: that cell is marked in
 * `weak`, and a reader gets the read amplifier's noise there.
 */
export function fluxToBits(flux: Uint8Array, bitTiming: number): Apple2BitTrack {
  // Absolute time of each transition, with 255 meaning "255 ticks and more".
  const at: number[] = [];
  let time = 0;
  for (let i = 0; i < flux.length; i++) {
    time += flux[i];
    if (flux[i] === 255) continue;
    at.push(time);
  }
  if (at.length === 0) return { data: new Uint8Array(0), bitCount: 0 };
  const bitCount = Math.max(1, Math.ceil(time / bitTiming));
  const data = new Uint8Array((bitCount + 7) >> 3);
  let weak: Uint8Array | null = null;
  let last = -1;
  for (const t of at) {
    // A transition at time T belongs to the cell whose window is (cell-1, cell]
    // — the same cell the gap-run writer below produced for exact multiples.
    const cell = Math.min(bitCount - 1, Math.max(0, Math.floor((t - 1) / bitTiming)));
    if (cell === last) {
      weak ??= new Uint8Array(data.length);
      weak[cell >> 3] |= 0x80 >> (cell & 7);
    } else {
      data[cell >> 3] |= 0x80 >> (cell & 7);
    }
    last = cell;
  }
  return weak ? { data, bitCount, weak } : { data, bitCount };
}

/** Parse a WOZ 1 / WOZ 2 / WOZ 2.1 image. Throws on a bad header, a CRC
 *  mismatch, a missing chunk or a 3.5" disk. */
export function parseWoz(data: Uint8Array): WozImage {
  if (!isWoz(data)) throw new Error('Not a WOZ image');
  const version = data[3] === 0x31 ? 1 : 2;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const crc = view.getUint32(8, true);
  if (crc !== 0 && wozCrc32(data.subarray(12)) !== crc) {
    throw new Error('WOZ image is corrupt (CRC-32 mismatch)');
  }

  let info: Uint8Array | null = null;
  let tmapChunk: Uint8Array | null = null;
  let trks: Uint8Array | null = null;
  let flux: Uint8Array | null = null;
  let meta: string | null = null;
  for (let at = 12; at + 8 <= data.length;) {
    const id = String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
    const size = view.getUint32(at + 4, true);
    const body = data.subarray(at + 8, Math.min(data.length, at + 8 + size));
    if (id === 'INFO') info = body;
    else if (id === 'TMAP') tmapChunk = body;
    else if (id === 'TRKS') trks = body;
    else if (id === 'FLUX') flux = body;
    else if (id === 'META') meta = ascii(body);
    at += 8 + size;
  }
  if (!info || info.length < 37) throw new Error('WOZ image has no INFO chunk');
  if (!tmapChunk || tmapChunk.length < APPLE2_QUARTER_TRACKS) throw new Error('WOZ image has no TMAP chunk');
  if (!trks) throw new Error('WOZ image has no TRKS chunk');
  const infoVersion = info[0];
  if (info[1] !== 1) throw new Error('3.5" WOZ disks are not supported by the Disk ][');
  const v2 = infoVersion >= 2 && info.length >= 46;
  const bitTiming = v2 && info[39] > 0 ? info[39] : APPLE2_BIT_TIMING;

  // The TRKS entries, by index.
  const byIndex: (Apple2BitTrack | null)[] = [];
  const rawFlux: (Uint8Array | null)[] = [];
  if (version === 1) {
    const view1 = new DataView(trks.buffer, trks.byteOffset, trks.byteLength);
    for (let i = 0; (i + 1) * WOZ1_TRACK_SIZE <= trks.length; i++) {
      const base = i * WOZ1_TRACK_SIZE;
      const bitCount = Math.min(view1.getUint16(base + 6648, true), WOZ1_BITS_BYTES * 8);
      byIndex.push({ data: trks.slice(base, base + ((bitCount + 7) >> 3)), bitCount });
    }
  } else {
    const trksView = new DataView(trks.buffer, trks.byteOffset, trks.byteLength);
    for (let i = 0; i < APPLE2_QUARTER_TRACKS && (i + 1) * 8 <= trks.length; i++) {
      const startBlock = trksView.getUint16(i * 8, true);
      const blockCount = trksView.getUint16(i * 8 + 2, true);
      const count = trksView.getUint32(i * 8 + 4, true);
      const off = startBlock * BLOCK;
      if (startBlock === 0 || count === 0) { byIndex.push(null); rawFlux.push(null); continue; }
      // `count` is bits for a bit track and bytes for a flux track.
      const bytesIfBits = (count + 7) >> 3;
      const end = Math.min(data.length, off + blockCount * BLOCK);
      rawFlux.push(data.slice(off, Math.min(end, off + count)));
      if (off + bytesIfBits > data.length || bytesIfBits > blockCount * BLOCK) { byIndex.push(null); continue; }
      byIndex.push({ data: data.slice(off, off + bytesIfBits), bitCount: count });
    }
  }

  // Compact the referenced tracks into a dense list, mapping the TMAP onto it.
  const tracks: Apple2BitTrack[] = [];
  const remap = new Map<number, number>();
  const tmap = new Uint8Array(APPLE2_QUARTER_TRACKS).fill(APPLE2_NO_TRACK);
  const use = (track: Apple2BitTrack, key: number): number => {
    let at = remap.get(key);
    if (at === undefined) { at = tracks.length; tracks.push(track); remap.set(key, at); }
    return at;
  };
  for (let qt = 0; qt < APPLE2_QUARTER_TRACKS; qt++) {
    const index = tmapChunk[qt];
    const track = index === APPLE2_NO_TRACK ? null : byIndex[index] ?? null;
    if (track && track.bitCount > 0) tmap[qt] = use(track, index);
  }
  // WOZ 2.1 flux tracks take precedence over the bit tracks for their quarter tracks.
  let fluxQuarterTracks = 0;
  if (flux && version === 2 && infoVersion >= 3) {
    for (let qt = 0; qt < APPLE2_QUARTER_TRACKS && qt < flux.length; qt++) {
      const index = flux[qt];
      const bytes = index === APPLE2_NO_TRACK ? null : rawFlux[index] ?? null;
      if (!bytes || bytes.length === 0) continue;
      const key = 0x10000 + index;
      let at = remap.get(key);
      if (at === undefined) {
        at = tracks.length;
        tracks.push(fluxToBits(bytes, bitTiming));
        remap.set(key, at);
      }
      tmap[qt] = at;
      fluxQuarterTracks++;
    }
  }

  return {
    version,
    infoVersion,
    writeProtected: info[2] === 1,
    synchronized: info[3] === 1,
    cleaned: info[4] === 1,
    creator: ascii(info.subarray(5, 37)).trim(),
    bootSectorFormat: v2 ? info[38] : 0,
    bitTiming,
    compatibleHardware: v2 ? info[40] | (info[41] << 8) : 0,
    requiredRam: v2 ? info[42] | (info[43] << 8) : 0,
    tmap,
    tracks,
    fluxQuarterTracks,
    meta,
  };
}

// ── Serialize ─────────────────────────────────────────────────────────────

export interface WozWriteOptions {
  tmap: Uint8Array;
  tracks: readonly Apple2BitTrack[];
  bitTiming: number;
  writeProtected: boolean;
  synchronized?: boolean;
  cleaned?: boolean;
  creator?: string;
  bootSectorFormat?: number;
  compatibleHardware?: number;
  requiredRam?: number;
  meta?: string | null;
}

/** Write a WOZ 2 image (INFO version 2, TMAP, TRKS, optional META) with its CRC. */
export function serializeWoz(opts: WozWriteOptions): Uint8Array {
  const used = opts.tracks.length;
  if (used > APPLE2_QUARTER_TRACKS) throw new Error('A WOZ image holds at most 160 tracks');
  const blocksOf = (t: Apple2BitTrack) => Math.ceil(((t.bitCount + 7) >> 3) / BLOCK);
  let dataBlocks = 0;
  let largest = 0;
  for (const t of opts.tracks) { const b = blocksOf(t); dataBlocks += b; if (b > largest) largest = b; }
  const metaBytes = opts.meta ? new TextEncoder().encode(opts.meta) : null;
  const trksSize = 1280 + dataBlocks * BLOCK;
  const total = WOZ2_FIRST_BLOCK * BLOCK + dataBlocks * BLOCK + (metaBytes ? 8 + metaBytes.length : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const ascii4 = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };

  ascii4(0, 'WOZ2');
  out.set(SIGNATURE_TAIL, 4);

  // INFO (60 bytes).
  ascii4(12, 'INFO');
  view.setUint32(16, 60, true);
  const info = 20;
  out[info] = 2;
  out[info + 1] = 1;                                   // 5.25"
  out[info + 2] = opts.writeProtected ? 1 : 0;
  out[info + 3] = opts.synchronized ? 1 : 0;
  out[info + 4] = opts.cleaned ? 1 : 0;
  const creator = new TextEncoder().encode((opts.creator ?? 'zx84').slice(0, 32));
  out.fill(0x20, info + 5, info + 37);
  out.set(creator.subarray(0, 32), info + 5);
  out[info + 37] = 1;                                  // sides
  out[info + 38] = opts.bootSectorFormat ?? 0;
  out[info + 39] = opts.bitTiming;
  view.setUint16(info + 40, opts.compatibleHardware ?? 0, true);
  view.setUint16(info + 42, opts.requiredRam ?? 0, true);
  view.setUint16(info + 44, largest, true);

  // TMAP (160 bytes).
  ascii4(80, 'TMAP');
  view.setUint32(84, APPLE2_QUARTER_TRACKS, true);
  out.set(opts.tmap.subarray(0, APPLE2_QUARTER_TRACKS), 88);

  // TRKS: entries, then the bits block-aligned from block 3.
  ascii4(248, 'TRKS');
  view.setUint32(252, trksSize, true);
  let block = WOZ2_FIRST_BLOCK;
  opts.tracks.forEach((t, i) => {
    const entry = 256 + i * 8;
    const blocks = blocksOf(t);
    view.setUint16(entry, block, true);
    view.setUint16(entry + 2, blocks, true);
    view.setUint32(entry + 4, t.bitCount, true);
    out.set(t.data.subarray(0, (t.bitCount + 7) >> 3), block * BLOCK);
    block += blocks;
  });

  if (metaBytes) {
    const at = block * BLOCK;
    ascii4(at, 'META');
    view.setUint32(at + 4, metaBytes.length, true);
    out.set(metaBytes, at + 8);
  }

  view.setUint32(8, wozCrc32(out.subarray(12)), true);
  return out;
}
