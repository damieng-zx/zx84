/**
 * LynxInputService — host keys onto the ten-line matrix. No mice, and the
 * joystick interface is a later increment.
 */

import type { HostKeyEvent, InputService } from '@/machines/machine.ts';
import type { LynxMachine } from '../lynx-machine.ts';

export class LynxInputService implements InputService {
  constructor(private readonly m: LynxMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(event.code, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(event.code, false);
  }

  releaseAll(): void { this.m.keyboard.reset(); }

  /** No mouse and no joystick interface fitted (the joystick add-on is a
   *  later increment). */
  readonly mouse = null;
  readonly mice = null;
  readonly joystick = null;
}
