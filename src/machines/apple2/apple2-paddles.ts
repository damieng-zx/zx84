/**
 * Apple II game port: four paddle inputs and three push buttons.
 *
 * A paddle is a variable resistor charging a 558 timer. Software starts all four
 * timers with an access to $C070, then polls $C064-$C067: bit 7 of each reads 1
 * until its timer expires, and the time it takes is the paddle's position —
 * about 11 CPU cycles per count, which is exactly one pass of the ROM's PREAD
 * loop. A joystick is two paddles (X and Y) with a button each way.
 *
 * With nothing plugged in the inputs are open and the timers run to their
 * limit, so a program reads full scale (255) and no button is ever down.
 */

/** Cycles for a paddle timer at position 0, and per count above it. */
const BASE_CYCLES = 25;
const CYCLES_PER_COUNT = 11;
/** An unplugged input charges for as long as a full-scale paddle does. */
const OPEN_CYCLES = BASE_CYCLES + CYCLES_PER_COUNT * 256;

export class Apple2Paddles {
  /** Whether a joystick or paddles are plugged into the game port. */
  fitted = true;

  /** Position of each paddle, 0-255 (127 is centred). */
  private readonly position = [127, 127, 127, 127];
  private readonly buttons = [false, false, false];
  /** Direction state per joystick (up, down, left, right). */
  private readonly dirs = [
    { up: false, down: false, left: false, right: false },
    { up: false, down: false, left: false, right: false },
  ];
  private triggeredAt = 0;

  setPosition(paddle: number, value: number): void {
    this.position[paddle & 3] = Math.max(0, Math.min(255, Math.round(value)));
  }

  setButton(index: number, down: boolean): void {
    if (index >= 0 && index < this.buttons.length) this.buttons[index] = down;
  }

  /** Whether push button `n` (0-2) is held. */
  button(n: number): boolean {
    return this.fitted && (this.buttons[n] ?? false);
  }

  /** $C070: restart the timers. */
  trigger(now: number): void { this.triggeredAt = now; }

  /** Bit 7 of $C064+`paddle`: true while its timer is still running. */
  timerHigh(paddle: number, now: number): boolean {
    const elapsed = now - this.triggeredAt;
    if (elapsed < 0) return false;                       // the clock was reset under us
    const limit = this.fitted
      ? BASE_CYCLES + CYCLES_PER_COUNT * this.position[paddle & 3]
      : OPEN_CYCLES;
    return elapsed < limit;
  }

  /**
   * A digital joystick press: a direction drives its axis to an extreme, and
   * letting go (or opposing directions) centres it again. Player 1 is paddles
   * 0/1 with button 0; player 2 is paddles 2/3 with button 1. A second fire key
   * presses the next button along.
   */
  press(dir: string, pressed: boolean, player: number): void {
    const p = player === 1 ? 1 : 0;
    if (dir === 'fire') { this.setButton(p, pressed); return; }
    if (dir === 'fire2') { this.setButton(p + 1, pressed); return; }
    const d = this.dirs[p];
    if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') return;
    d[dir] = pressed;
    this.setPosition(p * 2, d.right === d.left ? 127 : d.right ? 255 : 0);
    this.setPosition(p * 2 + 1, d.down === d.up ? 127 : d.down ? 255 : 0);
  }

  reset(): void {
    this.position.fill(127);
    this.buttons.fill(false);
    for (const d of this.dirs) { d.up = d.down = d.left = d.right = false; }
    this.triggeredAt = 0;
  }
}
