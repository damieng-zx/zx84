import type { HostKeyEvent, InputService, JoystickInput, MouseInput } from '@/machines/machine.ts';
import type { Apple2Machine } from '../apple2-machine.ts';

/** The Mouse pane's one choice: the host mouse standing in for a pair of paddles. */
export const APPLE2_MOUSE_PADDLES = 'apple2-mouse-paddles';

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

  readonly mouse = null;

  /** The captured mouse turns paddles 0 and 1 (left/right is X, up/down is Y)
   *  and its left and right buttons are push buttons 0 and 1. */
  readonly mice: MouseInput = {
    setMode: (mode) => this.machine.paddles.mouseCapture(mode === APPLE2_MOUSE_PADDLES),
    motion: (dx, dy, mode) => {
      if (mode === APPLE2_MOUSE_PADDLES) this.machine.paddles.mouseMotion(dx, dy);
    },
    button: (index, pressed, mode) => {
      if (mode !== APPLE2_MOUSE_PADDLES) return;
      // Left is button 0 and right button 1 (the browser numbers the right button 2).
      if (index === 0) this.machine.paddles.setButton(0, pressed);
      else if (index === 2) this.machine.paddles.setButton(1, pressed);
    },
  };
}
