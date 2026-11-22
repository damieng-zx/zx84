import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { AcornSystemMachine } from '../machine.ts';

/** The parallel ASCII keyboard is the only input device. */
export class AcornSystemInputService implements InputService {
  constructor(private readonly machine: AcornSystemMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    return this.machine.keyboard.handleEvent(event, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    return this.machine.keyboard.handleEvent(event, false);
  }

  /** Window blur: no key is down any more. */
  releaseAll(): void {
    this.machine.keyboard.reset();
  }

  readonly mouse: MouseSink | null = null;
}
