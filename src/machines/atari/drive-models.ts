/**
 * Atari disk drive models, and the disk geometries each can read.
 *
 * Every drive here sits on the SIO bus as D1:/D2: and speaks the same command
 * set; what differs is the media it can handle:
 *
 *   810    single density only: 720 sectors of 128 bytes (90K)
 *   1050   adds enhanced ("dual") density: 1040 sectors of 128 bytes (130K)
 *   XF551  adds true double density, 256-byte sectors: 720 (180K) on one
 *          side, 1440 (360K) on both; and answers the PERCOM configuration
 *          query DOSes use to ask a drive its format
 *   SIO2PC a PC (or APE / SIO2SD) serving image files as a drive: any ATR,
 *          hard-disk sized ones included (up to 65,535 sectors), with PERCOM.
 *          The default, since collections hold images no physical drive reads
 *
 * A disk the drive cannot read fails on the real machine with a device error
 * (status 144) rather than a timeout: the drive answers, it just cannot find
 * the sectors. The SIO fast path reproduces that.
 */

import type { AtariDisk } from '@/media/floppy/atr.ts';

export type AtariDriveModel = '810' | '1050' | 'xf551' | 'sio2pc';

export const ATARI_DRIVE_MODELS: readonly {
  readonly value: AtariDriveModel;
  readonly label: string;
  readonly title: string;
}[] = [
  { value: '810', label: 'Atari 810', title: 'Single density only (90K disks)' },
  { value: '1050', label: 'Atari 1050', title: 'Single and enhanced density (90K and 130K disks)' },
  { value: 'xf551', label: 'Atari XF551', title: 'Single, enhanced and double density, double-sided (up to 360K)' },
  { value: 'sio2pc', label: 'SIO2PC (any image)', title: 'A PC serving disk images: any size, hard-disk images included' },
];

export const DEFAULT_DRIVE_MODEL: AtariDriveModel = 'sio2pc';

/** SIO addresses eight disk drives ($31-$38); the Drives pane offers four,
 *  which is as many as the DOSes of the day configure. */
export const ATARI_MAX_DRIVES = 4;
export const ATARI_DEFAULT_DRIVE_COUNT = 2;

/** The drives fitted by default: two of the default model. */
export const DEFAULT_DRIVE_MODELS: readonly AtariDriveModel[] =
  Array.from({ length: ATARI_DEFAULT_DRIVE_COUNT }, () => DEFAULT_DRIVE_MODEL);

const SD_SECTORS = 720;
const ED_SECTORS = 1040;
const DSDD_SECTORS = 1440;

export function isAtariDriveModel(value: unknown): value is AtariDriveModel {
  return value === '810' || value === '1050' || value === 'xf551' || value === 'sio2pc';
}

/** A saved drive list made safe: unknown models fall back to the default,
 *  and the list is held to one to `ATARI_MAX_DRIVES` drives. Anything that is
 *  not a list at all is the default pair. */
export function normalizeDriveModels(value: unknown): AtariDriveModel[] {
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_DRIVE_MODELS];
  return value.slice(0, ATARI_MAX_DRIVES).map(v => (isAtariDriveModel(v) ? v : DEFAULT_DRIVE_MODEL));
}

/** True when `model` can read `disk`. */
export function driveReads(model: AtariDriveModel, disk: AtariDisk): boolean {
  if (model === 'sio2pc') return true;
  if (disk.sectorSize > 256) return false; // hard-disk images need a PC behind them
  if (disk.sectorSize === 256) return model === 'xf551' && disk.sectorCount <= DSDD_SECTORS;
  if (disk.sectorCount <= SD_SECTORS) return true;
  return model !== '810' && disk.sectorCount <= ED_SECTORS;
}

/** The cheapest drive that reads `disk` (SIO2PC reads anything). */
export function minimumDriveFor(disk: AtariDisk): AtariDriveModel {
  for (const m of ['810', '1050', 'xf551'] as const) if (driveReads(m, disk)) return m;
  return 'sio2pc';
}

/** Enhanced density: 128-byte sectors past the single-density count. */
export function isEnhancedDensity(disk: AtariDisk): boolean {
  return disk.sectorSize === 128 && disk.sectorCount > SD_SECTORS;
}

/** Only the XF551 understands the PERCOM read/write configuration commands
 *  ($4E/$4F) and the 1050's enhanced-density format command ($22) is not on
 *  the 810. */
export function driveHasPercom(model: AtariDriveModel): boolean { return model === 'xf551' || model === 'sio2pc'; }
export function driveFormatsEnhanced(model: AtariDriveModel): boolean { return model !== '810'; }

/**
 * The 12-byte PERCOM block describing `disk`: tracks, step rate, sectors per
 * track (high, low), sides - 1, density (0 FM, 4 MFM), bytes per sector
 * (high, low), drive present ($FF), then three unused bytes.
 */
export function percomBlock(disk: AtariDisk): Uint8Array {
  // A hard-disk image is described as one track holding every sector.
  const floppy = disk.sectorCount <= DSDD_SECTORS;
  const tracks = floppy ? 40 : 1;
  const spt = floppy ? disk.sectorsPerTrack : disk.sectorCount;
  const sides = floppy && disk.sectorCount > tracks * spt ? 2 : 1;
  const mfm = disk.sectorSize >= 256 || (floppy && isEnhancedDensity(disk));
  return new Uint8Array([
    tracks, 1, (spt >> 8) & 0xFF, spt & 0xFF, sides - 1, mfm ? 4 : 0,
    (disk.sectorSize >> 8) & 0xFF, disk.sectorSize & 0xFF, 0xFF, 0, 0, 0,
  ]);
}

/** Sector sizes a drive accepts in a PERCOM block. */
const PERCOM_BYTES = 12;
const PERCOM_SECTOR_SIZES: readonly number[] = [128, 256, 512, 8192];
/** The most sectors a PERCOM block may describe (SIO sector numbers are 16-bit). */
const PERCOM_MAX_SECTORS = 65535;

/**
 * The block a drive keeps when a program writes one, or null when the drive
 * refuses it (the call then fails with a device error).
 *
 * The XF551 reads only enough of the block to tell single, enhanced and double
 * density apart and fills in the rest itself; every other drive takes any
 * block that describes a possible disk (some tracks, some sectors a track, one
 * or two sides, a usual sector size, no more sectors than a sector number can
 * address) and keeps it as written.
 */
export function acceptPercom(model: AtariDriveModel, block: Uint8Array | null): Uint8Array | null {
  if (!block || block.length < PERCOM_BYTES) return null;
  if (model === 'xf551') {
    const kept = new Uint8Array(PERCOM_BYTES);
    kept[0] = 40;
    kept[8] = 1;
    kept[9] = 0x41;
    if (block[3] === 26) {          // enhanced density: 128-byte sectors, MFM
      kept[3] = 26; kept[5] = 4; kept[7] = 128;
    } else if (block[6] === 0) {    // single density
      kept[3] = 18; kept[7] = 128;
    } else {                        // double density, one side or both
      kept[3] = 18; kept[4] = block[4] ? 1 : 0; kept[5] = 4; kept[6] = 1;
    }
    return kept;
  }
  const tracks = block[0];
  const perTrack = (block[2] << 8) | block[3];
  const sides = block[4];
  const size = (block[6] << 8) | block[7];
  if (tracks < 1 || perTrack < 1 || sides > 1 || !PERCOM_SECTOR_SIZES.includes(size)) return null;
  if (tracks * perTrack * (sides + 1) > PERCOM_MAX_SECTORS) return null;
  return block.slice(0, PERCOM_BYTES);
}

/**
 * The configuration block a drive reports: the one a program last wrote to it,
 * else the one that describes the disk in it. The XF551 always shows a zero
 * step rate and an active drive.
 */
export function percomReport(model: AtariDriveModel, disk: AtariDisk, written: Uint8Array | null): Uint8Array {
  const block = written ? written.slice() : percomBlock(disk);
  if (model === 'xf551') { block[1] = 0; block[8] = 1; }
  return block;
}

/** The format bits of the drive status byte for a PERCOM block: bit 5 for a
 *  sector size above 255 bytes (double density), bit 6 for two sides, bit 7
 *  for 26 sectors a track (enhanced density). */
export function percomStatusBits(block: Uint8Array): number {
  const perTrack = (block[2] << 8) | block[3];
  return (block[6] !== 0 ? 0x20 : 0) | (block[4] > 0 ? 0x40 : 0) | (perTrack === 26 ? 0x80 : 0);
}
