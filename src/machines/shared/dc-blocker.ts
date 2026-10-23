/**
 * First-order DC-blocking high-pass (AC coupling), the one filter every sound
 * device in the mixer passes through: y[n] = α · (y[n-1] + x[n] − x[n-1]).
 *
 * It centres a source on zero whatever level it idles at — a beeper held high,
 * a DAC parked off-centre, a PSG with every channel gated to a constant — so a
 * level change never leaves a click or a standing offset, and the later stages
 * (an equaliser, the per-device volume) always see a signal around zero.
 */

/** Corner frequency, low enough to leave bass untouched. */
const CUTOFF_HZ = 20;

export class DcBlocker {
  private alpha: number;
  private prev = 0;
  private out = 0;
  /** True once the filter has seen a sample since construction/reset/idle. */
  private primed = false;

  /**
   * @param primeOnFirst When true the first sample seeds the filter's history, so
   *   a signal that is already at a DC level starts at zero instead of stepping.
   *   Pass false for a source that is exactly zero at idle (a signed DAC).
   */
  constructor(sampleRate = 44100, private readonly primeOnFirst = true) {
    this.alpha = DcBlocker.alphaFor(sampleRate);
    this.primed = !primeOnFirst;
  }

  private static alphaFor(sampleRate: number): number {
    return 1 - (2 * Math.PI * CUTOFF_HZ / sampleRate);
  }

  setSampleRate(sampleRate: number): void {
    this.alpha = DcBlocker.alphaFor(sampleRate);
  }

  process(x: number): number {
    if (!this.primed) {
      this.prev = x;
      this.out = 0;
      this.primed = true;
    }
    this.out = this.alpha * (this.out + x - this.prev);
    this.prev = x;
    return this.out;
  }

  /** The source stopped being sampled (a muted PSG): the next sample re-seeds
   *  the filter rather than stepping against stale history. */
  idle(): void {
    this.primed = !this.primeOnFirst;
    this.prev = 0;
    this.out = 0;
  }

  reset(): void {
    this.idle();
  }
}
