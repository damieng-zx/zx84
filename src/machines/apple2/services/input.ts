import type { HostKeyEvent, InputService, JoystickInput, MouseSink } from '@/machines/machine.ts';
import type { Apple2Machine } from '../apple2-machine.ts';

export class Apple2InputService implements InputService {
  constructor(private readonly machine: Apple2Machine) {}

  keyDown(event: HostKeyEvent): boolean {
    return this.machine.keyboard.handleEvent(event, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    return this.machine.keyboard.handleEvent(event, false);
  }

  releaseAll(): void {
    this.machine.keyboard.reset();
    this.machine.paddles.release();
  }

  /** Digital joystick presses drive the paddles to an extreme; a gamepad's
   *  axes set them proportionally. */
  readonly joystick: JoystickInput = {
    press: (dir, pressed, _mode, player) => this.machine.paddles.press(dir, pressed, player),
    analog: (axis, value, player) => this.machine.paddles.analog(axis, value, player),
  };

  readonly mouse: MouseSink | null = null;
}
