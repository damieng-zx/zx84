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
 * Interrupts follow the Z80-family daisy chain (Zilog Z80 CTC Technical
 * Manual, "Interrupt Operation"): channel 0 has the highest priority. When a
 * channel's interrupt is acknowledged its pending flag clears and its
 * interrupt-under-service (IUS) latch sets; while any channel is under service
 * it and every lower-priority channel are inhibited from requesting (a
 * higher-priority channel may still nest), and the CTC's IEO is held low so
 * downstream daisy-chain devices are inhibited too. The CPU's RETI (ED 4D) —
 * delivered via {@link reti} — clears the highest-priority channel under
 * service. RETN does not unwind the chain.
 */

const NUM_CHANNELS = 4;

// Control-word bits (byte with bit0 = 1).
const CW_INT_ENABLE = 0x80;
const CW_COUNTER_MODE = 0x40;   // 1 = counter, 0 = timer
const CW_PRESCALE_256 = 0x20;   // timer prescaler: 1 = /256, 0 = /16
// bit4 selects the CLK/TRG active edge — trigger() models an active edge.
const CW_TIMER_TRIGGER = 0x08;  // timer mode: 1 = start on CLK/TRG edge, 0 = on TC load
const CW_TC_FOLLOWS = 0x04;     // next byte is the time constant
const CW_RESET = 0x02;          // software reset (stop) this channel
const CW_CONTROL = 0x01;        // 1 = control word, 0 = vector/time-constant

interface Channel {
  control: number;
  timeConstant: number;   // 0 means 256
  counter: number;        // live down-counter
  running: boolean;
  awaitingTrigger: boolean; // timer loaded, waiting for a CLK/TRG edge to start
  tcFollows: boolean;     // expecting a time-constant byte next
  intPending: boolean;
  inService: boolean;     // IUS: acknowledged, awaiting RETI
  prescaleCount: number;  // timer sub-count within the prescaler window
}

export class Z80Ctc {
  private readonly ch: Channel[] = [];
  /** IM 2 vector base (written to channel 0 with bit0 = 0). */
  private vectorBase = 0;

  /** Raised (edge) whenever a channel reaches terminal count with interrupts
   *  enabled — the machine polls this to fire the CPU interrupt. */
  onInterrupt: (() => void) | null = null;

  /** Divisor from the addCycles() clock (the CPU clock) down to the CTC
   *  device clock that drives the timer-mode prescaler. Only relevant if a
   *  host wires the CTC's own clock pin to something slower than the CPU —
   *  it does NOT apply to counter-mode channels (advanced only by explicit
   *  {@link trigger} calls, never by addCycles). Real hardware nearly
   *  always ties CLK to the CPU clock directly (see the Einstein, which
   *  leaves this at 1: its per-channel CLK/TRG pins run at 2 MHz, but that
   *  only matters for counter mode, and the CTC *device* clock driving the
   *  timer prescaler is the full undivided 4 MHz). */
  inputClockDivide = 1;
  private clockAccum = 0;

  /** Zero-count / terminal-count output handlers per channel — the Einstein
   *  chains channel 2's ZC to channel 3's trigger (zc2 → trg3). */
  readonly zcHandlers: (Array<(() => void) | null>) = [null, null, null, null];

  constructor() {
    for (let i = 0; i < NUM_CHANNELS; i++) {
      this.ch.push({
        control: 0, timeConstant: 0, counter: 0, running: false,
        awaitingTrigger: false, tcFollows: false, intPending: false, inService: false,
        prescaleCount: 0,
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
      // A running channel finishes its current count and picks up the new
      // constant at the next zero count (Zilog CTC manual). Only the first
      // load after a reset loads the down-counter and starts the channel.
      if (ch.running || ch.awaitingTrigger) return;
      ch.counter = val === 0 ? 256 : val;
      ch.prescaleCount = 0;
      if ((ch.control & (CW_COUNTER_MODE | CW_TIMER_TRIGGER)) === CW_TIMER_TRIGGER) {
        ch.awaitingTrigger = true;   // timer starts on the next CLK/TRG edge
      } else {
        ch.running = true;
      }
      return;
    }

    if (val & CW_CONTROL) {
      ch.control = val;
      if (val & CW_RESET) { ch.running = false; ch.awaitingTrigger = false; }
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

  /** External CLK/TRG active edge for channel `c`: decrements a counter-mode
   *  channel, or starts a timer-mode channel loaded with bit 3 set. */
  trigger(c: number): void {
    const ch = this.ch[c & 3];
    if (ch.awaitingTrigger) {
      ch.awaitingTrigger = false;
      ch.running = true;
      return;
    }
    if (!ch.running || (ch.control & CW_COUNTER_MODE) === 0) return;
    this.decrement(ch, c & 3);
  }

  /** Deliver `edges` CLK/TRG active edges to channel `c` in one call — for a
   *  pin driven by a free-running clock (the Einstein's 2 MHz on TRG0-2),
   *  where per-edge trigger() calls would be wasteful. */
  triggerEdges(c: number, edges: number): void {
    if (edges <= 0) return;
    const ch = this.ch[c & 3];
    if (ch.awaitingTrigger) {
      ch.awaitingTrigger = false;
      ch.running = true;
      return;   // started a timer; further edges do not affect it
    }
    if (!ch.running || (ch.control & CW_COUNTER_MODE) === 0) return;
    while (edges > 0) {
      const step = Math.min(edges, ch.counter - 1);
      ch.counter -= step;
      edges -= step;
      if (edges > 0) { this.decrement(ch, c & 3); edges--; }
    }
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

  /** The channel driving /INT: the highest-priority pending channel with no
   *  channel of higher-or-equal priority under service, or -1. */
  private requestingChannel(): number {
    for (let c = 0; c < NUM_CHANNELS; c++) {
      const ch = this.ch[c];
      if (ch.inService) return -1;
      if (ch.intPending) return c;
    }
    return -1;
  }

  /** True if the CTC is asserting /INT — a pending channel not inhibited by
   *  a higher-or-equal priority channel under service. */
  get interruptPending(): boolean {
    return this.requestingChannel() >= 0;
  }

  /** Daisy-chain IEO: false while any channel is under service (awaiting
   *  RETI), which inhibits every lower-priority device on the chain. (A
   *  CTC channel that is merely pending also outranks downstream devices;
   *  hosts model that by polling the CTC first.) */
  get ieo(): boolean {
    const ch = this.ch;
    return !(ch[0].inService || ch[1].inService || ch[2].inService || ch[3].inService);
  }

  /** IM 2 vector for the requesting channel, or -1 if none. */
  pendingVector(): number {
    const c = this.requestingChannel();
    return c < 0 ? -1 : (this.vectorBase & 0xF8) | (c << 1);
  }

  /** Interrupt acknowledge: the requesting channel's pending flag clears and
   *  it goes under service until the next RETI. */
  acknowledge(): void {
    const c = this.requestingChannel();
    if (c < 0) return;
    this.ch[c].intPending = false;
    this.ch[c].inService = true;
  }

  /** RETI (ED 4D) seen on the bus: the highest-priority channel under
   *  service returns to normal. Wire to Z80.onReti. */
  reti(): void {
    for (let c = 0; c < NUM_CHANNELS; c++) {
      if (this.ch[c].inService) { this.ch[c].inService = false; return; }
    }
  }

  reset(): void {
    for (const ch of this.ch) {
      ch.control = 0; ch.timeConstant = 0; ch.counter = 0; ch.running = false;
      ch.awaitingTrigger = false; ch.tcFollows = false; ch.intPending = false; ch.inService = false;
      ch.prescaleCount = 0;
    }
    this.vectorBase = 0;
    this.clockAccum = 0;
    // zcHandlers are hardware wiring — left intact across reset.
  }
}
