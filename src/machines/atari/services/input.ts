/**
 * Atari 400/800 input service.
 *
 * The keyboard is event-driven: POKEY's scan code and the OS's two translation
 * tables do the work, so the input service only maps host events to scan
 * codes (see `keyboard.ts`). Joysticks are read by the OS through PIA PORTA
 * (directions) and GTIA's TRIG registers (fire buttons).
 */

import type { HostKeyEvent, InputService, JoystickInput } from '@/machines/machine.ts';
import type { AtariMachine } from '../atari-machine.ts';

export class AtariInputService implements InputService {
  readonly mouse = null;
  readonly joystick: JoystickInput = {
    press: (dir: string, pressed: boolean, _mode: string, player: number) => {
      this.m.pressJoystick(dir, pressed, player);
    },
  };

  constructor(private readonly m: AtariMachine) {}

  keyDown(e: HostKeyEvent): boolean { return this.m.keyDown(e); }
  keyUp(e: HostKeyEvent): boolean { return this.m.keyUp(e); }
  releaseAll(): void { this.m.releaseAllKeys(); }
}
