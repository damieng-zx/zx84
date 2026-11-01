/**
 * Vic20InputService — host keys onto the 8 × 8 matrix (and RESTORE), and a
 * joystick onto the one control port.
 */

import type { HostKeyEvent, InputService, JoystickInput } from '@/machines/machine.ts';
import type { Vic20Machine } from '../vic20-machine.ts';

/** The Joystick pane's one choice: the control port. */
export const VIC20_JOY_PORT = 'vic20-port';

export class Vic20InputService implements InputService {
  readonly mouse = null;
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
  }
}
