/**
 * Kempston joystick on port 0x1F.
 *
 * The SAM carries the same Kempston-compatible interface the Spectrum world
 * standardised on: one active-high bit per direction plus fire, presented on
 * the bus inverted, so an idle stick reads 0xFF.
 */

/** Bit positions within the Kempston byte. */
const BITS: Record<string, number> = {
  right: 0,
  left: 1,
  down: 2,
  up: 3,
  fire: 4,
};

export class SamJoystick {
  /** Set bits are pressed directions; the read inverts them. */
  private mask = 0;

  reset(): void { this.mask = 0; }

  /** Press or release one direction ('up'/'down'/'left'/'right'/'fire'). */
  set(dir: string, pressed: boolean): void {
    const bit = BITS[dir];
    if (bit === undefined) return;
    if (pressed) this.mask |= (1 << bit);
    else this.mask &= ~(1 << bit);
  }

  /** Port 0x1F: idle reads 0xFF, a pressed direction pulls its bit low. */
  read(): number { return (0xFF & ~this.mask) & 0xFF; }

  get anyPressed(): boolean { return this.mask !== 0; }
}
