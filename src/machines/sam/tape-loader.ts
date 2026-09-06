/**
 * ROM trap for instant tape loading on the SAM Coupé.
 *
 * The SAM's cassette routine is a reworked Spectrum LD-BYTES — same block
 * shape (flag byte, payload, XOR parity), same LD-EDGE edge sampler in ROM 0
 * at $2045/$204C — so the same trick works: recognise the block the ROM is
 * about to read, copy it into memory, and land on the routine's own RET.
 *
 * Addresses below were read out of the 3.0 PLC ROM (the stock image), all in
 * ROM 1 at $C000-$FFFF unless said otherwise:
 *
 *   $E60E  LOAD entry: CALL $E65D, then fall into the shared exit at $E611.
 *   $E65D  DI, stack the caller's AF, then ask $E526 whether the LOAD device
 *          is `T`. It answers NZ for the network, which takes the branch at
 *          $E61D and never touches the cassette — so a trap sited past that
 *          test cannot fire on a network load.
 *   $E664  Cassette path. Normalises the length pair through $2004, stashes it
 *          at $5AC8/$5ACA, and from $E675 runs the pilot/sync search.
 *   $E670  **The trap point.** The setup is done and the entry AF is still in
 *          the main registers, one instruction before the EX AF,AF' that hides
 *          it in the shadow set for the loading loop.
 *   $E73C  The routine's bare RET, reached with carry meaning success.
 *
 * At $E670 the contract is:
 *
 *   A    expected flag byte — $01 for a header, $FF for data
 *   F    carry set = LOAD, clear = VERIFY
 *   HL   destination address
 *   DE   byte count, and C-1 the count's whole 64K units ($2004 folds the
 *        caller's (16K pages, remainder) pair into that flat form; the value
 *        before the INC C at $E66F is the one the loop reads back)
 *
 * Contract, as on the Spectrum (see `spectrum/tape-loader.ts`):
 *
 *   - Return false WITHOUT touching CPU or tape state when the block does not
 *     match, so the real edge loop runs and custom-speed or protected tapes
 *     load at full fidelity.
 *   - Return true having copied the bytes and pointed PC at $E73C. Landing on
 *     the ROM's own RET — rather than popping by hand — means the exit at
 *     $E611 still runs: it is the routine's EI, and skipping it would leave
 *     interrupts off for good.
 *
 * Length check: the ROM reads exactly DE bytes plus a parity byte and ignores
 * anything after, so a block LONGER than asked for still loads on hardware. We
 * accept any block with at least DE payload bytes and copy DE of them, and
 * decline only a short one — the same leniency as the Spectrum trap, and for
 * the same reason (parity is not verified here either way).
 */

import { Z80 } from '@/cores/z80.ts';
import type { TapeDeck } from '@/media/tape/tap.ts';

/** The paging a load walks through: HMPR, and the means to bump it. */
export interface SamTapePaging {
  readonly hmpr: number;
  setHmpr(val: number): void;
}

/** Where the trap fires: LD-BYTES with its setup done, in ROM 1. */
export const SAM_TAPE_TRAP_PC = 0xE670;

/** The bare RET the loading loop exits through. */
const SAM_TAPE_RET = 0xE73C;

/**
 * Where a load spills over into the next page.
 *
 * The ROM writes through section C and, on reaching $C000, winds H back to
 * $80 and bumps HMPR by one — so a load longer than 16K walks up the pages
 * rather than wrapping on the spot. Replicated exactly, including the read of
 * HMPR's own register rather than a shadow copy.
 */
const SECTION_D = 0xC000;
const SECTION_C = 0x8000;

export function trapSamTapeLoad(cpu: Z80, memory: SamTapePaging, tape: TapeDeck): boolean {
  const expectedFlag = cpu.a;
  const isLoad = (cpu.f & Z80.FLAG_C) !== 0;
  // C was incremented at $E66F; the stashed value is the one the loop uses.
  const count = (((cpu.c - 1) & 0xFF) << 16) + cpu.de;

  const block = tape.peekDataBlock();
  if (!block) return false;                       // no block — let the ROM run
  if (block.flag !== expectedFlag) return false;  // not our block
  if (block.data.length < count) return false;    // too short — the ROM would overrun it

  // Commit: consume the block.
  tape.nextDataBlock();

  // VERIFY walks the destination without writing, exactly as the ROM does —
  // its store and its compare share the same address advance. The bytes
  // themselves are not compared, matching the Spectrum trap.
  let addr = cpu.hl;
  for (let i = 0; i < count; i++) {
    if (isLoad) cpu.write8(addr, block.data[i]);
    addr = (addr + 1) & 0xFFFF;
    if (addr >= SECTION_D) {
      addr = SECTION_C | (addr & 0xFF);
      memory.setHmpr((memory.hmpr + 1) & 0xFF);
    }
  }
  cpu.hl = addr;

  cpu.de = 0;
  cpu.pc = SAM_TAPE_RET;
  // Carry on exit is the success flag, exactly as the natural exit leaves it
  // after its `LD A,L / CP 01` parity test.
  cpu.a = 0;
  cpu.setFlag(Z80.FLAG_C, true);
  return true;
}
