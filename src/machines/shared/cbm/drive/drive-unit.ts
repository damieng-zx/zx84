/**
 * What a Commodore computer (the C64, the VIC-20) and its panes need of a
 * disk drive on the serial bus, whichever drive it is. Each drive is a
 * computer of its own (a 6502, RAM, the DOS ROM) and
 * differs inside: the 1541 turns a GCR track under its head bit by bit, the
 * 1581 has a floppy controller chip and 3.5" MFM disks. The bus, the
 * snapshots and the Drives pane see only this.
 */

import type { M6502 } from '@/cores/m6502.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { StateSink, StateSource } from '@/utils/state-stream.ts';

export type CbmDriveModel = '1541' | '1571' | '1581';

/** The ROM pane's sockets follow this order (the 1571 came last, so the
 *  indexes of the others stay where they were). */
export const CBM_DRIVE_MODELS: readonly CbmDriveModel[] = ['1541', '1581', '1571'];

export function isCbmDriveModel(value: unknown): value is CbmDriveModel {
  return value === '1541' || value === '1571' || value === '1581';
}

/** Each drive's DOS ROM on the ROM host. The 1541's is 325302-01 ($C000)
 *  then 901229-05 ($E000); the 1571's is the 32K 310654-05, the 1581's the
 *  32K 318045-02. They sit under `c64/` on the host, where they were put
 *  first, but serve every Commodore on the serial bus. */
export const CBM_DRIVE_ROM_SOURCES: Readonly<Record<CbmDriveModel, string>> = {
  '1541': 'c64/dos1541-325302-01-901229-05.rom',
  '1571': 'c64/dos1571-310654-05.rom',
  '1581': 'c64/dos1581-318045-02.rom',
};

/** Up to four drives share the bus, as devices 8 to 11. */
export const CBM_MAX_DRIVES = 4;

/** A drive list from a setting: one to four known models, else one 1541. */
export function normalizeDriveModels(value: unknown): CbmDriveModel[] {
  const models = Array.isArray(value) ? value.filter(isCbmDriveModel).slice(0, CBM_MAX_DRIVES) : [];
  return models.length > 0 ? models : ['1541'];
}

export interface CbmDriveUnit {
  readonly model: CbmDriveModel;
  /** The drive's own 6502. */
  readonly cpu: M6502;
  /** The drive's time base, in Hz: its CPU clock, or for a drive that can change
   *  speed (the 1571) the faster of its two. */
  readonly clockHz: number;
  /** The speed its CPU is running at now, in Hz, where that is not `clockHz`. */
  readonly cpuHz?: number;
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
  /** The computer's side of the bus: the lines it holds low. */
  setHostLines(atn: boolean, clk: boolean, data: boolean): void;
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
