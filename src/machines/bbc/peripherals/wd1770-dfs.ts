/**
 * Acorn 1770 disc interface (the Model B 1770 DFS upgrade).
 *
 * The WD1770 is mapped — as on the BBC B+ — at &FE84-&FE87 (status/command,
 * track, sector, data) with the drive-control latch at &FE80. The latch is a
 * write-only register (a 74LS173/174) whose outputs drive the drive/side/
 * density/reset lines; reads float high. Bit 1 selects drive 1 (else drive 0),
 * bit 2 the head, bit 3 the density, and bit 5 the controller reset — active
 * low, matching the /MR input it drives.
 */

import { WD179x } from '@/cores/wd179x.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { BbcDiscController } from './disc-controller.ts';

const CTRL_DRIVE1 = 0x02;
const CTRL_SIDE = 0x04;
const CTRL_RESET = 0x20;

export class BbcDfs1770 implements BbcDiscController {
  readonly fdc: WD179x;
  control = 0;
  /** True while the control latch is holding the controller in reset. */
  private resetting = false;

  constructor(onInterrupt?: (asserted: boolean) => void) {
    // The Acorn 1770 interface wires the controller's DRQ/completion to the
    // CPU's NMI line: the DFS transfers each byte from an NMI handler (the
    // same per-byte handshake the 8271 uses), so the core must offer the bytes
    // on the disc clock rather than synchronously.
    this.fdc = new WD179x({
      statusBit7: 'motor-on',
      formatSectorsPerTrack: 10,
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

  /** Frame-probe indicators (delegated to the WD179x). */
  get motorOn(): boolean { return this.fdc.motorOn; }
  get isExecuting(): boolean { return this.fdc.isExecuting; }
  get isWriting(): boolean { return this.fdc.isWriting; }
  get currentDrive(): number { return this.fdc.currentDrive; }
  get currentSector(): number { return this.fdc.currentSector; }
  getUnitTrack(unit: number): number { return this.fdc.getUnitTrack(unit); }
  get formattedUnit(): number { return this.fdc.formattedUnit; }
  set formattedUnit(unit: number) { this.fdc.formattedUnit = unit; }

  read(addr: number): number {
    switch (addr & 0xFF) {
      // The drive-control latch is write-only: its outputs drive the disc
      // lines, not the data bus, so reads float high. Acorn DFS's presence
      // probe reads it and requires a bit set, so it must not echo the value.
      case 0x80: return 0xFF;
      case 0x84: return this.fdc.readStatus();
      case 0x85: return this.fdc.readTrack();
      case 0x86: return this.fdc.readSectorReg();
      case 0x87: return this.fdc.readData();
      default: return 0xFF;
    }
  }

  write(addr: number, val: number): void {
    switch (addr & 0xFF) {
      case 0x80: this.writeControl(val); return;
      case 0x84: this.fdc.writeCommand(val); return;
      case 0x85: this.fdc.writeTrack(val); return;
      case 0x86: this.fdc.writeSectorReg(val); return;
      case 0x87: this.fdc.writeData(val); return;
      default: return;
    }
  }

  private writeControl(val: number): void {
    this.control = val;
    // Reset is active low; only a fresh assertion (high->low) resets the chip.
    const resetBit = (val & CTRL_RESET) !== 0;
    if (!resetBit && !this.resetting) this.fdc.reset();
    this.resetting = !resetBit;
    // Bit 1 selects drive 1, otherwise drive 0 (the Acorn board derives DS1 as
    // the inverse of DS0, so the two bits are not a binary drive number).
    this.fdc.selectDrive((val & CTRL_DRIVE1) ? 1 : 0);
    this.fdc.setSide((val & CTRL_SIDE) ? 1 : 0);
  }

  tickFrame(): void { this.fdc.tickFrame(); }

  insertDisk(image: DskImage, unit = 0): void { this.fdc.insertDisk(image, unit); }
  ejectDisk(unit = 0): void { this.fdc.ejectDisk(unit); }
  getDiskImage(unit: number): DskImage | null { return this.fdc.getDiskImage(unit); }
  isDirty(unit: number): boolean { return this.fdc.isDirty(unit); }
  clearDirty(unit: number): void { this.fdc.clearDirty(unit); }
  get writeProtect(): boolean[] { return this.fdc.writeProtect; }
}
