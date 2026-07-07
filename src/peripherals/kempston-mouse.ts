/**
 * Kempston mouse peripheral — shared by the Spectrum and the CPC. The class is
 * just the two 8-bit wrapping position counters plus an active-low button byte;
 * the port decoding (and which interface ports map to X/Y/buttons) lives in the
 * per-machine I/O layer, because the two machines decode different addresses:
 *
 *   Spectrum: 0xFBDF → X, 0xFFDF → Y, 0xFADF → buttons
 *   CPC:      0xFBEE → X, 0xFBEF → Y, 0xFAEF → buttons
 *
 * The button *bit* layout can also differ (the CPC has no middle button),
 * so the active-low mapping is supplied per machine via the constructor.
 */

/** DOM button index → active-low byte bit. Spectrum hardware (WoS FAQ ports
 *  reference, matched by FUSE): D0 = right, D1 = left, D2 = middle. */
const SPECTRUM_BUTTON_BITS: Record<number, number> = { 0: 1, 1: 2, 2: 0 };

export class KempstonMouse {
  x = 0;
  y = 0;
  /** Active-low: all bits set = all released */
  buttons = 0xFF;
  enabled = false;

  /** DOM-button-index → byte-bit map (active-low). Defaults to the Spectrum. */
  private readonly buttonBits: Record<number, number>;

  constructor(buttonBits: Record<number, number> = SPECTRUM_BUTTON_BITS) {
    this.buttonBits = buttonBits;
  }

  updatePosition(dx: number, dy: number): void {
    this.x = (this.x + dx) & 0xFF;
    this.y = (this.y + dy) & 0xFF;
  }

  setButton(button: number, pressed: boolean): void {
    const bit = this.buttonBits[button];
    if (bit === undefined) return;
    if (pressed) {
      this.buttons &= ~(1 << bit);
    } else {
      this.buttons |= (1 << bit);
    }
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
    this.buttons = 0xFF;
    // Note: enabled is not reset — it's a user setting, not machine state
  }
}
