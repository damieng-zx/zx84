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
 * routines need: TDRE is set whenever the transmitter holds no byte, and a byte
 * the host sends appears in the receiver at once. The chip never calls back
 * into the machine beyond `onTxByte` (the host's transmit sink, if one is
 * attached) and the handshake inputs the board drives.
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

  constructor() {
    this.reset();
  }

  reset(): void {
    this.control = 0;
    this.command = 0;
    this.status = 0;
    this.rxData = 0;
    this.txData = 0;
    this.refreshStatus();
  }

  /** Recompute the derived status bits and the IRQ line. */
  private refreshStatus(): void {
    let s = this.status & (ST_PE | ST_FE | ST_OVRN | ST_RDRF);
    s |= ST_TDRE;
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

  /** A byte arrives from the host: latch it into the receiver, or overrun. */
  receive(byte: number): void {
    if ((this.status & ST_RDRF) !== 0) this.status |= ST_OVRN;
    else { this.rxData = byte & 0xFF; this.status |= ST_RDRF; }
    this.refreshStatus();
  }

  get irq(): boolean { this.refreshStatus(); return (this.status & ST_IRQ) !== 0; }

  tick(now: number): void { this.now = now; }

  // ── Snapshot state ────────────────────────────────────────────────────────

  saveState(w: StateSink): void {
    w.u8(this.control); w.u8(this.command); w.u8(this.status);
    w.u8(this.rxData); w.u8(this.txData);
    w.bool(this.dcdPin); w.bool(this.dsrPin); w.f64(this.now);
  }

  loadState(r: StateSource): void {
    this.control = r.u8(); this.command = r.u8(); this.status = r.u8();
    this.rxData = r.u8(); this.txData = r.u8();
    this.dcdPin = r.bool(); this.dsrPin = r.bool(); this.now = r.f64();
  }
}
