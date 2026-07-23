/**
 * Memotech FDX/SDX floppy interface.
 *
 * The board combines a WD179x-compatible controller at ports 10h–13h with a
 * Memotech drive-control/status latch at port 14h. The latch selects drive,
 * side, motor and density and exposes READY, INTRQ and DRQ.
 */

import { WD179x } from '@/cores/wd179x.ts';

const DRIVE = 0x01;
const SIDE = 0x02;
const MOTOR_ON = 0x04;
const MOTOR_READY = 0x08;
const DOUBLE_DENSITY = 0x10;

const STATUS_READY = 0x20;
const STATUS_INTERRUPT = 0x40;
const STATUS_DATA_REQUEST = 0x80;
/** Head-load, sides, tracks, drive-count and link configuration bits. */
const TYPE07_DRIVE_CONFIGURATION = 0x08;

export class MtxFdx {
  readonly fdc = new WD179x({
    statusBit7: 'not-ready',
    formatSectorsPerTrack: 16,
  });

  private control = 0;
  private interrupt = false;

  get controlRegister(): number { return this.control; }
  get selectedDrive(): number { return this.control & DRIVE; }
  get selectedSide(): number { return (this.control & SIDE) >> 1; }
  get motorOn(): boolean { return (this.control & MOTOR_ON) !== 0; }
  get doubleDensity(): boolean { return (this.control & DOUBLE_DENSITY) !== 0; }

  reset(): void {
    this.fdc.reset();
    this.control = 0;
    this.interrupt = false;
  }

  read(port: number): number {
    switch (port & 0xFF) {
      case 0x10: return this.fdc.readStatus();
      case 0x11: return this.fdc.readTrack();
      case 0x12: return this.fdc.readSectorReg();
      case 0x13: {
        const value = this.fdc.readData();
        this.updateInterrupt();
        return value;
      }
      case 0x14: {
        let status = TYPE07_DRIVE_CONFIGURATION;
        if (
          this.fdc.getDiskImage(this.selectedDrive) !== null &&
          (this.control & (MOTOR_ON | MOTOR_READY)) === (MOTOR_ON | MOTOR_READY)
        ) status |= STATUS_READY;
        if (this.interrupt) status |= STATUS_INTERRUPT;
        if (this.fdc.drq) status |= STATUS_DATA_REQUEST;
        return status;
      }
      default: return 0xFF;
    }
  }

  write(port: number, value: number): void {
    value &= 0xFF;
    switch (port & 0xFF) {
      case 0x10:
        this.interrupt = false;
        this.fdc.writeCommand(value);
        // Unlike the WD177x automatic spin-down helper, the FDX motor is held
        // directly by bit 2 of the Memotech control latch.
        this.fdc.motorOn = this.motorOn;
        this.updateInterrupt();
        break;
      case 0x11: this.fdc.writeTrack(value); break;
      case 0x12: this.fdc.writeSectorReg(value); break;
      case 0x13:
        this.fdc.writeData(value);
        this.updateInterrupt();
        break;
      case 0x14:
        this.control = value;
        this.fdc.selectDrive(this.selectedDrive);
        this.fdc.setSide(this.selectedSide);
        this.fdc.motorOn = this.motorOn;
        break;
    }
  }

  tickFrame(): void {
    this.fdc.tickFrame();
    this.fdc.motorOn = this.motorOn;
  }

  private updateInterrupt(): void {
    if (this.fdc.intrq && !this.fdc.drq) this.interrupt = true;
  }
}
