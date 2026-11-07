/**
 * A parsed tape (`TapeBlock[]`) written into a machine snapshot and read back.
 *
 * The blocks are plain objects of numbers, strings and byte/pulse arrays, so
 * each is stored as JSON with its typed arrays taken out and written as raw
 * bytes alongside (a CSW capture is millions of pulses; JSON would bloat it
 * several times over). What comes back is equal block for block, so a deck
 * restored onto it plays the same edges at the same times.
 */

import type { TapeBlock } from './tap.ts';
import type { StateSink, StateSource } from '@/utils/state-stream.ts';

const U8 = 1;
const U32 = 2;

/** Largest typed array a snapshot will accept (a corrupt length is refused). */
const MAX_ARRAY = 1 << 28;

export function writeTapeBlocks(w: StateSink, blocks: readonly TapeBlock[]): void {
  w.u32(blocks.length);
  for (const block of blocks) {
    const arrays: (Uint8Array | Uint32Array)[] = [];
    const json = JSON.stringify(block, (_key, value: unknown) => {
      if (value instanceof Uint8Array || value instanceof Uint32Array) {
        arrays.push(value);
        return { $array: arrays.length - 1 };
      }
      return value;
    });
    w.str(json);
    w.u32(arrays.length);
    for (const a of arrays) {
      if (a instanceof Uint8Array) {
        w.u8(U8);
        w.bytes(a);
      } else {
        w.u8(U32);
        w.u32(a.length);
        for (let i = 0; i < a.length; i++) w.u32(a[i]);
      }
    }
  }
}

export function readTapeBlocks(r: StateSource): TapeBlock[] {
  const blocks: TapeBlock[] = [];
  for (let n = r.u32(); n > 0; n--) {
    const json = new TextDecoder().decode(r.bytes(1 << 24));
    const arrays: (Uint8Array | Uint32Array)[] = [];
    for (let k = r.u32(); k > 0; k--) {
      const type = r.u8();
      if (type === U8) {
        arrays.push(r.bytes(MAX_ARRAY));
      } else if (type === U32) {
        const len = r.u32();
        if (len > MAX_ARRAY / 4) throw new Error('Snapshot is corrupt (tape)');
        const a = new Uint32Array(len);
        for (let i = 0; i < len; i++) a[i] = r.u32();
        arrays.push(a);
      } else {
        throw new Error('Snapshot is corrupt (tape)');
      }
    }
    const block = JSON.parse(json, (_key, value: unknown) => {
      if (value !== null && typeof value === 'object' && '$array' in value) {
        const a = arrays[(value as { $array: number }).$array];
        if (!a) throw new Error('Snapshot is corrupt (tape)');
        return a;
      }
      return value;
    }) as TapeBlock;
    if (typeof block !== 'object' || block === null || typeof block.kind !== 'string') {
      throw new Error('Snapshot is corrupt (tape)');
    }
    blocks.push(block);
  }
  return blocks;
}
