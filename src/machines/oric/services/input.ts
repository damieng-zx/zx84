import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { OricMachine } from '../oric-machine.ts';

/** The host key that acts as the Oric's reset (there is none on the keyboard;
 *  the machine has a reset button). F12 belongs to the browser, so Pause is
 *  the convention the other machines use. */
export const ORIC_RESET_HOST_KEY = 'Pause';

export class OricInputService implements InputService {
  constructor(private readonly machine: OricMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    if (event.code === ORIC_RESET_HOST_KEY) {
      this.machine.cancelPaste();
      this.machine.reset();
      return true;
    }
    this.machine.cancelPaste();
    return this.machine.keyboard.handleEvent(event, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    if (event.code === ORIC_RESET_HOST_KEY) return true;
    return this.machine.keyboard.handleEvent(event, false);
  }

  releaseAll(): void {
    this.machine.cancelPaste();
    this.machine.keyboard.releaseAll();
  }

  readonly mouse: MouseSink | null = null;
}
