/**
 * Amstrad PCW family model type and classification helpers.
 *
 * The three models share one gate array, one Z80A and one uPD765A; they differ
 * in how much RAM is fitted, how many drives, and which printer is bolted on:
 *
 *   8256 — 256K, one single-sided 180K 3" drive, 9-pin dot matrix printer
 *   8512 — 512K, adds a second double-sided 720K drive, same printer
 *   9512 — 512K, one 720K drive, daisywheel printer and a white monitor
 */

import type { MachineModel } from '@/models.ts';
import { PCW_BLOCKS_256K, PCW_BLOCKS_512K } from './constants.ts';

/** Amstrad PCW models. */
export type PcwModel = 'pcw8256' | 'pcw8512' | 'pcw9512';

/** Type guard: true for any PCW model. */
export function isPcwModel(m: MachineModel): m is PcwModel {
  return m === 'pcw8256' || m === 'pcw8512' || m === 'pcw9512';
}

/** Fitted 16K blocks: 16 = 256K on the 8256, 32 = 512K on the 8512 and 9512. */
export function pcwBlocks(model: PcwModel): number {
  return model === 'pcw8256' ? PCW_BLOCKS_256K : PCW_BLOCKS_512K;
}

/** Number of floppy drives fitted. Only the 8512 shipped with a second one. */
export function pcwDriveCount(model: PcwModel): number {
  return model === 'pcw8512' ? 2 : 1;
}

/** True when drive A is the double-sided 720K mechanism rather than the
 *  single-sided 180K one. The 9512 shipped with the 720K drive as A. */
export function pcwHasDoubleSidedDriveA(model: PcwModel): boolean {
  return model === 'pcw9512';
}

/** Which printer is fitted. The 8000-series machines drive a 9-pin dot matrix
 *  head directly through ports &FC/&FD; the 9512's daisywheel presents a
 *  different interface on the same ports. */
export function pcwPrinter(model: PcwModel): 'matrix' | 'daisywheel' {
  return model === 'pcw9512' ? 'daisywheel' : 'matrix';
}

/** The 9512 shipped with a paper-white monitor; the 8000s were green. */
export function pcwDefaultPhosphor(model: PcwModel): 'green' | 'white' {
  return model === 'pcw9512' ? 'white' : 'green';
}
