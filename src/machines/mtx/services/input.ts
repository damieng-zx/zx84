import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { MtxMachine } from '../mtx-machine.ts';

export class MtxInputService implements InputService {
  constructor(private readonly machine: MtxMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    return this.machine.keyboard.handleKeyEvent(event.code, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    return this.machine.keyboard.handleKeyEvent(event.code, false);
  }

  releaseAll(): void {
    this.machine.keyboard.reset();
  }

  readonly mouse: MouseSink | null = null;
  readonly joystick = null;
}
