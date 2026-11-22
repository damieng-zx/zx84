/**
 * Acorn 8271 floppy controller card (200,004), fitted to the System 3 and 4.
 *
 * The Intel 8271 is mapped in the System's I/O block at &0A00:
 *
 *   +0  read status   write command
 *   +1  read result   write parameter
 *   +2               write reset (bit 0)
 *   +4  data port (both directions)
 *
 * The data port is at +4, not +3, which is the same odd offset the BBC's 8271
 * interface uses — the DOS's disc NMI handler reads `&0A04`. The chip's
 * interrupt output drives the CPU's NMI, as on the BBC; the DOS's NMI handler
 * checks the status register's DRQ bit to tell a data byte from a completion.
 *
 * Everything the chip does with sectors lives in the core. This wrapper is only
 * the card's address decode, like the BBC's.
 */

import { I8271 } from '@/cores/i8271.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';

export class AcornSystemFdc {
  private readonly fdc: I8271;

  constructor(onInterrupt: (asserted: boolean) => void) {
    this.fdc = new I8271({ onInterrupt });
  }

  read(offset: number): number {
    switch (offset & 0x0F) {
      case 0: return this.fdc.read(0);
      case 1: return this.fdc.read(1);
      case 4: return this.fdc.readData();
      default: return 0xFF;
    }
  }

  /**
   * Side-effect-free read for the debugger. Only the status register can be
   * peeked: reading +1 pops a result byte and +4 pops a data byte, so those
   * report the floating bus rather than consume anything.
   */
  peek(offset: number): number {
    return (offset & 0x0F) === 0 ? this.fdc.read(0) : 0xFF;
  }

  write(offset: number, value: number): void {
    switch (offset & 0x0F) {
      case 0: this.fdc.write(0, value); break;
      case 1: this.fdc.write(1, value); break;
      case 2: this.fdc.write(2, value); break;
      case 4: this.fdc.writeData(value); break;
      default: break;
    }
  }

  reset(): void { this.fdc.reset(); }
  tick(cycles: number): void { this.fdc.tick(cycles); }

  insertDisk(image: DskImage, unit: number): void { this.fdc.insertDisk(image, unit); }
  ejectDisk(unit: number): void { this.fdc.ejectDisk(unit); }
  getDiskImage(unit: number): DskImage | null { return this.fdc.getDiskImage(unit); }
  isDirty(unit: number): boolean { return this.fdc.isDirty(unit); }
  clearDirty(unit: number): void { this.fdc.clearDirty(unit); }
  get writeProtect(): boolean[] { return this.fdc.writeProtect; }

  get motorOn(): boolean { return this.fdc.motorOn; }
  get isExecuting(): boolean { return this.fdc.isExecuting; }
  get isWriting(): boolean { return this.fdc.isWriting; }
  get currentDrive(): number { return this.fdc.currentDrive; }
  get currentSector(): number { return this.fdc.currentSector; }
  getUnitTrack(unit: number): number { return this.fdc.getUnitTrack(unit); }
}
