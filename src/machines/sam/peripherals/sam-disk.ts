/**
 * SAM Coupé internal disk interface — two 3.5" drives on WD1772 controllers.
 *
 * Simpler than the +D it shares a controller with: there is no shadow ROM and
 * no paging trap, because SAMDOS and MasterDOS are ordinary programs loaded
 * from disk into RAM. The interface is nothing but the two FDCs.
 *
 * Port decode (transcribed from SimCoupe's `Base/SAMIO.cpp` dispatch and
 * `Base/Drive.cpp`):
 *
 *   0xE0-0xE7   drive 1        0xF0-0xF7   drive 2
 *
 *   port & 0x03   selects the WD1772 register:
 *                 0 = status (read) / command (write)
 *                 1 = track,  2 = sector,  3 = data
 *   (port >> 2) & 1   selects the head.
 *
 * Note the head is chosen by *which address you use*, not by a separate control
 * register — so 0xE0-0xE3 address side 0 and 0xE4-0xE7 side 1. The drives are
 * two independent controllers rather than one with a drive-select line, which
 * is why the SAM can have a different disk spinning in each.
 *
 * The motor is driven by the controller itself (`statusBit7: 'motor-on'`), so
 * nothing here has to model it.
 */

import { WD179x } from '@/cores/wd179x.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';

/** Address mask isolating a drive's 8-port block. */
const FLOPPY_MASK = 0xF8;
export const FLOPPY1_BASE = 0xE0;
export const FLOPPY2_BASE = 0xF0;

/** WD1772 register selected by the low two address bits. */
const REG_STATUS_COMMAND = 0;
const REG_TRACK = 1;
const REG_SECTOR = 2;
/** Register 3 is the data port — the `default` arm of both switches. */

export class SamDiskInterface {
  /** One controller per drive; index 0 is drive 1, index 1 is drive 2. */
  readonly fdc: readonly [WD179x, WD179x];

  /** Accesses this frame, for the disk activity LED. */
  accesses = 0;

  constructor() {
    const make = () => new WD179x({
      // WD1770/1772 report MOTOR ON in status bit 7, unlike the 1793's NOT READY.
      statusBit7: 'motor-on',
      // The SAM's 800K format lays down ten 512-byte sectors per track.
      formatSectorsPerTrack: 10,
    });
    this.fdc = [make(), make()];
  }

  reset(): void {
    for (const f of this.fdc) f.reset();
    this.accesses = 0;
  }

  /** Which drive a port belongs to (0 or 1), or -1 when it is not ours. */
  static driveFor(port: number): number {
    const lo = port & 0xFF;
    if ((lo & FLOPPY_MASK) === FLOPPY1_BASE) return 0;
    if ((lo & FLOPPY_MASK) === FLOPPY2_BASE) return 1;
    return -1;
  }

  read(port: number): number {
    const drive = SamDiskInterface.driveFor(port);
    if (drive < 0) return 0xFF;
    const f = this.fdc[drive];
    this.accesses++;
    // Every access re-asserts the head this address selects.
    f.setSide((port >> 2) & 1);
    switch (port & 0x03) {
      case REG_STATUS_COMMAND: return f.readStatus();
      case REG_TRACK: return f.readTrack();
      case REG_SECTOR: return f.readSectorReg();
      default: return f.readData();
    }
  }

  write(port: number, value: number): void {
    const drive = SamDiskInterface.driveFor(port);
    if (drive < 0) return;
    const f = this.fdc[drive];
    this.accesses++;
    f.setSide((port >> 2) & 1);
    switch (port & 0x03) {
      case REG_STATUS_COMMAND: f.writeCommand(value); return;
      case REG_TRACK: f.writeTrack(value); return;
      case REG_SECTOR: f.writeSectorReg(value); return;
      default: f.writeData(value); return;
    }
  }

  /** Per-UI-frame bookkeeping for both controllers. */
  frameTick(): void {
    for (const f of this.fdc) f.tickFrame();
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  insert(drive: number, image: DskImage): void {
    this.fdc[drive & 1].insertDisk(image, 0);
  }

  eject(drive: number): void {
    this.fdc[drive & 1].ejectDisk(0);
  }

  image(drive: number): DskImage | null {
    return this.fdc[drive & 1].getDiskImage(0);
  }

  writeProtected(drive: number): boolean {
    return this.fdc[drive & 1].writeProtect[0];
  }

  setWriteProtect(drive: number, on: boolean): void {
    this.fdc[drive & 1].writeProtect[0] = on;
  }

  motorOn(drive: number): boolean {
    return this.fdc[drive & 1].motorOn;
  }

  track(drive: number): number {
    return this.fdc[drive & 1].getUnitTrack(0);
  }
}
