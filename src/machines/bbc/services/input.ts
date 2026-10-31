import type { HostKeyEvent, InputService, JoystickInput, MouseSink } from '@/machines/machine.ts';
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
    this.machine.releaseJoysticks();
  }

  /** The analogue port: player 1 is ADC channels 0/1 and fire PB4, player 2
   *  channels 2/3 and fire PB5. Keys give full deflection, a gamepad's axes
   *  proportional. The port is fixed, so the interface `mode` is ignored. */
  readonly joystick: JoystickInput = {
    press: (dir, pressed, _mode, player) => this.machine.joystickPress(dir, pressed, player),
    analog: (axis, value, player) => this.machine.joystickAnalog(axis, value, player),
  };

  readonly mouse: MouseSink | null = null;
}
