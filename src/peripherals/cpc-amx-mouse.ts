/**
 * AMX mouse for the Amstrad CPC.
 *
 * Unlike the Spectrum AMX mouse (a Z80-PIO, interrupt-driven device), the CPC
 * AMX plugs into the joystick port and presents itself on keyboard matrix
 * **line 9** — the joystick-0 lines. The hardware contains no motion counters;
 * it just issues a momentary LOW pulse on a direction line for each "mickey" of
 * movement, and holds the button lines LOW while a button is pressed:
 *
 *   line 9, bit 0  up      LOW for 1 mickey when the mouse moves up
 *   line 9, bit 1  down    LOW for 1 mickey when the mouse moves down
 *   line 9, bit 2  left    LOW for 1 mickey when the mouse moves left
 *   line 9, bit 3  right   LOW for 1 mickey when the mouse moves right
 *   line 9, bit 4  fire2   LOW while the Left button is pressed
 *   line 9, bit 5  fire1   LOW while the Right button is pressed
 *   line 9, bit 6  fire3   LOW while the Middle button is pressed
 *
 * Driver software selects line 9, reads it, then *deselects* it; the pulse is
 * consumed on deselect (one mickey per select→read→deselect cycle). Reading line
 * 9 without deselecting returns the same pulse forever — which is exactly why the
 * naive "select once, poll forever" loop documented on CPCWiki does not work. The
 * model here reproduces that: `applyToLine9` drives the pending pulses LOW, and
 * `consumeStep` (called by the keyboard on a 9→other line transition) retires one
 * mickey per direction.
 *
 * Movement is queued by the UI as relative deltas (positive dx = right, positive
 * dy = down) and accumulated as per-direction mickey counts. Reads/deselects then
 * drain them, matching the ~300 mickeys/second the real AMX Art driver polls at.
 */

/**
 * Cap on queued mickeys per direction. The AMX has no motion counters: it emits
 * one LOW pulse per mickey, retired one-per-deselect, and a driver such as AMX
 * Art polls at ~300 Hz — i.e. it can only drain ~6–7 mickeys per direction per
 * 50 Hz frame. Browser pointer events deliver raw pixel deltas an order of
 * magnitude faster than that, so without a tight cap the backlog grows every
 * frame and keeps draining for ~0.7 s *after* the mouse stops — felt as lag.
 *
 * Capping at roughly one frame's drain keeps the pointer responsive (it stops
 * within a frame of the real mouse) at the cost of dropping distance on fast
 * flicks — which is faithful to the genuinely low-resolution AMX hardware.
 */
const MAX_PENDING = 8;

export class CpcAmxMouse {
  enabled = false;

  /** Queued movement mickeys, per direction (each drained one-per-deselect). */
  private up = 0;
  private down = 0;
  private left = 0;
  private right = 0;

  /** Active-low button state for line-9 bits 4–6 (1 = released). */
  private buttons = 0xFF;

  /** DOM button index → active-low line-9 bit: left→4, middle→6, right→5. */
  private static readonly BUTTON_BITS: Record<number, number> = { 0: 4, 1: 6, 2: 5 };

  /** Queue relative movement. dx>0 = right, dy>0 = down (screen coordinates). */
  queueMovement(dx: number, dy: number): void {
    if (dx > 0) this.right = Math.min(this.right + dx, MAX_PENDING);
    else if (dx < 0) this.left = Math.min(this.left - dx, MAX_PENDING);
    if (dy > 0) this.down = Math.min(this.down + dy, MAX_PENDING);
    else if (dy < 0) this.up = Math.min(this.up - dy, MAX_PENDING);
  }

  setButton(button: number, pressed: boolean): void {
    const bit = CpcAmxMouse.BUTTON_BITS[button];
    if (bit === undefined) return;
    if (pressed) this.buttons &= ~(1 << bit) & 0xFF;
    else this.buttons |= (1 << bit);
  }

  /** True while any movement is queued or a button is held — i.e. the device is
   *  driving line 9. Used to bump the MOUSE activity LED. */
  get active(): boolean {
    return this.up > 0 || this.down > 0 || this.left > 0 || this.right > 0 || this.buttons !== 0xFF;
  }

  /**
   * Overlay the AMX state onto a raw line-9 matrix value (active-low): pull the
   * direction bits LOW while a mickey is pending and AND in the held buttons.
   */
  applyToLine9(value: number): number {
    let v = value;
    if (this.up > 0) v &= ~0x01;
    if (this.down > 0) v &= ~0x02;
    if (this.left > 0) v &= ~0x04;
    if (this.right > 0) v &= ~0x08;
    v &= this.buttons;            // bits 4–6 (buttons), 1 elsewhere
    return v & 0xFF;
  }

  /** Retire one mickey per direction — called when line 9 is deselected. */
  consumeStep(): void {
    if (this.up > 0) this.up--;
    if (this.down > 0) this.down--;
    if (this.left > 0) this.left--;
    if (this.right > 0) this.right--;
  }

  reset(): void {
    this.up = this.down = this.left = this.right = 0;
    this.buttons = 0xFF;
    // Note: enabled is not reset — it's a user setting, not machine state.
  }
}
