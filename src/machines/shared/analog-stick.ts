/**
 * Host joystick state for a machine whose joystick is analogue (an ADC or a
 * paddle timer rather than four switches).
 *
 * Two sources drive each axis: digital presses (keys, the on-screen pad, a
 * D-pad), where a held direction is full deflection, and a gamepad's analogue
 * axis, which is proportional. Whichever moved last owns the axis — the input
 * controller never drives one axis from both at once (see
 * `JoystickInput.analog`). Positions are in the host's terms: -1 is full
 * left / up, +1 full right / down, 0 centred. Each machine converts them to
 * its own scale and direction.
 */

import type { StateReader, StateWriter } from './state-io.ts';

export type StickDir = 'up' | 'down' | 'left' | 'right';

interface PlayerStick {
  up: boolean; down: boolean; left: boolean; right: boolean;
  x: number; y: number;
}

export class AnalogSticks {
  private readonly sticks: PlayerStick[];

  constructor(players = 2) {
    this.sticks = Array.from({ length: players }, () => ({
      up: false, down: false, left: false, right: false, x: 0, y: 0,
    }));
  }

  /** A digital direction changed. Returns false for anything that is not a
   *  direction (fire buttons are the machine's own business). */
  press(dir: string, pressed: boolean, player: number): boolean {
    const s = this.sticks[player];
    if (!s) return false;
    if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') return false;
    s[dir] = pressed;
    // Opposing directions held together cancel, as on a real stick's switches.
    if (dir === 'left' || dir === 'right') s.x = s.left === s.right ? 0 : s.right ? 1 : -1;
    else s.y = s.up === s.down ? 0 : s.down ? 1 : -1;
    return true;
  }

  /** A proportional axis position, clamped to -1 … +1. */
  analog(axis: 'x' | 'y', value: number, player: number): void {
    const s = this.sticks[player];
    if (!s) return;
    s[axis] = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  }

  x(player: number): number { return this.sticks[player]?.x ?? 0; }
  y(player: number): number { return this.sticks[player]?.y ?? 0; }

  reset(): void {
    for (const s of this.sticks) {
      s.up = s.down = s.left = s.right = false;
      s.x = s.y = 0;
    }
  }

  /** Snapshot: each stick's held directions and position. */
  saveState(w: StateWriter): void {
    w.u8(this.sticks.length);
    for (const s of this.sticks) {
      w.bool(s.up); w.bool(s.down); w.bool(s.left); w.bool(s.right);
      w.f64(s.x); w.f64(s.y);
    }
  }

  loadState(r: StateReader): void {
    const n = r.u8();
    if (n !== this.sticks.length) throw new Error('Snapshot is corrupt (joysticks)');
    for (const s of this.sticks) {
      s.up = r.bool(); s.down = r.bool(); s.left = r.bool(); s.right = r.bool();
      s.x = r.f64(); s.y = r.f64();
    }
  }
}

/**
 * Scale a host position (-1 … +1) onto an ADC range `0 … max`. With
 * `highAtNegative` the left/up end reads `max` (the BBC Micro's and the
 * Electron's sticks); otherwise the left/up end reads 0. Centre is the
 * rounded midpoint.
 */
export function axisToRange(v: number, max: number, highAtNegative: boolean): number {
  const t = highAtNegative ? (1 - v) / 2 : (1 + v) / 2;
  return Math.max(0, Math.min(max, Math.round(t * max)));
}
