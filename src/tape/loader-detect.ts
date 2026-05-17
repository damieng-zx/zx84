/**
 * Tape loader detection — auto-start AND auto-stop tape playback by
 * watching the shape of port-0xFE reads.
 *
 * The detector is a pure state machine: callers pass each port-read event
 * plus the current tape-playing state and receive a 'start' / 'stop' /
 * null event. The caller decides what to do with it (zx84 wires this in
 * src/io-ports.ts).
 *
 * Why edge-detection loops are visible to us:
 *   Custom loaders (Speedlock, Bleepload, Alkatraz, etc.) poll port 0xFE
 *   in a tight loop, using the B register as a timeout counter that
 *   increments or decrements on every iteration. The signature is:
 *     - successive IN reads spaced a few hundred T-states apart
 *     - B register changes by 0 or ±1 between reads
 *   Keyboard polling does not match this — it touches B differently and
 *   has much wider gaps.
 *
 * Auto-start: while paused, 10 successive reads matching the signature
 * within START_GAP T-states each flip the tape to playing.
 *
 * Auto-stop: while playing, 2 successive reads that DON'T match the
 * signature (gap too large OR B-delta outside the tight range) flip the
 * tape back to paused. The stop hysteresis is small because real loaders
 * never break the pattern mid-byte — once we see two off-pattern reads,
 * the loader has either finished or moved into post-load processing.
 *
 * History note: an earlier version of this file detected start only and
 * relied on a per-frame idle cooldown in spectrum.ts to detect stop. That
 * cooldown is ~500 ms slow; this state machine reacts within microseconds
 * for the common case where the loader keeps polling after finishing.
 * The cooldown is kept as a fallback for the case where port activity
 * stops entirely (the detector needs at least one more read to fire).
 *
 * Algorithm is inspired by Fuse's loader.c (Philip Kendall, GPL-2.0) but
 * the implementation is original — different API (event return vs direct
 * tape control), different state layout, different naming. The shared
 * elements are functional facts about Spectrum loader behaviour (the
 * tight-loop signature and the choice of thresholds), not copyrightable
 * expression.
 */

/** Max T-states between reads to count as a tight start-loop iteration */
const START_GAP = 500;
/** Successive matching reads to trigger auto-start */
const START_THRESHOLD = 10;

/** T-state gap above which a read is considered "loader has moved on" */
const STOP_GAP = 1000;
/** Successive non-matching reads while playing to trigger auto-stop */
const STOP_THRESHOLD = 2;

/** Sentinel timestamp meaning "no previous read" (forces gap to overflow) */
const NO_PREVIOUS = -100000;

export type LoaderEvent = 'start' | 'stop' | null;

export class LoaderDetector {
  /** T-states of last port 0xFE read */
  private lastT = NO_PREVIOUS;
  /** B register value at last read */
  private lastB = 0;
  /** Count of consecutive reads matching whichever direction we're tracking */
  private successive = 0;

  /**
   * Called on each IN from port 0xFE.
   *
   * @param tstates  current CPU T-state counter
   * @param bReg     current B register value
   * @param playing  true if tape is actively playing (not paused/stopped).
   *                 The detector watches for stop signals while playing
   *                 and start signals while not.
   * @returns 'start' / 'stop' to request a state change, or null.
   */
  onPortRead(tstates: number, bReg: number, playing: boolean): LoaderEvent {
    // First read after construction/reset has no previous to compare to —
    // record it and bail. Otherwise the huge sentinel gap would
    // immediately tick the auto-stop counter on the first read while
    // playing, firing stop spuriously after just one more read.
    if (this.lastT === NO_PREVIOUS) {
      this.lastT = tstates;
      this.lastB = bReg;
      return null;
    }

    const gap = tstates - this.lastT;
    const bDelta = bReg - this.lastB;
    this.lastT = tstates;
    this.lastB = bReg;

    // Loader signature: B counter ticks by 0 or ±1 and the loop is tight.
    const tightDelta = bDelta === 0 || bDelta === 1 || bDelta === -1;
    const tightGap = gap <= START_GAP;

    if (!playing) {
      // Looking for an auto-start.
      if (tightGap && tightDelta) {
        if (++this.successive >= START_THRESHOLD) {
          this.successive = 0;
          return 'start';
        }
      } else {
        this.successive = 0;
      }
      return null;
    }

    // Playing — looking for an auto-stop. The stop predicate is wider
    // (uses STOP_GAP > START_GAP) so brief CPU stalls during loading don't
    // pause the tape mid-byte.
    if (gap > STOP_GAP || !tightDelta) {
      if (++this.successive >= STOP_THRESHOLD) {
        this.successive = 0;
        return 'stop';
      }
    } else {
      this.successive = 0;
    }
    return null;
  }

  /**
   * Called at frame end so the next frame's first read still computes a
   * sensible gap against the previous frame's last read.
   */
  onFrameEnd(frameLength: number): void {
    this.lastT -= frameLength;
  }

  /** Reset — called on tape play/stop/rewind/insert and on machine reset */
  reset(): void {
    this.lastT = NO_PREVIOUS;
    this.lastB = 0;
    this.successive = 0;
  }
}
