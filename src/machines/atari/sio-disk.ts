/**
 * The disk drives' command set, shared by both ways a program can reach them:
 * the native SIOV fast path (`sio.ts`, which moves data to and from the DCB's
 * buffer) and the bit-level serial bus (`sio-bus.ts`, which moves it a bit at
 * a time through POKEY). Neither knows how a command is carried out; this
 * class does, against the disk service and the fitted drive model.
 *
 *   STATUS ($53)            reply: the four-byte status block
 *   READ ($52)              reply: the sector
 *   WRITE ($57) / PUT ($50) input: the sector
 *   VERIFY ($56)            no data
 *   FORMAT ($21)            reply: a sector of $FF (no bad sectors)
 *   FORMAT ENHANCED ($22)   the same, on drives that have it (not the 810)
 *   READ PERCOM ($4E)       reply: the 12-byte configuration block
 *   WRITE PERCOM ($4F)      input: the 12-byte configuration block
 *
 * A device is "present" when its drive holds a disk: an empty drive is
 * treated as switched off and does not answer at all. An executable armed to
 * boot (xex.ts) answers as D1:.
 */

import type { AtariMachine } from './atari-machine.ts';
import {
  acceptPercom, driveFormatsEnhanced, driveHasPercom, driveReads, percomReport,
} from './drive-models.ts';
import { xexBootSector } from './xex.ts';

export const SIO_OK = 0x01;
export const SIO_TIMEOUT = 0x8a;
export const SIO_NAK = 0x8b;
export const SIO_CHECKSUM = 0x8f;
export const SIO_DEVICE_ERROR = 0x90;

export const CMD_FORMAT = 0x21;
export const CMD_FORMAT_ENHANCED = 0x22;
export const CMD_READ_PERCOM = 0x4e;
export const CMD_WRITE_PERCOM = 0x4f;
export const CMD_PUT = 0x50;
export const CMD_READ = 0x52;
export const CMD_STATUS = 0x53;
export const CMD_VERIFY = 0x56;
export const CMD_WRITE = 0x57;

export const PERCOM_SIZE = 12;
/** Longest data frame a drive sends or takes (a 256-byte sector). */
export const MAX_SECTOR = 256;

const DEVICE_D1 = 0x31;

export class SioDisks {
  /** The data `run` produced for a read-type command, else null. */
  reply: Uint8Array | null = null;

  constructor(private readonly m: AtariMachine) {}

  /** True when a device answers on the bus: a drive holding a disk, or the
   *  boot executable posing as D1:. */
  present(device: number): boolean {
    if (device === DEVICE_D1 && this.m.xex?.phase === 'boot') return true;
    return this.m.services.disks.driveForDevice(device)?.disk != null;
  }

  /**
   * How many data bytes the computer sends after the command frame (0 for
   * none), or -1 when the drive refuses the command (NAK). Call only for a
   * present device.
   */
  inputLength(device: number, command: number, sector: number): number {
    if (device === DEVICE_D1 && this.m.xex?.phase === 'boot') {
      return command === CMD_STATUS || command === CMD_READ ? 0 : -1;
    }
    const model = this.m.services.disks.modelFor(device);
    switch (command) {
      case CMD_STATUS:
      case CMD_FORMAT:
        return 0;
      case CMD_READ:
      case CMD_VERIFY:
        return this.sectorExists(device, sector) ? 0 : -1;
      case CMD_FORMAT_ENHANCED:
        return driveFormatsEnhanced(model) ? 0 : -1;
      case CMD_READ_PERCOM:
        return driveHasPercom(model) ? 0 : -1;
      case CMD_WRITE_PERCOM:
        return driveHasPercom(model) ? PERCOM_SIZE : -1;
      case CMD_WRITE:
      case CMD_PUT: {
        const disk = this.m.services.disks.driveForDevice(device)?.disk;
        if (!disk || !this.sectorExists(device, sector)) return -1;
        return disk.sectorLength(sector);
      }
      default:
        return -1;
    }
  }

  /**
   * A sector number the disk has. The drive checks it before it ACKs: sector 0
   * or one past the last is refused outright (NAK), with no data frame and no
   * wait for one, rather than failing after the transfer.
   */
  private sectorExists(device: number, sector: number): boolean {
    if (device === DEVICE_D1 && this.m.xex?.phase === 'boot') return true;
    const disk = this.m.services.disks.driveForDevice(device)?.disk;
    return disk != null && sector >= 1 && sector <= disk.sectorCount;
  }

  /**
   * The length of the data frame a drive still sends after it answers ERROR to
   * a read-type command (the protocol sends one whether or not the command
   * worked; its contents are not meaningful), or 0 when none follows.
   */
  errorFrameLength(device: number, command: number, sector: number): number {
    const disk = this.m.services.disks.driveForDevice(device)?.disk;
    if (!disk) return 0;
    switch (command) {
      case CMD_READ:
        return sector >= 1 && sector <= disk.sectorCount ? disk.sectorLength(sector) : disk.sectorSize;
      case CMD_FORMAT:
      case CMD_FORMAT_ENHANCED:
        return disk.sectorSize;
      case CMD_READ_PERCOM:
        return PERCOM_SIZE;
      default:
        return 0;
    }
  }

  /**
   * Carry the command out and return its status (SIO_OK, SIO_DEVICE_ERROR or
   * SIO_TIMEOUT for a device that is not there). `input` is the data frame of
   * a write-type command. Read-type commands leave their data in `reply`.
   */
  run(device: number, command: number, sector: number, input: Uint8Array | null): number {
    this.reply = null;
    // An executable waiting to boot answers as D1:, with the boot record that
    // hands over to its loader (xex.ts), until the loader takes over.
    if (device === DEVICE_D1 && this.m.xex?.phase === 'boot') {
      if (command === CMD_STATUS) {
        this.reply = new Uint8Array([0x00, 0xff, 0xe0, 0x00]);
        return SIO_OK;
      }
      if (command === CMD_READ && sector === 1) {
        this.reply = xexBootSector();
        return SIO_OK;
      }
      return SIO_DEVICE_ERROR;
    }
    const disks = this.m.services.disks;
    const drive = disks.driveForDevice(device);
    if (!drive?.disk) return SIO_TIMEOUT;
    const model = drive.model;

    switch (command) {
      case CMD_STATUS:
        this.reply = disks.statusBytes(device);
        return SIO_OK;
      case CMD_READ: {
        const data = disks.readSector(device, sector);
        if (!data) return SIO_DEVICE_ERROR;
        this.reply = data;
        return SIO_OK;
      }
      case CMD_VERIFY:
        return disks.readSector(device, sector) ? SIO_OK : SIO_DEVICE_ERROR;
      case CMD_WRITE:
      case CMD_PUT:
        if (drive.writeProtected || !input) return SIO_DEVICE_ERROR;
        return disks.writeSector(device, sector, input) ? SIO_OK : SIO_DEVICE_ERROR;
      case CMD_FORMAT:
        // A real drive would format; the image is left alone so a stray
        // format cannot destroy a disk the user just mounted.
        if (drive.writeProtected || !driveReads(model, drive.disk)) return SIO_DEVICE_ERROR;
        this.reply = new Uint8Array(drive.disk.sectorSize).fill(0xff);
        return SIO_OK;
      case CMD_FORMAT_ENHANCED:
        if (!driveFormatsEnhanced(model)) return SIO_NAK;
        if (drive.writeProtected) return SIO_DEVICE_ERROR;
        this.reply = new Uint8Array(drive.disk.sectorSize).fill(0xff);
        return SIO_OK;
      case CMD_READ_PERCOM:
        if (!driveHasPercom(model)) return SIO_NAK;
        this.reply = percomReport(model, drive.disk, drive.percom);
        return SIO_OK;
      case CMD_WRITE_PERCOM: {
        if (!driveHasPercom(model)) return SIO_NAK;
        // The drive keeps what it is told (the disk image is not reformatted).
        const kept = acceptPercom(model, input);
        if (!kept) return SIO_DEVICE_ERROR;
        drive.percom = kept;
        drive.lastOpFailed = false;
        return SIO_OK;
      }
      default:
        return SIO_NAK;
    }
  }
}
