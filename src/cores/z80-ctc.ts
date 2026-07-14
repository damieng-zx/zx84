/**
 * Z80 CTC (Counter/Timer Circuit) — the interrupt/timing core used by the
 * Tatung Einstein. Four independent channels, each a timer (counting down the
 * CPU clock through a 16/256 prescaler) or a counter (counting external CLK/TRG
 * pulses). On terminal count a channel reloads its time constant and, if enabled,
 * raises a maskable interrupt whose IM 2 vector is `(base & 0xF8) | (ch << 1)`.
 *
 * On the Einstein the TMS9929A vblank is wired to a channel's trigger input, so
 * the machine calls {@link trigger} once per frame; timer-mode channels are
 * advanced by {@link addCycles} from the CPU's elapsed T-states.
 *
 * This is a pragmatic model: it implements the control-word protocol, both
 * modes, per-channel vectors and channel-priority interrupt selection. It does
 * not model the RETI daisy-chain unwind (an interrupt is cleared on acknowledge),
 * which is sufficient for a periodic tick where each ISR returns before the next.
 */

const NUM_CHANNELS = 4;

// Control-word bits (byte with bit0 = 1).
const CW_INT_ENABLE = 0x80;
const CW_COUNTER_MODE = 0x40;   // 1 = counter, 0 = timer
const CW_PRESCALE_256 = 0x20;   // timer prescaler: 1 = /256, 0 = /16
// bit4 clock/trigger edge, bit3 timer trigger source — not modelled in detail
const CW_TC_FOLLOWS = 0x04;     // next byte is the time constant
const CW_RESET = 0x02;          // software reset (stop) this channel
const CW_CONTROL = 0x01;        // 1 = control word, 0 = vector/time-constant

interface Channel {
  control: number;
  timeConstant: number;   // 0 means 256
  counter: number;        // live down-counter
  running: boolean;
  tcFollows: boolean;     // expecting a time-constant byte next
  intPending: boolean;
  prescaleCount: number;  // timer sub-count within the prescaler window
}

export class Z80Ctc {
  private readonly ch: Channel[] = [];
  /** IM 2 vector base (written to channel 0 with bit0 = 0). */
  private vectorBase = 0;

  /** Raised (edge) whenever a channel reaches terminal count with interrupts
   *  enabled — the machine polls this to fire the CPU interrupt. */
  onInterrupt: (() => void) | null = null;

  /** Divisor from the addCycles() clock (the CPU clock) down to the CTC's own
   *  clock pin. The Einstein feeds channels 0–2 a 2 MHz clock = 4 MHz CPU / 2. */
  inputClockDivide = 1;
  private clockAccum = 0;

  /** Zero-count / terminal-count output handlers per channel — the Einstein
   *  chains channel 2's ZC to channel 3's trigger (zc2 → trg3). */
  readonly zcHandlers: (Array<(() => void) | null>) = [null, null, null, null];

  constructor() {
    for (let i = 0; i < NUM_CHANNELS; i++) {
      this.ch.push({
        control: 0, timeConstant: 0, counter: 0, running: false,
        tcFollows: false, intPending: false, prescaleCount: 0,
      });
    }
  }

  /** Register write for channel `c` (0–3), decoded per the CTC protocol. */
  write(c: number, val: number): void {
    const ch = this.ch[c & 3];
    val &= 0xFF;

    if (ch.tcFollows) {
      // This byte is the time constant.
      ch.tcFollows = false;
      ch.timeConstant = val;
      ch.counter = val === 0 ? 256 : val;
      ch.prescaleCount = 0;
      ch.running = true;
      return;
    }

    if (val & CW_CONTROL) {
      ch.control = val;
      if (val & CW_RESET) ch.running = false;
      ch.tcFollows = (val & CW_TC_FOLLOWS) !== 0;
      if (!ch.tcFollows && (val & CW_RESET)) ch.intPending = false;
      return;
    }

    // bit0 = 0 written to channel 0 sets the shared interrupt vector.
    if ((c & 3) === 0) this.vectorBase = val & 0xF8;
  }

  /** Register read — the live down-counter value (as the CTC returns). */
  read(c: number): number {
    return this.ch[c & 3].counter & 0xFF;
  }

  /** External CLK/TRG pulse for channel `c` (counter mode). */
  trigger(c: number): void {
    const ch = this.ch[c & 3];
    if (!ch.running || (ch.control & CW_COUNTER_MODE) === 0) return;
    this.decrement(ch, c & 3);
  }

  /** Advance timer-mode channels by `cycles` CPU T-states (scaled down to the
   *  CTC clock pin by inputClockDivide). Counter-mode channels advance only on
   *  external triggers / chained ZC pulses, not here. */
  addCycles(cycles: number): void {
    this.clockAccum += cycles;
    const edges = Math.floor(this.clockAccum / this.inputClockDivide);
    if (edges <= 0) return;
    this.clockAccum -= edges * this.inputClockDivide;
    for (let c = 0; c < NUM_CHANNELS; c++) {
      const ch = this.ch[c];
      if (!ch.running || (ch.control & CW_COUNTER_MODE) !== 0) continue;
      const prescale = (ch.control & CW_PRESCALE_256) ? 256 : 16;
      ch.prescaleCount += edges;
      while (ch.prescaleCount >= prescale) {
        ch.prescaleCount -= prescale;
        this.decrement(ch, c);
      }
    }
  }

  private decrement(ch: Channel, c: number): void {
    ch.counter--;
    if (ch.counter <= 0) {
      ch.counter = ch.timeConstant === 0 ? 256 : ch.timeConstant;
      if (ch.control & CW_INT_ENABLE) {
        ch.intPending = true;
        if (this.onInterrupt) this.onInterrupt();
      }
      // Terminal-count (ZC/TO) output — may be chained to another channel's TRG.
      const zc = this.zcHandlers[c];
      if (zc) zc();
    }
  }

  /** True if any channel has an interrupt pending. */
  get interruptPending(): boolean {
    return this.ch.some(ch => ch.intPending);
  }

  /** IM 2 vector for the highest-priority pending channel, or -1 if none. */
  pendingVector(): number {
    for (let c = 0; c < NUM_CHANNELS; c++) {
      if (this.ch[c].intPending) return (this.vectorBase & 0xF8) | (c << 1);
    }
    return -1;
  }

  /** Acknowledge (clear) the highest-priority pending interrupt. */
  acknowledge(): void {
    for (let c = 0; c < NUM_CHANNELS; c++) {
      if (this.ch[c].intPending) { this.ch[c].intPending = false; return; }
    }
  }

  reset(): void {
    for (const ch of this.ch) {
      ch.control = 0; ch.timeConstant = 0; ch.counter = 0; ch.running = false;
      ch.tcFollows = false; ch.intPending = false; ch.prescaleCount = 0;
    }
    this.vectorBase = 0;
    this.clockAccum = 0;
    // zcHandlers are hardware wiring — left intact across reset.
  }
}
