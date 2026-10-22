/**
 * POKEY — the Atari 8-bit keyboard, serial and sound chip.
 *
 * Four audio channels, four timers, the keyboard scanner, the serial port and
 * the random-number generator all live here. POKEY's audio is a set of
 * programmable dividers feeding short polynomial counters; it is not a
 * wavetable chip like the AY. The model runs the dividers as real counters in
 * CPU time, event by event, and renders the audio from the same events.
 *
 * Register map ($D200-$D20F):
 *
 *   $D200/2/4/6  AUDF1-4     $D208  ALLPOT (read)   $D20C  (unused)
 *   $D201/3/5/7  AUDC1-4     $D209  KBCODE (read)
 *   $D208        AUDCTL      $D20A  RANDOM (read)
 *   $D209        STIMER      $D20B  POTGO
 *   $D20A        SKRES       $D20C  (unused)
 *   $D20B        POTGO       $D20D  SEROUT
 *   $D20E        IRQEN/IRQST $D20F  SKCTL/SKSTAT
 *
 * Counters (Altirra Hardware Reference Manual 5.3, 5.4). Each channel has an
 * 8-bit down-counter. It is clocked by the 64 kHz or 15 kHz prescaler
 * (AUDCTL bit 0; one prescaler, shared, whose phase only initialisation mode
 * resets), or, for channels 1 and 3, by every 1.79 MHz cycle (AUDCTL bits 6
 * and 5). A counter underflows on the pulse that finds it at 0; it reloads
 * from AUDF 3 cycles later and fires (IRQST, the audio flip-flop, the serial
 * port) 4 cycles after the underflow. So at 1.79 MHz the period is AUDF+4,
 * and on the prescaler (AUDF+1) ticks, the delay hidden before the next tick.
 * AUDF changes take effect at the next reload. STIMER reloads every counter
 * 3 cycles after the write; it does not fire anything and does not move the
 * prescaler, and it pre-empts any underflow that had not yet happened.
 *
 * Linked pairs (AUDCTL bit 4: 1+2, bit 3: 3+4). The low counter does not
 * reload: it wraps and keeps underflowing every 256 pulses. Each of its
 * underflows steps the high counter 3 cycles later; when the high counter
 * underflows, both reload 3 cycles after that. So the pair's period is N+7
 * at 1.79 MHz (N = AUDFhi:AUDFlo) or N+1 ticks, and the low channel fires
 * AUDFhi+1 times a period, AUDFlo+7 cycles after the pair's last fire and
 * then every 256 pulses. Both channels still clock their audio, and timer 1
 * follows the low counter.
 *
 * Each channel's output is a flip-flop clocked by its counter's fire.
 * The polynomial counters (4, 5 and 17 bits; AUDCTL bit 7 turns the 17-bit
 * one into 9 bits) are XNOR shift registers that run free at 1.79 MHz,
 * shared by every channel (each channel sees a bit one cycle after the one
 * before it), and AUDC's distortion bits pick what the flip-flop takes when
 * it is clocked: bit 7 clear lets it change only while the 5-bit poly's
 * output is 1; then bit 5 set toggles it (a square wave), otherwise it loads
 * the 4-bit poly (bit 6 set) or the 17/9-bit poly. AUDC bit 4 forces the
 * output high (volume only).
 * AUDCTL bits 2 and 1 put a high-pass filter on channels 1 and 2: a second
 * flip-flop samples the channel's output at each channel 3 (or 4) fire
 * and the channel plays its output XOR that sample, so only tones above the
 * filter channel's rate get through. With the filter off that flip-flop is
 * held at 1 and the XOR still happens, so channels 1 and 2 play inverted
 * against 3 and 4. STIMER sets every output flip-flop to 1. RANDOM reads the
 * low 8 bits of the 17-bit (or 9-bit) register, inverted.
 *
 * Analogue output (Altirra Hardware Reference Manual, appendix E). Each
 * channel's 4-bit DAC is four gates that are not quite binary: the volume
 * bits drop the output by about 0.12, 0.26, 0.56 and 1.12 V. The four
 * channels' drops add, normalised to 0-1 over 4 x 2.06 V, and the sum
 * saturates: linear (x 2.171) up to 0.14, then exponential, reaching 1 at 1.
 * The first amplifier stage AC-couples the result with a 2.6 ms time
 * constant, so a constant level decays away. External sources join after it
 * (`setExternal`: on the XL, the CONSOL speaker), and the second stage takes
 * the sum: it clips its input to [-0.50, +0.65] of POKEY's full scale (more
 * headroom towards high volume, so it catches the swing back down after a
 * loud passage) and AC-couples again, with a slower 24.7 ms time constant.
 * Together the two give a small overshoot below zero after a step.
 *
 * Initialisation mode (SKCTL bits 0-1 both clear) holds the polys at their
 * zeroed start, stops the prescaler (so prescaler-clocked counters stop) and
 * resets the serial input. Leaving it restarts the prescaler at a known
 * phase: an unlinked period-0 counter on it first fires 24 (64 kHz) or 83
 * (15 kHz) cycles after the SKCTL write.
 *
 * The keyboard scanner is modelled at the IRQ level rather than as a matrix
 * scan: a key event loads KBCODE and raises the keyboard IRQ, which is what
 * the OS's handler consumes. Multi-key chords (SHIFT/CTRL) are handled by the
 * machine's key mapping, not by POKEY.
 *
 * Interrupts. IRQST reads *active low*: a 0 bit is a pending interrupt. The
 * OS's IRQ dispatcher depends on that (`BIT IRQST / BEQ found`). A source can
 * only latch while its IRQEN bit is set, and the way to acknowledge one is to
 * clear its IRQEN bit (the OS writes the inverted mask, then POKMSK). Reading
 * KBCODE does not acknowledge anything. Internally `irqPending` keeps the
 * latches in positive logic; only the register read inverts them.
 *
 * Serial input. SKSTAT bit 4 reads the SIO data-in line directly (`serialIn`,
 * driven by the program recorder). The receiver shifts a byte in 8N1, clocked
 * by channel 4's fires unless SKCTL bits 4-6 select an external clock (modes
 * 0 and 4, which a cassette does not supply). One bit lasts two fires. In the
 * asynchronous modes (SKCTL bit 4) counters 3 and 4 are held in reset while
 * the receiver waits, and a falling edge on the line starts them, so the
 * start bit is sampled one period in, at its middle, and every bit two fires
 * after the one before: 19 fires a byte. In the synchronous modes channel 4
 * runs free, so the bits are sampled wherever its fires happen to fall.
 * When the stop bit has been sampled the byte goes to
 * SERIN and IRQST bit 5 (serial input ready) latches. SKSTAT bit 7 latches
 * low on a framing error (stop bit 0), bit 5 on an overrun (a byte arriving
 * while the last one's interrupt is still pending), and bit 1 reads low
 * while a byte is being shifted in. SKRES clears the two latches.
 *
 * Serial output. SEROUT is a holding register in front of a shift register
 * clocked by channel 4 (a bit lasts two channel-4 periods; ten bits a byte,
 * 8N1). The shifter only loads on a serial clock edge, so a byte written
 * while it is idle waits until channel 4 next counts out; one written while
 * it is busy waits for the byte ahead to finish. IRQST bit 4 (serial output
 * data needed) latches as a byte moves across (a second write before then
 * replaces the first). Bit 3 (transmission complete) is a level: low
 * (pending) whenever the shifter is idle, even with a byte waiting. Bytes go
 * to `onSerialOut` as they start to shift out (with the cycles until the
 * stop bit ends, so a device can time its reply).
 *
 * Register accesses land at the start of the CPU step that makes them (the
 * time POKEY has been advanced to), not at the access's own cycle.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

const IRQ_TIMER1 = 0x01;
const IRQ_TIMER2 = 0x02;
const IRQ_TIMER4 = 0x04;
const IRQ_SEROC = 0x08;
const IRQ_SEROR = 0x10;
/** Bits on the wire per transmitted byte: start, eight data, stop. */
const TX_FRAME_BITS = 10;
const IRQ_SERIN = 0x20;
const IRQ_KEYBOARD = 0x40;
const IRQ_BREAK = 0x80;
/** The order simultaneous fires are handled in: channels 3 and 4 (index 2, 3)
 *  first, so the high-pass filters they drive sample channels 1 and 2 before
 *  the same cycle's fire changes them. */
const FIRE_ORDER = [2, 3, 0, 1] as const;
/** The timer interrupt each channel's fire raises (channel 3 has none). */
const TIMER_IRQ = [IRQ_TIMER1, IRQ_TIMER2, 0, IRQ_TIMER4];

/** The last count of a pot scan: a slow one stops at 228, a fast one (SKCTL bit
 *  2) at 229. A paddle that never charges past the threshold (none plugged in)
 *  reads that count once the scan is over. */
const POT_SLOW_END = 228;
const POT_FAST_END = 229;
/** CPU cycles per count of a slow scan: the 15 kHz clock. */
const POT_SLOW_PERIOD = 114;

/** SKSTAT error latches, positive logic (the register reads them low). */
const SK_KB_OVERRUN = 0x40;
const SK_OVERRUN = 0x20;
const SK_FRAMING = 0x80;
/** CPU cycles per tick of the 64 kHz and 15 kHz base clocks. */
const BASE_64K = 28;
const BASE_15K = 114;
/** Cycles from an underflow to the counter's reload, and to its fire. */
const RELOAD_DELAY = 3;
const FIRE_DELAY = 4;
/** Cycles from a linked low counter's underflow to the high counter's step. */
const LINK_DELAY = 3;
/** The first prescaler pulse after initialisation mode ends: a period-0
 *  counter's fire comes FIRE_DELAY later, at 24 and 83 cycles. */
const FIRST_64K = 24 - FIRE_DELAY;
const FIRST_15K = 83 - FIRE_DELAY;

/** How a counter is clocked. */
const CLOCK_BASE = 0;
const CLOCK_FAST = 1;
/** The high half of a linked pair: stepped by the low half's underflows. */
const CLOCK_LINKED = 2;

/** Rendered samples kept for the mixer; older ones are dropped. */
const SAMPLE_BUFFER = 512;

/** Output drop of each volume bit, in hundredths of a volt (appendix E.2). */
const DAC_BIT_CV = [12, 26, 56, 112];
/** Each volume level's drop, in hundredths of a volt. */
const DAC_CV = Array.from({ length: 16 }, (_, v) =>
  DAC_BIT_CV.reduce((sum, cv, bit) => sum + ((v >> bit) & 1) * cv, 0));
/** All four channels at full volume. */
const DAC_FULL_CV = 4 * DAC_CV[15];
/** The saturation curve over the summed drop: `x` normalised to 0-1. */
function saturate(x: number): number {
  return x < 0.14 ? 2.171 * x : 2.171 * (0.14 + (1 - Math.exp(-2.85 * (x - 0.14))) / 2.85);
}
/** POKEY's output level (0-1) for each summed drop in hundredths of a volt. */
const OUTPUT_LEVEL = Float64Array.from({ length: DAC_FULL_CV + 1 }, (_, cv) => saturate(cv / DAC_FULL_CV));
/** The first amplifier stage's coupling time constant, in seconds. */
const COUPLING_TAU = 0.0026;
/** The second stage's: slower, so external sources decay less (E.5). */
const SECOND_STAGE_TAU = 0.0247;
/** The second stage's input clamp, in units of POKEY's full scale (E.5). */
const CLAMP_LOW = -0.5;
const CLAMP_HIGH = 0.65;

export class Pokey {
  readonly audf = new Uint8Array(4);
  readonly audc = new Uint8Array(4);
  audctl = 0;

  /** IRQEN: interrupt enable mask. */
  irqen = 0;
  /** Latched interrupt sources, positive logic (1 = pending). IRQST reads
   *  the inverse of this. */
  irqPending = 0;

  /** Serial/keyboard control; bit 1 enables the keyboard scan. */
  skctl = 0;

  /** Last scanned key code. Bits 6-7 carry SHIFT/CONTROL, per the keyboard
   *  controller's code space. */
  kbcode = 0;

  /** True while at least one key is held (SKSTAT bit 2). */
  anyKeyDown = false;
  /** True while SHIFT is held (SKSTAT bit 3). */
  shiftDown = false;

  /** The SIO data-in line (1 = mark, the idle level). */
  serialIn: () => number = () => 1;
  /** Called with each byte as the transmitter starts shifting it out, and
   *  the CPU cycles left until its stop bit has been sent. */
  onSerialOut: ((byte: number, cyclesLeft: number) => void) | null = null;
  /** Cycles left of the byte in the output shift register (0 = idle). */
  private txLeft = 0;
  /** A byte is waiting in SEROUT for the shifter. */
  private txHolding = false;
  private txHoldingByte = 0;
  /** Cycles until an idle shifter loads the waiting byte (its next clock). */
  private txLoadIn = 0;
  /** Last byte the serial receiver assembled (SERIN). */
  serin = 0xFF;

  /** Total key-down events, for the keyboard activity LED. */
  keyEvents = 0;

  /** Number of keys currently held (the machine tracks the matrix). */
  keysDown = 0;

  // ── Time ─────────────────────────────────────────────────────────────────
  /** CPU cycles POKEY has been advanced to. */
  private now = 0;
  /** A pot scan (started by POTGO) is counting, and when it began. */
  private potScanning = false;
  private potStart = 0;
  /** The scan counts every cycle (SKCTL bit 2 when POTGO was written). */
  private potFast = false;
  /** What an unconnected pot reads once the scan is over: the count it stopped at. */
  private potLatch = 0;
  /** When initialisation mode last ended: the polys' and prescaler's zero. */
  private initEnd = 0;

  // ── Counters ─────────────────────────────────────────────────────────────
  private readonly clock = new Uint8Array(4);
  /** Pulses the counter still needs to underflow (its value + 1). */
  private readonly remaining = new Float64Array(4);
  /** The first time a pulse counts towards `remaining`. */
  private readonly asOf = new Float64Array(4);
  /** Time of the next underflow (Infinity when none is due). */
  private readonly under = new Float64Array(4).fill(Infinity);
  /** Time of the next fire. */
  private readonly fire = new Float64Array(4).fill(Infinity);
  /** Time of a scheduled reload; until then an AUDF write still counts. */
  private readonly reloadAt = new Float64Array(4).fill(-Infinity);
  /** Counters 3 and 4 held in reset (asynchronous receive, waiting). */
  private held34 = false;

  // ── Audio state ──────────────────────────────────────────────────────────
  private readonly clockHz: number;
  private sampleRate = 44100;
  private cyclesPerSample: number;
  /** Each channel's output flip-flop. */
  private readonly out = new Uint8Array(4);
  /** High-pass filter flip-flops for channels 1 and 2. */
  private readonly hp = new Uint8Array([1, 1]);
  /** Rendering position: audio up to here is in the buffer or `sampleAcc`. */
  private audioT = 0;
  private sampleAcc = 0;
  private sampleLeft: number;
  private readonly samples = new Float32Array(SAMPLE_BUFFER);
  private sampleHead = 0;
  private sampleCount = 0;
  /** The coupling capacitors' levels, and how far each moves a sample. */
  private coupled = 0;
  private couplingStep = 0;
  private coupled2 = 0;
  private couplingStep2 = 0;
  /** A level joining between the stages (see `setExternal`), and its
   *  running sum over the sample being built. */
  private external = 0;
  private externalAcc = 0;
  /** The mixer's weight on POKEY's own channels, ahead of the external
   *  source (see `setChannelGain`). */
  private channelGain = 1;
  /** The last sample handed out, repeated when none is ready. */
  private lastSample = 0;

  // ── Serial receiver state ────────────────────────────────────────────────
  /** Next bit to sample (0 = start ... 9 = stop), or -1 while idle. */
  private rxBit = -1;
  /** Channel 4 fires since the start bit's edge. */
  private rxFires = 0;
  /** The data-in level for this step. */
  private rxLevel = 1;
  private rxShift = 0;
  private rxLastLevel = 1;
  /** SKSTAT's overrun and framing latches, positive logic. */
  private skErrors = 0;

  constructor(clockHz: number) {
    this.clockHz = clockHz;
    this.cyclesPerSample = clockHz / this.sampleRate;
    this.sampleLeft = this.cyclesPerSample;
    this.setCoupling();
    this.reset();
  }

  private setCoupling(): void {
    this.couplingStep = 1 - Math.exp(-1 / (COUPLING_TAU * this.sampleRate));
    this.couplingStep2 = 1 - Math.exp(-1 / (SECOND_STAGE_TAU * this.sampleRate));
  }

  reset(): void {
    this.audf.fill(0);
    this.audc.fill(0);
    this.audctl = 0;
    this.irqen = 0;
    this.irqPending = 0;
    this.skctl = 0;
    this.potScanning = false;
    this.potLatch = 0;
    this.kbcode = 0;
    this.keyEvents = 0;
    this.keysDown = 0;
    this.serin = 0xFF;
    this.txLeft = 0;
    this.txHolding = false;
    this.txHoldingByte = 0;
    this.txLoadIn = 0;
    this.rxBit = -1;
    this.rxFires = 0;
    this.rxShift = 0;
    this.rxLastLevel = 1;
    this.skErrors = 0;
    // The output flip-flops power up at 1, as STIMER sets them.
    this.out.fill(1);
    this.hp.fill(1);
    this.held34 = false;
    this.initEnd = this.now;
    for (let c = 0; c < 4; c++) {
      this.remaining[c] = 1;
      this.asOf[c] = this.now;
      this.fire[c] = Infinity;
      this.reloadAt[c] = -Infinity;
    }
    this.sampleCount = 0;
    this.sampleAcc = 0;
    this.sampleLeft = this.cyclesPerSample;
    this.coupled = 0;
    this.coupled2 = 0;
    this.externalAcc = 0;
    this.lastSample = 0;
    this.audioT = this.now;
    this.decodeClocks();
    for (let c = 0; c < 4; c++) this.schedule(c);
  }

  /**
   * Snapshot: registers, keyboard and serial state, and every counter's
   * schedule. The times are absolute (`now` is saved with them) and go in as
   * f64, since they pass 2^32 and an idle counter's is Infinity. The rendered
   * sample buffer is not saved; audio picks up from `now` on load.
   */
  saveState(w: StateWriter): void {
    w.raw(this.audf); w.raw(this.audc);
    w.u8(this.audctl); w.u8(this.irqen); w.u8(this.irqPending); w.u8(this.skctl);
    w.u8(this.kbcode); w.bool(this.anyKeyDown); w.bool(this.shiftDown);
    w.u8(this.serin); w.u32(this.keyEvents); w.u32(this.keysDown);
    w.f64(this.txLeft); w.bool(this.txHolding); w.u8(this.txHoldingByte); w.f64(this.txLoadIn);
    w.f64(this.now); w.f64(this.initEnd);
    w.f64s(this.remaining); w.f64s(this.asOf); w.f64s(this.under);
    w.f64s(this.fire); w.f64s(this.reloadAt);
    w.bool(this.held34);
    w.raw(this.out); w.raw(this.hp);
    w.f64(this.coupled); w.f64(this.coupled2);
    w.f64(this.external); w.f64(this.lastSample);
    w.i32(this.rxBit); w.u32(this.rxFires); w.u8(this.rxLevel);
    w.u16(this.rxShift); w.u8(this.rxLastLevel); w.u8(this.skErrors);
  }

  loadState(r: StateReader): void {
    r.rawInto(this.audf); r.rawInto(this.audc);
    this.audctl = r.u8(); this.irqen = r.u8(); this.irqPending = r.u8(); this.skctl = r.u8();
    this.kbcode = r.u8(); this.anyKeyDown = r.bool(); this.shiftDown = r.bool();
    this.serin = r.u8(); this.keyEvents = r.u32(); this.keysDown = r.u32();
    this.txLeft = r.f64(); this.txHolding = r.bool(); this.txHoldingByte = r.u8(); this.txLoadIn = r.f64();
    this.now = r.f64(); this.initEnd = r.f64();
    r.f64sInto(this.remaining); r.f64sInto(this.asOf); r.f64sInto(this.under);
    r.f64sInto(this.fire); r.f64sInto(this.reloadAt);
    this.held34 = r.bool();
    r.rawInto(this.out); r.rawInto(this.hp);
    this.coupled = r.f64(); this.coupled2 = r.f64();
    this.external = r.f64(); this.lastSample = r.f64();
    this.rxBit = r.i32(); this.rxFires = r.u32(); this.rxLevel = r.u8();
    this.rxShift = r.u16(); this.rxLastLevel = r.u8(); this.skErrors = r.u8();
    this.decodeClocks();
    // Audio restarts at `now`, with nothing buffered.
    this.audioT = this.now;
    this.sampleAcc = 0;
    this.externalAcc = 0;
    this.sampleLeft = this.cyclesPerSample;
    this.sampleHead = 0;
    this.sampleCount = 0;
  }

  /** Update the output sample rate (called once the AudioContext exists). */
  setSampleRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.sampleRate = rate;
    this.cyclesPerSample = this.clockHz / rate;
    this.setCoupling();
    this.sampleAcc = 0;
    this.externalAcc = 0;
    this.sampleLeft = this.cyclesPerSample;
  }

  /** Set the level of a source that joins the audio between the amplifier
   *  stages (the XL's CONSOL speaker), in units of POKEY's full scale. It
   *  takes effect at the time POKEY has been advanced to. */
  setExternal(level: number): void {
    if (level === this.external) return;
    this.renderTo(this.now);
    this.external = level;
  }

  /** Weigh POKEY's own channels against the external source: the Sound
   *  pane's balance, which on the XL has to be struck before the two meet. */
  setChannelGain(gain: number): void {
    if (gain === this.channelGain) return;
    this.renderTo(this.now);
    this.channelGain = gain;
  }

  // ── Bus ──────────────────────────────────────────────────────────────────

  readReg(addr: number): number {
    const a = addr & 0x0F;
    if (a < 0x08) return this.potCount();
    switch (a) {
      case 0x08: this.potCount(); return this.potScanning ? 0xFF : 0x00; // ALLPOT
      case 0x09: return this.kbcode;
      case 0x0a: return this.random();
      case 0x0d: return this.serin;
      case 0x0e: return ~(this.irqPending | this.serocLevel()) & 0xFF;
      case 0x0f: return this.readSkstat();
      default: return 0xFF;
    }
  }

  writeReg(addr: number, value: number): void {
    const a = addr & 0x0F;
    const v = value & 0xFF;
    if (a < 0x08) {
      // Each channel's AUDF and AUDC sit side by side: AUDF1 $D200, AUDC1
      // $D201, AUDF2 $D202 ... AUDC4 $D207.
      if ((a & 1) === 0) this.writeAudf(a >> 1, v);
      else this.audc[a >> 1] = v;
      return;
    }
    switch (a) {
      case 0x08: this.writeAudctl(v); break;
      case 0x09: this.stimer(); break;
      case 0x0a: this.skErrors = 0; break; // SKRES
      case 0x0b: this.startPotScan(); break;
      case 0x0d: this.writeSerout(v); break;
      case 0x0e: this.writeIrqen(v); break;
      case 0x0f: this.writeSkctl(v); break;
      default: break;
    }
  }

  // ── Pots ─────────────────────────────────────────────────────────────────
  //
  // POTGO starts a scan: the eight counters run up from zero, and each stops
  // when its paddle's capacitor has charged past the threshold, leaving the
  // count in POTn; ALLPOT has a bit set for every pot still counting. A slow
  // scan counts once per 15 kHz clock and ends at 228; a fast one (SKCTL bit 2)
  // counts every cycle and ends at 229. Nothing is plugged into the ports, so
  // no pot ever stops early: they all count to the end and latch that count.
  // (With the 15 kHz clock stopped, as in initialisation mode, a slow scan
  // never moves.)

  private startPotScan(): void {
    this.potScanning = true;
    this.potStart = this.now;
    this.potFast = (this.skctl & 0x04) !== 0;
    this.potLatch = 0;
  }

  /** The count a pot scan has reached (settling it, if it is over). */
  private potCount(): number {
    if (!this.potScanning) return this.potLatch;
    const elapsed = this.now - this.potStart;
    if (this.potFast) {
      if (elapsed >= POT_FAST_END) return this.finishPotScan(POT_FAST_END);
      return Math.max(0, Math.floor(elapsed));
    }
    if ((this.skctl & 0x03) === 0) return 0; // 15 kHz clock stopped
    // The last count lands one cycle after the 228th tick.
    if (elapsed > POT_SLOW_END * POT_SLOW_PERIOD) return this.finishPotScan(POT_SLOW_END);
    return Math.floor(elapsed / POT_SLOW_PERIOD);
  }

  private finishPotScan(last: number): number {
    this.potScanning = false;
    this.potLatch = last;
    return last;
  }

  private writeIrqen(v: number): void {
    // A disabled source cannot hold a latch: clearing an IRQEN bit is how
    // every POKEY interrupt is acknowledged.
    this.irqen = v;
    this.irqPending &= v;
  }

  /** Latch interrupt `bit`, if its source is enabled. */
  private raise(bit: number): void {
    this.irqPending |= bit & this.irqen;
  }

  /** True while any enabled interrupt source is pending. */
  get irq(): boolean {
    // Bit 3 (transmission complete) is level-sensitive and never latched, so
    // it asserts the line whenever it is enabled and the transmitter is idle.
    return (this.irqen & (this.irqPending | this.serocLevel())) !== 0;
  }

  /** IRQST bit 3 as a pending bit: set while the shifter is idle. */
  private serocLevel(): number {
    return this.txLeft <= 0 ? IRQ_SEROC : 0;
  }

  /** Cycles to shift one byte out: ten bits of two channel-4 periods. */
  private txByteCycles(): number {
    return TX_FRAME_BITS * Math.max(2, 2 * this.channel4Period());
  }

  /** Channel 4's period in CPU cycles, from AUDF and AUDCTL. */
  private channel4Period(): number {
    const base = (this.audctl & 0x01) !== 0 ? BASE_15K : BASE_64K;
    if ((this.audctl & 0x08) === 0) return (this.audf[3] + 1) * base;
    const n = (this.audf[3] << 8) | this.audf[2];
    return (this.audctl & 0x20) !== 0 ? n + 7 : (n + 1) * base;
  }

  private writeSerout(v: number): void {
    if (this.txLeft <= 0 && !this.txHolding) {
      // The idle shifter takes the byte at channel 4's next count-out.
      const next = this.under[3] - this.now;
      this.txLoadIn = Number.isFinite(next) ? Math.max(1, next) : this.channel4Period();
    }
    this.txHolding = true;
    this.txHoldingByte = v;
  }

  private clockSerialOut(cycles: number): void {
    if (this.txLeft <= 0) {
      if (!this.txHolding) return;
      this.txLoadIn -= cycles;
      if (this.txLoadIn > 0) return;
      // Loaded part-way through this step: the rest of it shifts.
      this.txHolding = false;
      this.txLeft = this.txByteCycles() + this.txLoadIn;
      this.onSerialOut?.(this.txHoldingByte, this.txLeft);
      this.raise(IRQ_SEROR); // the holding register is free again
      return;
    }
    this.txLeft -= cycles;
    while (this.txLeft <= 0 && this.txHolding) {
      this.txHolding = false;
      this.txLeft += this.txByteCycles();
      this.onSerialOut?.(this.txHoldingByte, this.txLeft);
      this.raise(IRQ_SEROR);
    }
    if (this.txLeft < 0) this.txLeft = 0;
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  get keyboardScanEnabled(): boolean {
    return (this.skctl & 0x02) !== 0;
  }

  /** A key was pressed. `code` is the POKEY scan code; SHIFT is folded into
   *  KBCODE bit 6, matching the hardware's keyboard code space. */
  pressKey(code: number, shift: boolean, control: boolean): void {
    // With the scan off (SKCTL bit 1 clear) nothing walks the keyboard: the
    // key is never seen, SKSTAT shows no key down.
    if (!this.keyboardScanEnabled) return;
    this.anyKeyDown = true;
    this.shiftDown = shift;
    this.kbcode = (code & 0x3F) | (shift ? 0x40 : 0) | (control ? 0x80 : 0);
    // A key that arrives while the last one's interrupt is still waiting to be
    // acknowledged is an overrun (SKSTAT bit 6, cleared by SKRES).
    if ((this.irqen & IRQ_KEYBOARD) !== 0 && (this.irqPending & IRQ_KEYBOARD) !== 0) {
      this.skErrors |= SK_KB_OVERRUN;
    }
    this.raise(IRQ_KEYBOARD);
    this.keyEvents++;
  }

  /** The BREAK key is outside the scan matrix but is read by the same scan, so
   *  it only raises IRQST bit 7 while the scan runs. */
  breakKey(): void {
    if (!this.keyboardScanEnabled) return;
    this.raise(IRQ_BREAK);
  }

  /** SKSTAT: bit 2 low while a key is held, bit 3 low while SHIFT is held,
   *  bit 4 the serial data-in line, bit 1 low while a byte is shifting in,
   *  bits 5, 6 and 7 the serial overrun, keyboard overrun and framing-error
   *  latches (low = set). */
  readSkstat(): number {
    let v = 0xFF & ~this.skErrors;
    if (this.anyKeyDown) v &= ~0x04;
    if (this.shiftDown) v &= ~0x08;
    if (this.serialIn() === 0) v &= ~0x10;
    if (this.rxBit >= 0) v &= ~0x02;
    return v;
  }

  // ── SKCTL, initialisation mode ───────────────────────────────────────────

  /** True in initialisation mode (SKCTL bits 0-1 both clear). */
  private get initMode(): boolean {
    return (this.skctl & 0x03) === 0;
  }

  /** True when SKCTL clocks the receiver from channel 4 (not modes 0, 4). */
  private get rxClocked(): boolean {
    return ((this.skctl >> 4) & 0x03) !== 0;
  }

  /** Asynchronous receive (SKCTL bit 4). */
  private get rxAsync(): boolean {
    return (this.skctl & 0x10) !== 0;
  }

  private writeSkctl(v: number): void {
    const wasInit = this.initMode;
    this.rebaseAll();
    this.skctl = v;
    if (this.initMode) {
      this.rxBit = -1; // initialisation mode resets the serial input
    } else if (wasInit) {
      this.initEnd = this.now;
    }
    const wasHeld = this.held34;
    this.held34 = this.rxAsync && this.rxBit < 0;
    if (this.held34) {
      this.hold34();
    } else if (wasHeld) {
      this.reload(2, this.now);
      this.reload(3, this.now);
    }
    for (let c = 0; c < 4; c++) this.schedule(c);
  }

  /** Hold counters 3 and 4 in reset: loaded from AUDF, not counting. */
  private hold34(): void {
    for (let c = 2; c < 4; c++) {
      this.remaining[c] = this.audf[c] + 1;
      this.reloadAt[c] = Infinity;
      this.under[c] = Infinity;
    }
  }

  /** RANDOM: the inverted low 8 bits of the 9- or 17-bit register. */
  private random(): number {
    const pos = this.polyPos(this.now);
    return (this.audctl & 0x80) !== 0 ? RANDOM9[pos % RANDOM9.length] : RANDOM17[pos % RANDOM17.length];
  }

  /** Cycles the polys have run at time `t` (0 while initialisation holds them). */
  private polyPos(t: number): number {
    return this.initMode ? 0 : t - this.initEnd;
  }

  // ── Counters ─────────────────────────────────────────────────────────────

  /** Work out each channel's clock from AUDCTL. */
  private decodeClocks(): void {
    const audctl = this.audctl;
    this.clock[0] = (audctl & 0x40) !== 0 ? CLOCK_FAST : CLOCK_BASE;
    this.clock[1] = (audctl & 0x10) !== 0 ? CLOCK_LINKED : CLOCK_BASE;
    this.clock[2] = (audctl & 0x20) !== 0 ? CLOCK_FAST : CLOCK_BASE;
    this.clock[3] = (audctl & 0x08) !== 0 ? CLOCK_LINKED : CLOCK_BASE;
    // A high-pass filter that is off holds its flip-flop at 1.
    if ((audctl & 0x04) === 0) this.hp[0] = 1;
    if ((audctl & 0x02) === 0) this.hp[1] = 1;
  }

  /** True for the low half of a linked pair (channels 1 and 3). */
  private isLinkedLow(c: number): boolean {
    return c < 3 && (c & 1) === 0 && this.clock[c + 1] === CLOCK_LINKED;
  }

  /** True while counter `c` gets no pulses of its own clock. */
  private frozen(c: number): boolean {
    if (c >= 2 && this.held34) return true;
    return this.clock[c] === CLOCK_BASE && this.initMode;
  }

  /** The prescaler's first pulse and spacing for the selected base clock. */
  private baseGrid(): { first: number; step: number } {
    return (this.audctl & 0x01) !== 0
      ? { first: this.initEnd + FIRST_15K, step: BASE_15K }
      : { first: this.initEnd + FIRST_64K, step: BASE_64K };
  }

  /** Pulses counter `c` gets in [from, to). */
  private pulses(c: number, from: number, to: number): number {
    if (to <= from || this.frozen(c)) return 0;
    switch (this.clock[c]) {
      case CLOCK_FAST: return to - from;
      case CLOCK_BASE: {
        const { first, step } = this.baseGrid();
        const j0 = Math.max(0, Math.ceil((from - first) / step));
        const j1 = Math.max(0, Math.ceil((to - first) / step));
        return j1 - j0;
      }
      default: return 0; // linked: stepped by events
    }
  }

  /** Time of counter `c`'s `k`-th pulse at or after `from`. */
  private nthPulse(c: number, from: number, k: number): number {
    if (this.frozen(c)) return Infinity;
    switch (this.clock[c]) {
      case CLOCK_FAST: return from + k - 1;
      case CLOCK_BASE: {
        const { first, step } = this.baseGrid();
        const j = Math.max(0, Math.ceil((from - first) / step)) + k - 1;
        return first + j * step;
      }
      default: return Infinity;
    }
  }

  /** Count the pulses each running counter has had up to now, before a
   *  change of clock. */
  private rebaseAll(): void {
    const now = this.now;
    for (let c = 0; c < 4; c++) {
      if (this.clock[c] === CLOCK_LINKED || this.asOf[c] >= now) continue;
      this.remaining[c] = Math.max(1, this.remaining[c] - this.pulses(c, this.asOf[c], now));
      this.asOf[c] = now;
    }
  }

  /** Recompute counter `c`'s next underflow from its count and clock. A
   *  linked high counter's underflow is set by its low half instead. */
  private schedule(c: number): void {
    if (this.clock[c] === CLOCK_LINKED) {
      if (this.frozen(c)) this.under[c] = Infinity;
      return;
    }
    if (this.asOf[c] < this.now) this.asOf[c] = this.now;
    this.under[c] = this.nthPulse(c, this.asOf[c], this.remaining[c]);
  }

  /** Reload counter `c` from AUDF at time `r`; it counts from r+1. */
  private reload(c: number, r: number): void {
    this.remaining[c] = this.audf[c] + 1;
    this.reloadAt[c] = r;
    this.asOf[c] = r + 1;
    if (this.clock[c] === CLOCK_LINKED) this.under[c] = Infinity;
    else this.schedule(c);
  }

  private writeAudf(c: number, v: number): void {
    this.audf[c] = v;
    // Only the next reload picks the value up; one still ahead (or a
    // counter held in reset) takes it now.
    if (this.reloadAt[c] > this.now) {
      this.remaining[c] = v + 1;
      this.schedule(c);
    }
  }

  private writeAudctl(v: number): void {
    this.rebaseAll();
    const wasLinked = [this.clock[1] === CLOCK_LINKED, this.clock[3] === CLOCK_LINKED];
    this.audctl = v;
    this.decodeClocks();
    for (let hi = 1; hi < 4; hi += 2) {
      const linked = this.clock[hi] === CLOCK_LINKED;
      if (linked && !wasLinked[hi >> 1]) this.under[hi] = Infinity;
      if (!linked && wasLinked[hi >> 1]) this.asOf[hi] = this.now;
    }
    for (let c = 0; c < 4; c++) this.schedule(c);
  }

  /** STIMER: every counter reloads 3 cycles on, which pre-empts any
   *  underflow not yet reached; every output flip-flop goes to 1. */
  private stimer(): void {
    const r = this.now + RELOAD_DELAY;
    for (let c = 0; c < 4; c++) this.reload(c, r);
    if (this.held34) this.hold34();
    this.out.fill(1);
  }

  /** Counter `c` underflows at time `u`. */
  private underflow(c: number, u: number): void {
    this.under[c] = Infinity;
    this.fire[c] = u + FIRE_DELAY;
    if (this.clock[c] === CLOCK_LINKED) {
      // The pair's high half: both halves reload together.
      this.reload(c - 1, u + RELOAD_DELAY);
      this.reload(c, u + RELOAD_DELAY);
    } else if (this.isLinkedLow(c)) {
      // No reload: the counter wraps through $FF, and steps the high half.
      this.remaining[c] = 256;
      this.asOf[c] = u + 1;
      this.schedule(c);
      const hi = c + 1;
      if (!this.frozen(hi) && --this.remaining[hi] <= 0) this.under[hi] = u + LINK_DELAY;
    } else {
      this.reload(c, u + RELOAD_DELAY);
    }
  }

  /** Counter `c`'s pulse reaches the outputs at time `f`. */
  private fireChannel(c: number, f: number): void {
    this.fire[c] = Infinity;
    // The high-pass filters sample channel 1 at channel 3's fire and
    // channel 2 at channel 4's.
    if (c === 2 && (this.audctl & 0x04) !== 0) this.hp[0] = this.out[0];
    if (c === 3 && (this.audctl & 0x02) !== 0) this.hp[1] = this.out[1];
    this.clockOutput(c, f);
    if (TIMER_IRQ[c] !== 0) this.raise(TIMER_IRQ[c]);
    if (c === 3) this.clockSerialIn();
  }

  // ── Serial input ─────────────────────────────────────────────────────────

  /** Look for a start bit on the data-in line, read once per step (steps
   *  are a CPU instruction, far finer than any bit cell). */
  private watchSerialIn(): void {
    const level = this.serialIn() & 1;
    this.rxLevel = level;
    if (this.rxBit < 0 && level === 0 && this.rxLastLevel === 1 && this.rxClocked && !this.initMode) {
      this.rxBit = 0;
      this.rxShift = 0;
      this.rxFires = 0;
      if (this.held34) {
        // The edge lets counters 3 and 4 go.
        this.held34 = false;
        this.reload(2, this.now);
        this.reload(3, this.now);
      }
    }
    this.rxLastLevel = level;
  }

  /** Channel 4 fired: the receiver samples on every other fire. */
  private clockSerialIn(): void {
    if (this.rxBit < 0) return;
    if ((++this.rxFires & 1) === 0) return;
    this.sampleBit(this.rxLevel);
    if (this.rxBit < 0 && this.rxAsync) {
      // Byte done: back to waiting, counters 3 and 4 held.
      this.held34 = true;
      this.hold34();
    }
  }

  private sampleBit(level: number): void {
    const bit = this.rxBit;
    if (bit >= 1 && bit <= 8) this.rxShift |= level << (bit - 1);
    if (bit < 9) {
      this.rxBit++;
      return;
    }
    // The stop bit: hand the byte over.
    if (level === 0) this.skErrors |= SK_FRAMING;
    if ((this.irqPending & IRQ_SERIN) !== 0) this.skErrors |= SK_OVERRUN;
    this.serin = this.rxShift;
    this.raise(IRQ_SERIN);
    this.rxBit = -1;
  }

  // ── Running ──────────────────────────────────────────────────────────────

  /** Advance the chip by `cycles` CPU cycles: counters, timers, audio and
   *  the serial port. */
  advance(cycles: number): void {
    if (cycles <= 0) return;
    const end = this.now + cycles;
    this.watchSerialIn();
    this.clockSerialOut(cycles);
    for (;;) {
      // The next event before `end`; a fire goes before an underflow at the
      // same time, and of fires at one time channels 3 and 4 go before 1 and
      // 2, so the high-pass filters sample those as they were the cycle before.
      let t = end;
      let c = -1;
      let isFire = false;
      for (const i of FIRE_ORDER) {
        if (this.fire[i] < t) { t = this.fire[i]; c = i; isFire = true; }
      }
      for (let i = 0; i < 4; i++) {
        if (this.under[i] < t) { t = this.under[i]; c = i; isFire = false; }
      }
      if (c < 0) break;
      this.renderTo(t);
      if (isFire) this.fireChannel(c, t);
      else this.underflow(c, t);
    }
    this.renderTo(end);
    this.now = end;
  }

  // ── Audio ────────────────────────────────────────────────────────────────

  /** Clock channel `c`'s output flip-flop at time `t`. */
  private clockOutput(c: number, t: number): void {
    const audc = this.audc[c];
    const held = this.initMode;
    const pos = this.polyPos(t) - c; // each channel a cycle behind the last
    // Initialisation mode holds the 5-bit poly's output at 1.
    if ((audc & 0x80) === 0 && !held && polyBit(POLY5, pos % POLY5.length) === 0) return;
    if ((audc & 0x20) !== 0) this.out[c] ^= 1;
    else if ((audc & 0x40) !== 0) this.out[c] = polyBit(POLY4, pos % POLY4.length);
    else if ((this.audctl & 0x80) !== 0) this.out[c] = 1 ^ (polyBit(RANDOM9, pos % RANDOM9.length) & 1);
    else this.out[c] = 1 ^ (polyBit(RANDOM17, pos % RANDOM17.length) & 1);
  }

  /** True while channel `c`'s digital output is on. */
  private channelOn(c: number): boolean {
    if ((this.audc[c] & 0x10) !== 0) return true; // volume only
    return (c < 2 ? this.out[c] ^ this.hp[c] : this.out[c]) !== 0;
  }

  /** The total volume (0-60) of the channels whose output is on now: the
   *  digital mix, before the DACs. */
  get volumeSum(): number {
    let sum = 0;
    for (let c = 0; c < 4; c++) if (this.channelOn(c)) sum += this.audc[c] & 0x0F;
    return sum;
  }

  /** POKEY's output now (0-1), before the amplifier stages. */
  get outputLevel(): number {
    return this.mixLevel();
  }

  /** POKEY's output now (0-1): the DACs' summed drop through the
   *  saturation curve. */
  private mixLevel(): number {
    let cv = 0;
    for (let c = 0; c < 4; c++) if (this.channelOn(c)) cv += DAC_CV[this.audc[c] & 0x0F];
    return OUTPUT_LEVEL[cv];
  }

  /** Render the output, at its current level, up to time `t`. */
  private renderTo(t: number): void {
    let dt = t - this.audioT;
    if (dt <= 0) return;
    this.audioT = t;
    const level = this.mixLevel();
    const ext = this.external;
    while (dt >= this.sampleLeft) {
      dt -= this.sampleLeft;
      this.pushSample(
        (this.sampleAcc + level * this.sampleLeft) / this.cyclesPerSample,
        (this.externalAcc + ext * this.sampleLeft) / this.cyclesPerSample,
      );
      this.sampleAcc = 0;
      this.externalAcc = 0;
      this.sampleLeft = this.cyclesPerSample;
    }
    this.sampleAcc += level * dt;
    this.externalAcc += ext * dt;
    this.sampleLeft -= dt;
  }

  /** Queue one sample: POKEY's `level` through the first stage, `external`
   *  joining after it, then the second stage's clamp and coupling. */
  private pushSample(level: number, external: number): void {
    const first = level - this.coupled;
    this.coupled += first * this.couplingStep;
    const input = Math.min(CLAMP_HIGH, Math.max(CLAMP_LOW, first * this.channelGain + external));
    const v = input - this.coupled2;
    this.coupled2 += v * this.couplingStep2;
    if (this.sampleCount === SAMPLE_BUFFER) {
      this.sampleHead = (this.sampleHead + 1) % SAMPLE_BUFFER;
      this.sampleCount--;
    }
    this.samples[(this.sampleHead + this.sampleCount) % SAMPLE_BUFFER] = v;
    this.sampleCount++;
  }

  /** One output sample; the mixer calls this once per sample period, after
   *  the CPU (and so POKEY) has run past it. With nothing rendered yet it
   *  repeats the last one. */
  generateSampleStereo(): { left: number; right: number } {
    if (this.sampleCount > 0) {
      this.lastSample = this.samples[this.sampleHead];
      this.sampleHead = (this.sampleHead + 1) % SAMPLE_BUFFER;
      this.sampleCount--;
    }
    return { left: this.lastSample, right: this.lastSample };
  }
}

/**
 * POKEY's polynomial counters are XNOR shift registers that shift right one
 * bit per cycle from a zeroed start: for 1 + x^a + x^n the bit shifted in at
 * the top is XNOR(bit 0, bit n-a), and the audio takes bit 0. The 9-bit
 * register is the 17-bit one's low end, so both tap bits 0 and 5.
 *
 * `bits` gives bit 0 for one period, `bytes` the inverted low 8 bits (what
 * RANDOM reads), both indexed by cycles since initialisation mode ended.
 */
function polyStates(n: number, tap: number): { bits: Uint8Array; bytes: Uint8Array } {
  const length = (1 << n) - 1;
  const bits = new Uint8Array(length);
  const bytes = new Uint8Array(length);
  let s = 0;
  for (let i = 0; i < length; i++) {
    bits[i] = s & 1;
    bytes[i] = ~s & 0xFF;
    const b = 1 ^ ((s ^ (s >> tap)) & 1);
    s = (s >> 1) | (b << (n - 1));
  }
  return { bits, bytes };
}

const POLY4 = polyStates(4, 1).bits;   // 1 + x^3 + x^4
const POLY5 = polyStates(5, 2).bits;   // 1 + x^3 + x^5
const RANDOM9 = polyStates(9, 5).bytes;    // 1 + x^4 + x^9
const RANDOM17 = polyStates(17, 5).bytes;  // 1 + x^12 + x^17

/** A poly's output `pos` cycles in, wrapping (pos may be a few below 0). */
function polyBit(poly: Uint8Array, pos: number): number {
  return poly[pos < 0 ? pos + poly.length : pos];
}
