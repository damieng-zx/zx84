/**
 * Spectrum InputService — delivers host keyboard events to the Spectrum's
 * keyboard matrix, replacing the shell's per-machine dispatch ladder.
 *
 * Joystick key-mapping (cursor/WASD/gamepad → joystick directions) stays in
 * the shell: which host keys emulate a joystick is a user setting, not
 * machine hardware. The shell resolves those first and only forwards
 * unclaimed keys here.
 */

import type { HostKeyEvent, InputService, JoystickInput, MouseInput, MouseSink } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { joyPressForType, resetJoystickKeyState } from '@/machines/spectrum/peripherals/joysticks.ts';

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

  readonly mouse: MouseSink | null = null;

  /** Mode-aware Kempston/AMX routing (which mode is active stays pane state). */
  readonly mice: MouseInput = {
    setMode: (mode) => {
      this.s.kempstonMouse.enabled = mode === 'kempston';
      this.s.amxMouse.enabled = mode === 'amx';
    },
    motion: (dx, dy, mode) => {
      if (mode === 'kempston') this.s.kempstonMouse.updatePosition(dx, dy);
      else if (mode === 'amx') this.s.amxMouse.queueMovement(dx, dy);
    },
    button: (index, pressed, mode) => {
      if (mode === 'kempston') this.s.kempstonMouse.setButton(index, pressed);
      else if (mode === 'amx') this.s.amxMouse.setButton(index, pressed);
    },
  };

  /** Kempston port / Sinclair-row / cursor-key joystick press routing. */
  readonly joystick: JoystickInput = {
    press: (dir, pressed, mode, _player) => joyPressForType(this.s, dir, pressed, mode),
  };
}
