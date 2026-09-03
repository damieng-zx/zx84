/**
 * SAM InputService — host keyboard and joystick delivery.
 *
 * The SAM presents a single fixed joystick interface (Kempston on port 0x1F),
 * so `descriptor.ui.fixedJoystick` is true and the mode argument is ignored.
 * No mouse is fitted in this build.
 */

import type {
  HostKeyEvent, InputService, JoystickInput, MouseSink,
} from '@/machines/machine.ts';
import type { SamMachine } from '../sam-machine.ts';

export class SamInputService implements InputService {
  constructor(private readonly m: SamMachine) {}

  /** Kempston only, so the mode and player arguments carry no meaning here. */
  readonly joystick: JoystickInput = {
    press: (dir, pressed) => this.m.joystick.set(dir, pressed),
  };

  keyDown(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e, true);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e, false);
  }

  releaseAll(): void {
    this.m.keyboard.reset();
    this.m.joystick.reset();
  }

  readonly mouse: MouseSink | null = null;
}
