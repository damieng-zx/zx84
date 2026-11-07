import type { HostKeyEvent, InputService, JoystickInput, MouseSink } from '@/machines/machine.ts';
import type { ElectronMachine } from '../electron-machine.ts';

export class ElectronInputService implements InputService {
  constructor(private readonly machine: ElectronMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    // The BREAK key has no matrix cell: it resets the CPU. With SHIFT held
    // the OS also boots a disc or cartridge.
    if (event.code === 'Pause' || event.code === 'F12') {
      if (event.shift) this.machine.bootWithShift(); else this.machine.breakReset();
      return true;
    }
    return this.machine.keyboard.handleEvent(event, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    if (event.code === 'Pause' || event.code === 'F12') return true;
    return this.machine.keyboard.handleEvent(event, false);
  }

  releaseAll(): void {
    this.machine.keyboard.reset();
    this.machine.releaseJoysticks();
  }

  private readonly plus1Joystick: JoystickInput = {
    press: (dir, pressed, _mode, player) => this.machine.joystickPress(dir, pressed, player),
    analog: (axis, value, player) => this.machine.joystickAnalog(axis, value, player),
  };

  /** The joystick ports are the Plus 1's: without it there is nowhere to plug
   *  a stick in, so the cursor keys stay the keyboard's. */
  get joystick(): JoystickInput | null {
    return this.machine.plus1Fitted ? this.plus1Joystick : null;
  }

  readonly mouse: MouseSink | null = null;
}
