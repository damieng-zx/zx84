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
import { Asic } from '@/machines/cpc/asic.ts';
import { AnalogSticks, axisToRange } from '@/machines/shared/analog-stick.ts';

/** How far a proportional axis must go to count as a digital direction. */
const DIGITAL_THRESHOLD = 0.5;

export class CpcInputService implements InputService {
  constructor(private readonly c: CpcMachine) {}

  /** The sticks as the host drives them, for the Plus's analogue port. */
  private readonly sticks = new AnalogSticks(2);
  /** Digital directions a proportional axis is holding, per player. */
  private readonly axisHeld = [
    { up: false, down: false, left: false, right: false },
    { up: false, down: false, left: false, right: false },
  ];

  /** The Plus / GX4000's ASIC, or null on a 464/664/6128. */
  private get asic(): Asic | null {
    return this.c.gateArray instanceof Asic ? this.c.gateArray : null;
  }

  /** Joystick `player`'s position onto the ASIC's analogue channels: X1/Y1
   *  are channels 0/1, X2/Y2 channels 2/3; 0 is left / up, &3F right / down. */
  private updateAnalogue(player: number): void {
    const asic = this.asic;
    if (!asic) return;
    asic.setAnalogue(player * 2, axisToRange(this.sticks.x(player), 0x3F, false));
    asic.setAnalogue(player * 2 + 1, axisToRange(this.sticks.y(player), 0x3F, false));
  }

  /** A digital direction a proportional axis implies, onto the matrix only
   *  when it changes (a key held on the same direction is left alone). */
  private holdFromAxis(dir: 'up' | 'down' | 'left' | 'right', on: boolean, player: number): void {
    const held = this.axisHeld[player];
    if (held[dir] === on) return;
    held[dir] = on;
    this.c.keyboard.setJoystick(dir, on, player);
  }

  keyDown(e: HostKeyEvent): boolean {
    return this.c.keyboard.handleKeyEvent(e.code, true);
  }

  keyUp(e: HostKeyEvent): boolean {
    return this.c.keyboard.handleKeyEvent(e.code, false);
  }

  releaseAll(): void {
    this.c.keyboard.reset();
    this.sticks.reset();
    for (const h of this.axisHeld) h.up = h.down = h.left = h.right = false;
    this.updateAnalogue(0);
    this.updateAnalogue(1);
  }

  readonly mouse: MouseSink | null = null;

  /** Mode-aware Kempston/AMX routing (which mode is active stays pane state). */
  readonly mice: MouseInput = {
    setMode: (mode) => {
      this.c.kempstonMouse.enabled = mode === 'kempston';
      this.c.amxMouse.enabled = mode === 'amx';
    },
    motion: (dx, dy, mode) => {
      // Host deltas arrive raw; the Kempston mouse counts Y upwards.
      if (mode === 'kempston') this.c.kempstonMouse.updatePosition(dx, -dy);
      else if (mode === 'amx') this.c.amxMouse.queueMovement(dx, dy);
    },
    button: (index, pressed, mode) => {
      if (mode === 'kempston') this.c.kempstonMouse.setButton(index, pressed);
      else if (mode === 'amx') this.c.amxMouse.setButton(index, pressed);
    },
  };

  /** Joystick presses land in the keyboard matrix rows 9/6 (per player).
   *
   *  The CPC's *main* fire button is Fire 2, not Fire 1 — an Amstrad naming
   *  quirk: a single-button joystick wires its one button to Fire 2, so games
   *  put their primary action there (CPCWiki/magic-cookie joystick pinout).
   *  Map the emulator's primary fire ('fire') to CPC Fire 2 so the main action
   *  button behaves as on real hardware; the secondary button drives Fire 1.
   *  Without this, Burnin' Rubber's launch/options were reversed.
   *
   *  On a Plus or GX4000 the same stick also drives the ASIC's analogue
   *  inputs (an analogue joystick's buttons are the digital port's fire
   *  buttons): a key is full deflection, a gamepad axis proportional. A
   *  proportional axis drives the digital port too, past half travel, so a
   *  game reading the digital port still sees it. */
  readonly joystick: JoystickInput = {
    press: (dir, pressed, _mode, player) => {
      const d = dir === 'fire' ? 'fire2' : dir === 'fire2' ? 'fire1' : dir;
      if (d === 'up' || d === 'down' || d === 'left' || d === 'right' || d === 'fire1' || d === 'fire2') {
        this.c.keyboard.setJoystick(d, pressed, player);
      }
      if ((player === 0 || player === 1) && this.sticks.press(dir, pressed, player)) this.updateAnalogue(player);
    },
    analog: (axis, value, player) => {
      if (player !== 0 && player !== 1) return;
      this.sticks.analog(axis, value, player);
      const v = axis === 'x' ? this.sticks.x(player) : this.sticks.y(player);
      this.holdFromAxis(axis === 'x' ? 'left' : 'up', v <= -DIGITAL_THRESHOLD, player);
      this.holdFromAxis(axis === 'x' ? 'right' : 'down', v >= DIGITAL_THRESHOLD, player);
      this.updateAnalogue(player);
    },
  };
}
