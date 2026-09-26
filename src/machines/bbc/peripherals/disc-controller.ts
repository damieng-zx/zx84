/**
 * Common face of a fitted BBC disc controller.
 *
 * The Model B shipped (or could be upgraded) with one of two floppy
 * interfaces — the original Intel 8271 or the later WD1770 — or none at all.
 * The machine holds whichever is fitted behind this interface, so the IO
 * decode, the disk service and the frame probe stay controller-agnostic.
 */

import type { DskImage } from '@/media/floppy/disk-image.ts';

export interface BbcDiscController {
  /** Read a register in the floppy window (0xFE80-0xFE87). */
  read(addr: number): number;
  /** Write a register in the floppy window. */
  write(addr: number, val: number): void;
  /** Full controller reset (register/file state, not the mounted media). */
  reset(): void;
  /** Advance by `cycles` at the 1 MHz disc clock (command-completion timers). */
  tick(cycles: number): void;
  /** Per-frame pump (motor timers, index pulses). */
  tickFrame(): void;

  insertDisk(image: DskImage, unit: number): void;
  ejectDisk(unit: number): void;
  getDiskImage(unit: number): DskImage | null;
  isDirty(unit: number): boolean;
  clearDirty(unit: number): void;
  readonly writeProtect: boolean[];

  /** Frame-probe indicators. */
  readonly motorOn: boolean;
  readonly isExecuting: boolean;
  readonly isWriting: boolean;
  readonly currentDrive: number;
  readonly currentSector: number;
  getUnitTrack(unit: number): number;
  /** Unit a FORMAT just completed on, or -1 (cleared by the probe). */
  formattedUnit: number;
}
