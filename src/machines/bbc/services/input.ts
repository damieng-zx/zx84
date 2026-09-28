import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { BbcMachine } from '../bbc-machine.ts';

export class BbcInputService implements InputService {
  constructor(private readonly machine: BbcMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    const handled = this.machine.keyboard.handleEvent(event, true);
    if (handled) this.machine.keyboardActivity();
    return handled;
  }

  keyUp(event: HostKeyEvent): boolean {
    const handled = this.machine.keyboard.handleEvent(event, false);
    if (handled) this.machine.keyboardActivity();
    return handled;
  }

  releaseAll(): void {
    this.machine.keyboard.reset();
  }

  readonly mouse: MouseSink | null = null;
}
