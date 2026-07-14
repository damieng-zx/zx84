/**
 * WD1793 Floppy Disk Controller — used by the Beta Disk interface (TR-DOS).
 *
 * Register- and command-compatible with the WD1772 (see wd179x.ts for the
 * shared engine); two things differ on the 1793:
 *
 *   • Status bit 7 is the NOT READY line (the 1793 has a real READY input),
 *     not the 1772's MOTOR ON. TR-DOS polls it to detect an empty drive, so we
 *     report "not ready" (bit 7 set) when the selected drive holds no disk.
 *   • A TR-DOS format lays down 16 × 256-byte sectors per track (the +D's
 *     G+DOS format is 10 × 512), so the WRITE TRACK parser finalises at 16.
 *
 * The Beta system port (0xFF) reads the FDC's INTRQ/DRQ lines — exposed by the
 * base class getters `intrq` / `drq`.
 */

import { WD179x } from '@/cores/wd179x.ts';

export class WD1793 extends WD179x {
  /** NOT READY: bit 7 is set when the selected drive has no disk. */
  protected override statusBit7(): number {
    return this.disks[this.currentDrive] === null ? 0x80 : 0;
  }

  /** A TR-DOS track is 16 × 256-byte sectors. */
  protected override readonly formatSectorsPerTrack = 16;
}
