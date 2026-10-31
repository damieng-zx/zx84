/**
 * PCW InputService — host keyboard and joystick delivery.
 *
 * A stock PCW has no joystick port; the joystick reaches the add-on interface
 * the Joystick pane fits (Kempston, Spectravideo or Cascade — see
 * pcw-joystick.ts). There is no mouse (the AMX and Kempston mice were add-ons
 * on ports &A0-&A2 and &D0-&D4, not fitted here), so its pane hides itself.
 */

import type {
  HostKeyEvent, InputService, JoystickInput, MouseSink,
} from '@/machines/machine.ts';
import type { PcwMachine } from '../pcw-machine.ts';

export class PcwInputService implements InputService {
  constructor(private readonly m: PcwMachine) {}

  /** One joystick, on whichever interface is fitted; `mode` is that
   *  interface, which the machine already holds from its settings. */
  readonly joystick: JoystickInput = {
    press: (dir, pressed, _mode, player) => { if (player === 0) this.m.joystick.press(dir, pressed); },
  };

  keyDown(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e, true);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e, false);
  }

  releaseAll(): void {
    this.m.keyboard.reset();
    this.m.joystick.release();
  }

  readonly mouse: MouseSink | null = null;
}
