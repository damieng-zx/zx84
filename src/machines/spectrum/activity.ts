/**
 * Per-frame I/O activity counters for the Spectrum.
 *
 * Lives in its own neutral module (rather than inside `spectrum.ts`) so that
 * Spectrum peripherals which report activity — e.g. the AMX mouse — can share
 * the type without importing the whole machine class. Spectrum-scoped either
 * way; the point is peripherals don't reach back up into the machine module.
 */
export class IOActivity {
  /** Number of ULA port reads this frame (keyboard / tape) */
  ulaReads = 0;
  /** Number of Kempston joystick port reads this frame */
  kempstonReads = 0;
  /** Whether the beeper bit toggled this frame */
  beeperToggled = false;
  /** Number of AY register writes this frame */
  ayWrites = 0;
  /** Number of LD-BYTES (0x0556) calls this frame */
  tapeLoads = 0;
  /** Number of FDC data port accesses this frame */
  fdcAccesses = 0;
  /** Number of ULA reads while tape is active (EAR sampling) with port high
   *  byte 0xFF — the standard ROM loader's `IN A,(0xFE)` (A=0xFF). Drives the
   *  EAR LED. */
  earReads = 0;
  /** Number of ULA reads while the tape is playing, for ANY port high byte.
   *  Superset of earReads: custom loaders poll with A=0x7F/0xBF/etc., which
   *  earReads misses. Used to engage tape turbo for custom/musical loaders
   *  independent of loader-shape recognition. */
  tapePolls = 0;
  /** Set when LoaderDetector fires 'start' this frame — used to engage tape turbo */
  loaderDetected = false;
  /** Number of attribute-area (5800-5AFF) writes this frame */
  attrWrites = 0;
  /** Number of Kempston mouse port reads this frame */
  mouseReads = 0;

  reset(): void {
    this.ulaReads = 0;
    this.kempstonReads = 0;
    this.beeperToggled = false;
    this.ayWrites = 0;
    this.tapeLoads = 0;
    this.fdcAccesses = 0;
    this.earReads = 0;
    this.tapePolls = 0;
    this.loaderDetected = false;
    this.attrWrites = 0;
    this.mouseReads = 0;
  }
}
