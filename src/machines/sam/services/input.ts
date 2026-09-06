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

  /**
   * One mouse, so there is nothing for the mode to select.
   *
   * The interface is always plugged in — a SAM's mouse port is on the back of
   * every machine, and an idle mouse reports nothing, so nothing needs
   * switching off. Capturing or releasing the pointer does restart the report
   * though: whatever half-read sequence or stale movement was in flight
   * belongs to the previous capture.
   *
   * The Y inversion lives here rather than in the capture pane, because which
   * way up a mouse counts is machine hardware.
   */
  readonly mice: MouseInput = {
    setMode: () => this.m.mouse.reset(),
    motion: (dx, dy) => this.m.mouse.motion(dx, dy),
    button: (index, pressed) => this.m.mouse.button(index, pressed),
  };
}
