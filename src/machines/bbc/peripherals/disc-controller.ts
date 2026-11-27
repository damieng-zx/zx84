/**
 * Common face of a fitted BBC disc controller.
 *
 * The Model B shipped (or could be upgraded) with one of two floppy
 * interfaces — the original Intel 8271 or the later WD1770 — or none at all.
 * The machine holds whichever is fitted behind this interface, so the IO
 * decode, the disk service and the frame probe stay controller-agnostic.
 */

import type { FloppyController } from '@/cores/floppy-controller.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

export interface BbcDiscController extends FloppyController {
  /** Read a register in the floppy window (0xFE80-0xFE87). */
  read(addr: number): number;
  /** Write a register in the floppy window. */
  write(addr: number, val: number): void;
  /** Full controller reset (register/file state, not the mounted media). */
  reset(): void;
  /** Advance by `cycles` at the 1 MHz disc clock (command-completion timers). */
  tick(cycles: number): void;

  /** Fit the first `count` drives; the rest have no drive wired to their select
   *  line (the controller reports them not-ready / not at track 0). */
  setDriveCount(count: number): void;

  /** Last drive addressed — the drive-panel LED's active unit. */
  readonly currentDrive: number;

  /** Snapshot: the controller's state, taken after the discs are restored. */
  saveState(w: StateWriter): void;
  loadState(r: StateReader): void;
}