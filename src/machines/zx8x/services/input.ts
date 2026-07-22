import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { Zx8xMachine } from '../zx8x-machine.ts';

export class Zx8xInputService implements InputService {
  constructor(private readonly machine: Zx8xMachine) {}
  keyDown(e: HostKeyEvent): boolean { return this.machine.keyboard.handleKeyEvent(e.code, true); }
  keyUp(e: HostKeyEvent): boolean { return this.machine.keyboard.handleKeyEvent(e.code, false); }
  releaseAll(): void { this.machine.keyboard.reset(); }
  readonly mouse: MouseSink | null = null;
}
