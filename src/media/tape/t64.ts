/**
 * Commodore 64 tape archives (.t64) and bare program files (.prg).
 *
 * A .t64 is not a recording but a container of files as a tape would hold
 * them: a 64-byte header ("C64" signature, version, directory size, entries
 * used, tape name), then 32-byte directory entries — entry type (1 = normal
 * file), C64 file type, start and end address, offset into the archive and a
 * 16-character PETSCII name. Many archives were written with wrong end
 * addresses, so a file's length is taken from the offsets where they disagree.
 *
 * A .prg is the file itself: a two-byte load address, then the bytes.
 */

import { petsciiChar } from './c64-tap.ts';

export interface C64Program {
  readonly name: string;
  /** Load address. */
  readonly start: number;
  /** The program bytes (without the load address). */
  readonly data: Uint8Array;
}

export function isT64(data: Uint8Array): boolean {
  if (data.length < 64) return false;
  const sig = String.fromCharCode(...data.subarray(0, 3));
  return sig === 'C64';
}

/** The programs in a .t64, in directory order. */
export function parseT64(data: Uint8Array): C64Program[] {
  if (!isT64(data)) throw new Error('not a .t64 archive');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const maxEntries = Math.max(1, view.getUint16(0x22, true));
  const entries: { name: string; start: number; end: number; offset: number }[] = [];
  for (let i = 0; i < maxEntries; i++) {
    const at = 0x40 + i * 32;
    if (at + 32 > data.length) break;
    if (data[at] === 0) continue;
    const start = view.getUint16(at + 2, true);
    const end = view.getUint16(at + 4, true);
    const offset = view.getUint32(at + 8, true);
    let name = '';
    for (let k = 0; k < 16; k++) name += petsciiChar(data[at + 0x10 + k]);
    if (offset >= data.length) continue;
    entries.push({ name: name.trimEnd(), start, end, offset });
  }
  const offsets = entries.map(e => e.offset).sort((a, b) => a - b);
  return entries.map(e => {
    const next = offsets.find(o => o > e.offset) ?? data.length;
    const claimed = e.end > e.start ? e.end - e.start : 0;
    const room = next - e.offset;
    const length = claimed > 0 && claimed <= room ? claimed : room;
    return { name: e.name, start: e.start, data: data.slice(e.offset, e.offset + length) };
  });
}

/** A .prg as a program. */
export function parsePrg(data: Uint8Array, name: string): C64Program {
  if (data.length < 3) throw new Error('a .prg needs a load address and at least one byte');
  return { name, start: data[0] | (data[1] << 8), data: data.slice(2) };
}
