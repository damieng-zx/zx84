/**
 * Cassette-output capture: the time between successive transitions of a
 * machine's tape-out line (the Spectrum's MIC bit, the CPC's PPI write-data
 * bit, an Apple's toggle flip-flop), in that machine's own clock units.
 *
 * This is the raw material every "what did the program SAVE" export is built
 * from — the format encoders and pulse decoders in this folder read it back.
 * It is fed from port and soft-switch handlers, so `observe` is kept
 * allocation-free: pulses go into a typed buffer that only grows (doubling)
 * when it fills, up to a fixed ceiling, so a machine left running with a
 * flickering output line cannot consume memory without bound.
 */

/** Initial buffer size, in pulses — a few seconds of tape signal. */
const INITIAL_PULSES = 1 << 16;

/** Default ceiling on retained pulses: about five full 48K Spectrum saves at
 *  ROM speed (each ~0.8M pulses), 16 MB of buffer. */
export const PULSE_RECORDER_MAX = 1 << 22;

/** Largest storable pulse; longer silences are clamped to it. */
const MAX_PULSE = 0xFFFFFFFF;

export class PulseRecorder {
  private buf = new Uint32Array(INITIAL_PULSES);
  private len = 0;
  private level = 0;
  private lastT = 0;
  private started = false;
  private startLevel = 0;

  constructor(private readonly maxPulses = PULSE_RECORDER_MAX) {}

  /**
   * Observe the output line at absolute clock `t` (monotonic between resets).
   * Only a change of level is an edge: re-writing the same level (a border
   * colour change on the Spectrum, a keyboard-row select on the CPC) is not.
   * The first edge starts the clock; whatever came before it is silence.
   */
  observe(level: number, t: number): void {
    if (level === this.level) return;
    this.level = level;
    if (!this.started) {
      this.started = true;
      this.startLevel = level;
      this.lastT = t;
      return;
    }
    const d = t - this.lastT;
    this.lastT = t;
    if (this.len >= this.buf.length && !this.grow()) return;
    this.buf[this.len++] = d < 1 ? 1 : d > MAX_PULSE ? MAX_PULSE : d;
  }

  /**
   * Record an edge unconditionally (for outputs that are a toggle, like the
   * Apple II's `$C020` flip-flop, where every access is a transition).
   */
  toggle(t: number): void {
    this.observe(this.level ^ 1, t);
  }

  /** Number of closed pulses recorded (the pulse still in progress excluded). */
  get count(): number { return this.len; }

  /** Level the line was driven to by the first recorded edge — the level of
   *  the first pulse. Successive pulses alternate from it. */
  get firstLevel(): number { return this.startLevel; }

  /** True once the line has moved at least once. */
  get hasEdges(): boolean { return this.started; }

  /**
   * A copy of the recorded pulses. With `now`, the pulse still in progress
   * (from the last edge to `now`) is closed off and appended, so the final
   * half-cycle of a save that ended with no further edge is not lost.
   */
  pulses(now?: number): Uint32Array {
    const open = now !== undefined && this.started && now > this.lastT;
    const out = new Uint32Array(this.len + (open ? 1 : 0));
    out.set(this.buf.subarray(0, this.len));
    if (open) {
      const d = now! - this.lastT;
      out[this.len] = d > MAX_PULSE ? MAX_PULSE : d;
    }
    return out;
  }

  reset(): void {
    this.len = 0;
    this.level = 0;
    this.lastT = 0;
    this.started = false;
    this.startLevel = 0;
  }

  /** Double the buffer, up to the ceiling. False when already at it. */
  private grow(): boolean {
    if (this.buf.length >= this.maxPulses) return false;
    const next = new Uint32Array(Math.min(this.buf.length * 2, this.maxPulses));
    next.set(this.buf);
    this.buf = next;
    return true;
  }
}
