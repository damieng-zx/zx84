/**
 * Commodore 64 raw tape images (.tap, "C64-TAPE-RAW").
 *
 * A .tap holds the time between successive falling edges of the Datasette's
 * read line — the edges that trigger CIA 1's FLAG input — so it carries
 * KERNAL and turbo-loader recordings alike. After the 20-byte header each
 * byte is a pulse length in units of 8 cycles of the PAL C64's clock;
 * a zero byte is a pulse too long for that. Version 0 leaves the length of a
 * zero unsaid (it is taken as the longest a byte can hold); version 1 follows
 * it with the exact length in cycles as a 24-bit little-endian number.
 *
 * Header: "C64-TAPE-RAW" (12 bytes), version (0/1; 2 is the C16's half-wave
 * format, not read here), platform, video standard, a reserved byte, then
 * the data length (u32 LE).
 *
 * For the shared pulse deck each pulse becomes two half-waves, so the deck's
 * level falls once per pulse, at its end. The tape is split into blocks at
 * long silences so the tape pane can list and seek them, and a block that
 * starts with a KERNAL header is named after the file in it.
 */

import { TAPE_REF_HZ, type CswBlock, type TapeBlock } from './tap.ts';

const MAGIC = 'C64-TAPE-RAW';
const HEADER_SIZE = 20;
/** The PAL C64's clock, which the pulse units are counted in. */
export const C64_TAP_CLOCK = 985_248;
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
  /** Pulse lengths in cycles. */
  readonly pulses: Uint32Array;
  readonly blocks: TapeBlock[];
  readonly files: readonly C64TapeFile[];
}

export function isC64Tap(data: Uint8Array): boolean {
  if (data.length < HEADER_SIZE) return false;
  for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

/** The pulse lengths (cycles) of a .tap. Throws on a malformed file. */
export function readC64TapPulses(data: Uint8Array): { version: number; pulses: Uint32Array } {
  if (!isC64Tap(data)) throw new Error('not a C64 .tap');
  const version = data[12];
  if (version > 1) throw new Error(`C64 .tap version ${version} is not supported`);
  const declared = data[16] | (data[17] << 8) | (data[18] << 16) | (data[19] << 24);
  const end = Math.min(data.length, HEADER_SIZE + (declared >>> 0 || data.length));
  const out = new Uint32Array(end - HEADER_SIZE);
  let n = 0;
  for (let i = HEADER_SIZE; i < end; i++) {
    const b = data[i];
    if (b !== 0) { out[n++] = b * 8; continue; }
    if (version === 1 && i + 3 < end) {
      out[n++] = data[i + 1] | (data[i + 2] << 8) | (data[i + 3] << 16);
      i += 3;
    } else {
      out[n++] = 256 * 8;
    }
  }
  return { version, pulses: out.subarray(0, n) };
}

/** Parse a .tap into deck blocks. */
export function parseC64Tap(data: Uint8Array): C64Tape {
  const { version, pulses } = readC64TapPulses(data);
  const blocks: TapeBlock[] = [];
  const files: C64TapeFile[] = [];
  const ratio = TAPE_REF_HZ / C64_TAP_CLOCK;
  let start = 0;
  const flush = (end: number): void => {
    if (end <= start) return;
    const seg = pulses.subarray(start, end);
    const half = new Uint32Array(seg.length * 2);
    for (let i = 0; i < seg.length; i++) {
      const whole = Math.max(2, Math.round(seg[i] * ratio));
      const a = whole >> 1;
      half[i * 2] = a;
      half[i * 2 + 1] = whole - a;
    }
    const payload = kernalPayload(seg);
    const file = payload ? kernalHeader(payload) : null;
    const block: CswBlock = { kind: 'csw', pulses: half, role: file ? 'data' : 'tone' };
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
  for (let i = 0; i < pulses.length; i++) {
    if (pulses[i] >= GAP_CYCLES) flush(i + 1);
  }
  flush(pulses.length);
  return { version, pulses, blocks, files };
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
  const bytes = decodeKernalBytes(pulses, 0x10000);
  for (let at = 0; at + 10 < bytes.length; at++) {
    const top = bytes[at];
    if (top !== 0x89 && top !== 0x09) continue;
    let ok = true;
    for (let k = 1; k < 9; k++) if (bytes[at + k] !== top - k) { ok = false; break; }
    if (ok) return bytes.slice(at + 9, bytes.length - 1);
  }
  return null;
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
 * Build a version-1 .tap from full pulse lengths in cycles (falling edge to
 * falling edge). Pulses too long for a byte are written exactly.
 */
export function encodeC64Tap(pulses: ArrayLike<number>): Uint8Array {
  const body: number[] = [];
  for (let i = 0; i < pulses.length; i++) {
    const p = Math.round(pulses[i]);
    const units = Math.round(p / 8);
    if (units >= 1 && units <= 255) { body.push(units); continue; }
    const c = Math.min(p, 0xFFFFFF);
    body.push(0, c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF);
  }
  const out = new Uint8Array(HEADER_SIZE + body.length);
  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  out[12] = 1;
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

/** The KERNAL's pulse lengths in cycles: short, medium and long. */
const PULSE_SHORT = 0x30 * 8;
const PULSE_MEDIUM = 0x42 * 8;
const PULSE_LONG = 0x56 * 8;
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
function pushKernalByte(out: number[], byte: number): void {
  out.push(PULSE_LONG, PULSE_MEDIUM);
  let ones = 0;
  for (let bit = 0; bit < 8; bit++) {
    const one = ((byte >> bit) & 1) === 1;
    if (one) ones++;
    out.push(...(one ? [PULSE_MEDIUM, PULSE_SHORT] : [PULSE_SHORT, PULSE_MEDIUM]));
  }
  out.push(...((ones & 1) === 0 ? [PULSE_MEDIUM, PULSE_SHORT] : [PULSE_SHORT, PULSE_MEDIUM]));
}

/** One copy of a block: the sync countdown, the payload, its XOR checksum and
 *  the end-of-data marker. `first` counts down from $89, the repeat from $09. */
function pushKernalCopy(out: number[], payload: ArrayLike<number>, first: boolean): void {
  const top = first ? 0x89 : 0x09;
  for (let k = 0; k < 9; k++) pushKernalByte(out, top - k);
  let check = 0;
  for (let i = 0; i < payload.length; i++) {
    pushKernalByte(out, payload[i]);
    check ^= payload[i];
  }
  pushKernalByte(out, check);
  out.push(PULSE_LONG, PULSE_SHORT);
}

/** A block as the KERNAL writes it: leader, first copy, short leader, repeat. */
function pushKernalBlock(out: number[], payload: ArrayLike<number>): void {
  for (let i = 0; i < LEADER_PULSES; i++) out.push(PULSE_SHORT);
  pushKernalCopy(out, payload, true);
  for (let i = 0; i < REPEAT_LEADER_PULSES; i++) out.push(PULSE_SHORT);
  pushKernalCopy(out, payload, false);
  out.push(BLOCK_GAP);
}

/**
 * A .tap holding `files` as the KERNAL would have SAVEd them: for each, a
 * 192-byte header block (type, start and end address, 16-character name) then
 * a data block with the program. A program at $0801 is a relocatable one
 * (type 1) and any other is fixed in place (type 3). Empty files are skipped.
 */
export function encodeKernalTap(files: readonly KernalFileInput[]): Uint8Array {
  const pulses: number[] = [];
  for (const file of files) {
    if (file.data.length === 0) continue;
    const end = (file.start + file.data.length) & 0xFFFF;
    const header = new Array<number>(192).fill(0x20);
    header[0] = file.start === 0x0801 ? 1 : 3;
    header[1] = file.start & 0xFF; header[2] = (file.start >> 8) & 0xFF;
    header[3] = end & 0xFF; header[4] = end >> 8;
    petsciiName(file.name).forEach((c, k) => { header[5 + k] = c; });
    pushKernalBlock(pulses, header);
    pushKernalBlock(pulses, file.data);
  }
  return encodeC64Tap(pulses);
}

/** Full pulses from the half-waves a recorder timed on the write line: each
 *  pair of edges is one pulse. */
export function halvesToPulses(halves: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(halves.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = halves[i * 2] + halves[i * 2 + 1];
  return out;
}
