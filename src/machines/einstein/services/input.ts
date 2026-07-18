/**
 * Einstein InputService — delivers host keyboard events to the AY-scanned
 * keyboard matrix, replacing the shell's per-machine dispatch ladder.
 */

import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';

export class EinsteinInputService implements InputService {
  constructor(private readonly e: EinsteinMachine) {}

  keyDown(e: HostKeyEvent): boolean {
    return this.e.keyboard.handleKeyEvent(e.code, true);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.e.keyboard.handleKeyEvent(e.code, false);
  }

  releaseAll(): void {
    this.e.keyboard.reset();
  }

  readonly mouse: MouseSink | null = null;
}
