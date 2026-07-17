/**
 * Tape auto play/stop detector.
 *
 * Sniffs the cadence of IN A,(0xFE) reads to decide when to auto-start and
 * auto-stop tape playback, and exposes `loaderActive` so the machine can engage
 * tape turbo for the duration of a load.
 *
 * It NEVER executes code, traps, patches ROM, or synthesises loader state — it
 * only decides *when* the tape runs. (The previous fingerprint-based edge
 * accelerator was removed entirely: forging a loader's exit state from a guessed
 * edge length was inherently loader-specific and corrupted whatever titles it
 * guessed wrong. Acceleration is now purely "run the real code faster" — the
 * ROM fast-load trap for standard blocks, and turbo while loading for the rest.)
 */

/** A read with gap ≤ this and an in-shape B-delta counts as loader polling. */
const START_GAP_T = 500;
/** Gap > this (with an out-of-shape B-delta) counts as "the loader has moved
 *  on". Deliberately lenient so loaders that do heavy per-byte work between
 *  reads (checksums, decryption) don't auto-stop mid-load. */
const STOP_GAP_T = 2000;
/** Consecutive in-shape reads (while stopped) before auto-start. */
const START_THRESHOLD = 10;
/** Consecutive out-of-shape reads (while playing) before auto-stop. */
const STOP_THRESHOLD = 4;
const NO_PREV = -1_000_000;

/** Frames of no loader-shaped polling after which `loaderActive` decays — for
 *  programs that finish and simply stop touching the ULA (so auto-stop, which
 *  needs ongoing out-of-shape reads, never fires). */
const IDLE_FRAMES_TO_STOP = 25;
/** Tighter idle threshold once AY music is playing: the game has taken over. */
const AY_IDLE_FRAMES = 3;

/** Minimal CPU surface the detector reads (tStates + B). */
export interface LoaderDetectorCpu { tStates: number; b: number; }

export class LoaderDetector {
  /** True while a loader is actively polling the tape — used to engage tape
   *  turbo for the load's duration. */
  loaderActive = false;

  /** When true, auto-start is suppressed so a post-load game whose keyboard
   *  polling looks loader-shaped can't yank the tape back on. Cleared by
   *  reset() and by the user manually pressing play. */
  userOverride = false;

  private lastTStatesRead = NO_PREV;
  private lastBRead = 0;
  private successiveReads = 0;
  private sawLoaderPollThisFrame = false;
  private idleFrames = 0;

  /**
   * Called on every IN A,(0xFE). Returns 'start' / 'stop' to ask the caller to
   * change tape playback state, or null.
   */
  onULARead(cpu: LoaderDetectorCpu, playing: boolean): 'start' | 'stop' | null {
    const t = cpu.tStates;
    const b = cpu.b;

    if (this.lastTStatesRead === NO_PREV) {
      this.lastTStatesRead = t;
      this.lastBRead = b;
      return null;
    }

    const tDiff = t - this.lastTStatesRead;
    const bDiff = (b - this.lastBRead) & 0xFF;
    this.lastTStatesRead = t;
    this.lastBRead = b;

    let event: 'start' | 'stop' | null = null;

    if (playing) {
      // Watching for the loader to have finished polling. Require BOTH a wide
      // T-state gap AND an unexpected B-delta — either alone false-positives
      // during normal ROM data sampling (the 48K ROM reloads B,$B0 between
      // bits, so the first IN of each new bit shows a wild bDiff).
      const outOfShape = tDiff > STOP_GAP_T && (bDiff !== 0 && bDiff !== 1 && bDiff !== 0xFF);
      if (outOfShape) {
        if (++this.successiveReads >= STOP_THRESHOLD) {
          this.successiveReads = 0;
          this.loaderActive = false;
          event = 'stop';
        }
      } else {
        this.successiveReads = 0;
        // Tape may have been started by another path (ROM trap, user pressing
        // Play) without a 'start' event, leaving loaderActive false. Mark it
        // active on any in-shape read while playing so turbo engages.
        if (tDiff <= START_GAP_T && (bDiff === 1 || bDiff === 0xFF)) {
          this.loaderActive = true;
          this.sawLoaderPollThisFrame = true;
        }
      }
    } else if (this.userOverride) {
      this.successiveReads = 0;
    } else {
      // Watching for the loader to have started polling.
      const inShape = tDiff <= START_GAP_T && (bDiff === 1 || bDiff === 0xFF);
      if (inShape) {
        this.sawLoaderPollThisFrame = true;
        if (++this.successiveReads >= START_THRESHOLD) {
          this.successiveReads = 0;
          this.loaderActive = true;
          event = 'start';
        }
      } else {
        this.successiveReads = 0;
      }
    }

    return event;
  }

  /** Slide lastTStatesRead across the frame boundary, and decay loaderActive
   *  once loader-shaped polling stops. `ayActive` means AY music this frame —
   *  the game has taken over, so release faster. */
  onFrameEnd(frameTstates: number, ayActive = false): void {
    if (this.lastTStatesRead !== NO_PREV) {
      this.lastTStatesRead -= frameTstates;
    }
    if (this.loaderActive) {
      if (this.sawLoaderPollThisFrame) {
        this.idleFrames = 0;
      } else if (++this.idleFrames >= (ayActive ? AY_IDLE_FRAMES : IDLE_FRAMES_TO_STOP)) {
        this.loaderActive = false;
        this.idleFrames = 0;
      }
    } else {
      this.idleFrames = 0;
    }
    this.sawLoaderPollThisFrame = false;
  }

  /** Called when the tape transitions between play and stop. */
  onTapePlayStateChange(): void {
    this.successiveReads = 0;
    this.idleFrames = 0;
  }

  /** Full reset — machine reset, tape eject, etc. */
  reset(): void {
    this.lastTStatesRead = NO_PREV;
    this.lastBRead = 0;
    this.successiveReads = 0;
    this.sawLoaderPollThisFrame = false;
    this.idleFrames = 0;
    this.loaderActive = false;
    this.userOverride = false;
  }
}
