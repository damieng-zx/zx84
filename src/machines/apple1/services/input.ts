import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { Apple1Machine } from '../apple1-machine.ts';

/** Host keys for the two keys that never reach the PIA: RESET and CLEAR SCREEN. */
export const APPLE1_RESET_HOST_KEY = 'Pause';
export const APPLE1_CLEAR_HOST_KEY = 'Home';

export class Apple1InputService implements InputService {
  constructor(private readonly machine: Apple1Machine) {}

  keyDown(event: HostKeyEvent): boolean {
    const kb = this.machine.keyboard;
    if (event.code === APPLE1_RESET_HOST_KEY) {
      kb.track(event.code, true);
      this.machine.pressResetKey();
      return true;
    }
    if (event.code === APPLE1_CLEAR_HOST_KEY) {
      kb.track(event.code, true);
      this.machine.pressClearScreenKey();
      return true;
    }
    return kb.handleEvent(event, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    if (event.code === APPLE1_RESET_HOST_KEY || event.code === APPLE1_CLEAR_HOST_KEY) {
      this.machine.keyboard.track(event.code, false);
      return true;
    }
    return this.machine.keyboard.handleEvent(event, false);
  }

  /** The encoder latches rather than scans, so there is no held key to release. */
  releaseAll(): void {
    this.machine.keyboard.shiftHeld = false;
    this.machine.keyboard.ctrlHeld = false;
  }

  readonly mouse: MouseSink | null = null;
}
