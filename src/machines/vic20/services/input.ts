/**
 * Vic20InputService — host keys onto the 8 × 8 matrix (and RESTORE), a
 * joystick onto the one control port, and the mouse onto a pair of paddles.
 */

import type { HostKeyEvent, InputService, JoystickInput, MouseInput } from '@/machines/machine.ts';
import type { Vic20Machine } from '../vic20-machine.ts';

/** The Joystick pane's one choice: the control port. */
export const VIC20_JOY_PORT = 'vic20-port';

/** The Mouse pane's one choice: the host mouse turning a pair of paddles. */
export const VIC20_MOUSE_PADDLES = 'vic20-paddles';

export class Vic20InputService implements InputService {
  readonly mouse = null;
  /** The captured mouse turns the paddles (left-right is X, up-down Y); its
   *  left button is X's fire button and its right button Y's. */
  readonly mice: MouseInput = {
    setMode: (mode) => this.m.setPaddles(mode === VIC20_MOUSE_PADDLES),
    motion: (dx, dy, mode) => {
      if (mode === VIC20_MOUSE_PADDLES) this.m.turnPaddles(dx, dy);
    },
    button: (index, pressed, mode) => {
      if (mode !== VIC20_MOUSE_PADDLES) return;
      // The browser numbers the right button 2.
      if (index === 0) this.m.setPaddleButton(0, pressed);
      else if (index === 2) this.m.setPaddleButton(1, pressed);
    },
  };
  readonly joystick: JoystickInput = {
    press: (dir: string, pressed: boolean, mode: string) => {
      if (mode === 'none') return;
      this.m.joystickPress(dir, pressed);
    },
  };

  constructor(private readonly m: Vic20Machine) {}

  keyDown(e: HostKeyEvent): boolean { return this.m.keyboard.handleEvent(e, true); }
  keyUp(e: HostKeyEvent): boolean { return this.m.keyboard.handleEvent(e, false); }

  releaseAll(): void {
    this.m.keyboard.reset();
    this.m.releaseJoysticks();
    this.m.setPaddleButton(0, false);
    this.m.setPaddleButton(1, false);
  }
}
