/**
 * Acorn parallel ASCII keyboard, as the CPU card's INS8154 sees it.
 *
 * The keyboard is a separate Eurocard (or an Acorn ASCII keyboard on a ribbon)
 * that puts a 7-bit ASCII code on port B with bit 7 pulled low while a key is
 * down. The COS polls the port: `BIT &0E21` until bit 7 is clear means "wait
 * for a key", and the byte it then reads is the character. There is no strobe
 * latch to clear — holding the key holds the code on the pins.
 *
 * The capslock/shift arrangement is the keyboard's own: the host layout's
 * character (already shifted, if the user held shift) is what goes on the pins.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';
import type { Ins8154 } from '@/cores/ins8154.ts';

/** No key down: the port's pull-ups read all ones, which the OS reads as "idle". */
const NO_KEY = 0xFF;

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

  constructor(private readonly pia: Ins8154) {
    pia.portBInput = NO_KEY;
  }

  isHeld(code: string): boolean { return this.held.has(code); }

  track(code: string, down: boolean): void {
    if (down) this.held.add(code); else this.held.delete(code);
  }

  handleEvent(event: HostKeyEvent, down: boolean): boolean {
    this.track(event.code, down);
    const byte = acornSystemKeyByte(event);
    if (byte === null) return false;
    if (down) {
      this.code = byte;
      this.pia.portBInput = byte & 0x7F;
    } else if (this.code === byte) {
      this.code = null;
      this.pia.portBInput = NO_KEY;
    }
    return true;
  }

  reset(): void {
    this.code = null;
    this.pia.portBInput = NO_KEY;
    this.held.clear();
  }
}
