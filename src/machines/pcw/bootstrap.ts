/**
 * PCW bootstrap — standing in for the gate array's bootstrap mode.
 *
 * The PCW has no ROM at all. Jacob Nevins' account of the boot sequence
 * describes what happens instead: on reset the machine enters a "bootstrap
 * mode" in which instruction fetches "come from somewhere special (the gate
 * array and/or printer controller, presumably)" rather than from RAM. That
 * invented code copies 256 bytes into RAM at &0002-&0101, leaves bootstrap mode
 * with `OUT (&F8),0`, then runs from RAM: it initialises the FDC, reads the
 * 512-byte boot sector from drive A cylinder 0, head 0, sector 1 to
 * &F000-&F1FF, checksums it, and jumps to &F010.
 *
 * There is no dump of that invented code, so this module performs the same
 * *observable* job natively: place the boot sector where the hardware would
 * have placed it, verify the checksum the same way, and start the CPU at &F010.
 * Everything from that entry point on is the real boot sector's own code
 * driving the real emulated FDC, so only the 15ms of gate-array bootstrap is
 * short-circuited.
 *
 * The checksum rule, quoted: "Sum 512 bytes F000..F1FF, starting and ending at
 * F010", and the "sum should be 0FFh". A disc that fails it is not a system
 * disc, and real hardware refuses it — it "complains" with the bleeps of doom
 * rather than executing the sector — so this refuses it too, and says why.
 */

import type { DskImage } from '@/media/floppy/disk-image.ts';
import { PCW_BOOT_SECTOR_SIZE } from './constants.ts';

/** Outcome of an attempted boot, for the machine's status line. */
export type BootResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; reason: 'no-disc' | 'unreadable' | 'checksum' };

/**
 * Locate cylinder 0 / head 0 / sector 1 of a mounted disc.
 *
 * PCW system discs number their sectors from 1 (CP/M format) — a data disc
 * formatted without a boot sector simply has no matching record, which is the
 * 'unreadable' case.
 */
function readBootSector(image: DskImage): Uint8Array | null {
  const track = image.tracks[0]?.[0];
  if (!track) return null;
  const index = track.sectorMap.get(1);
  if (index === undefined) return null;
  const sector = track.sectors[index];
  if (!sector || sector.data.length < PCW_BOOT_SECTOR_SIZE) return null;
  return sector.data.subarray(0, PCW_BOOT_SECTOR_SIZE);
}

/** The hardware's boot-sector checksum: the 512 bytes, summed 8 bits wide,
 *  must come to &FF. */
export function bootChecksumValid(data: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < PCW_BOOT_SECTOR_SIZE; i++) sum = (sum + data[i]) & 0xFF;
  return sum === 0xFF;
}

/** Read and validate the boot sector of the disc in drive A. */
export function loadBootSector(image: DskImage | null): BootResult {
  if (!image) return { ok: false, reason: 'no-disc' };
  const data = readBootSector(image);
  if (!data) return { ok: false, reason: 'unreadable' };
  if (!bootChecksumValid(data)) return { ok: false, reason: 'checksum' };
  return { ok: true, data };
}

/** Human-readable explanation for a failed boot, for the status line. */
export function bootFailureMessage(reason: 'no-disc' | 'unreadable' | 'checksum'): string {
  switch (reason) {
    case 'no-disc': return 'No disc in drive A — insert a system disc and reset';
    case 'unreadable': return 'Drive A: cannot read the boot sector (track 0, sector 1)';
    case 'checksum': return 'Drive A: not a system disc (boot sector checksum failed)';
  }
}
