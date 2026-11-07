/**
 * C64InputService — host keys onto the 8 × 8 matrix (and RESTORE), the
 * joysticks onto the two control ports, and a 1351 mouse in either. Each player's joystick type is the
 * port it is plugged into.
 */

import type { HostKeyEvent, InputService, JoystickInput, MouseInput } from '@/machines/machine.ts';
import type { C64Machine } from '../c64-machine.ts';

/** Joystick type ids (the Joystick pane's choices): which control port. */
export const C64_JOY_PORT2 = 'c64-port2';
export const C64_JOY_PORT1 = 'c64-port1';

/** Mouse type ids (the Mouse pane's choices): a 1351 in a control port. */
export const C64_MOUSE_PORT1 = 'c64-1351-port1';
export const C64_MOUSE_PORT2 = 'c64-1351-port2';

export class C64InputService implements InputService {
  readonly mouse = null;
  readonly mice: MouseInput = {
    setMode: (mode) => {
      this.m.setMousePort(mode === C64_MOUSE_PORT1 ? 1 : mode === C64_MOUSE_PORT2 ? 2 : 0);
    },
    motion: (dx, dy, mode) => {
      if (mode === C64_MOUSE_PORT1 || mode === C64_MOUSE_PORT2) this.m.moveMouse(dx, dy);
    },
    button: (index, pressed, mode) => {
      if (mode === C64_MOUSE_PORT1 || mode === C64_MOUSE_PORT2) this.m.setMouseButton(index, pressed);
    },
  };
  readonly joystick: JoystickInput = {
    // Any other type (the shared setting can still hold the Spectrum's
    // Kempston) is the player's own port: player 1 in port 1, player 2 in 2.
    press: (dir: string, pressed: boolean, mode: string, player: number) => {
      if (mode === 'none') return;
      const port = mode === C64_JOY_PORT1 ? 1 : mode === C64_JOY_PORT2 ? 2 : player === 0 ? 1 : 2;
      this.m.joystickPress(dir, pressed, port);
    },
  };

  constructor(private readonly m: C64Machine) {}

  keyDown(e: HostKeyEvent): boolean { return this.m.keyboard.handleEvent(e, true); }
  keyUp(e: HostKeyEvent): boolean { return this.m.keyboard.handleEvent(e, false); }

  releaseAll(): void {
    this.m.keyboard.reset();
    this.m.releaseJoysticks();
  }
}
