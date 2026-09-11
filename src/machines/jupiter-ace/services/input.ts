/**
 * Ace InputService — delivers host keyboard events to the Ace keyboard matrix.
 * The Ace has no mouse or joystick hardware.
 */

import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { JupiterAceMachine } from '../ace-machine.ts';

export class AceInputService implements InputService {
  constructor(private readonly m: JupiterAceMachine) {}

  keyDown(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e.code, true, e.key);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e.code, false, e.key);
  }

  releaseAll(): void { this.m.keyboard.reset(); }

  readonly mouse: MouseSink | null = null;
}
