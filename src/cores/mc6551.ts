/**
 * MOS 6551A Asynchronous Communications Interface Adapter (ACIA).
 *
 * The part on the Commodore Plus/4's RS-232 port (it has no other use there, and
 * the C16 has none at all). Four registers, selected by A0-A1, mirrored through
 * a 16-byte window:
 *
 *   0  transmitted data   (write) / received data   (read)
 *   1  status             (read only)
 *   2  command
 *   3  control
 *
 * Status register (read):
 *
 *   7  IRQ (any enabled interrupt source)
 *   6  DSR (data set ready — a handshake input)
 *   5  DCD (data carrier detect — a handshake input)
 *   4  transmitter data register empty
 *   3  receiver data register full
 *   2  overrun
 *   1  framing error
 *   0  parity error
 *
 * Command register (write):
 *
 *   7-6  parity mode (00 odd, 01 even, 10 mark, 11 space)
 *   5    parity enable
 *   4-2  receiver interrupts (00/10 off, 01 RX full, 11 RX full or overrun)
 *   1    transmitter interrupts (1 = TDRE)
 *   0    DTR / break (writes the DTR output and clears all status bits)
 *
 * Control register (write):
 *
 *   7-5  baud rate (16 possible internal rates otherwise)
 *   4    receiver clock source (1 = baud rate, 0 = external)
 *   3-1  word format (data bits, parity, stop bits)
 *   0    parity check (for the 8-bit formats)
 *
 * The Plus/4 wires no other line than the two handshake bits it can read back,
 * so the transmit and receive shifters are the minimum the KERNAL's RS-232
 * routines need: TDRE clears while a byte is shifting out and returns after the
 * frame's ten bit times, and a byte the host sends into the receiver becomes
 * available after its frame time. Nothing is connected to the socket, so there
 * are no line-noise framing or parity errors to report, and the modem handshake
 * bits are the board's. The chip never calls back into the machine beyond
 * `onTxByte` (the host's transmit sink, if one is attached) and the handshake
 * inputs the board drives.
 *
 * Reference: Motorola MC6551 datasheet; the Plus/4 registers as documented in
 * the +4 memory maps ($FD00 data, $FD01 status, $FD02 command, $FD03 control).
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';

const ST_PE = 0x01;
const ST_FE = 0x02;
const ST_OVRN = 0x04;
const ST_RDRF = 0x08;
const ST_TDRE = 0x10;
const ST_DCD = 0x20;
const ST_DSR = 0x40;
const ST_IRQ = 0x80;

/** Control-register baud-rate divisors (bits 5-7); the Plus/4 harness runs its
 *  own crystal, so these are the chip's nominal values only. */
const BAUD_DIVISORS = [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

export class Mc6551 {
  /** Transmit rate in bits per second for a CPU clock of `cpuClock` Hz, from
   *  the control register (the board's clock divisor is the machine's). */
  txBaud(cpuClock: number, externalDivisor = 1): number {
    const d = BAUD_DIVISORS[(this.control >> 5) & 0x0F] * externalDivisor;
    return cpuClock / (2 * d);
  }

  /** The bits in one character frame: start, data, parity (if enabled) and
   *  stop, from the control register's word format (bits 3-1). */
  private get frameBits(): number {
    const format = (this.control >> 1) & 0x07;
    const data = 8 - (format & 0x03);
    const stop = format >= 4 ? 2 : 1;
    const parity = (this.command & 0x20) !== 0 ? 1 : 0;
    return 1 + data + parity + stop;
  }

  /** CPU cycles one frame takes: the chip's baud divisor is 2 cycles a bit. */
  private get frameCycles(): number {
    return this.frameBits * 2 * BAUD_DIVISORS[(this.control >> 5) & 0x0F];
  }

  /** A byte has started shifting out of the transmitter. */
  onTxByte: ((value: number, startCycle: number) => void) | null = null;

  private control = 0;
  private command = 0;
  private status = 0;
  private rxData = 0;
  private txData = 0;
  private dcdPin = false;
  private dsrPin = false;
  private now = 0;
  /** The transmitter is shifting a byte out, done at this cycle; a received
   *  byte is on its way, available at this cycle (-1 when none). */
  private txDoneAt = 0;
  private rxDoneAt = -1;
  private rxPending = -1;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.control = 0;
    this.command = 0;
    this.status = 0;
    this.rxData = 0;
    this.txData = 0;
    this.txDoneAt = 0;
    this.rxDoneAt = -1;
    this.rxPending = -1;
    this.refreshStatus();
  }

  /** Recompute the derived status bits and the IRQ line. */
  private refreshStatus(): void {
    let s = this.status & (ST_PE | ST_FE | ST_OVRN | ST_RDRF);
    if (this.now >= this.txDoneAt) s |= ST_TDRE;
    if (this.dcdPin) s |= ST_DCD;
    if (this.dsrPin) s |= ST_DSR;
    const rxInt = ((this.command >> 2) & 3) !== 0
      && (s & (ST_RDRF | (((this.command >> 2) & 3) === 3 ? ST_OVRN : 0))) !== 0;
    const txInt = (this.command & 0x02) !== 0 && (s & ST_TDRE) !== 0;
    if (rxInt || txInt) s |= ST_IRQ;
    this.status = s;
  }

  // ── Bus interface ────────────────────────────────────────────────────────

  /** Read register `rs` (0 data, 1 status, 2 command, 3 control): the Plus/4
   *  mirrors the four through their 16-byte window. */
  read(rs: number): number {
    switch (rs & 3) {
      case 0: {
        const value = this.rxData;
        this.status &= ~(ST_RDRF | ST_OVRN | ST_PE | ST_FE);
        this.refreshStatus();
        return value;
      }
      case 1:
        this.refreshStatus();
        return this.status;
      case 2:
        return this.command;
      default:
        return this.control;
    }
  }

  /** The register as the debugger sees it (no status clear). */
  peek(rs: number): number {
    switch (rs & 3) {
      case 0: return this.rxData;
      case 1: this.refreshStatus(); return this.status;
      case 2: return this.command;
      default: return this.control;
    }
  }

  write(rs: number, value: number): void {
    const v = value & 0xFF;
    switch (rs & 3) {
      case 0:
        this.txData = v;
        // A write to an idle transmitter starts a frame; TDRE stays clear
        // until its last bit has gone.
        if (this.now >= this.txDoneAt) this.txDoneAt = this.now + this.frameCycles;
        if (this.onTxByte) this.onTxByte(v, this.now);
        this.refreshStatus();
        break;
      case 1:
        // The status register is read-only.
        break;
      case 2:
        this.command = v;
        // The DTR/break bit clears every status flag.
        if ((v & 0x01) !== 0) this.status &= 0;
        this.refreshStatus();
        break;
      default:
        this.control = v;
        this.refreshStatus();
        break;
    }
  }

  // ── Pins ─────────────────────────────────────────────────────────────────

  /** The /DCD input (true = carrier detected). */
  setDcd(high: boolean): void { this.dcdPin = high; this.refreshStatus(); }

  /** The /DSR input (true = the modem is ready). */
  setDsr(high: boolean): void { this.dsrPin = high; this.refreshStatus(); }

  /** A byte arrives from the host: it becomes available once its frame has
   *  been clocked in, or overruns a receiver that still holds one. */
  receive(byte: number): void {
    if (this.rxPending >= 0 || (this.status & ST_RDRF) !== 0) {
      this.status |= ST_OVRN;
      this.refreshStatus();
      return;
    }
    this.rxPending = byte & 0xFF;
    this.rxDoneAt = this.now + this.frameCycles;
    this.refreshStatus();
  }

  get irq(): boolean { this.refreshStatus(); return (this.status & ST_IRQ) !== 0; }

  tick(now: number): void {
    this.now = now;
    if (this.rxPending >= 0 && now >= this.rxDoneAt) {
      this.rxData = this.rxPending;
      this.rxPending = -1;
      this.rxDoneAt = -1;
      this.status |= ST_RDRF;
    }
    this.refreshStatus();
  }

  /** Cycles until the transmitter's current frame finishes (0 when idle). */
  get txBusyCycles(): number {
    return this.txDoneAt > this.now ? this.txDoneAt - this.now : 0;
  }

  /** Cycles until a byte being received is complete (0 when none is). */
  get rxBusyCycles(): number {
    return this.rxPending >= 0 && this.rxDoneAt > this.now ? this.rxDoneAt - this.now : 0;
  }

  // ── Snapshot state ────────────────────────────────────────────────────────

  saveState(w: StateSink): void {
    w.u8(this.control); w.u8(this.command); w.u8(this.status);
    w.u8(this.rxData); w.u8(this.txData);
    w.bool(this.dcdPin); w.bool(this.dsrPin); w.f64(this.now);
    w.f64(this.txDoneAt); w.f64(this.rxDoneAt);
    w.bool(this.rxPending >= 0); w.u8(this.rxPending < 0 ? 0 : this.rxPending);
  }

  loadState(r: StateSource): void {
    this.control = r.u8(); this.command = r.u8(); this.status = r.u8();
    this.rxData = r.u8(); this.txData = r.u8();
    this.dcdPin = r.bool(); this.dsrPin = r.bool(); this.now = r.f64();
    this.txDoneAt = r.f64(); this.rxDoneAt = r.f64();
    this.rxPending = r.bool() ? r.u8() : -1;
  }
}
