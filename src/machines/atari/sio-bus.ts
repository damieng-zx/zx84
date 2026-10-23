/**
 * The device end of the SIO serial bus, at bit level.
 *
 * The OS's own SIO routine is trapped and served natively (sio.ts), but a
 * program that drives the bus itself (a custom loader, a fast-load or copy
 * protection routine) writes command and data bytes straight to POKEY's
 * SEROUT and reads the replies from SERIN. This is the other side of that
 * wire: it collects the bytes POKEY shifts out, follows the COMMAND line,
 * and answers on the data-in line `level()` as the drives would.
 *
 * The protocol (Atari SIO documentation):
 *
 *   1. The computer asserts COMMAND and sends a five-byte command frame:
 *      device ID ($31 for D1:), command, AUX1, AUX2 and a checksum (the 8-bit
 *      sum with the carry added back in). It then releases COMMAND.
 *   2. The addressed device answers ACK ('A', $41) or NAK ('N', $4E) a
 *      millisecond or so later. NAK means a bad checksum or a command the
 *      drive does not have. A device that is not there (an empty drive here,
 *      which is modelled as switched off) says nothing at all.
 *   3. A write-type command is followed by the computer's data frame (the
 *      sector and its checksum), which the device acknowledges the same way.
 *   4. The device carries the command out and reports COMPLETE ('C', $43) or
 *      ERROR ('E', $45); a read-type command (read, status, read PERCOM,
 *      format's bad-sector list) then sends its data frame, the data and a
 *      checksum.
 *
 * Every byte is ten bits on the wire, a start bit (0), eight data bits LSB
 * first and a stop bit (1), with mark (1) as the idle level. The device
 * sends at 19200 baud whatever rate the computer used. The delays are the
 * short end of what the drives do (the real ones take far longer to seek);
 * a program that waits for a reply is not sensitive to them, one that races
 * the bus gets the ordering the protocol promises.
 *
 * Time is kept in CPU cycles, advanced with the rest of the machine. The
 * level is a pure function of that time, so nothing allocates per cycle or
 * per byte; a command allocates its reply once.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { sioChecksum } from '@/media/tape/atari-cas.ts';
import { MAX_SECTOR, SIO_OK } from './sio-disk.ts';

/** What the bus needs of the devices on it (sio-disk.ts implements it). */
export interface SioBusDevices {
  /** True when something answers to this bus ID. */
  present(device: number): boolean;
  /** Data bytes the computer sends after the command frame, or -1 for NAK. */
  inputLength(device: number, command: number, sector: number): number;
  /** Carry the command out; read-type commands leave their data in `reply`. */
  run(device: number, command: number, sector: number, input: Uint8Array | null): number;
  /** Bytes of data frame that follow an ERROR to this command (0 for none). */
  errorFrameLength(device: number, command: number, sector: number): number;
  readonly reply: Uint8Array | null;
}

export const SIO_ACK = 0x41;
export const SIO_NAK_BYTE = 0x4e;
export const SIO_COMPLETE = 0x43;
export const SIO_ERROR = 0x45;

const BAUD = 19200;
const BITS_PER_BYTE = 10;
/** Command frame: device, command, aux1, aux2, checksum. */
const COMMAND_FRAME = 5;

/** Delay from the end of the frame (or COMMAND going high) to the ACK/NAK. */
const ACK_DELAY_MS = 1.0;
/** Delay from the end of the ACK to COMPLETE/ERROR. */
const COMPLETE_DELAY_MS = 1.5;
/** Gap between COMPLETE and the data frame that follows it. */
const DATA_GAP_MS = 0.3;

/** A reply is within this many cycles of starting, or shifting: chunk time. */
const NEAR_CYCLES = 192;

const enum Mode {
  /** Not collecting: bytes the computer sends are not for the bus. */
  Idle,
  /** COMMAND is asserted and the command frame is arriving. */
  Command,
  /** Waiting for the data frame of a write-type command. */
  Data,
}

const enum After {
  Nothing,
  /** Run the command, then send COMPLETE/ERROR. */
  Run,
  /** Send the staged data frame. */
  Frame,
}

export class SioBus {
  private readonly cyclesPerBit: number;
  private readonly byteCycles: number;
  private readonly msCycles: number;

  /** Cycles elapsed on the bus's own clock. */
  private now = 0;
  private command = false;
  private mode = Mode.Idle;

  /** Bytes arriving from the computer: a command or data frame. */
  private readonly rx = new Uint8Array(MAX_SECTOR + 1);
  private rxCount = 0;
  private rxNeed = 0;
  /** When the last byte of the frame has been fully sent. */
  private rxEnd = 0;

  /** The command being served. */
  private device = 0;
  private cmd = 0;
  private sector = 0;

  /** Bytes going out, the staged data frame, and the cursor into them. */
  private readonly tx = new Uint8Array(MAX_SECTOR + 2);
  private txLen = 0;
  private txPos = 0;
  /** Cycle at which byte `txPos` starts; may be in the future. */
  private txStart = 0;
  private txActive = false;
  private after = After.Nothing;
  /** The data frame to follow COMPLETE (data plus checksum). */
  private readonly frame = new Uint8Array(MAX_SECTOR + 1);
  private frameLen = 0;

  /**
   * The SIO bus's two attention lines, which a device pulls low and which the
   * board brings to the PIA: PROCEED (CA1) and INTERRUPT (CB1). Both idle
   * high (released). A device calls `setProceed` / `setInterrupt`; the board
   * hooks these to drive the PIA, which raises its IRQ on the edge it was set
   * up for. The drives and recorder modelled here never use them.
   */
  onProceed: ((asserted: boolean) => void) | null = null;
  onInterrupt: ((asserted: boolean) => void) | null = null;
  private proceed = false;
  private interrupt = false;

  setProceed(asserted: boolean): void {
    if (asserted === this.proceed) return;
    this.proceed = asserted;
    this.onProceed?.(asserted);
  }

  setInterrupt(asserted: boolean): void {
    if (asserted === this.interrupt) return;
    this.interrupt = asserted;
    this.onInterrupt?.(asserted);
  }

  constructor(private readonly devices: SioBusDevices, clockHz: number) {
    this.cyclesPerBit = clockHz / BAUD;
    this.byteCycles = this.cyclesPerBit * BITS_PER_BYTE;
    this.msCycles = clockHz / 1000;
  }

  reset(): void {
    this.setProceed(false);
    this.setInterrupt(false);
    this.now = 0;
    this.command = false;
    this.mode = Mode.Idle;
    this.rxCount = 0;
    this.txActive = false;
    this.txLen = this.txPos = 0;
    this.after = After.Nothing;
  }

  /** Snapshot: where the bus is in a command, so a drive mid-reply goes on. */
  saveState(w: StateWriter): void {
    w.f64(this.now);
    w.bool(this.command);
    w.u8(this.mode);
    w.raw(this.rx); w.u16(this.rxCount); w.u16(this.rxNeed); w.f64(this.rxEnd);
    w.u8(this.device); w.u8(this.cmd); w.u16(this.sector);
    w.raw(this.tx); w.u16(this.txLen); w.u16(this.txPos); w.f64(this.txStart);
    w.bool(this.txActive);
    w.u8(this.after);
    w.raw(this.frame); w.u16(this.frameLen);
  }

  loadState(r: StateReader): void {
    this.now = r.f64();
    this.command = r.bool();
    this.mode = r.u8();
    r.rawInto(this.rx); this.rxCount = r.u16(); this.rxNeed = r.u16(); this.rxEnd = r.f64();
    this.device = r.u8(); this.cmd = r.u8(); this.sector = r.u16();
    r.rawInto(this.tx); this.txLen = r.u16(); this.txPos = r.u16(); this.txStart = r.f64();
    this.txActive = r.bool();
    this.after = r.u8();
    r.rawInto(this.frame); this.frameLen = r.u16();
  }

  /** The device-to-computer data line (1 = mark, the idle level). */
  level(): number {
    if (!this.txActive) return 1;
    const elapsed = this.now - this.txStart;
    if (elapsed < 0) return 1;
    const bit = (elapsed / this.cyclesPerBit) | 0;
    if (bit === 0) return 0;
    if (bit >= BITS_PER_BYTE - 1) return 1;
    return (this.tx[this.txPos] >> (bit - 1)) & 1;
  }

  /** True while a reply is about to start or being shifted out, so the
   *  machine should clock in small steps and not skip over a bit. */
  get busy(): boolean {
    return this.txActive && this.now + NEAR_CYCLES >= this.txStart;
  }

  /** Advance the bus's clock. Call before POKEY is clocked, so POKEY samples
   *  the line where the reply now is. */
  advance(cycles: number): void {
    this.now += cycles;
    if (this.txActive) this.serviceTx();
  }

  /** The COMMAND line changed (PBCTL CB2; true = asserted). */
  setCommand(asserted: boolean): void {
    if (asserted === this.command) return;
    this.command = asserted;
    if (asserted) {
      // A new command frame supersedes whatever the bus was doing.
      this.txActive = false;
      this.after = After.Nothing;
      this.mode = Mode.Command;
      this.rxCount = 0;
      return;
    }
    if (this.mode !== Mode.Command) return;
    this.mode = Mode.Idle;
    if (this.rxCount === COMMAND_FRAME) this.commandFrame();
  }

  /** POKEY started shifting `byte` out; its stop bit ends `cyclesLeft` on. */
  receive(byte: number, cyclesLeft: number): void {
    const end = this.now + cyclesLeft;
    if (this.mode === Mode.Command) {
      if (this.rxCount < COMMAND_FRAME) {
        this.rx[this.rxCount++] = byte;
        this.rxEnd = end;
      } else {
        this.rxCount = COMMAND_FRAME + 1; // a frame that is too long
      }
    } else if (this.mode === Mode.Data) {
      this.rx[this.rxCount++] = byte;
      this.rxEnd = end;
      if (this.rxCount === this.rxNeed) this.dataFrame();
    }
  }

  // ── Frames ───────────────────────────────────────────────────────────────

  /** COMMAND went high after a complete command frame: answer it. */
  private commandFrame(): void {
    const rx = this.rx;
    const device = rx[0];
    // A device that is not there does not answer at all, whatever the rest.
    if (!this.devices.present(device)) return;
    this.device = device;
    this.cmd = rx[1];
    this.sector = rx[2] | (rx[3] << 8);
    this.rxNeed = 0;
    const at = Math.max(this.now, this.rxEnd) + ACK_DELAY_MS * this.msCycles;
    const need = rx[4] === sioChecksum(rx, 4)
      ? this.devices.inputLength(device, this.cmd, this.sector) : -1;
    if (need < 0) {
      this.send1(SIO_NAK_BYTE, at, After.Nothing);
      return;
    }
    if (need > 0) {
      // The data frame follows the ACK: its sector bytes and a checksum.
      this.mode = Mode.Data;
      this.rxCount = 0;
      this.rxNeed = need + 1;
      this.send1(SIO_ACK, at, After.Nothing);
    } else {
      this.send1(SIO_ACK, at, After.Run);
    }
  }

  /** The write-type command's data frame is in: acknowledge it. */
  private dataFrame(): void {
    this.mode = Mode.Idle;
    const len = this.rxNeed - 1;
    const at = this.rxEnd + ACK_DELAY_MS * this.msCycles;
    if (this.rx[len] !== sioChecksum(this.rx, len)) {
      this.send1(SIO_NAK_BYTE, at, After.Nothing);
      return;
    }
    this.send1(SIO_ACK, at, After.Run);
  }

  /** The ACK is out: carry the command out and say how it went. */
  private runCommand(end: number): void {
    const input = this.rxNeed > 1 ? this.rx.slice(0, this.rxNeed - 1) : null;
    this.rxNeed = 0;
    const status = this.devices.run(this.device, this.cmd, this.sector, input);
    const reply = this.devices.reply;
    const at = end + COMPLETE_DELAY_MS * this.msCycles;
    if (status === SIO_OK) {
      if (reply && reply.length <= MAX_SECTOR) {
        this.frame.set(reply);
        this.frame[reply.length] = sioChecksum(reply);
        this.frameLen = reply.length + 1;
        this.send1(SIO_COMPLETE, at, After.Frame);
      } else {
        this.send1(SIO_COMPLETE, at, After.Nothing);
      }
    } else {
      // A read-type command that fails still sends its data frame (what was
      // read, here nothing but zeros) after the ERROR.
      const n = this.devices.errorFrameLength(this.device, this.cmd, this.sector);
      if (n > 0 && n <= MAX_SECTOR) {
        this.frame.fill(0, 0, n + 1);
        this.frameLen = n + 1;
        this.send1(SIO_ERROR, at, After.Frame);
      } else {
        this.send1(SIO_ERROR, at, After.Nothing);
      }
    }
  }

  // ── Transmit ─────────────────────────────────────────────────────────────

  private send1(byte: number, at: number, after: After): void {
    this.tx[0] = byte;
    this.txLen = 1;
    this.begin(at, after);
  }

  private begin(at: number, after: After): void {
    this.txPos = 0;
    this.txStart = at;
    this.txActive = true;
    this.after = after;
  }

  /** Retire finished bytes and move on to what follows the reply. */
  private serviceTx(): void {
    while (this.txActive && this.now - this.txStart >= this.byteCycles) {
      this.txStart += this.byteCycles;
      if (++this.txPos < this.txLen) continue;
      this.txActive = false;
      const end = this.txStart;
      const after = this.after;
      this.after = After.Nothing;
      if (after === After.Run) {
        this.runCommand(end);
      } else if (after === After.Frame) {
        this.tx.set(this.frame.subarray(0, this.frameLen));
        this.txLen = this.frameLen;
        this.begin(end + DATA_GAP_MS * this.msCycles, After.Nothing);
      }
    }
  }
}
