/**
 * Cassette FSK demodulator shared by the BBC Micro's serial ULA and the Acorn
 * Electron's ULA.
 *
 * Acorn tapes use Kansas City modulation: a `0` is 1200 Hz and a `1` is 2400
 * Hz (the idle carrier is a continuous 2400 Hz). The deck delivers the audio as
 * level changes; this classifies each half-cycle by its length, the way the
 * hardware's tone-detect circuits do:
 *
 *   half-cycle under ~312 us  → 2400 Hz → data line high, tone present
 *   half-cycle ~312-600 us    → 1200 Hz → data line low
 *   nothing for over ~600 us  → silence → line idles high, no carrier
 *
 * A 2400 Hz half-cycle is only recognised once it has finished, but a 1200 Hz
 * one is recognised by the *absence* of an edge by 312 us, so each output
 * change is reported with the cycle it truly started on (`levelSince`) so a
 * UART can start its bit clock from the real edge rather than the late
 * detection.
 */

export class CassetteFsk {
  /** Demodulated data line: 1 = mark (2400 Hz / idle), 0 = space (1200 Hz). */
  level = 1;
  /** Cycle the data line last changed. */
  levelSince = 0;
  /**
   * The data line as a start-bit detector may trust it. `level` drops to 0 as
   * soon as a half-cycle outlasts a 2400 Hz one, but that is also how the end
   * of the tone looks until the silence timeout, so a UART idling for a start
   * bit waits for the long half-cycle to end in a real edge (`startLevel`)
   * while one mid-frame samples the faster `level`.
   */
  startLevel = 1;
  /** A steady 2400 Hz carrier has been present for the detect time. */
  carrier = false;

  private readonly shortMax: number;     // half-cycle longer than this is a 1200 Hz one
  private readonly idleAfter: number;    // no edge for this long = silence
  private readonly carrierAfter: number; // continuous 2400 Hz needed before carrier detect
  private lastEdge = 0;
  private toneSince = -1;                // start of the current run of 2400 Hz half-cycles
  private signal = false;                // some tone has been seen since the last silence

  /** @param cpuClock CPU cycles per second  @param carrierDetectMs time of unbroken
   *  2400 Hz before `carrier` asserts */
  constructor(cpuClock: number, carrierDetectMs = 40) {
    this.shortMax = Math.round(cpuClock / 3200);
    this.idleAfter = Math.round(cpuClock / 1650);
    this.carrierAfter = Math.round(cpuClock * carrierDetectMs / 1000);
  }

  reset(now = 0): void {
    this.level = 1;
    this.startLevel = 1;
    this.levelSince = now;
    this.carrier = false;
    this.lastEdge = now;
    this.toneSince = -1;
    this.signal = false;
  }

  private set(level: number, since: number): void {
    if (level !== this.level) { this.level = level; this.levelSince = since; }
  }

  /** The tape level toggled at `now`. */
  edge(now: number): void {
    const half = now - this.lastEdge;
    const prev = this.lastEdge;
    this.lastEdge = now;
    if (!this.signal) {
      // First edge after silence: nothing to measure against yet.
      this.signal = true;
      return;
    }
    if (half <= this.shortMax) {
      if (this.toneSince < 0) this.toneSince = prev;
      this.set(1, prev);
      this.startLevel = 1;
      if (!this.carrier && now - this.toneSince >= this.carrierAfter) this.carrier = true;
    } else if (half <= this.idleAfter) {
      this.set(0, prev);
      this.startLevel = 0;
      this.toneSince = -1;
      this.carrier = false;
    } else {
      this.silence(now);
    }
  }

  /** Apply the no-edge timeouts. Call as time advances. */
  update(now: number): void {
    const since = now - this.lastEdge;
    if (since <= this.shortMax || !this.signal) return;
    if (since > this.idleAfter) {
      this.silence(now);
    } else if (this.level !== 0) {
      this.set(0, this.lastEdge);       // the long half-cycle began at the last edge
      this.toneSince = -1;
      this.carrier = false;
    }
  }

  private silence(now: number): void {
    this.signal = false;
    this.toneSince = -1;
    this.carrier = false;
    this.set(1, now);
    this.startLevel = 1;
  }
}
