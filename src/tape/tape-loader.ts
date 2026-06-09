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
 *     stack: a normal entry via $0556 pushes $053F (parity-error
 *     return) at $0561, on top of the caller's return address, so we
 *     pop it only when it is actually there, then pop the caller's
 *     address into PC. Loaders that CALL into LD-BYTES *after* the
 *     $0561 PUSH (e.g. $0562 or $056C) leave just the caller's
 *     address on the stack — a single pop returns to them. Carry is
 *     set on
 *     main F to signal success — the natural LD-BYTES exit at
 *     $05DF..$05E2 leaves main F's carry as the success indicator
 *     and does NOT do an EX AF,AF' before RET (verified against the
 *     48K ROM: LD A,H / CP $01 / RET — the C9 at $05E2 is bare RET).
 *
 * Length check: the real ROM's LD-BYTES reads exactly DE bytes plus one
 * parity byte and ignores any trailing bytes, so a block that is LONGER
 * than requested still loads on hardware (e.g. re-releases like Paperboy
 * (MCM) carry an 18-byte "header" and data blocks one byte over the
 * length their header declares). We therefore accept any block with at
 * least `cpu.de` payload bytes and copy only `cpu.de` of them — declining
 * only when the block is shorter than requested (the ROM would then read
 * past the block and fail). This is looser than FUSE's exact
 * `block_length == DE+2`, which rejects such tapes; we don't verify
 * parity here regardless, so the extra leniency doesn't change fidelity.
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
  if (block.data.length < count) return false;       // block too short — let ROM run (the ROM would read past it / fail)

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

  // Return to whoever called LD-BYTES. A normal entry at $0556 pushes
  // $053F (SA/LD-RET) at $0561, so the stack reads [$053F][caller]. But
  // loaders that CALL straight into the routine *after* that PUSH never
  // stack the $053F — e.g. Solseed enters at $0562, some protected
  // loaders at $056C — so the top word is already the caller's return
  // address. Pop the $053F only when it's actually present, then pop the
  // caller's address into PC.
  //
  // FUSE sets PC=$05E2 and lets the ROM's bare RET pop exactly once;
  // ZEsarUX traps at $0562 and does a single pop_valor(). Both return
  // exactly once. Our earlier *unconditional* double-pop corrupted the
  // stack for these partial-entry loaders — it discarded the real return
  // address and jumped to garbage, unwinding back to the BASIC main loop
  // which then HALTed with interrupts disabled (a permanent hang).
  const stackTop = cpu.read8(cpu.sp) | (cpu.read8((cpu.sp + 1) & 0xFFFF) << 8);
  if (stackTop === 0x053F) cpu.pop16();
  cpu.pc = cpu.pop16();
  // Carry on main F = success (matches the ROM's natural exit at $05E0/$05E2).
  cpu.setFlag(Z80.FLAG_C, true);
  return true;
}
