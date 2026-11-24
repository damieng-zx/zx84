import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { AtomMachine } from '../atom-machine.ts';

/** The host key that acts as the Atom's BREAK button (a separate key on the
 *  real keyboard; F12 belongs to the browser, so Pause is the convention). */
export const ATOM_BREAK_HOST_KEY = 'Pause';

export class AtomInputService implements InputService {
  constructor(private readonly machine: AtomMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    if (event.code === ATOM_BREAK_HOST_KEY) {
      this.machine.cancelPaste();
      this.machine.pressBreak();
      return true;
    }
    this.machine.cancelPaste();
    return this.machine.keyboard.handleEvent(event, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    if (event.code === ATOM_BREAK_HOST_KEY) return true;
    return this.machine.keyboard.handleEvent(event, false);
  }

  /** The Atom's own shifted-symbol map (`ATOM_CHAR_KEYS`), which asserts its
   *  own SHIFT line where the symbol needs it. */
  charDown(char: string): boolean {
    this.machine.cancelPaste();
    return this.machine.keyboard.pressChar(char);
  }

  charUp(): void {
    this.machine.keyboard.releaseAll();
  }

  releaseAll(): void {
    this.machine.cancelPaste();
    this.machine.keyboard.releaseAll();
  }

  readonly mouse: MouseSink | null = null;
}
