/**
 * Acorn parallel ASCII keyboard, as the CPU card's port sees it.
 *
 * The keyboard is a separate Eurocard (or a ribboned Acorn ASCII keyboard)
 * that puts a 7-bit ASCII code on the port with bit 7 pulled low while a key is
 * down. The system software polls it: "wait until bit 7 is clear" means "wait
 * for a key", and the byte it then reads is the character. There is no strobe
 * latch to clear — holding the key holds the code on the pins.
 *
 * Both CPU cards read the same way: an INS8154's port B on the 1 MHz cards, a
 * 6522's port A on the System 5. The machine composes the pins; this class only
 * knows what a keypress puts on them.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';

/** No key down: the pull-ups read all ones, which the software reads as "idle". */
export const ACORN_SYSTEM_NO_KEY = 0xFF;

/** The byte the keyboard would put on the port, or null for a key it cannot send. */
export function acornSystemKeyByte(event: HostKeyEvent): number | null {
  switch (event.code) {
    case 'Enter': case 'NumpadEnter': return 0x0D;
    case 'Backspace': case 'Delete': return 0x7F;
    case 'Escape': return 0x1B;
    case 'Tab': return 0x09;
    default: break;
  }
  if (event.ctrl && /^Key[A-Z]$/.test(event.code)) return event.code.charCodeAt(3) & 0x1F;
  if (event.key.length !== 1) return null;
  const code = event.key.charCodeAt(0);
  return code >= 0x20 && code < 0x7F ? code : null;
}

export class AcornSystemKeyboard {
  /** The code currently on the port's data lines, or null when no key is down. */
  private code: number | null = null;
  /** Caps currently down (host key codes), for lighting an on-screen keyboard later. */
  private readonly held = new Set<string>();

  /** The level the keyboard drives onto the port: bit 7 low while a key is down. */
  get keyLine(): number { return this.code === null ? ACORN_SYSTEM_NO_KEY : this.code & 0x7F; }

  isHeld(code: string): boolean { return this.held.has(code); }

  track(code: string, down: boolean): void {
    if (down) this.held.add(code); else this.held.delete(code);
  }

  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    this.track(event.code, down);
    const byte = acornSystemKeyByte(event);
    if (byte === null) return false;
    if (down) this.code = byte;
    else if (this.code === byte) this.code = null;
    return true;
  }

  /** An on-screen cap: put its code on the port (the encoder's job). */
  press(code: number): void { this.code = code & 0x7F; }

  /** The cap was let go: no key is down any more. */
  release(): void { this.code = null; }

  reset(): void {
    this.code = null;
    this.held.clear();
  }
}
