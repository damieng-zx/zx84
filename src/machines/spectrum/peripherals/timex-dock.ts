/**
 * Timex 2068 dock cartridges, and the `.dck` file format that holds them.
 *
 * A `.dck` file is a run of banks. Each starts with nine bytes: a bank id, then one
 * type byte for each of the eight 8K chunks the bank covers (the first is
 * 0x0000-0x1FFF). The chunks the types say have an image follow, in order, 8192
 * bytes each, then the next bank's header.
 *
 *   bank id     0 = DOCK (what port 0xF4 swaps in with port 0xFF bit 7 clear)
 *               254 = EXROM (the same, with bit 7 set: overrides the built-in EXROM)
 *               255 = HOME (replaces the HOME ROM: a cartridge carrying its own ROM)
 *               1-253 are reserved, and their banks are skipped
 *   chunk type  0 = nothing there (a DOCK chunk reads 0xFF; EXROM and HOME fall
 *                   back to what the machine has)
 *               1 = RAM, no image in the file (starts zeroed)
 *               2 = ROM, image follows
 *               3 = RAM, image follows (its initial contents)
 *   Bit 0 of the type is "writable" and bit 1 is "has an image".
 */

import type { DockCartridge, MemoryChunk } from '@/machines/spectrum/timex-mmu.ts';
import { CHUNK_COUNT, CHUNK_SIZE } from '@/machines/spectrum/timex-mmu.ts';

const BANK_DOCK = 0;
const BANK_EXROM = 254;
const BANK_HOME = 255;
const HEADER_SIZE = 1 + CHUNK_COUNT;

const WRITABLE = 0x01;
const HAS_IMAGE = 0x02;

/** Parse a `.dck` file, or throw an Error saying what is wrong with it. */
export function parseDck(data: Uint8Array, name: string): DockCartridge {
  const dock: (MemoryChunk | null)[] = new Array<MemoryChunk | null>(CHUNK_COUNT).fill(null);
  const exrom: (MemoryChunk | null)[] = new Array<MemoryChunk | null>(CHUNK_COUNT).fill(null);
  const home: (MemoryChunk | null)[] = new Array<MemoryChunk | null>(CHUNK_COUNT).fill(null);
  if (data.length < HEADER_SIZE) throw new Error('Not a dock cartridge: the file is too short');

  let at = 0;
  let banks = 0;
  while (at < data.length) {
    if (data.length - at < HEADER_SIZE) throw new Error('Dock cartridge is truncated: a bank header is cut short');
    const id = data[at];
    const types = data.subarray(at + 1, at + HEADER_SIZE);
    at += HEADER_SIZE;
    const target = id === BANK_DOCK ? dock : id === BANK_EXROM ? exrom : id === BANK_HOME ? home : null;
    for (let chunk = 0; chunk < CHUNK_COUNT; chunk++) {
      const type = types[chunk];
      if (type > (WRITABLE | HAS_IMAGE)) throw new Error(`Dock cartridge has an unknown chunk type ${type}`);
      let bytes: Uint8Array;
      if ((type & HAS_IMAGE) !== 0) {
        if (data.length - at < CHUNK_SIZE) throw new Error('Dock cartridge is truncated: a chunk image is cut short');
        bytes = data.slice(at, at + CHUNK_SIZE);
        at += CHUNK_SIZE;
      } else {
        bytes = new Uint8Array(CHUNK_SIZE);
      }
      // Type 0 is "nothing here"; every other type is memory.
      if (target !== null && type !== 0) target[chunk] = { data: bytes, writable: (type & WRITABLE) !== 0 };
    }
    banks++;
  }
  if (banks === 0) throw new Error('Not a dock cartridge: no banks');
  return { name, dock, exrom, home };
}

/** True when the cartridge has anything in it the machine can map in. */
export function dockCartridgeIsEmpty(cart: DockCartridge): boolean {
  return ![...cart.dock, ...cart.exrom, ...cart.home].some((c) => c !== null);
}
