/**
 * Plus4InputService — host keys onto the 8 × 8 matrix, and a joystick onto
 * either control port (both read through the TED's keyboard register).
 */

import type { HostKeyEvent, InputService, JoystickInput } from '@/machines/machine.ts';
import type { Plus4Machine } from '../plus4-machine.ts';

/** The Joystick pane's choices: which control port. */
export const PLUS4_JOY_PORT1 = 'plus4-port1';
export const PLUS4_JOY_PORT2 = 'plus4-port2';

export class Plus4InputService implements InputService {
  readonly mouse = null;
  readonly joystick: JoystickInput = {
    press: (dir: string, pressed: boolean, mode: string, player: number) => {
      if (mode === 'none') return;
      const port = mode === PLUS4_JOY_PORT1 ? 1 : mode === PLUS4_JOY_PORT2 ? 2 : player === 0 ? 1 : 2;
      this.m.joystickPress(dir, pressed, port);
    },
  };

  constructor(private readonly m: Plus4Machine) {}

  keyDown(e: HostKeyEvent): boolean { return this.m.keyboard.handleEvent(e, true); }
  keyUp(e: HostKeyEvent): boolean { return this.m.keyboard.handleEvent(e, false); }

  releaseAll(): void {
    this.m.keyboard.reset();
    this.m.releaseJoysticks();
  }
}
