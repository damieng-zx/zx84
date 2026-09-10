/**
 * Camputers Lynx model classification.
 *
 * The 48K and 96K are the same machine with more RAM and a longer ROM — the
 * 96K adds the disk interface. The 128K is a different board: its banking port
 * is 0x82 rather than 0x7F, with the bit order reversed, its video planes sit
 * elsewhere in RAM and its cassette motor moves to another bit of port 0x80.
 */

import type { MachineModel } from '@/models.ts';

export type LynxModel = 'lynx48' | 'lynx96' | 'lynx128';

export function isLynxModel(model: MachineModel): model is LynxModel {
  return model === 'lynx48' || model === 'lynx96' || model === 'lynx128';
}

/** RAM fitted, in bytes. */
export function lynxRamSize(model: LynxModel): number {
  if (model === 'lynx128') return 128 * 1024;
  return model === 'lynx96' ? 96 * 1024 : 48 * 1024;
}

/** The 128K is the odd board out — nearly every hardware difference keys off
 *  this rather than off the model name. */
export function isLynx128(model: LynxModel): boolean { return model === 'lynx128'; }

/** A disk interface is fitted (the FD1793 and its DOS ROM). */
export function lynxHasDisk(model: LynxModel): boolean { return model !== 'lynx48'; }

// ── System-ROM slot geometry ───────────────────────────────────────────────
//
// Every Lynx ROM socket holds one 8K image. The 48K has two system images; the
// 96K/128K add a third and, above it, the disk interface's DOS ROM — which the
// Hardware pane's FD1793 toggle can remove.

export const LYNX_ROM_SLOT_SIZE = 0x2000;

const LYNX_SLOTS_48 = ['System 1', 'System 2'] as const;
const LYNX_SLOTS_DISK = ['System 1', 'System 2', 'System 3', 'DOS ROM'] as const;

/** The default title of every ROM socket this model has, in load order. */
export function lynxRomSlotLabels(model: LynxModel): readonly string[] {
  return lynxHasDisk(model) ? LYNX_SLOTS_DISK : LYNX_SLOTS_48;
}

/** The socket holding the DOS ROM, or -1 when the model has no disk interface. */
export function lynxDosSlot(model: LynxModel): number {
  return lynxHasDisk(model) ? LYNX_SLOTS_DISK.length - 1 : -1;
}
