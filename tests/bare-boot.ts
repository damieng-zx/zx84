/**
 * A machine built and reset with no ROM, for the tests that run every
 * registered machine's CPU on empty memory (stops, beam, trace).
 *
 * Most machines run their CPU from the reset vector at once. The Commodore 128
 * starts on its Z80, which runs the BIOS in the system ROM and then hands the
 * bus to the 8502 by setting bit 0 of the MMU's mode register; with no ROM the
 * Z80 would run NOPs for ever and the 8502 (the CPU the debugger reports) would
 * never start, so the 128 is handed over here, as the BIOS would.
 */

import type { Machine, MachineEntry } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import type { C128Machine } from '@/machines/c128/c128-machine.ts';

export function bareBoot(entry: MachineEntry, model: MachineModel): Machine {
  const m = entry.create(model, null);
  m.reset();
  if (m.kind === 'c128') (m as C128Machine).memory.mmu.write(5, 0x01);
  return m;
}
