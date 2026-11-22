/**
 * Joystick peripherals: Kempston hardware + keyboard-mapped modes
 * (Cursor, Sinclair 1 & 2).
 *
 * Keyboard-mapped modes press Spectrum matrix keys that correspond to
 * the joystick directions. The Cursor (AGF/Protek) interface is wired to the
 * 5/6/7/8/0 keys alone: it never presses Caps Shift.
 */

import type { SpectrumKeyboard } from '@/machines/spectrum/keyboard.ts';

/** The narrow slice of the machine `joyPressForType` touches: the Kempston
 *  hardware register and the key matrix. Passing a whole `Spectrum` still
 *  satisfies this structurally, so callers are unchanged. */
export interface JoystickTarget {
  joystick: KempstonJoystick;
  timexJoystick: TimexJoystick;
  keyboard: SpectrumKeyboard;
}

// ── Kempston joystick ────────────────────────────────────────────────────
// Bits: 0=right, 1=left, 2=down, 3=up, 4=fire.
// Port read at (port & 0x00E0) === 0 returns `state`.

export const KEMPSTON_BITS: Record<string, number> = {
  right: 0, left: 1, down: 2, up: 3, fire: 4,
};

export class KempstonJoystick {
  /** Whether a Kempston interface is fitted (selected for either player).
   *  When not, port 0x1F is undriven and reads as the floating bus, so
   *  programs probing for a Kempston do not mistake an idle bus for one. */
  enabled = true;
  /** 8-bit port value read by the Z80 */
  state = 0;

  press(dir: string, pressed: boolean): void {
    const bit = KEMPSTON_BITS[dir];
    if (bit === undefined) return;
    if (pressed) {
      this.state |= (1 << bit);
    } else {
      this.state &= ~(1 << bit);
    }
  }

  reset(): void {
    this.state = 0;
  }
}

// ── Timex 2068 joysticks ──────────────────────────────────────────
// Two Atari-style sticks wired to the AY-3-8912's spare I/O port (register 14).
// A stick reads as one byte, 0 in each bit it holds and 1 in the rest:
// bit 0 up, 1 down, 2 left, 3 right, 7 fire. Address lines A8 and A9 of the
// read choose the left (A8) and right (A9) stick; with both chosen a bit reads 0
// if either holds it, and with neither the port floats high.

export const TIMEX_JOYSTICK_BITS: Record<string, number> = {
  up: 0, down: 1, left: 2, right: 3, fire: 7,
};

/** The joystick-type ids of the 2068's two ports (the `joy-p1` / `joy-p2` setting values). */
export const TIMEX_JOY_LEFT = 'timex-left';
export const TIMEX_JOY_RIGHT = 'timex-right';

export class TimexJoystick {
  /** Held directions of the left (index 0) and right (index 1) stick, one bit per
   *  TIMEX_JOYSTICK_BITS entry (1 = held). */
  readonly held = [0, 0];

  press(port: number, dir: string, pressed: boolean): void {
    const bit = TIMEX_JOYSTICK_BITS[dir];
    if (bit === undefined || (port !== 0 && port !== 1)) return;
    if (pressed) this.held[port] |= 1 << bit;
    else this.held[port] &= ~(1 << bit);
  }

  /** The AY register 14 value for the sticks chosen by A9:A8 (bit 0 left, bit 1 right). */
  read(select: number): number {
    let held = 0;
    if ((select & 1) !== 0) held |= this.held[0];
    if ((select & 2) !== 0) held |= this.held[1];
    return 0xFF & ~held;
  }

  reset(): void {
    this.held[0] = 0;
    this.held[1] = 0;
  }
}

// ── Keyboard-mapped joystick modes ───────────────────────────────────────

export const CURSOR_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 3, bit: 4 },
  down:  { row: 4, bit: 4 },
  up:    { row: 4, bit: 3 },
  right: { row: 4, bit: 2 },
  fire:  { row: 4, bit: 0 },
};

export const SINCLAIR2_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 3, bit: 0 },
  right: { row: 3, bit: 1 },
  down:  { row: 3, bit: 2 },
  up:    { row: 3, bit: 3 },
  fire:  { row: 3, bit: 4 },
};

export const SINCLAIR1_KEYS: Record<string, { row: number; bit: number }> = {
  left:  { row: 4, bit: 4 },
  right: { row: 4, bit: 3 },
  down:  { row: 4, bit: 2 },
  up:    { row: 4, bit: 1 },
  fire:  { row: 4, bit: 0 },
};

export function joyPressForType(target: JoystickTarget, dir: string, pressed: boolean, mode: string): void {
  if (mode === 'none') return;

  if (mode === 'kempston') {
    target.joystick.press(dir, pressed);
  } else if (mode === TIMEX_JOY_LEFT || mode === TIMEX_JOY_RIGHT) {
    target.timexJoystick.press(mode === TIMEX_JOY_LEFT ? 0 : 1, dir, pressed);
  } else {
    const map = mode === 'cursor' ? CURSOR_KEYS
              : mode === 'sinclair2' ? SINCLAIR2_KEYS
              : SINCLAIR1_KEYS;
    const key = map[dir];
    if (key) target.keyboard.setKey(key.row, key.bit, pressed);
  }
}
