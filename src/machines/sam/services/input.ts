/**
 * SAM InputService — host keyboard, joystick and mouse delivery.
 *
 * The SAM presents a single fixed joystick interface (Kempston on port 0x1F),
 * so `descriptor.ui.fixedJoystick` is true and the mode argument is ignored.
 * It also presents exactly one mouse — the MGT interface on the DIN port — so
 * the mode argument of `mice` carries no meaning either; it exists because
 * machines with two mice (the Spectrum's Kempston and AMX) need it.
 */

import type {
  HostKeyEvent, InputService, JoystickInput, MouseInput, MouseSink,
} from '@/machines/machine.ts';
import type { SamMachine } from '../sam-machine.ts';

export class SamInputService implements InputService {
  constructor(private readonly m: SamMachine) {}

  /** Kempston only, so the mode and player arguments carry no meaning here. */
  readonly joystick: JoystickInput = {
    press: (dir, pressed) => this.m.joystick.set(dir, pressed),
  };

  keyDown(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e, true);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e, false);
  }

  releaseAll(): void {
    this.m.keyboard.reset();
    this.m.joystick.reset();
    this.m.mouse.reset();
  }

  readonly mouse: MouseSink | null = null;

  /** One mouse, so the mode is ignored. The Y inversion lives here rather than
   *  in the capture pane: which way up a mouse counts is machine hardware. */
  readonly mice: MouseInput = {
    setMode: () => { /* nothing to select — the SAM has one mouse port */ },
    motion: (dx, dy) => this.m.mouse.motion(dx, dy),
    button: (index, pressed) => this.m.mouse.button(index, pressed),
  };
}
