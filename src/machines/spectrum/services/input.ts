/**
 * Spectrum InputService — delivers host keyboard events to the Spectrum's
 * keyboard matrix, replacing the shell's per-machine dispatch ladder.
 *
 * Joystick key-mapping (cursor/WASD/gamepad → joystick directions) stays in
 * the shell: which host keys emulate a joystick is a user setting, not
 * machine hardware. The shell resolves those first and only forwards
 * unclaimed keys here.
 */

import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { resetJoystickKeyState } from '@/machines/spectrum/peripherals/joysticks.ts';

export class SpectrumInputService implements InputService {
  constructor(private readonly s: Spectrum) {}

  keyDown(e: HostKeyEvent): boolean {
    return this.s.keyboard.handleKeyEvent(e.code, true, e.key);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.s.keyboard.handleKeyEvent(e.code, false, e.key);
  }

  releaseAll(): void {
    this.s.keyboard.reset();
    resetJoystickKeyState();
  }

  /** Mice still route through the shell's mode-aware path (Kempston vs AMX is
   *  a settings decision); wired here in a later phase. */
  readonly mouse: MouseSink | null = null;
}
