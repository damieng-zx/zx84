/**
 * Amstrad PCW family model type and classification helpers.
 *
 * Every model shares one gate array, one Z80A and one uPD765A; they differ in
 * how much RAM is fitted, what the drives are, and which printer is bolted on:
 *
 *   8256 — 256K, one single-sided 180K 3" drive, 9-pin dot matrix printer
 *   8512 — 512K, adds a second double-sided 720K 3" drive, same printer
 *   9512 — 512K, one 720K 3" drive, daisywheel printer and a white monitor
 *   9256 — 256K, one 720K 3.5" drive, back to the dot matrix and a green
 *          monitor: the 1991 budget machine in the redesigned case, which is
 *          where the range left CF2 behind
 */

import type { MachineModel } from '@/models.ts';
import type { DriveType } from '@/media/floppy/floppy-sound.ts';
import { PCW_BLOCKS_256K, PCW_BLOCKS_512K } from './constants.ts';

/** Amstrad PCW models. */
export type PcwModel = 'pcw8256' | 'pcw8512' | 'pcw9512' | 'pcw9256';

/** Type guard: true for any PCW model. */
export function isPcwModel(m: MachineModel): m is PcwModel {
  return m === 'pcw8256' || m === 'pcw8512' || m === 'pcw9512' || m === 'pcw9256';
}

/** Fitted 16K blocks: 16 = 256K on the two 256s, 32 = 512K on the two 512s. */
export function pcwBlocks(model: PcwModel): number {
  return model === 'pcw8256' || model === 'pcw9256'
    ? PCW_BLOCKS_256K : PCW_BLOCKS_512K;
}

/** Number of floppy drives fitted. Only the 8512 shipped with a second one. */
export function pcwDriveCount(model: PcwModel): number {
  return model === 'pcw8512' ? 2 : 1;
}

/** True when drive A is a double-sided 720K mechanism rather than the 8256's
 *  single-sided 180K one. The 9512 got a double-sided CF2 as A, and the 9256's
 *  3.5" drive is double-sided by construction. */
export function pcwHasDoubleSidedDriveA(model: PcwModel): boolean {
  return model === 'pcw9512' || model === 'pcw9256';
}

/**
 * What the drives are, for the drive-sound synth.
 *
 * The 8000s and the 9512 all use Amstrad's 3" CF2 — the same mechanism as the
 * +3's, and it sounds like it. The 9256 is where the range moved to 3.5".
 */
export function pcwDriveType(model: PcwModel): DriveType {
  return model === 'pcw9256' ? '3.5inch' : '3inch';
}

/** Which printer is fitted. The dot matrix machines drive a 9-pin head directly
 *  through ports &FC/&FD; the 9512's daisywheel presents a different interface
 *  on the same ports. The 9256 went back to the dot matrix. */
export function pcwPrinter(model: PcwModel): 'matrix' | 'daisywheel' {
  return model === 'pcw9512' ? 'daisywheel' : 'matrix';
}

/**
 * True for the redesigned deck the 9000s carry: the function keys paired down
 * the left and the numeric pad off on its own to the right, with case showing
 * between the blocks. The 8000s put both in one slab along the top right.
 */
export function pcwHasNineSeriesDeck(model: PcwModel): boolean {
  return model === 'pcw9512' || model === 'pcw9256';
}

/** The 9512 shipped with a paper-white monitor; every other PCW was green. */
export function pcwDefaultPhosphor(model: PcwModel): 'green' | 'white' {
  return model === 'pcw9512' ? 'white' : 'green';
}
