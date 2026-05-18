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
 *   - Return true after copying bytes to memory and rewinding the
 *     stack: the PUSH HL at $0561 left $053F (parity-error return)
 *     on top of the caller's return address, so we POP it ourselves
 *     and then POP the caller's address into PC. Carry is set on
 *     main F to signal success — the natural LD-BYTES exit at
 *     $05DF..$05E2 leaves main F's carry as the success indicator
 *     and does NOT do an EX AF,AF' before RET (verified against the
 *     48K ROM: LD A,H / CP $01 / RET — the C9 at $05E2 is bare RET).
 *
 * Length check matches FUSE's `block_length != DE+2` (their length
 * includes flag+payload+checksum; our `block.data` is the payload
 * only, so the equivalent check is `block.data.length === cpu.de`).
 */

import { Z80 } from '@/cores/z80.ts';
import type { TapeDeck } from '@/tape/tap.ts';

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

  // Discard the 0x053F parity-error return that LD-BYTES pushed at $0561,
  // then pop the caller's return address into PC.
  cpu.pop16();
  cpu.pc = cpu.pop16();
  // Carry on main F = success (matches the ROM's natural exit at $05E0/$05E2).
  cpu.setFlag(Z80.FLAG_C, true);
  return true;
}
