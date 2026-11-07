/**
 * Apple II 5.25" disks as the Disk II drive sees them: a stream of bit cells
 * per track, one bit every 4 µs as the disk turns past the head.
 *
 * A `1` cell is a flux transition and a `0` cell is none; a disk byte
 * ("nibble") is eight cells starting with a 1, and the self-sync bytes of the
 * gaps are `$FF` followed by two 0 cells, ten in all. Every image format ends up
 * here: sector images (`.dsk`/`.po`/`.d13`/`.2mg`) are nibblized into standard
 * tracks, `.nib` tracks are widened back into bit cells, and `.woz` stores this
 * representation directly. The tracks hang off a quarter-track map, as in WOZ:
 * the head can stop on any of 160 quarter-track positions (0 to 39.75), and
 * each position either names a track or is blank (`0xFF`).
 *
 * Bits are packed most significant first: cell `i` is
 * `(data[i >> 3] >> (7 - (i & 7))) & 1` — the WOZ packing.
 */

import {
  APPLE2_TRACK_NIBBLES, decodeNibbleSectors, layoutTrack, type Apple2TrackGaps,
} from './apple2.ts';

/** Quarter-track positions the head can stop on: tracks 0 to 39.75. */
export const APPLE2_QUARTER_TRACKS = 160;
/** No track at this quarter-track position (WOZ TMAP convention). */
export const APPLE2_NO_TRACK = 0xFF;
/** A bit cell's length in the WOZ "optimal bit timing" unit of 125 ns: 32 is
 *  the Disk II's 4 µs cell. The controller's state machine runs at 2 MHz from
 *  the same crystal as the CPU, so a cell is 8 state-machine clocks = 4 CPU
 *  cycles exactly, and one CPU cycle is 8 of these units. */
export const APPLE2_BIT_TIMING = 32;
/** CPU cycles are this many bit-timing units. */
export const APPLE2_TIMING_UNITS_PER_CYCLE = 8;
/** Bit cells in one revolution at 300 RPM, 4 CPU cycles per cell: 0.2 s ×
 *  1,022,727 Hz ÷ 4. Synthesised and newly written tracks are this long. */
export const APPLE2_TRACK_BITS = 51136;

export interface Apple2BitTrack {
  /** Bit cells, packed most significant bit first. */
  data: Uint8Array;
  /** Cells in one revolution (the last byte may be partly used). */
  bitCount: number;
}

export interface Apple2BitDisk {
  /** Quarter-track position → index into `tracks`, or {@link APPLE2_NO_TRACK}. */
  tmap: Uint8Array;
  tracks: Apple2BitTrack[];
  /** Bit-cell length in 125 ns units (32 = 4 µs). */
  bitTiming: number;
  /** The disk's write-protect notch is covered. */
  writeProtected: boolean;
}

/** One cell of a bit track. */
export function bitAt(track: Apple2BitTrack, index: number): number {
  return (track.data[index >> 3] >> (7 - (index & 7))) & 1;
}

/** Appends bit cells to a growing buffer. */
export class Apple2BitWriter {
  private buf = new Uint8Array(8192);
  bitCount = 0;

  /** The low `bits` bits of `value`, most significant first. */
  push(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) this.put((value >> i) & 1);
  }

  put(bit: number): void {
    const byte = this.bitCount >> 3;
    if (byte >= this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    if (bit) this.buf[byte] |= 0x80 >> (this.bitCount & 7);
    this.bitCount++;
  }

  /** A disk byte: eight cells. */
  byte(value: number): void { this.push(value & 0xFF, 8); }

  /** Self-sync bytes: `$FF` then two 0 cells, so a reader that has fallen out
   *  of step drops back into byte alignment within a few of them. */
  sync(count: number): void { for (let i = 0; i < count; i++) this.push(0x3FC, 10); }

  finish(): Apple2BitTrack {
    return { data: this.buf.slice(0, (this.bitCount + 7) >> 3), bitCount: this.bitCount };
  }
}

/** Gaps of a nibblized track: gap 3 is short enough that 16 sectors, with
 *  ten-cell sync bytes, fit in one {@link APPLE2_TRACK_BITS} revolution. */
const BIT_TRACK_GAPS: Apple2TrackGaps = { gap1: 48, gap2: 6, gap3: 20 };

/**
 * Nibblize a formatted track (physical sector order) into bit cells, with real
 * ten-cell self-sync bytes in the gaps, padded with more sync to one revolution.
 */
export function encodeTrackBits(
  sectors: readonly (Uint8Array | null)[],
  track: number,
  volume: number,
  sectorsPerTrack: 13 | 16,
): Apple2BitTrack {
  const w = new Apple2BitWriter();
  layoutTrack(w, sectors, track, volume, sectorsPerTrack, BIT_TRACK_GAPS);
  while (w.bitCount + 10 <= APPLE2_TRACK_BITS) w.sync(1);
  return w.finish();
}

/** An unformatted track: one revolution with no flux transitions, which a
 *  drive reads as noise. */
export function blankBitTrack(bitCount = APPLE2_TRACK_BITS): Apple2BitTrack {
  return { data: new Uint8Array((bitCount + 7) >> 3), bitCount };
}

/**
 * The disk bytes a reader sees in `count` cells from `start` (wrapping round
 * the track): bits shift in until the top bit is set, and a finished byte is
 * held through 0 cells until the next 1 cell starts the next — the Disk II
 * data latch with an ideal read channel (no noise on long zero runs).
 */
export function nibblesFromBits(track: Apple2BitTrack, start: number, count: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(count / 8) + 1);
  let n = 0;
  let reg = 0;
  const len = track.bitCount;
  if (len === 0) return out.subarray(0, 0);
  let pos = start % len;
  for (let i = 0; i < count; i++) {
    const bit = (track.data[pos >> 3] >> (7 - (pos & 7))) & 1;
    if (++pos === len) pos = 0;
    if (reg & 0x80) {
      if (!bit) continue;
      reg = 0;
    }
    reg = (reg << 1) | bit;
    if (reg & 0x80) out[n++] = reg;
  }
  return out.subarray(0, n);
}

/** Decode the standard sectors on a bit track, reading two revolutions so a
 *  sector that straddles the index is found whole. Physical order. */
export function decodeBitTrack(track: Apple2BitTrack, sectorsPerTrack: 13 | 16): (Uint8Array | null)[] {
  return decodeNibbleSectors(nibblesFromBits(track, 0, track.bitCount * 2), sectorsPerTrack, false);
}

/**
 * Turn a raw nibble track (a `.nib` track: one byte per disk byte, no record
 * of the 0 cells after each sync byte) back into bit cells. The `$FF`s of the
 * gaps are widened into ten-cell self-sync bytes; the ones inside an address
 * or data field are code bytes and stay eight cells. The stream is started at
 * the first field prologue so that no field is split across the track's end.
 */
export function nibToBitTrack(nibbles: Uint8Array): Apple2BitTrack {
  const n = nibbles.length;
  const w = new Apple2BitWriter();
  if (n === 0) return w.finish();
  const at = (i: number) => nibbles[i % n];
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (at(i) === 0xD5 && at(i + 1) === 0xAA) { start = i; break; }
  }
  // A 13-sector track has 411-byte data fields; look at its address marks.
  let thirteen = false;
  for (let i = 0; i < n; i++) {
    if (at(i) === 0xD5 && at(i + 1) === 0xAA) {
      if (at(i + 2) === 0xB5) { thirteen = true; break; }
      if (at(i + 2) === 0x96) break;
    }
  }
  let field = 0;          // disk bytes left in the field being copied
  for (let k = 0; k < n; k++) {
    const i = start + k;
    const b = at(i);
    if (field > 0) {
      field--;
      w.byte(b);
      continue;
    }
    if (b === 0xD5 && at(i + 1) === 0xAA) {
      const mark = at(i + 2);
      if (mark === 0x96 || mark === 0xB5) field = 2 + 8 + 3;              // mark, vol trk sec chk, epilogue
      else if (mark === 0xAD) field = 2 + (thirteen ? 411 : 343) + 3;
      w.byte(b);
      continue;
    }
    if (b === 0xFF) w.sync(1);
    else w.byte(b);
  }
  return w.finish();
}

/** One revolution of a bit track as `length` nibbles: the bytes a reader
 *  collects, cut or padded with `$FF` to the `.nib` track length. */
export function bitTrackToNib(track: Apple2BitTrack, length = APPLE2_TRACK_NIBBLES): Uint8Array {
  const out = new Uint8Array(length).fill(0xFF);
  const nibbles = nibblesFromBits(track, 0, track.bitCount);
  out.set(nibbles.subarray(0, length));
  return out;
}

/**
 * The quarter-track map of a disk whose whole track t is `tracks[t]`: as in the
 * WOZ images of standard disks, the quarter tracks either side of a track
 * (t - 0.25, t + 0.25) read the same track, and the half tracks are blank.
 */
export function standardTmap(numTracks: number): Uint8Array {
  const tmap = new Uint8Array(APPLE2_QUARTER_TRACKS).fill(APPLE2_NO_TRACK);
  for (let t = 0; t < numTracks; t++) {
    for (const qt of [4 * t - 1, 4 * t, 4 * t + 1]) {
      if (qt >= 0 && qt < APPLE2_QUARTER_TRACKS) tmap[qt] = t;
    }
  }
  return tmap;
}
