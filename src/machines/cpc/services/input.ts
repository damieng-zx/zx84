/**
 * CPC InputService — delivers host keyboard events to the CPC keyboard matrix,
 * replacing the shell's per-machine dispatch ladder.
 *
 * Joystick key-mapping (cursor/WASD/gamepad → joystick directions) stays in the
 * shell: which host keys emulate a joystick is a user setting, not machine
 * hardware. The shell resolves those first and only forwards unclaimed keys here.
 */

import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
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

  /** Mice route through the shell's mode-aware path (Kempston vs AMX is a
   *  settings decision); wired here in a later phase. */
  readonly mouse: MouseSink | null = null;
}
