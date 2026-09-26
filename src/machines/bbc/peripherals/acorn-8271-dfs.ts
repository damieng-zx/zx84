/**
 * Acorn 8271 disc interface — the original BBC Micro Model B floppy upgrade.
 *
 * The Intel 8271 is mapped at &FE80-&FE84 (status/command, result/parameter,
 * reset, and the data register), unlike the WD1770's &FE80 + &FE84-&FE87. The
 * chip's interrupt output is wired to the CPU's NMI line, so the machine passes
 * an `onInterrupt` callback that pulses `cpu.nmi()`.
 */

import { I8271 } from '@/cores/i8271.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { BbcDiscController } from './disc-controller.ts';

export class BbcAcornDfs implements BbcDiscController {
  private readonly fdc: I8271;

  /** No in-place FORMAT indicator on this path (the 8271 formats instantly). */
  formattedUnit = -1;

  constructor(onInterrupt: (asserted: boolean) => void) {
    this.fdc = new I8271({ onInterrupt });
  }

  read(addr: number): number {
    const a = addr & 0xFF;
    if (a >= 0x80 && a <= 0x83) return this.fdc.read(a - 0x80);
    if (a === 0x84) return this.fdc.readData();
    return 0xFF;
  }

  write(addr: number, val: number): void {
    const a = addr & 0xFF;
    if (a >= 0x80 && a <= 0x82) this.fdc.write(a - 0x80, val);
    else if (a === 0x84) this.fdc.writeData(val);
    // 0x83 and the rest of the window are unmapped.
  }

  reset(): void { this.fdc.reset(); }
  tick(cycles: number): void { this.fdc.tick(cycles); }
  tickFrame(): void { this.fdc.tickFrame(); }

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
