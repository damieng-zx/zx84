/**
 * PCW InputService — host keyboard delivery.
 *
 * There is no joystick and no mouse on a stock PCW (the AMX and Kempston mice
 * were add-ons on ports &A0-&A2 and &D0-&D4, not fitted here), so both optional
 * surfaces are absent and their panes hide themselves.
 */

import type {
  HostKeyEvent, InputService, JoystickInput, MouseSink,
} from '@/machines/machine.ts';
import type { PcwMachine } from '../pcw-machine.ts';

export class PcwInputService implements InputService {
  constructor(private readonly m: PcwMachine) {}

  /** No joystick port: presses go nowhere. */
  readonly joystick: JoystickInput = { press: () => {} };

  keyDown(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e, true);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e, false);
  }

  releaseAll(): void {
    this.m.keyboard.reset();
  }

  readonly mouse: MouseSink | null = null;
}
