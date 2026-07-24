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

  readonly mouse: MouseSink | null = null;
  readonly joystick: JoystickInput = {
    press: (direction, pressed, _mode, player) => {
      this.machine.keyboard.setJoystick(direction, pressed, player);
    },
  };
}
