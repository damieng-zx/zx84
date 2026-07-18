/**
 * CPC InputService — delivers host keyboard events to the CPC keyboard matrix,
 * replacing the shell's per-machine dispatch ladder.
 *
 * Joystick key-mapping (cursor/WASD/gamepad → joystick directions) stays in the
 * shell: which host keys emulate a joystick is a user setting, not machine
 * hardware. The shell resolves those first and only forwards unclaimed keys here.
 */

import type { HostKeyEvent, InputService, JoystickInput, MouseInput, MouseSink } from '@/machines/machine.ts';
import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

export class CpcInputService implements InputService {
  constructor(private readonly c: CpcMachine) {}

  keyDown(e: HostKeyEvent): boolean {
    return this.c.keyboard.handleKeyEvent(e.code, true);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.c.keyboard.handleKeyEvent(e.code, false);
  }

  releaseAll(): void {
    this.c.keyboard.reset();
  }

  readonly mouse: MouseSink | null = null;

  /** Mode-aware Kempston/AMX routing (which mode is active stays pane state). */
  readonly mice: MouseInput = {
    setMode: (mode) => {
      this.c.kempstonMouse.enabled = mode === 'kempston';
      this.c.amxMouse.enabled = mode === 'amx';
    },
    motion: (dx, dy, mode) => {
      if (mode === 'kempston') this.c.kempstonMouse.updatePosition(dx, dy);
      else if (mode === 'amx') this.c.amxMouse.queueMovement(dx, dy);
    },
    button: (index, pressed, mode) => {
      if (mode === 'kempston') this.c.kempstonMouse.setButton(index, pressed);
      else if (mode === 'amx') this.c.amxMouse.setButton(index, pressed);
    },
  };

  /** Joystick presses land in the keyboard matrix rows 9/6 (per player). */
  readonly joystick: JoystickInput = {
    press: (dir, pressed, _mode, player) => {
      const d = dir === 'fire' ? 'fire1' : dir;
      if (d === 'up' || d === 'down' || d === 'left' || d === 'right' || d === 'fire1' || d === 'fire2') {
        this.c.keyboard.setJoystick(d, pressed, player);
      }
    },
  };
}
