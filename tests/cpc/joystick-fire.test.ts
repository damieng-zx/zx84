/**
 * CPC joystick fire-button mapping.
 *
 * Hardware facts (CPCTech keyboard matrix + CPCWiki/magic-cookie joystick pinout):
 *   - Keyboard matrix line 9 (joystick 0): bit 4 = Fire 2, bit 5 = Fire 1.
 *   - "Confusingly, on an ordinary joystick, the main fire button is Fire 2."
 *     A single-button joystick wires its one (primary) button to Fire 2, so
 *     games put their primary action on Fire 2 (bit 4).
 *
 * Therefore the emulator's *primary* fire ('fire') must drive CPC Fire 2, and the
 * *secondary* on-screen button ('fire2') must drive CPC Fire 1 — otherwise the
 * main action button does the game's secondary action (the Burnin' Rubber
 * "launch vs options" swap).
 *
 * Line reads are active-low: a pressed key/button reads its bit as 0.
 */

import { describe, it, expect } from 'vitest';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

const FIRE2_BIT = 1 << 4;   // CPC Fire 2 — the main/primary physical button
const FIRE1_BIT = 1 << 5;   // CPC Fire 1 — the secondary button

/** Read joystick-0 matrix line (line 9) after selecting it. */
function readJoy0(m: CpcMachine): number {
  m.keyboard.selectLine(9);
  return m.keyboard.read();
}

describe('CPC joystick fire mapping', () => {
  it('primary fire maps to CPC Fire 2 (line 9 bit 4, the main button)', () => {
    const m = new CpcMachine('cpc6128', null);
    m.services.input.joystick.press('fire', true, 'keys', 0);
    const line9 = readJoy0(m);
    expect(line9 & FIRE2_BIT).toBe(0);          // Fire 2 pressed
    expect(line9 & FIRE1_BIT).toBe(FIRE1_BIT);  // Fire 1 untouched
  });

  it('secondary fire maps to CPC Fire 1 (line 9 bit 5)', () => {
    const m = new CpcMachine('cpc6128', null);
    m.services.input.joystick.press('fire2', true, 'keys', 0);
    const line9 = readJoy0(m);
    expect(line9 & FIRE1_BIT).toBe(0);          // Fire 1 pressed
    expect(line9 & FIRE2_BIT).toBe(FIRE2_BIT);  // Fire 2 untouched
  });

  it('releasing the primary fire clears CPC Fire 2', () => {
    const m = new CpcMachine('cpc6128', null);
    m.services.input.joystick.press('fire', true, 'keys', 0);
    m.services.input.joystick.press('fire', false, 'keys', 0);
    const line9 = readJoy0(m);
    expect(line9 & FIRE2_BIT).toBe(FIRE2_BIT);  // released
  });
});
