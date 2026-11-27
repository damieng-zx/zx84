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

  /** The parallel ASCII keyboard takes the character's own code. */
  charDown(char: string): boolean {
    return this.machine.keyboard.handleEvent({ code: '', key: char, shift: false, ctrl: false, alt: false }, true);
  }

  charUp(char: string): void {
    this.machine.keyboard.handleEvent({ code: '', key: char, shift: false, ctrl: false, alt: false }, false);
  }

  readonly mouse: MouseSink | null = null;
}
