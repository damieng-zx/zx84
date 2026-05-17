/**
 * ROM trap for instant tape loading.
 *
 * Intercepts the standard LD-BYTES routine at 0x0556 and transfers block data
 * directly into memory, bypassing the real tape-timing loop.
 *
 * Returns true if a block was successfully loaded, false if loading failed
 * (no block available, flag mismatch, or verify mode). The caller uses this
 * to decide whether to advance the tape player past the loaded block.
 */

import { Z80 } from '@/cores/z80.ts';
import type { TapeDeck } from '@/tape/tap.ts';

export function trapTapeLoad(cpu: Z80, tape: TapeDeck): boolean {
  // Expected flag byte is in A register
  const expectedFlag = cpu.a;
  // Carry flag: 1 = LOAD, 0 = VERIFY
  const isLoad = cpu.getFlag(Z80.FLAG_C);
  // IX = destination address, DE = byte count
  let dest = cpu.ix;
  let count = cpu.de;

  const block = tape.nextDataBlock();
  let success = false;

  if (!block || block.flag !== expectedFlag) {
    // No block or flag mismatch — signal failure
    cpu.setFlag(Z80.FLAG_C, false);
  } else {
    // Consume up to min(count, block.data.length) bytes for both LOAD and
    // VERIFY. Real LD-BYTES fails at checksum time if the block runs out
    // before DE counts down to 0 — we mirror that by clearing carry and
    // leaving DE at the unsatisfied remainder. Excess block bytes (long
    // block) are dropped, matching real ROM behaviour: the ROM stops
    // reading once DE hits 0 and treats byte N+1 as the parity byte.
    // VERIFY is treated as instant-success when the lengths align; we do
    // not compare bytes (consistent with JSpeccy / ZEsarUX fast-load
    // paths — only Fuse implements a real instant verify).
    const available = block.data.length;
    const len = Math.min(count, available);

    if (isLoad) {
      for (let i = 0; i < len; i++) {
        cpu.write8(dest, block.data[i]);
        dest = (dest + 1) & 0xFFFF;
      }
    } else {
      dest = (dest + len) & 0xFFFF;
    }

    cpu.ix = dest;
    cpu.de = (count - len) & 0xFFFF;

    if (available < count) {
      // Short block — real ROM would error at the missing checksum byte
      cpu.setFlag(Z80.FLAG_C, false);
    } else {
      cpu.setFlag(Z80.FLAG_C, true);
      success = true;
    }
  }

  // Pop return address (simulating RET from LD-BYTES)
  cpu.pc = cpu.pop16();
  // Re-enable interrupts (LD-BYTES starts with DI but executes EI before RET)
  cpu.iff1 = true;
  cpu.iff2 = true;

  return success;
}
