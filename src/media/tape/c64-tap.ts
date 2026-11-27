/**
 * Commodore raw tape images (.tap, "C64-TAPE-RAW"), for the C64, the VIC-20
 * and the C16/Plus/4.
 *
 * A .tap holds the length of each level on the Datasette's read line. After
 * the 20-byte header each entry is a duration in units of 8 cycles of the
 * clock of the machine it was made on (the header's platform and video
 * standard say which: a PAL C64 unless they say otherwise); a zero entry is
 * a duration too long for a byte. Version 0 leaves the length of a zero
 * unsaid (it is taken as the longest a byte can hold); version 1 follows it
 * with the exact length in cycles as a 24-bit little-endian number.
 *
 * Versions 0 and 1 count falling edge to falling edge — one full pulse. The
 * C16/Plus/4's KERNAL instead times both halves of every dipole separately
 * and carries each bit in *which half is short*, so version 2 (Markus
 * Brenner's half-wave extension) stores one entry per level, the first being
 * a high half. Its entries count 8 cycles of a base clock of half the
 * machine's, i.e. 16 machine cycles, and a zero's exact length is in that
 * half-clock unit too (so the exact value is doubled to get machine cycles).
 * VICE's `tap.c`/`datasette.c` read it this way.
 *
 * Header: "C64-TAPE-RAW" (12 bytes), version (0/1/2), platform (0 C64,
 * 1 VIC-20, 2 C16/Plus/4), video standard (0 PAL, 1 NTSC), a reserved byte,
 * then the data length (u32 LE).
 *
 * For the shared pulse deck a version 0/1 pulse becomes two half-waves, so
 * the deck's level falls once per pulse, at its end; a version 2 entry is
 * already one half-wave. The tape is split into blocks at long silences so
 * the tape pane can list and seek them, and a block that starts with a KERNAL
 * header is named after the file in it.
 */

import { TAPE_REF_HZ, type CswBlock, type TapeBlock } from './tap.ts';

const MAGIC = 'C64-TAPE-RAW';
const HEADER_SIZE = 20;
/** The PAL C64's clock, which the pulse units are counted in by default. */
export const C64_TAP_CLOCK = 985_248;

/** The KERNAL's tape pulses, in cycles of its machine: short, medium, long. */
export interface KernalPulses {
  readonly short: number;
  readonly medium: number;
  readonly long: number;
}

/** The C16/Plus/4 KERNAL's tape levels, in its own CPU cycles. It writes the
 *  two halves of every dipole separately and carries the bit in which half is
 *  short, so these are half-wave lengths, not falling-edge-to-falling-edge
 *  pulses: a 0 is short-short-long-long, a 1 long-long-short-short and a
 *  byte's word marker marker-marker-long-long. From `tapwrt.src`'s timer
 *  latches (tshort 208, tlong 420, tbyte 846) counted in TED timer-1 ticks of
 *  two CPU cycles each. */
export interface HalfwavePulses {
  readonly short: number;
  readonly long: number;
  /** The "byte" level that opens every word marker (tbyte). */
  readonly marker: number;
}

/** The C64 KERNAL's: TAP bytes $30, $42, $56. */
export const C64_KERNAL_PULSES: KernalPulses = { short: 0x30 * 8, medium: 0x42 * 8, long: 0x56 * 8 };
/** The VIC-20 KERNAL's: TAP bytes $2C, $40, $54. Its timer constants come out
 *  at nearly the same cycle counts as the C64's, so at its faster clock the
 *  pulses are shorter in time. Measured from the VIC-20 KERNAL's own SAVE. */
export const VIC20_KERNAL_PULSES: KernalPulses = { short: 0x2C * 8, medium: 0x40 * 8, long: 0x54 * 8 };

/** The C16/Plus/4's KERNAL levels (see `HalfwavePulses`): the nominal timer
 *  latches. Its own SAVE measures a little longer (its write loop adds a few
 *  cycles per toggle), but `tapred.src` derives its sample points from the
 *  level it measures on the tape, so the nominal lengths are what to write. */
export const PLUS4_KERNAL_HALFWAVES: HalfwavePulses = { short: 416, long: 840, marker: 1692 };

/** Which machine's clock a .tap's pulses count: the header's platform and
 *  video standard bytes, and the clock they mean. */
export interface TapFormat {
  readonly platform: number;
  readonly video: number;
  /** Cycles a second of the machine the pulses are counted on. */
  readonly clock: number;
  /** The falling-edge pulses that machine's KERNAL writes (for generated
   *  tapes). Set for the C64 and the VIC-20. */
  readonly kernal?: KernalPulses;
  /** The half-wave levels that machine's KERNAL writes. Set for the machines
   *  whose tapes are version 2, the C16 and Plus/4. */
  readonly halfwave?: HalfwavePulses;
}

/** The clock a .tap's pulses count, from its platform and video standard
 *  bytes: the C64's, the VIC-20's or the C16/Plus/4's, PAL or NTSC. Anything
 *  else is taken as a PAL C64, as tapes have always been read here. */
export function tapClock(platform: number, video: number): number {
  if (platform === 1) return video === 1 ? 1_022_727 : 1_108_405;
  if (platform === 2) return video === 1 ? 1_789_772 : 1_773_447;
  if (platform === 0 && video === 1) return 1_022_727;
  return C64_TAP_CLOCK;
}

/** The KERNAL's pulse lengths for a platform, in its own clock's cycles. */
function kernalPulses(platform: number): KernalPulses {
  if (platform === 1) return VIC20_KERNAL_PULSES;
  return C64_KERNAL_PULSES;
}

export function tapFormat(platform: number, video: number): TapFormat {
  const clock = tapClock(platform, video);
  if (platform === 2) return { platform, video, clock, halfwave: PLUS4_KERNAL_HALFWAVES };
  return { platform, video, clock, kernal: kernalPulses(platform) };
}

/** The PAL C64's tapes. */
export const C64_TAP_PAL: TapFormat = tapFormat(0, 0);
/** A pulse this long (cycles) is silence on the tape: a block boundary. */
const GAP_CYCLES = 20_000;

/** A KERNAL file found on the tape. */
export interface C64TapeFile {
  /** KERNAL header type: 1 relocatable program, 3 program at a fixed
   *  address, 4 data-file header, 5 end of tape. */
  readonly type: number;
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export interface C64Tape {
  readonly version: number;
  /** Pulse lengths in cycles of `clock`. For a version-2 (half-wave) tape
   *  these are the two halves of each dipole summed, the legacy view. */
  readonly pulses: Uint32Array;
  /** The clock the pulses count (see `tapClock`). */
  readonly clock: number;
  readonly blocks: TapeBlock[];
  readonly files: readonly C64TapeFile[];
}

/** One value of a .tap body: full pulses for versions 0/1, half-waves for
 *  version 2, both in cycles of `clock`. */
export interface C64TapEntries {
  readonly version: number;
  readonly clock: number;
  /** True for version 2: each entry is one level, not a falling-edge pulse. */
  readonly halfwave: boolean;
  readonly entries: Uint32Array;
}

export function isC64Tap(data: Uint8Array): boolean {
  if (data.length < HEADER_SIZE) return false;
  for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

/** The body entries of a .tap. Throws on a malformed file. */
export function readC64TapEntries(data: Uint8Array): C64TapEntries {
  if (!isC64Tap(data)) throw new Error('not a C64 .tap');
  const version = data[12];
  if (version > 2) throw new Error(`C64 .tap version ${version} is not supported`);
  const halfwave = version === 2;
  // A version-2 entry counts 8 cycles of half the machine's clock, so it is
  // 16 machine cycles; a zero's exact 24-bit value is in that same half-clock
  // unit. Versions 0/1 count 8 machine cycles.
  const unit = halfwave ? 16 : 8;
  const exactScale = halfwave ? 2 : 1;
  const declared = data[16] | (data[17] << 8) | (data[18] << 16) | (data[19] << 24);
  const end = Math.min(data.length, HEADER_SIZE + (declared >>> 0 || data.length));
  const out = new Uint32Array(end - HEADER_SIZE);
  let n = 0;
  for (let i = HEADER_SIZE; i < end; i++) {
    const b = data[i];
    if (b !== 0) { out[n++] = b * unit; continue; }
    if (version >= 1 && i + 3 < end) {
      out[n++] = (data[i + 1] | (data[i + 2] << 8) | (data[i + 3] << 16)) * exactScale;
      i += 3;
    } else {
      out[n++] = 256 * unit;
    }
  }
  return { version, clock: tapClock(data[13], data[14]), halfwave, entries: out.subarray(0, n) };
}

/** The pulse lengths (cycles of `clock`) of a .tap. A version-2 half-wave
 *  tape's entries are paired and summed, as VICE's legacy path does. Throws
 *  on a malformed file. */
export function readC64TapPulses(data: Uint8Array): { version: number; pulses: Uint32Array; clock: number } {
  const { version, entries, clock, halfwave } = readC64TapEntries(data);
  if (!halfwave) return { version, pulses: entries, clock };
  const out = new Uint32Array(entries.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = entries[i * 2] + entries[i * 2 + 1];
  return { version, pulses: out, clock };
}

/** Parse a .tap into deck blocks. */
export function parseC64Tap(data: Uint8Array): C64Tape {
  const { clock, halfwave } = readC64TapEntries(data);
  return halfwave ? parseHalfwaveTap(data, clock) : parsePulseTap(data, clock);
}

/** Group a body into blocks at long silences, naming each from the KERNAL
 *  payload in it. `build` returns the deck's pulses for a segment and, for a
 *  half-wave stream, the level it starts at. */
function buildBlocks(
  entries: Uint32Array,
  build: (seg: Uint32Array) => { pulses: Uint32Array; startLevel?: 0 | 1 },
  payloadIn: (pulses: Uint32Array) => number[] | null,
): { blocks: TapeBlock[]; files: C64TapeFile[] } {
  const blocks: TapeBlock[] = [];
  const files: C64TapeFile[] = [];
  let start = 0;
  const flush = (end: number): void => {
    if (end <= start) return;
    const seg = entries.subarray(start, end);
    const { pulses, startLevel } = build(seg);
    const payload = payloadIn(seg);
    const file = payload ? kernalHeader(payload) : null;
    const block: CswBlock = { kind: 'csw', pulses, role: file ? 'data' : 'tone' };
    if (startLevel !== undefined) block.startLevel = startLevel;
    if (file) {
      files.push(file);
      block.label = file.type === 5 ? 'End of tape' : `"${file.name}"`;
      block.detail = file.type === 5 ? undefined
        : `${file.type === 4 ? 'data file' : 'program'} $${hex4(file.start)}-$${hex4(file.end)}`;
    } else {
      block.label = payload ? `Data (${payload.length} bytes)` : `Pulses (${seg.length})`;
      if (payload) block.role = 'data';
    }
    blocks.push(block);
    start = end;
  };
  for (let i = 0; i < entries.length; i++) {
    if (entries[i] >= GAP_CYCLES) flush(i + 1);
  }
  flush(entries.length);
  return { blocks, files };
}

/** Versions 0/1: each entry is a falling-edge-to-falling-edge pulse. The deck
 *  wants levels, so each pulse is split into two equal halves. */
function parsePulseTap(data: Uint8Array, clock: number): C64Tape {
  const { version, pulses } = readC64TapPulses(data);
  const ratio = TAPE_REF_HZ / clock;
  const { blocks, files } = buildBlocks(pulses, (seg) => {
    const half = new Uint32Array(seg.length * 2);
    for (let i = 0; i < seg.length; i++) {
      const whole = Math.max(2, Math.round(seg[i] * ratio));
      const a = whole >> 1;
      half[i * 2] = a;
      half[i * 2 + 1] = whole - a;
    }
    return { pulses: half };
  }, kernalPayload);
  return { version, pulses, clock, blocks, files };
}

/** Version 2: each entry is already one level of the C16/Plus/4's half-wave
 *  stream, so the deck gets it verbatim. The first entry is the first high
 *  half (VICE's convention), and the starting level of each block follows the
 *  parity of the half-waves before it. */
function parseHalfwaveTap(data: Uint8Array, clock: number): C64Tape {
  const { version, entries } = readC64TapEntries(data);
  const ratio = TAPE_REF_HZ / clock;
  let level: 0 | 1 = 1;
  const { blocks, files } = buildBlocks(entries, (seg) => {
    const half = new Uint32Array(seg.length);
    for (let i = 0; i < seg.length; i++) half[i] = Math.max(2, Math.round(seg[i] * ratio));
    const startLevel = level;
    if ((seg.length & 1) === 1) level = level === 1 ? 0 : 1;
    return { pulses: half, startLevel };
  }, kernalPayloadHalves);
  return { version, pulses: readC64TapPulses(data).pulses, clock, blocks, files };
}

function hex4(v: number): string { return v.toString(16).toUpperCase().padStart(4, '0'); }

// ── KERNAL format decoding (for naming blocks) ─────────────────────────────

/** KERNAL pulse classes: short (~$30), medium (~$42), long (~$56), in TAP
 *  byte units of 8 cycles. */
const SHORT_MAX = 0x3A * 8;
const MEDIUM_MAX = 0x4C * 8;
const LONG_MAX = 0x70 * 8;

function pulseClass(p: number): number {
  if (p < 0x20 * 8) return -1;
  if (p < SHORT_MAX) return 0;
  if (p < MEDIUM_MAX) return 1;
  if (p < LONG_MAX) return 2;
  return -1;
}

/**
 * The bytes of the first KERNAL-encoded run in `pulses`: each byte is a
 * long-medium marker, then eight data bits and an odd-parity bit, LSB first,
 * a 0 as short-medium and a 1 as medium-short.
 */
export function decodeKernalBytes(pulses: ArrayLike<number>, limit = 256): number[] {
  const out: number[] = [];
  let i = 0;
  const n = pulses.length;
  while (i + 19 < n && out.length < limit) {
    if (pulseClass(pulses[i]) !== 2 || pulseClass(pulses[i + 1]) !== 1) {
      if (out.length > 0) break;
      i++;
      continue;
    }
    let byte = 0;
    let ok = true;
    for (let b = 0; b < 9; b++) {
      const a = pulseClass(pulses[i + 2 + b * 2]);
      const c = pulseClass(pulses[i + 3 + b * 2]);
      let bit: number;
      if (a === 0 && c === 1) bit = 0;
      else if (a === 1 && c === 0) bit = 1;
      else { ok = false; break; }
      if (b < 8) byte |= bit << b;
    }
    if (!ok) {
      if (out.length > 0) break;
      i++;
      continue;
    }
    out.push(byte);
    i += 20;
  }
  return out;
}

/** A KERNAL block's payload is 192 bytes when it is a file header. */
const HEADER_PAYLOAD = 192;

/**
 * The KERNAL block at the start of `pulses`: its payload (after the sync
 * countdown, $89..$81 on the first copy and $09..$01 on the repeat, and
 * before the checksum), or null when the pulses are not one.
 */
function kernalPayload(pulses: Uint32Array): number[] | null {
  return payloadOf(decodeKernalBytes(pulses, 0x10000));
}

/** The same for a C16/Plus/4 half-wave block. */
function kernalPayloadHalves(halves: Uint32Array): number[] | null {
  return payloadOf(decodeKernalHalves(halves, 0x10000));
}

/** The payload of a decoded byte run: the countdown's tail and everything up
 *  to (not including) the checksum. */
function payloadOf(bytes: number[]): number[] | null {
  for (let at = 0; at + 10 < bytes.length; at++) {
    const top = bytes[at];
    if (top !== 0x89 && top !== 0x09) continue;
    let ok = true;
    for (let k = 1; k < 9; k++) if (bytes[at + k] !== top - k) { ok = false; break; }
    if (ok) return bytes.slice(at + 9, bytes.length - 1);
  }
  return null;
}

// ── KERNAL half-wave decoding (the C16/Plus/4) ─────────────────────────────

/** A half-wave stream's short level: the mean of its opening leader run, or
 *  the median of the first entries when it does not open with one. */
function halfwaveShort(halves: ArrayLike<number>): number {
  const n = halves.length;
  if (n === 0) return 0;
  const first = halves[0];
  let end = 1;
  while (end < n && end < 4096 && Math.abs(halves[end] - first) <= first * 0.15) end++;
  if (end >= 8) {
    let sum = 0;
    for (let i = 0; i < end; i++) sum += halves[i];
    return sum / end;
  }
  const sample = Array.from({ length: Math.min(64, n) }, (_, i) => halves[i]).sort((a, b) => a - b);
  return sample[sample.length >> 1] || first;
}

/** A level relative to the stream's short one: 0 short, 1 long, 2 word
 *  marker, -1 neither. The KERNAL writes the long level at about twice the
 *  short one and the marker at about four times. */
function halfwaveClass(p: number, short: number): number {
  if (p < short * 0.5) return -1;
  if (p < short * 1.5) return 0;
  if (p < short * 2.8) return 1;
  if (p < short * 6) return 2;
  return -1;
}

/**
 * The bytes of the first KERNAL-encoded half-wave run in `halves`. Each byte
 * opens with a word marker (marker, marker, long, long), then carries eight
 * data bits and an odd-parity bit, LSB first: a 0 is short, short, long, long
 * and a 1 long, long, short, short.
 */
export function decodeKernalHalves(halves: ArrayLike<number>, limit = 256): number[] {
  const out: number[] = [];
  const n = halves.length;
  const short = halfwaveShort(halves);
  if (!(short > 0)) return out;
  const cls = new Int8Array(n);
  for (let i = 0; i < n; i++) cls[i] = halfwaveClass(halves[i], short);
  let i = 0;
  while (i + 39 < n && out.length < limit) {
    if (cls[i] !== 2 || cls[i + 1] !== 2 || cls[i + 2] !== 1 || cls[i + 3] !== 1) {
      if (out.length > 0) break;
      i++;
      continue;
    }
    let byte = 0;
    let ok = true;
    for (let b = 0; b < 9; b++) {
      const j = i + 4 + b * 4;
      const a = cls[j], c = cls[j + 1], d = cls[j + 2], e = cls[j + 3];
      let bit: number;
      if (a === 0 && c === 0 && d === 1 && e === 1) bit = 0;
      else if (a === 1 && c === 1 && d === 0 && e === 0) bit = 1;
      else { ok = false; break; }
      if (b < 8) byte |= bit << b;
    }
    if (!ok) {
      if (out.length > 0) break;
      i++;
      continue;
    }
    out.push(byte);
    i += 40;
  }
  return out;
}

/** A KERNAL file header, from a block's payload. */
function kernalHeader(payload: number[]): C64TapeFile | null {
  if (payload.length !== HEADER_PAYLOAD) return null;
  const type = payload[0];
  if (type < 1 || type > 5) return null;
  let name = '';
  for (let k = 0; k < 16; k++) name += petsciiChar(payload[5 + k]);
  return { type, name: name.trimEnd(), start: payload[1] | (payload[2] << 8), end: payload[3] | (payload[4] << 8) };
}

/** A PETSCII byte as the nearest printable ASCII, for file names. */
export function petsciiChar(b: number): string {
  if (b >= 0x20 && b <= 0x5F) return String.fromCharCode(b);
  if (b >= 0xC1 && b <= 0xDA) return String.fromCharCode(b - 0x80);
  if (b === 0xA0) return ' ';
  return '?';
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Build a .tap from `pulses` in cycles of `format`'s clock. A machine with
 * `halfwave` (the C16/Plus/4) gets a version-2 file and `pulses` are its
 * levels; anyone else gets a version-1 file and `pulses` are falling-edge
 * pulses. The header names `format`'s machine. Durations too long for a byte
 * are written exactly.
 */
export function encodeC64Tap(pulses: ArrayLike<number>, format: TapFormat = C64_TAP_PAL): Uint8Array {
  const halfwave = format.halfwave !== undefined;
  // A version-2 entry counts 16 machine cycles (8 of half the clock); a
  // version-1 entry counts 8. An exact zero entry is in the same unit, so a
  // version-2 exact value is stored in half-cycles.
  const unit = halfwave ? 16 : 8;
  const exactDivisor = halfwave ? 2 : 1;
  const body: number[] = [];
  for (let i = 0; i < pulses.length; i++) {
    const p = Math.round(pulses[i]);
    const units = Math.round(p / unit);
    if (units >= 1 && units <= 255) { body.push(units); continue; }
    const c = Math.min(Math.round(p / exactDivisor), 0xFFFFFF);
    body.push(0, c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF);
  }
  const out = new Uint8Array(HEADER_SIZE + body.length);
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  out[12] = halfwave ? 2 : 1;
  out[13] = format.platform;
  out[14] = format.video;
  const len = body.length;
  out[16] = len & 0xFF; out[17] = (len >> 8) & 0xFF; out[18] = (len >> 16) & 0xFF; out[19] = (len >>> 24) & 0xFF;
  out.set(body, HEADER_SIZE);
  return out;
}

/** A program to put on a tape: its name, load address and bytes. */
export interface KernalFileInput {
  readonly name: string;
  readonly start: number;
  readonly data: Uint8Array;
}

/** Leader before a block's first copy, and between its two copies. */
const LEADER_PULSES = 3000;
const REPEAT_LEADER_PULSES = 79;
/** Silence after a block, which the tape pane splits blocks at. */
const BLOCK_GAP = 80_000;

/** A name as the 16 PETSCII bytes of a header, padded with spaces. */
function petsciiName(name: string): number[] {
  const out: number[] = [];
  for (const ch of name.slice(0, 16)) {
    const c = ch.toUpperCase().charCodeAt(0);
    out.push(c >= 0x20 && c <= 0x5F ? c : 0x3F);
  }
  while (out.length < 16) out.push(0x20);
  return out;
}

/** One KERNAL byte: the long-medium marker, eight bits LSB first, odd parity. */
function pushKernalByte(out: number[], byte: number, p: KernalPulses): void {
  out.push(p.long, p.medium);
  let ones = 0;
  for (let bit = 0; bit < 8; bit++) {
    const one = ((byte >> bit) & 1) === 1;
    if (one) ones++;
    out.push(...(one ? [p.medium, p.short] : [p.short, p.medium]));
  }
  out.push(...((ones & 1) === 0 ? [p.medium, p.short] : [p.short, p.medium]));
}

/** One copy of a block: the sync countdown, the payload, its XOR checksum and
 *  the end-of-data marker. `first` counts down from $89, the repeat from $09. */
function pushKernalCopy(out: number[], payload: ArrayLike<number>, first: boolean, p: KernalPulses): void {
  const top = first ? 0x89 : 0x09;
  for (let k = 0; k < 9; k++) pushKernalByte(out, top - k, p);
  let check = 0;
  for (let i = 0; i < payload.length; i++) {
    pushKernalByte(out, payload[i], p);
    check ^= payload[i];
  }
  pushKernalByte(out, check, p);
  out.push(p.long, p.short);
}

/** A block as the KERNAL writes it: leader, first copy, short leader, repeat. */
function pushKernalBlock(out: number[], payload: ArrayLike<number>, p: KernalPulses): void {
  for (let i = 0; i < LEADER_PULSES; i++) out.push(p.short);
  pushKernalCopy(out, payload, true, p);
  for (let i = 0; i < REPEAT_LEADER_PULSES; i++) out.push(p.short);
  pushKernalCopy(out, payload, false, p);
  out.push(BLOCK_GAP);
}

// ── The C16/Plus/4 half-wave writer ────────────────────────────────────────

/** Leader before a half-wave block's first copy, and between its copies.
 *  `tapwrt.src`'s first-pass leader is 16256 `wttt` calls (32512 toggles) and
 *  its repeat 254 (508); the KERNAL's own SAVE has 32765 halves before the
 *  first countdown marker — the odd phase its word search then expects. */
const HALFWAVE_LEADER = 32765;
const HALFWAVE_REPEAT_LEADER = 508;
/** The end-of-block leader: 194 `wttt` calls, 388 halves. */
const HALFWAVE_END_LEADER = 388;

/** One half-wave KERNAL byte: the marker-marker-long-long word marker, eight
 *  bits LSB first (0 = short-short-long-long, 1 = long-long-short-short) and
 *  an odd-parity bit. */
function pushKernalByteHalves(out: number[], byte: number, p: HalfwavePulses): void {
  out.push(p.marker, p.marker, p.long, p.long);
  let ones = 0;
  for (let bit = 0; bit < 8; bit++) {
    const one = ((byte >> bit) & 1) === 1;
    if (one) ones++;
    out.push(...(one ? [p.long, p.long, p.short, p.short] : [p.short, p.short, p.long, p.long]));
  }
  out.push(...((ones & 1) === 0
    ? [p.long, p.long, p.short, p.short]
    : [p.short, p.short, p.long, p.long]));
}

/** One half-wave copy: countdown, payload, XOR checksum and the end marker
 *  (the writer's `setupl; wttt`, i.e. two long levels). */
function pushKernalCopyHalves(out: number[], payload: ArrayLike<number>, first: boolean, p: HalfwavePulses): void {
  const top = first ? 0x89 : 0x09;
  for (let k = 0; k < 9; k++) pushKernalByteHalves(out, top - k, p);
  let check = 0;
  for (let i = 0; i < payload.length; i++) {
    pushKernalByteHalves(out, payload[i], p);
    check ^= payload[i];
  }
  pushKernalByteHalves(out, check, p);
  out.push(p.long, p.long);
}

/** A half-wave block as `tapwrt.src` writes it: leader, first copy, short
 *  leader, repeat, end leader, then a silent gap (one level, so each block
 *  holds an even number of levels and the next opens on a high half). The
 *  leader is odd — the real KERNAL's own recording has an odd number of
 *  halves there, and the reader's word search depends on that phase. */
function pushKernalBlockHalves(out: number[], payload: ArrayLike<number>, p: HalfwavePulses): void {
  for (let i = 0; i < HALFWAVE_LEADER; i++) out.push(p.short);
  pushKernalCopyHalves(out, payload, true, p);
  for (let i = 0; i < HALFWAVE_REPEAT_LEADER; i++) out.push(p.short);
  pushKernalCopyHalves(out, payload, false, p);
  for (let i = 0; i < HALFWAVE_END_LEADER; i++) out.push(p.short);
  out.push(BLOCK_GAP);
}

/**
 * A .tap holding `files` as the KERNAL would have SAVEd them: for each, a
 * 192-byte header block (type, start and end address, 16-character name) then
 * a data block with the program. A program at the start of BASIC
 * (`basicStarts`: $0801 on the 64) is a relocatable one (type 1) and any
 * other is fixed in place (type 3). Empty files are skipped. The pulses are
 * the lengths `format`'s machine's KERNAL writes, in its cycles.
 */
export function encodeKernalTap(
  files: readonly KernalFileInput[],
  format: TapFormat = C64_TAP_PAL,
  basicStarts: readonly number[] = [0x0801],
): Uint8Array {
  const pulses: number[] = [];
  const pushBlock = (payload: ArrayLike<number>): void => {
    if (format.halfwave) pushKernalBlockHalves(pulses, payload, format.halfwave);
    else if (format.kernal) pushKernalBlock(pulses, payload, format.kernal);
    else throw new Error('tape format has neither pulses nor half-waves');
  };
  for (const file of files) {
    if (file.data.length === 0) continue;
    const end = (file.start + file.data.length) & 0xFFFF;
    const header = new Array<number>(192).fill(0x20);
    header[0] = basicStarts.includes(file.start) ? 1 : 3;
    header[1] = file.start & 0xFF; header[2] = (file.start >> 8) & 0xFF;
    header[3] = end & 0xFF; header[4] = end >> 8;
    petsciiName(file.name).forEach((c, k) => { header[5 + k] = c; });
    pushBlock(header);
    pushBlock(file.data);
  }
  return encodeC64Tap(pulses, format);
}

/** Full pulses from the half-waves a recorder timed on the write line: each
 *  pair of edges is one pulse. */
export function halvesToPulses(halves: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(halves.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = halves[i * 2] + halves[i * 2 + 1];
  return out;
}
