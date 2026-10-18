/**
 * Acorn Plus 3 disc interface: a WD1770 floppy controller, a drive-control
 * latch and the ADFS ROM (paged in as ROM 4), on the Electron's 1 MHz bus.
 *
 *   &FCC0        drive-control latch (write-only)
 *   &FCC4-&FCC7  WD1770 status/command, track, sector, data
 *
 * Latch bits: 0 selects drive 0, 1 drive 1, 2 the head, 3 the density, and 5 is
 * the controller's /MR reset — active low, so a 0 written there holds the chip
 * in reset. The controller's DRQ and command-completion lines are wired to the
 * CPU's NMI, and ADFS moves each byte from an NMI handler.
 *
 * Reference: Acorn Electron Plus 3 service manual; MAME `plus3.cpp` (register
 * map and latch decode).
 */

import { WD179x } from '@/cores/wd179x.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { ADFS_SECTORS_PER_TRACK } from '@/media/floppy/adfs.ts';

const CTRL_DRIVE0 = 0x01;
const CTRL_DRIVE1 = 0x02;
const CTRL_SIDE = 0x04;
const CTRL_RESET = 0x20;

export const PLUS3_ROM_PAGE = 4;
/** Where the ACP 1770 DFS ROM goes in place of ADFS. Every DFS ROM for this
 *  interface ends its calls with `LDA #&80 : STA &FE05`, which pages ROM 0 back
 *  in, so it only keeps running when it is itself ROM 0.
 *
 *  Known limit: this DFS holds its catalogue and state in main RAM at
 *  &0E00-&0FFF (PAGE &1900). A title that loads a file over that range and then
 *  uses the disc again fails ("Sector not found at :F", "File not found",
 *  "Channel"); about a quarter of the Electron .ssd collection does. Those discs
 *  were made for a DFS with workspace off the main bus (likely the Slogger
 *  Pegasus 400, whose extra hardware is not emulated). */
export const DFS_ROM_PAGE = 0;

export class ElectronPlus3 {
  readonly fdc: WD179x;
  control = 0;
  /** True while the latch is holding the controller in reset. */
  private resetting = false;

  constructor(onInterrupt?: (asserted: boolean) => void) {
    this.fdc = new WD179x({
      statusBit7: 'motor-on',
      formatSectorsPerTrack: ADFS_SECTORS_PER_TRACK,
      onInterrupt,
    });
  }

  reset(): void {
    this.control = 0;
    this.resetting = false;
    this.fdc.reset();
  }

  /** Advance the per-byte transfer cadence at the 1 MHz disc clock. */
  tick(cycles: number): void { this.fdc.tick(cycles); }
  tickFrame(): void { this.fdc.tickFrame(); }

  /** Read from FRED (`addr` is the full 0xFCxx address); null when not ours. */
  read(addr: number): number | null {
    if (addr >= 0xFCC4 && addr <= 0xFCC7) {
      switch (addr & 3) {
        case 0: return this.fdc.readStatus();
        case 1: return this.fdc.readTrack();
        case 2: return this.fdc.readSectorReg();
        default: return this.fdc.readData();
      }
    }
    // The latch is write-only: its outputs drive the disc, not the data bus.
    if (addr === 0xFCC0) return 0xFF;
    return null;
  }

  write(addr: number, val: number): boolean {
    if (addr === 0xFCC0) { this.writeControl(val); return true; }
    if (addr >= 0xFCC4 && addr <= 0xFCC7) {
      switch (addr & 3) {
        case 0: this.fdc.writeCommand(val); break;
        case 1: this.fdc.writeTrack(val); break;
        case 2: this.fdc.writeSectorReg(val); break;
        default: this.fdc.writeData(val); break;
      }
      return true;
    }
    return false;
  }

  private writeControl(val: number): void {
    this.control = val;
    // Reset is active low; only a fresh assertion (high->low) resets the chip.
    const run = (val & CTRL_RESET) !== 0;
    if (!run && !this.resetting) this.fdc.reset();
    this.resetting = !run;
    // Each drive has its own select line; with neither raised drive 0 stays
    // the default so a command still has somewhere to go.
    this.fdc.selectDrive((val & CTRL_DRIVE1) && !(val & CTRL_DRIVE0) ? 1 : 0);
    this.fdc.setSide((val & CTRL_SIDE) ? 1 : 0);
  }

  // Frame-probe indicators and media (delegated to the WD179x).
  get motorOn(): boolean { return this.fdc.motorOn; }
  get isExecuting(): boolean { return this.fdc.isExecuting; }
  get isWriting(): boolean { return this.fdc.isWriting; }
  get currentDrive(): number { return this.fdc.currentDrive; }
  get currentSector(): number { return this.fdc.currentSector; }
  getUnitTrack(unit: number): number { return this.fdc.getUnitTrack(unit); }
  get formattedUnit(): number { return this.fdc.formattedUnit; }
  set formattedUnit(unit: number) { this.fdc.formattedUnit = unit; }

  /** Sectors per track a disc format lays down: 16 for ADFS, 10 for DFS. */
  setFormatSectors(count: number): void { this.fdc.setFormatSectorsPerTrack(count); }

  insertDisk(image: DskImage, unit = 0): void { this.fdc.insertDisk(image, unit); }
  ejectDisk(unit = 0): void { this.fdc.ejectDisk(unit); }
  getDiskImage(unit: number): DskImage | null { return this.fdc.getDiskImage(unit); }
  isDirty(unit: number): boolean { return this.fdc.isDirty(unit); }
  clearDirty(unit: number): void { this.fdc.clearDirty(unit); }
  get writeProtect(): boolean[] { return this.fdc.writeProtect; }
}
