/**
 * Native SIO fast path for the Atari disk drives and program recorder.
 *
 * The real OS implements SIO in software: a deferred VBI clocks bytes through
 * POKEY's serial port bit by bit and samples the command/ready lines. That is
 * faithful but painfully slow, and it is also the piece that hangs when no
 * device answers. This module services the DCB at $0300 directly when the CPU
 * reaches SIOV, before the bit-level routine runs:
 *
 *   D1: ($31) and D2: ($32), the drives of the fitted model (drive-models.ts):
 *     STATUS ($53)          the four-byte status block
 *     READ ($52)            one sector into the buffer
 *     WRITE ($57) / PUT ($50) one sector from the buffer
 *     FORMAT ($21)          accepted without rewriting the image
 *     FORMAT ENHANCED ($22) the same, on drives that have it (not the 810)
 *     READ/WRITE PERCOM ($4E/$4F)  the XF551's configuration block
 *   C: ($60), the 410/1010 program recorder (cassette.ts):
 *     READ ($52)            the next record frame the tape reaches
 *     WRITE ($57 or $50)    one record frame to the recording
 *
 * With `cassetteFastPath` off, cassette reads are left to the OS, which then
 * reads the tape bit by bit through POKEY in real time, as it does on the
 * real machine. Cassette writes are always served here.
 *
 * Programs that skip the OS and drive POKEY's serial port themselves reach
 * the disk drives through the bit-level bus instead (sio-bus.ts); both paths
 * share the drives' command set in sio-disk.ts.
 *
 * Status codes are the ones a real device produces: 1 for success, 138
 * (timeout) when nothing answers or the tape has run out, 139 (NAK) for a
 * command the device does not support, 143 for a tape checksum error, and
 * 144 (device error) when a drive answers but fails: a density it cannot
 * read, a write-protected disk, a missing sector.
 *
 * An empty drive is treated as switched off, so it times out. A real drive
 * that is on with no disk answers every boot attempt with an error and the
 * OS prints BOOT ERROR forever, which is why owners switched it off.
 *
 * The handler then returns exactly as the OS routine does: the status in Y
 * (and in DSTATS and STATUS), with N set for an error so callers can `BMI`,
 * from the `JSR` that reached SIOV.
 *
 * The trap sits on SIOV ($E459), the published OS vector every revision
 * keeps. Its target is not stable: the 400/800 OS jumps to $E959, the XL OS
 * to its parallel-bus handler at $C933 first, which never reaches $E959.
 */

import { FLAG_C, FLAG_N, FLAG_Z } from '@/cores/m6502.ts';
import { sioChecksum } from '@/media/tape/atari-cas.ts';
import type { AtariMachine } from './atari-machine.ts';
import {
  CMD_PUT, CMD_READ, CMD_WRITE, SIO_CHECKSUM, SIO_DEVICE_ERROR, SIO_NAK, SIO_OK, SIO_TIMEOUT, SioDisks,
} from './sio-disk.ts';

/** SIOV, the OS's SIO vector. */
export const SIO_ENTRY = 0xe459;

const DCB = 0x0300;
/** OS zero-page copy of the last SIO status. */
const STATUS = 0x0030;

export { SIO_OK, SIO_TIMEOUT, SIO_NAK, SIO_CHECKSUM, SIO_DEVICE_ERROR };

const DEVICE_CASSETTE = 0x60;

// OS locations a real SIO call reads or leaves behind.
const BRKKEY = 0x0011;
const CHKSNT = 0x003b;
const CRITIC = 0x0042;
const CDTMA1 = 0x0226;
const SSKCTL = 0x0232;
const TIMFLG = 0x0317;
/** An RTS in the OS ROM, the dummy timer-1 routine SIO installs. */
const KNOWN_RTS = 0xe4c0;

/**
 * Which way a recorder call moves data. The OSes disagree on the write
 * command byte (the Atari OS writes with $57, AltirraOS with $50), so both are
 * accepted. A command the
 * recorder does not know is judged by the DCB's direction bits instead, as a
 * loader with its own command byte would expect: DSTATS bit 6 means the
 * computer receives (a read), bit 7 that it sends (a write).
 */
export function recorderDirection(dstats: number, command: number): 'read' | 'write' | null {
  if (command === CMD_READ) return 'read';
  if (command === CMD_WRITE || command === CMD_PUT) return 'write';
  if (dstats & 0x40) return 'read';
  if (dstats & 0x80) return 'write';
  return null;
}

export class AtariSio {
  /** Serve cassette reads whole (instant loading). */
  cassetteFastPath = true;
  /** The drives' command set, shared with the bit-level bus (sio-bus.ts). */
  readonly disks: SioDisks;

  constructor(private readonly m: AtariMachine) {
    this.disks = new SioDisks(m);
  }

  /** True when the call waiting at SIOV is one this fast path serves. */
  claims(): boolean {
    const mem = this.m.memory;
    // The OS's own SIO is left to run when the transfer would trample TIMFLG,
    // which it uses to time the call out (Formula 1 Racing reads its sectors
    // over it), or when BREAK has been pressed, so that it sees the break.
    const buffer = mem.readByte(DCB + 0x04) | (mem.readByte(DCB + 0x05) << 8);
    const length = mem.readByte(DCB + 0x08) | (mem.readByte(DCB + 0x09) << 8);
    if (buffer <= TIMFLG && TIMFLG - buffer < length) return false;
    if (mem.readByte(BRKKEY) === 0) return false;
    if (this.cassetteFastPath) return true;
    return mem.readByte(DCB + 0x00) !== DEVICE_CASSETTE
      || recorderDirection(mem.readByte(DCB + 0x03), mem.readByte(DCB + 0x02)) !== 'read';
  }

  /** Service the DCB at $0300 and return from the SIO call. */
  handle(): void {
    const mem = this.m.memory;
    // DDEVIC + DUNIT - 1 is the bus ID, as the OS's own SIO forms it (D2: is
    // DDEVIC $31, DUNIT 2). The cassette is recognised by DDEVIC alone.
    const ddevic = mem.readByte(DCB + 0x00);
    const device = (ddevic + mem.readByte(DCB + 0x01) - 1) & 0xff;
    const command = mem.readByte(DCB + 0x02);
    const buffer = mem.readByte(DCB + 0x04) | (mem.readByte(DCB + 0x05) << 8);
    const length = mem.readByte(DCB + 0x08) | (mem.readByte(DCB + 0x09) << 8);
    const aux = mem.readByte(DCB + 0x0a) | (mem.readByte(DCB + 0x0b) << 8);
    // DSTATS holds the transfer direction on entry; the status replaces it below.
    const dstats = mem.readByte(DCB + 0x03);

    const status = ddevic === DEVICE_CASSETTE
      ? this.cassette(recorderDirection(dstats, command), buffer, length)
      : this.disk(device, command, buffer, length, aux);

    mem.writeByte(DCB + 0x03, status);
    mem.writeByte(STATUS, status);
    this.leaveOsState(ddevic === DEVICE_CASSETTE, status);
    const cpu = this.m.cpu;
    cpu.y = status;
    cpu.p = (cpu.p & ~(FLAG_N | FLAG_Z | FLAG_C)) | (status & 0x80 ? FLAG_N : 0) | (status === 0 ? FLAG_Z : 0)
      // The OS leaves carry from its last compares of the status, against 1
      // then $8A: clear for a failure below $8A (Micropainter tests it).
      | (status !== SIO_OK && status < SIO_TIMEOUT ? 0 : FLAG_C);
    cpu.a = 0; // SIOV clears CRITIC on the way out
    cpu.x = 0xfe;
    this.returnFromSio();
  }

  /**
   * What the OS's SIO routine leaves behind, which programs depend on: the
   * checksum-sent flag (Apple Panic enables the serial output complete
   * interrupt after a read and loops in its IRQ if it is not set), the
   * timeout flag the VBI clears (some tape loaders look at it after a good
   * read), CRITIC cleared, the timer 1 routine pointer defaulted (Ankh uses
   * timer 1 without setting it up), and, for anything but the recorder,
   * POKEY's serial setup: channels 3+4 at 19200 baud with asynchronous
   * receive (Wayout otherwise plays garbage on them).
   */
  private leaveOsState(recorder: boolean, status: number): void {
    const mem = this.m.memory;
    if (!recorder) {
      mem.writeByte(0xd204, 0x28); // AUDF3
      mem.writeByte(0xd206, 0x00); // AUDF4
      mem.writeByte(0xd20f, 0x13); // SKCTL
      mem.writeByte(SSKCTL, 0x13);
    }
    if (mem.readByte(CDTMA1) === 0 && mem.readByte(CDTMA1 + 1) === 0) {
      mem.writeByte(CDTMA1, KNOWN_RTS & 0xff);
      mem.writeByte(CDTMA1 + 1, KNOWN_RTS >> 8);
    }
    mem.writeByte(CHKSNT, 0xff);
    mem.writeByte(CRITIC, 0);
    mem.writeByte(TIMFLG, status === SIO_TIMEOUT ? 0 : 1);
  }

  // ── Disk drives ──────────────────────────────────────────────────────────

  private disk(device: number, command: number, buffer: number, length: number, sector: number): number {
    const drives = this.disks;
    if (!drives.present(device)) return SIO_TIMEOUT;
    const need = drives.inputLength(device, command, sector);
    if (need < 0) return SIO_NAK;

    // The data frame of a write-type command comes from the DCB's buffer.
    let input: Uint8Array | null = null;
    if (need > 0) {
      input = new Uint8Array(need);
      const count = length > 0 ? Math.min(length, need) : need;
      for (let i = 0; i < count; i++) input[i] = this.m.memory.readByte((buffer + i) & 0xffff);
    }
    // A data frame of the wrong length is not what the drive expects: a short
    // one leaves it waiting for the rest, so the call times out; a long one puts
    // a data byte where the drive wants the checksum, and it NAKs.
    if (need > 0 && length > 0 && length !== need) return length < need ? SIO_TIMEOUT : SIO_NAK;
    const status = drives.run(device, command, sector, input);
    const reply = drives.reply;
    if (status !== SIO_OK || !reply) return status;

    // The OS reads DBYT bytes and takes the next as the checksum. A drive that
    // sends more leaves a data byte in the checksum's place (checksum error);
    // one that sends fewer is never heard from again (timeout). Either way the
    // buffer holds what arrived, and DBYT is left as the caller set it.
    const count = length > 0 ? Math.min(length, reply.length) : reply.length;
    this.copyIn(buffer, reply, count);
    if (length > 0 && reply.length !== length) return reply.length > length ? SIO_CHECKSUM : SIO_TIMEOUT;
    return status;
  }

  // ── Program recorder ─────────────────────────────────────────────────────

  private cassette(direction: 'read' | 'write' | null, buffer: number, length: number): number {
    const tape = this.m.cassette;
    if (direction === 'read') {
      if (!tape.loaded) return SIO_TIMEOUT;
      const record = tape.readRecord();
      if (!record) return SIO_TIMEOUT; // run off the end of the tape
      this.m.activity.casReads++;
      this.m.noteTapeRead();
      const count = Math.min(length, record.length);
      this.copyIn(buffer, record, count);
      // The byte after the frame is its checksum, when the record has one.
      if (record.length > count && record[count] !== sioChecksum(record, count)) return SIO_CHECKSUM;
      return SIO_OK;
    }
    if (direction === 'write') {
      const frame = new Uint8Array(length);
      for (let i = 0; i < length; i++) frame[i] = this.m.memory.readByte((buffer + i) & 0xffff);
      tape.writeRecord(frame);
      return SIO_OK;
    }
    return SIO_NAK;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private copyIn(buffer: number, data: Uint8Array, length: number): void {
    const count = Math.min(length, data.length);
    for (let i = 0; i < count; i++) this.m.memory.writeByte((buffer + i) & 0xffff, data[i]);
  }

  /** Pop the return address pushed by the `JSR` that reached the SIO entry. */
  private returnFromSio(): void {
    const cpu = this.m.cpu;
    const mem = this.m.memory;
    let sp = (cpu.sp + 1) & 0xff;
    const lo = mem.readByte(0x0100 | sp) & 0xff;
    sp = (sp + 1) & 0xff;
    const hi = mem.readByte(0x0100 | sp) & 0xff;
    cpu.sp = sp;
    cpu.pc = (((hi << 8) | lo) + 1) & 0xffff;
    cpu.tStates += 8; // the JSR/RTS pair's nominal cycles
  }
}
