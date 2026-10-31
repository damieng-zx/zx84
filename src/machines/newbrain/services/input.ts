/**
 * NewBrain InputService — delivers host keyboard events to the key matrix the
 * COP420 scans. The NewBrain has no mouse or joystick.
 */

import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { NewBrainMachine } from '../newbrain-machine.ts';

export class NewBrainInputService implements InputService {
  constructor(private readonly m: NewBrainMachine) {}

  keyDown(e: HostKeyEvent): boolean { return this.m.keyboard.handleKeyEvent(e.code, true, e.key); }
  keyUp(e: HostKeyEvent): boolean { return this.m.keyboard.handleKeyEvent(e.code, false, e.key); }
  releaseAll(): void { this.m.keyboard.reset(); }

  readonly mouse: MouseSink | null = null;
}
