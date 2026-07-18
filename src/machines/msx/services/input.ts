/**
 * MSX InputService — delivers host keyboard events to the MSX keyboard matrix,
 * replacing the shell's per-machine dispatch ladder. Joystick key-mapping stays
 * in the shell (a user setting); the window-blur release also zeroes the two
 * Atari-style joystick ports.
 */

import type { HostKeyEvent, InputService, JoystickInput, MouseSink } from '@/machines/machine.ts';
import type { MsxMachine } from '@/machines/msx/msx-machine.ts';

export class MsxInputService implements InputService {
  constructor(private readonly m: MsxMachine) {}

  /** Atari-style joystick ports (two players). */
  readonly joystick: JoystickInput = {
    press: (dir, pressed, _mode, player) => this.m.joystick.set(dir, pressed, player),
  };

  keyDown(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e.code, true);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.m.keyboard.handleKeyEvent(e.code, false);
  }

  releaseAll(): void {
    this.m.keyboard.reset();
    this.m.joystick.reset();
  }

  readonly mouse: MouseSink | null = null;
}
