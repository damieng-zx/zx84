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
 *
 * Paddle 0 / joystick X reads 0 turned fully left (anticlockwise) and 255
 * fully right; joystick Y reads 0 at full up and 255 at full down (Apple II
 * Reference Manual, "The Game I/O Connector"; PREAD at $FB1E).
 *
 * The connector also carries four annunciator outputs, AN0-AN3: TTL latches
 * that an access to $C058-$C05F turns off (even address) or on (odd), two
 * addresses per output. Nothing here is driven by them, but their state is
 * kept so it can be read.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/**
 * A paddle timer's length is a few cycles plus 11 per count of position, so
 * that the ROM's PREAD returns the position itself: PREAD triggers the timers,
 * takes its first sample 10 cycles later and one more every 11 (a pass of its
 * loop), counting the samples that still see bit 7 high. A timer of 11·p + 8
 * cycles is seen high by exactly p samples, so position 0 reads 0 and 255
 * reads 255, the 0-255 range the Reference Manual gives for PDL and PREAD.
 */
const BASE_CYCLES = 8;
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
  /** Annunciator outputs AN0-AN3 (true = on, the output high). */
  readonly annunciators = [false, false, false, false];

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

  /** An access to $C058-$C05F: even addresses turn an annunciator off, odd
   *  ones on ($C058/9 AN0, $C05A/B AN1, $C05C/D AN2, $C05E/F AN3). */
  annunciator(off: number): void {
    this.annunciators[((off - 0x58) >> 1) & 3] = (off & 1) === 1;
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

  /**
   * A gamepad axis, proportional: -1 (full left / up) … +1 (full right /
   * down) onto 0-255. Player 1's stick is paddles 0 (X) and 1 (Y), player 2's
   * paddles 2 and 3.
   */
  analog(axis: 'x' | 'y', value: number, player: number): void {
    const p = player === 1 ? 1 : 0;
    const v = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
    this.setPosition(p * 2 + (axis === 'y' ? 1 : 0), ((v + 1) / 2) * 255);
  }

  /** Machine reset: the timers and annunciator latches. Where the host holds
   *  the sticks is the host's business, so a held stick stays held. */
  reset(): void {
    this.annunciators.fill(false);
    this.triggeredAt = 0;
  }

  /** Let go of every stick and button (window blur). */
  release(): void {
    this.position.fill(127);
    this.buttons.fill(false);
    for (const d of this.dirs) { d.up = d.down = d.left = d.right = false; }
  }

  /** Snapshot: when the timers were last started, the annunciator latches,
   *  and where the sticks and buttons are held. */
  saveState(w: StateWriter): void {
    w.f64(this.triggeredAt);
    for (const on of this.annunciators) w.bool(on);
    for (const p of this.position) w.u8(p);
    for (const b of this.buttons) w.bool(b);
    for (const d of this.dirs) { w.bool(d.up); w.bool(d.down); w.bool(d.left); w.bool(d.right); }
  }

  loadState(r: StateReader): void {
    this.triggeredAt = r.f64();
    for (let i = 0; i < this.annunciators.length; i++) this.annunciators[i] = r.bool();
    for (let i = 0; i < this.position.length; i++) this.position[i] = r.u8();
    for (let i = 0; i < this.buttons.length; i++) this.buttons[i] = r.bool();
    for (const d of this.dirs) { d.up = r.bool(); d.down = r.bool(); d.left = r.bool(); d.right = r.bool(); }
  }
}
