/**
 * Motorola MC6850 Asynchronous Communications Interface Adapter.
 *
 * Two registers selected by RS: control (write) / status (read) and transmit
 * data (write) / receive data (read). The control register picks the clock
 * divider (÷1, ÷16, ÷64 or master reset), the word format and the transmit /
 * receive interrupt enables; the status register reports RDRF, TDRE, DCD, CTS,
 * framing/overrun/parity errors and IRQ.
 *
 * The chip is clocked from a baud-rate generator outside it, so the owning
 * machine says how many CPU cycles one bit lasts (`rxBitCycles`/`txBitCycles`)
 * and steps the chip with its running cycle count. The receive line and the
 * carrier-detect pin are inputs the machine drives (`setRxLine`, `setDcd`); a
 * finished transmit byte is reported through `onTxByte` with the cycle it
 * began on.
 *
 * DCD follows the datasheet's latch: a low→high transition on the pin sets the
 * status bit (and an interrupt when RIE), and the bit then stays set until the
 * status register is read followed by the data register — and only clears
 * then if the pin has gone back low.
 *
 * Reference: Motorola MC6850 datasheet (ADI-472).
 */

import { AsyncSerialReceiver, type RxFormat } from '@/utils/async-serial-rx.ts';

const ST_RDRF = 0x01;
const ST_TDRE = 0x02;
const ST_DCD = 0x04;
const ST_CTS = 0x08;
const ST_FE = 0x10;
const ST_OVRN = 0x20;
const ST_PE = 0x40;
const ST_IRQ = 0x80;

/** CR2-4 word formats: data bits, parity, stop bits. */
const WORD_FORMATS: readonly { fmt: RxFormat; bits: number }[] = [
  { fmt: { dataBits: 7, parity: 'even', stopBits: 2 }, bits: 11 },
  { fmt: { dataBits: 7, parity: 'odd', stopBits: 2 }, bits: 11 },
  { fmt: { dataBits: 7, parity: 'even', stopBits: 1 }, bits: 10 },
  { fmt: { dataBits: 7, parity: 'odd', stopBits: 1 }, bits: 10 },
  { fmt: { dataBits: 8, parity: 'none', stopBits: 2 }, bits: 11 },
  { fmt: { dataBits: 8, parity: 'none', stopBits: 1 }, bits: 10 },
  { fmt: { dataBits: 8, parity: 'even', stopBits: 1 }, bits: 11 },
  { fmt: { dataBits: 8, parity: 'odd', stopBits: 1 }, bits: 11 },
];

export class Mc6850 {
  /** CPU cycles per received bit (set from the baud-rate generator). */
  get rxBitCycles(): number { return this.rx.bitCycles; }
  set rxBitCycles(v: number) { this.rx.bitCycles = v; }
  /** CPU cycles per transmitted bit. */
  txBitCycles = 1000;

  /** Transmit rate in bits per second for a CPU clock of `cpuClock` Hz. */
  txBaud(cpuClock: number): number { return cpuClock / this.txBitCycles; }

  /** A byte has started shifting out of the transmitter. */
  onTxByte: (value: number, startCycle: number) => void = () => {};

  private control = 0;
  private status = 0;
  private rxData = 0;
  private dcdPin = false;
  private dcdLatched = false;
  private ctsPin = false;
  private statusReadSinceEvent = false;
  private rxLevel = 1;
  private rxSince = 0;
  private rxStartLevel = 1;
  private now = 0;

  private txHold = -1;                  // byte waiting for the shifter, or -1
  private txHoldAt = 0;
  private txFrameBits = 10;
  private txEnd = 0;                    // cycle the shifter frees up

  private readonly rx = new AsyncSerialReceiver();

  constructor() {
    this.rx.onFrame = (f) => {
      if (this.status & ST_RDRF) {
        this.status |= ST_OVRN;           // previous byte never read
      } else {
        this.rxData = f.value;
        this.status |= ST_RDRF;
      }
      this.status = (this.status & ~(ST_FE | ST_PE))
        | (f.framingError ? ST_FE : 0) | (f.parityError ? ST_PE : 0);
    };
    this.reset();
  }

  /** Power-on / hardware reset. */
  reset(): void {
    this.control = 0;
    this.status = 0;
    this.dcdLatched = false;
    this.statusReadSinceEvent = false;
    this.txHold = -1;
    this.txEnd = 0;
    this.applyFormat();
    this.rx.reset();
    this.refreshStatus();
  }

  /** Control-register master reset (CR1:0 = 11). */
  private masterReset(): void {
    this.status &= ST_DCD | ST_CTS;
    this.txHold = -1;
    this.rx.reset();
    this.statusReadSinceEvent = false;
  }

  private applyFormat(): void {
    const w = WORD_FORMATS[(this.control >> 2) & 7];
    this.rx.format = w.fmt;
    this.txFrameBits = w.bits;
  }

  /** Clock divide selected by CR1:0 (1, 16 or 64; 64 also while in reset). */
  get clockDivide(): number { return [1, 16, 64, 64][this.control & 3]; }

  /** Interrupt request output. */
  get irq(): boolean { return (this.status & ST_IRQ) !== 0; }

  /** Recompute the derived status bits (TDRE, CTS, DCD, IRQ). */
  private refreshStatus(): void {
    let s = this.status & ~(ST_TDRE | ST_DCD | ST_CTS | ST_IRQ);
    if (this.txHold < 0 && !this.ctsPin) s |= ST_TDRE;
    if (this.dcdLatched) s |= ST_DCD;
    if (this.ctsPin) s |= ST_CTS;
    const rxInt = (this.control & 0x80) !== 0 && (s & (ST_RDRF | ST_OVRN | ST_DCD)) !== 0;
    const txInt = ((this.control >> 5) & 3) === 1 && (s & ST_TDRE) !== 0;
    if (rxInt || txInt) s |= ST_IRQ;
    this.status = s;
  }

  // ── Bus interface ────────────────────────────────────────────────────────

  /** Read register `rs` (0 = status, 1 = receive data). */
  read(rs: number): number {
    if ((rs & 1) === 0) {
      this.refreshStatus();
      this.statusReadSinceEvent = true;
      return this.status;
    }
    const value = this.rxData;
    this.status &= ~(ST_RDRF | ST_FE | ST_PE);
    if (this.statusReadSinceEvent) {
      this.status &= ~ST_OVRN;
      if (!this.dcdPin) this.dcdLatched = false;
    }
    this.statusReadSinceEvent = false;
    this.refreshStatus();
    return value;
  }

  /** Write register `rs` (0 = control, 1 = transmit data). */
  write(rs: number, value: number): void {
    value &= 0xFF;
    if ((rs & 1) === 0) {
      this.control = value;
      if ((value & 3) === 3) this.masterReset();
      this.applyFormat();
    } else {
      this.txHold = value;
      this.txHoldAt = this.now;
    }
    this.refreshStatus();
  }

  // ── Pins ─────────────────────────────────────────────────────────────────

  /** Receive data line (1 = mark) and the cycle it last changed. */
  setRxLine(level: number, since: number, startLevel = level): void {
    this.rxLevel = level;
    this.rxSince = since;
    this.rxStartLevel = startLevel;
  }

  /** The /DCD input: true = pin high (carrier present on the BBC). */
  setDcd(high: boolean): void {
    if (high === this.dcdPin) return;
    if (high) {
      this.dcdLatched = true;
      this.statusReadSinceEvent = false;
    }
    this.dcdPin = high;
    this.refreshStatus();
  }

  setCts(high: boolean): void {
    if (high === this.ctsPin) return;
    this.ctsPin = high;
    this.refreshStatus();
  }

  // ── Time ─────────────────────────────────────────────────────────────────

  /** Step to CPU cycle `now`: sample the receive line, run the transmitter. */
  tick(now: number): void {
    this.now = now;
    if ((this.control & 3) !== 3) this.rx.step(now, this.rxLevel, this.rxSince, this.rxStartLevel);
    if (this.txHold >= 0 && (this.control & 3) !== 3 && !this.ctsPin) {
      // An idle transmitter takes the byte into its shift register on the next
      // bit-clock boundary rather than at once, so TDRE stays low for up to a
      // bit time. The BBC's interrupt-driven cassette output depends on that
      // gap: the foreground has to store the next byte before TDRE interrupts
      // again, or the handler sends the previous byte twice.
      const start = this.txEnd <= this.txHoldAt ? this.txHoldAt + this.txBitCycles : this.txEnd;
      if (now >= start) {
        const byte = this.txHold;
        this.txHold = -1;
        this.txEnd = start + this.txFrameBits * this.txBitCycles;
        this.onTxByte(byte, start);
      }
    }
    this.refreshStatus();
  }
}
