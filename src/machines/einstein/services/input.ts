/**
 * Einstein InputService — delivers host keyboard events to the AY-scanned
 * keyboard matrix, replacing the shell's per-machine dispatch ladder.
 */

import type { HostKeyEvent, InputService, JoystickInput, MouseSink } from '@/machines/machine.ts';
import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';

export class EinsteinInputService implements InputService {
  constructor(private readonly e: EinsteinMachine) {}

  keyDown(e: HostKeyEvent): boolean {
    return this.e.keyboard.handleKeyEvent(e.code, true);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.e.keyboard.handleKeyEvent(e.code, false);
  }

  releaseAll(): void {
    this.e.keyboard.reset();
    this.e.sticks.reset();
  }

  /** The two joystick ports: the TC-01's ADC0844 channels (proportional) and
   *  the 256's digital ports, with fire on status bits 0/1 and the fire
   *  interrupt. The ports are fixed, so the interface `mode` is ignored. */
  readonly joystick: JoystickInput = {
    press: (dir, pressed, _mode, player) => this.e.joystickPress(dir, pressed, player),
    analog: (axis, value, player) => this.e.joystickAnalog(axis, value, player),
  };

  readonly mouse: MouseSink | null = null;
}
