/**
 * Camputers Lynx .TAP — the container the Pale and Jynx emulators use.
 *
 * It shares an extension with the ZX Spectrum's .TAP and nothing else. There
 * are no length prefixes and no checksums at the container level: the file is
 * the tape's *byte* stream with the leader tones left out, one entry after
 * another, each shaped like this:
 *
 *     ["NAME"]        the program name in quotes — optional, some files
 *                     carry only the data entry
 *     <type>          'A', 'B' or 'M'
 *     <data...>       length implied by the type and a 16-bit field inside it
 *     [00 00 ...]     some files pad with zeroes
 *
 * A tape also carries a leader the file does not: 555 zero bytes and an A5
 * sync byte before the name, and again before the data. This module puts them
 * back, because the ROM needs them to find the bit clock.
 *
 * On the wire each byte is eight bits, most significant first, with no start
 * or stop bit. A bit is one square-wave cycle whose width says which bit it
 * is — a 1 is twice as wide as a 0 — which the shared pulse deck expresses
 * directly as a pure-data block with no pilot or sync of its own.
 *
 * Structure and sizes are MAME's `formats/camplynx_cas.cpp`, checked against
 * the TOSEC images: "Lynx Invaders" is a 10-byte name entry plus a 12299-byte
 * 'M' entry, which is exactly its 12309 bytes.
 */

import type { DataBlock, TapeBlock } from '@/media/tape/tap.ts';
import { TAPE_REF_HZ } from '@/media/tape/tap.ts';

/** The sync byte that ends each leader. */
const SYNC_BYTE = 0xa5;
/** Zero bytes of leader before each sync byte, as MAME writes them. */
const LEADER_BYTES = 555;

const QUOTE = 0x22;

/** Sample rates the two boards record and replay at. The 128K runs its tape
 *  at twice the speed, so its bit cells are half as wide. */
export const LYNX_TAPE_HZ_48 = 4000;
export const LYNX_TAPE_HZ_128 = 8000;

/** What kind of file an entry holds. The letter is what the ROM stores. */
export type LynxFileType = 'A' | 'B' | 'M';

export interface LynxTapEntry {
  /** The name in quotes, or '' when the entry has no name block. */
  readonly name: string;
  readonly type: LynxFileType;
  /** The command that loads it: BASIC takes LOAD, machine code takes MLOAD. */
  readonly command: string;
  /** Bytes of the data entry, type letter included. */
  readonly bytes: Uint8Array;
}

/** A parsed tape: what is on it, and the blocks that play it. */
export interface LynxTape {
  readonly entries: readonly LynxTapEntry[];
  readonly blocks: TapeBlock[];
}

function u16le(data: Uint8Array, at: number): number {
  return data[at] | (data[at + 1] << 8);
}

/**
 * How long an entry is, including its type letter.
 *
 * Each type keeps a 16-bit length somewhere inside its own header and adds a
 * fixed number of bytes around it; the constants are MAME's.
 */
function entrySize(data: Uint8Array, at: number): number | null {
  switch (data[at]) {
    case 0x41: return 5 + u16le(data, at + 3) + 12;   // 'A'
    case 0x42: return 3 + u16le(data, at + 1) + 3;    // 'B'
    case 0x4d: return 3 + u16le(data, at + 1) + 7;    // 'M'
    default: return null;
  }
}

/** The pane's type word for a Lynx file type, Spectrum-style. B is a BASIC
 *  program, M is machine code (saved and loaded via the monitor's MLOAD); A is
 *  the monitor's other data entry, which the Spectrum would call DATA. */
function fileTypeName(type: LynxFileType): string {
  return type === 'B' ? 'BASIC' : type === 'M' ? 'CODE' : 'DATA';
}

/** One pure-data block: a leader, the sync byte, then these bytes. */
function block(payload: Uint8Array, bit0: number, bit1: number, pauseMs: number): DataBlock {
  const bytes = new Uint8Array(LEADER_BYTES + 1 + payload.length);
  bytes[LEADER_BYTES] = SYNC_BYTE;          // the leader itself is already zero
  bytes.set(payload, LEADER_BYTES + 1);
  return {
    kind: 'data',
    flag: payload[0] ?? 0,
    data: bytes,
    rawBytes: bytes,
    pause: pauseMs,
    pilotPulse: 0,
    syncPulse1: 0,
    syncPulse2: 0,
    bit0Pulse: bit0,
    bit1Pulse: bit1,
    pilotCount: 0,        // pure data: the leader above is part of the stream
    usedBits: 8,
    source: 'pure-data',
  };
}

/**
 * Parse a Lynx .tap.
 *
 * `sampleHz` is the board's tape rate — 4kHz on the 48K and 96K, 8kHz on the
 * 128K. Pulse widths come out in the deck's 3.5MHz reference units, which it
 * scales to whatever the machine's clock actually is.
 */
export function parseLynxTap(data: Uint8Array, sampleHz = LYNX_TAPE_HZ_48): LynxTape {
  // A 0 bit is two samples high then two low; a 1 bit is four and four. The
  // deck wants the half-cycle, so that is 2 and 4 samples.
  const perSample = TAPE_REF_HZ / sampleHz;
  const bit0 = Math.round(2 * perSample);
  const bit1 = Math.round(4 * perSample);

  const entries: LynxTapEntry[] = [];
  const blocks: TapeBlock[] = [];
  let at = 0;

  while (at < data.length) {
    // Some images carry a stray sync byte between entries.
    while (at < data.length && data[at] === SYNC_BYTE) at++;
    if (at >= data.length) break;

    let name = '';
    let nameBlock: DataBlock | null = null;
    if (data[at] === QUOTE) {
      const start = at++;
      while (at < data.length && data[at] !== QUOTE) {
        name += String.fromCharCode(data[at]);
        at++;
      }
      if (at >= data.length) break;         // unterminated name: a truncated file
      at++;                                 // the closing quote
      nameBlock = block(data.subarray(start, at), bit0, bit1, 200);
      blocks.push(nameBlock);
    }

    const size = entrySize(data, at);
    if (size === null || size <= 0) break;  // not something this format describes
    const bytes = data.subarray(at, Math.min(at + size, data.length));
    at += size;

    const type = String.fromCharCode(bytes[0]) as LynxFileType;
    const command = type === 'M' ? 'MLOAD' : 'LOAD';
    const typeName = fileTypeName(type);
    const dataBlock = block(bytes, bit0, bit1, 1000);
    // Tag both entries with the file identity the tape pane lists. The name
    // block is the header the data block pairs with; an entry with no name is
    // its own header so it still shows as a file rather than a byte count.
    const file = { name, type, typeName, command, size: bytes.length };
    if (nameBlock) {
      nameBlock.file = { ...file, header: true };
      dataBlock.file = { ...file, header: false };
    } else {
      dataBlock.file = { ...file, header: true };
    }
    entries.push({ name, type, command, bytes });
    blocks.push(dataBlock);

    // Trailing padding belongs to no entry.
    while (at < data.length && data[at] === 0x00) at++;
  }

  return { entries, blocks };
}

/** Whether these bytes look like a Lynx tape rather than someone else's .tap. */
export function isLynxTap(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  let at = 0;
  while (at < data.length && data[at] === SYNC_BYTE) at++;
  if (data[at] === QUOTE) {
    at++;
    // A name is printable and ends in a quote within a sane distance.
    for (let n = 0; n < 32 && at < data.length; n++, at++) {
      if (data[at] === QUOTE) { at++; break; }
      if (data[at] < 0x20 || data[at] > 0x7e) return false;
    }
  }
  const size = entrySize(data, at);
  return size !== null && at + size <= data.length + 8;
}

// ── Recording: what the ROM SAVEd, back to a .tap ─────────────────────────

/** A leader must run at least this many half-cycles to count as one. The ROM
 *  writes 555 zero bytes (8880 half-cycles); this only has to reject the odd
 *  stray edge. */
const MIN_LEADER_PULSES = 64;
/** A leader half-cycle may stray this far from the leader's running mean. */
const LEADER_TOLERANCE = 0.4;
/** Half-cycles are classed against the leader's (a 0 bit's) half-cycle: below
 *  1.5x is a 0 half, below 3x a 1 half (nominally 2x), and anything longer is
 *  the silence after the block. */
const ONE_THRESHOLD = 1.5;
const GAP_THRESHOLD = 3;

/**
 * Decode a capture of the cassette output — the times between successive
 * edges, in any clock unit — into the blocks the ROM wrote: each is the bytes
 * after the leader's A5 sync byte.
 *
 * The decoder takes its bit timing from each leader rather than a fixed
 * rate, so the 48K's 4kHz and the 128K's 8kHz tapes (and the ROM's other
 * TAPE speeds) decode alike. A bit is one cycle — two equal half-cycles, a 1
 * twice as wide as a 0 — so the first wide half-cycle after the leader is
 * the first half of the sync byte's leading 1, which fixes the bit phase.
 */
export function decodeLynxSavePulses(pulses: ArrayLike<number>): Uint8Array[] {
  const out: Uint8Array[] = [];
  const n = pulses.length;
  let i = 0;
  while (i < n) {
    // Leader: a run of near-equal half-cycles.
    const start = i;
    let sum = 0;
    let count = 0;
    while (i < n) {
      const p = pulses[i];
      if (count > 0) {
        const mean = sum / count;
        if (p < mean * (1 - LEADER_TOLERANCE) || p > mean * (1 + LEADER_TOLERANCE)) break;
      }
      sum += p;
      count++;
      i++;
    }
    if (count < MIN_LEADER_PULSES) {
      i = start + Math.max(count, 1);
      continue;
    }
    const half0 = sum / count;
    const oneAt = half0 * ONE_THRESHOLD;
    const gapAt = half0 * GAP_THRESHOLD;
    const classify = (p: number): number => (p < oneAt ? 0 : p < gapAt ? 1 : -1);

    // The leader must end on a wide half-cycle: the sync byte's first bit.
    if (i >= n || classify(pulses[i]) !== 1) continue;

    const bytes: number[] = [];
    let acc = 0;
    let bits = 0;
    while (i < n) {
      const a = classify(pulses[i]);
      if (a < 0) break;                               // silence: block over
      const b = i + 1 < n ? classify(pulses[i + 1]) : -1;
      if (b >= 0 && b !== a) break;                   // halves disagree: not a bit
      acc = ((acc << 1) | a) & 0xFF;
      // A final half-cycle that nothing ended still finishes its bit.
      i += b < 0 ? 1 : 2;
      if (++bits === 8) {
        bytes.push(acc);
        acc = 0;
        bits = 0;
      }
      if (b < 0) break;
    }
    if (bytes.length >= 2 && bytes[0] === SYNC_BYTE) out.push(Uint8Array.from(bytes.slice(1)));
  }
  return out;
}

/**
 * Assemble decoded blocks into a .tap: a quoted name block is kept only when
 * a data entry follows it, and each data entry is cut to the size its own
 * header gives (the ROM may run the block on past it). Blocks that are
 * neither — or an entry shorter than its header says — are dropped. Returns
 * null when nothing usable remains.
 */
export function encodeLynxTap(blocks: readonly Uint8Array[]): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let name: Uint8Array | null = null;
  for (const b of blocks) {
    if (b.length >= 2 && b[0] === QUOTE) {
      const close = b.indexOf(QUOTE, 1);
      name = close > 0 ? b.subarray(0, close + 1) : null;
      continue;
    }
    const size = b.length >= 3 ? entrySize(b, 0) : null;
    if (size !== null && size > 0 && size <= b.length) {
      if (name) parts.push(name);
      parts.push(b.subarray(0, size));
    }
    name = null;
  }
  if (parts.length === 0) return null;
  const total = parts.reduce((s, p) => s + p.length, 0);
  const tap = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { tap.set(p, at); at += p.length; }
  return tap;
}
