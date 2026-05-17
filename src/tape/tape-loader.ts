/**
 * ROM trap for instant tape loading.
 *
 * Intercepts the 48K BASIC ROM's LD-BYTES routine partway through
 * (PC = 0x056C, just after the BREAK check at LD-BREAK) and transfers
 * block data straight into memory, bypassing the real edge-sampling
 * loop. The trap is modelled on FUSE's tape.c — at 0x056C the routine
 * has already done EX AF,AF' so the entry A/F live in the shadow regs.
 *
 * Contract:
 *   - Return false WITHOUT modifying CPU or tape state when the block
 *     doesn't match (no block, flag mismatch, length mismatch). The
 *     caller then lets the real ROM execute LD-BYTES at full fidelity,
 *     so custom-speed turbos and protected tapes load correctly.
 *   - Return true after copying bytes to memory and pointing PC at the
 *     ROM's `POP AF; RET` cleanup at 0x05E2. The POP AF will pop the
 *     0x053F that LD-BYTES pushed at 0x0561 (its parity-error return
 *     address) and load F=0x3F — carry set, signalling success to the
 *     caller. RET then returns to the caller's saved address.
 *
 * Length check matches FUSE's `block_length != DE+2` (their length
 * includes flag+payload+checksum; our `block.data` is the payload
 * only, so the equivalent check is `block.data.length === cpu.de`).
 */

import { Z80 } from '@/cores/z80.ts';
import type { TapeDeck } from '@/tape/tap.ts';

/** PC that LD-BYTES returns through after a successful load. POP AF; RET
 *  — POP AF pops the 0x053F pushed at 0x0561 (F=0x3F → carry set), RET
 *  pops the caller's return address. */
const LD_BYTES_RETURN = 0x05E2;

export function trapTapeLoad(cpu: Z80, tape: TapeDeck): boolean {
  // EX AF,AF' at 0x0557 swapped the entry A/F into the shadow regs.
  // A' holds the expected flag byte; F' bit 0 (carry) selects LOAD vs VERIFY.
  const expectedFlag = cpu.a_;
  const isLoad = (cpu.f_ & Z80.FLAG_C) !== 0;
  const dest = cpu.ix;
  const count = cpu.de;

  const block = tape.peekDataBlock();
  if (!block) return false;                          // no block — let ROM run
  if (block.flag !== expectedFlag) return false;     // flag mismatch — let ROM run
  if (block.data.length !== count) return false;    // length mismatch — let ROM run (turbo / non-standard sizes)

  // Commit: consume the block.
  tape.nextDataBlock();

  if (isLoad) {
    for (let i = 0; i < count; i++) {
      cpu.write8((dest + i) & 0xFFFF, block.data[i]);
    }
  }
  // VERIFY shortcut: don't compare bytes (JSpeccy and ZEsarUX do the same).
  // FUSE is the only emulator that runs a real instant-verify; the cost in
  // false-passes for corrupted blocks is bounded by the fact that VERIFY is
  // rarely used in modern tape workflows.

  cpu.ix = (dest + count) & 0xFFFF;
  cpu.de = 0;

  // Hand control back to the ROM at POP AF; RET. POP AF makes carry=1
  // (from F=0x3F on the stack), which is the ROM's "load succeeded" signal.
  cpu.pc = LD_BYTES_RETURN;
  return true;
}
