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

  /** The Ace's own chord map, keyed by the produced character. */
  charDown(char: string): boolean {
    return this.m.keyboard.handleKeyEvent(char, true, char);
  }

  charUp(char: string): void {
    this.m.keyboard.handleKeyEvent(char, false, char);
  }

  readonly mouse: MouseSink | null = null;
}
