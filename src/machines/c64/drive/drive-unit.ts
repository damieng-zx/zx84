/**
 * What the 64 and its panes need of a disk drive on the serial bus, whichever
 * drive it is. Each is a computer of its own (a 6502, RAM, the DOS ROM) and
 * differs inside: the 1541 turns a GCR track under its head bit by bit, the
 * 1581 has a floppy controller chip and 3.5" MFM disks. The bus, the
 * snapshots and the Drives pane see only this.
 */

import type { M6502 } from '@/cores/m6502.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { StateSink, StateSource } from '@/utils/state-stream.ts';

export type C64DriveModel = '1541' | '1581';

export const C64_DRIVE_MODELS: readonly C64DriveModel[] = ['1541', '1581'];

export function isC64DriveModel(value: unknown): value is C64DriveModel {
  return value === '1541' || value === '1581';
}

/** Up to four drives share the bus, as devices 8 to 11. */
export const C64_MAX_DRIVES = 4;

/** A drive list from a setting: one to four known models, else one 1541. */
export function normalizeDriveModels(value: unknown): C64DriveModel[] {
  const models = Array.isArray(value) ? value.filter(isC64DriveModel).slice(0, C64_MAX_DRIVES) : [];
  return models.length > 0 ? models : ['1541'];
}

export interface C64DriveUnit {
  readonly model: C64DriveModel;
  /** The drive's own 6502. */
  readonly cpu: M6502;
  /** The drive's own CPU clock, in Hz. */
  readonly clockHz: number;
  /** Which device it answers as: 0 is device 8, 3 is device 11 (the jumpers
   *  the DOS reads when it starts up). */
  unit: number;
  /** The DOS ROM image it holds (for fitting another drive of the same model). */
  readonly rom: Uint8Array;
  /** Size of the DOS ROM image it wants, in bytes. */
  readonly romSize: number;
  hasRom: boolean;

  /** The file the disk came from, and whether the disk is write protected or
   *  holds writes not yet saved. */
  mediaName: string;
  writeProtected: boolean;
  dirty: boolean;
  /** A disk is in the drive. */
  readonly loaded: boolean;

  readonly motorOn: boolean;
  readonly ledOn: boolean;
  readonly isWriting: boolean;
  /** The track (1-based) the head is over, and the half-track it is on. */
  readonly currentTrack: number;
  readonly currentHalfTrack: number;
  /** The drive's cycle counter. */
  readonly cycles: number;

  loadRom(data: Uint8Array): void;
  reset(): void;
  /** Run the drive until its clock reaches `target`. */
  runTo(target: number): void;
  /** The 64's side of the bus: the lines it holds low. */
  setC64Lines(atn: boolean, clk: boolean, data: boolean): void;
  /** What the drive holds low. */
  readonly clkAsserted: boolean;
  readonly dataAsserted: boolean;
  /** Bytes moved to or from the disk since the last call. */
  takeActivity(): number;

  /** Put a disk in from a file's bytes; throws, with a message fit to show, for
   *  one this drive cannot read. `silent` puts back the disk a restored
   *  snapshot already had, without the drive noticing a change. */
  mountImage(data: Uint8Array, name: string, silent?: boolean): void;
  /** Put a ready-made disk image in (the Drives pane's own formats). */
  insertImage(image: DskImage, name: string): void;
  ejectDisk(): void;
  setWriteProtect(on: boolean): void;
  /** The disk with everything written to it, as a file. */
  saveImage(): { data: Uint8Array; ext: string } | null;
  /** The disk as the Drives pane describes it. */
  diskImage(): DskImage | null;

  /** Registers and state as text for the debugger. */
  describe(): string[];

  saveState(w: StateSink): void;
  loadState(r: StateSource): void;
  saveDisk(w: StateSink): void;
  loadDisk(r: StateSource): void;
}
