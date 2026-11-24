import type { HostKeyEvent, InputService, JoystickInput, MouseSink } from '@/machines/machine.ts';
import type { BbcMachine } from '../bbc-machine.ts';

/** A host-style event for a literal character: letters get their key code (the
 *  BBC types case from CAPS LOCK, so the code alone is the key) and printable
 *  symbols get no code, leaving `BBC_CHAR_KEYS` to place them. */
function bbcCharEvent(char: string): HostKeyEvent | null {
  const letter = /^[A-Za-z]$/.test(char) ? `Key${char.toUpperCase()}` : '';
  return { code: letter, key: char, shift: false, ctrl: false, alt: false };
}

export class BbcInputService implements InputService {
  constructor(private readonly machine: BbcMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    const handled = this.machine.keyboard.handleEvent(event, true);
    if (handled) this.machine.keyboardActivity();
    return handled;
  }

  keyUp(event: HostKeyEvent): boolean {
    const handled = this.machine.keyboard.handleEvent(event, false);
    if (handled) this.machine.keyboardActivity();
    return handled;
  }

  /** The BBC's own shifted-symbol table, driven through the same matrix event
   *  path so SHIFT is asserted for the symbols that need it. Letters go by
   *  position (their case comes from the machine's CAPS LOCK state). */
  charDown(char: string): boolean {
    const event = bbcCharEvent(char);
    if (!event) return false;
    const handled = this.machine.keyboard.handleEvent(event, true);
    if (handled) this.machine.keyboardActivity();
    return handled;
  }

  charUp(char: string): void {
    const event = bbcCharEvent(char);
    if (!event) return;
    if (this.machine.keyboard.handleEvent(event, false)) this.machine.keyboardActivity();
  }

  releaseAll(): void {
    this.machine.keyboard.reset();
    this.machine.releaseJoysticks();
  }

  /** The analogue port: player 1 is ADC channels 0/1 and fire PB4, player 2
   *  channels 2/3 and fire PB5. Keys give full deflection, a gamepad's axes
   *  proportional. The port is fixed, so the interface `mode` is ignored. */
  readonly joystick: JoystickInput = {
    press: (dir, pressed, _mode, player) => this.machine.joystickPress(dir, pressed, player),
    analog: (axis, value, player) => this.machine.joystickAnalog(axis, value, player),
  };

  readonly mouse: MouseSink | null = null;
}
