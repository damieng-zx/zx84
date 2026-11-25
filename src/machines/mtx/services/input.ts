import type {
  HostKeyEvent, InputService, JoystickInput, MouseSink,
} from '@/machines/machine.ts';
import type { MtxMachine } from '../mtx-machine.ts';

export class MtxInputService implements InputService {
  constructor(private readonly machine: MtxMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    return this.machine.keyboard.handleEvent(event, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    return this.machine.keyboard.handleEvent(event, false);
  }

  releaseAll(): void {
    this.machine.keyboard.reset();
  }

  /** The MTX legend, derived from the character itself. */
  charDown(char: string): boolean {
    return this.machine.keyboard.handleEvent({ code: '', key: char, shift: false, ctrl: false, alt: false }, true);
  }

  charUp(char: string): void {
    this.machine.keyboard.handleEvent({ code: '', key: char, shift: false, ctrl: false, alt: false }, false);
  }

  readonly mouse: MouseSink | null = null;
  readonly joystick: JoystickInput = {
    press: (direction, pressed, _mode, player) => {
      this.machine.keyboard.setJoystick(direction, pressed, player);
    },
  };
}
