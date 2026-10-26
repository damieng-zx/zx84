/**
 * EnterpriseInputService — host keys onto Dave's keyboard matrix. The
 * built-in joystick is part of that matrix (the cursor keys), so there is no
 * separate joystick to route.
 */

import type { HostKeyEvent, InputService } from '@/machines/machine.ts';
import type { EnterpriseMachine } from '../enterprise-machine.ts';

export class EnterpriseInputService implements InputService {
  constructor(private readonly m: EnterpriseMachine) {}

  /** A physical key by code; with no code, a literal character typed by
   *  intent (the MCP `type` tool), pressed on the typer's layer. */
  keyDown(event: HostKeyEvent): boolean {
    if (event.code === '' && event.key.length === 1) return this.m.keyboard.setTypedChar(event.key);
    return this.m.keyboard.handleKeyEvent(event.code, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    if (event.code === '' && event.key.length === 1) return this.m.keyboard.setTypedChar(null);
    return this.m.keyboard.handleKeyEvent(event.code, false);
  }

  releaseAll(): void { this.m.keyboard.reset(); }

  readonly mouse = null;
  readonly mice = null;
  readonly joystick = null;
}
