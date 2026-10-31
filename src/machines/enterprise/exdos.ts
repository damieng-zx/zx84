/**
 * The EXDOS disk card: a WD1770 and a control latch, with the EXDOS ROM.
 *
 * Ports (low byte; the card decodes 0x10-0x1F):
 *   0x10-0x13  WD1770 status/command, track, sector, data (mirrored to 0x17)
 *   0x18-0x1F  write: b0-b3 select drive 0-3 (b0 wins), b4 side,
 *              b5 single density, b6 clear the disk-change latch
 *              read:  b7 DRQ, b6 disk NOT changed, b1 INTRQ, b0 drive NOT
 *              ready; the unused bits read 1 (0x3C)
 *
 * The status bit polarities follow ep128emu, whose EXDOS emulation real
 * EXDOS and IS-DOS boot on. Single density (b5) drives the WD1770's /DDEN, so
 * an FM disk (from an HFE or SCP image) reads only with it set and an MFM one
 * only with it clear.
 */

import { WD179x } from '@/cores/wd179x.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

export class ExdosCard {
  /** A WD1770: status bit 7 is MOTOR ON. EXDOS formats 9 sectors a track. */
  readonly fdc = new WD179x({ statusBit7: 'motor-on', formatSectorsPerTrack: 9 });
  /** Set when a disk is inserted; EXDOS clears it through control bit 6. */
  private changed = [true, true, true, true];
  /** A drive is selected (no select bits means none). */
  private selected = false;

  reset(): void {
    this.fdc.reset();
    this.fdc.setDensity(false);
    this.selected = false;
  }

  noteDiskChanged(unit: number): void { this.changed[unit & 3] = true; }

  /** The WD1770 (registers and any command in flight) and the card's latch.
   *  Mount the disks before {@link loadState}. */
  saveState(w: StateWriter): void {
    this.fdc.saveState(w);
    for (let u = 0; u < 4; u++) w.bool(this.changed[u]);
    w.bool(this.selected);
  }

  loadState(r: StateReader): void {
    this.fdc.loadState(r);
    for (let u = 0; u < 4; u++) this.changed[u] = r.bool();
    this.selected = r.bool();
  }

  readFdc(reg: number): number {
    switch (reg) {
      case 0: return this.fdc.readStatus();
      case 1: return this.fdc.trackReg;
      case 2: return this.fdc.sectorReg;
      default: return this.fdc.readData();
    }
  }

  writeFdc(reg: number, value: number): void {
    switch (reg) {
      case 0: this.fdc.writeCommand(value); break;
      case 1: this.fdc.trackReg = value; break;
      case 2: this.fdc.sectorReg = value; break;
      default: this.fdc.writeData(value); break;
    }
  }

  writeControl(value: number): void {
    this.fdc.setDensity((value & 0x20) !== 0);
    if ((value & 0x0F) === 0) { this.selected = false; return; }
    this.selected = true;
    const unit = value & 0x01 ? 0 : value & 0x02 ? 1 : value & 0x04 ? 2 : 3;
    this.fdc.selectDrive(unit);
    this.fdc.setSide((value >> 4) & 1);
    // A drive only lets go of DISK CHANGE once it has a disk in it.
    if ((value & 0x40) && this.fdc.getDiskImage(unit) !== null) this.changed[unit] = false;
  }

  readStatus(): number {
    const unit = this.fdc.currentDrive;
    const ready = this.selected && this.fdc.getDiskImage(unit) !== null;
    return 0x3C
      | (this.fdc.intrq ? 0x02 : 0)
      | (this.changed[unit] ? 0 : 0x40)
      | (this.fdc.drq ? 0x80 : 0)
      | (ready ? 0 : 0x01);
  }
}
