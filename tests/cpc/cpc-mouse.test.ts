/**
 * CPC mouse support — Kempston and AMX.
 *
 * Expectations are derived from the CPCWiki hardware documentation, not from the
 * implementation:
 *
 * Kempston (ports decoded on A10/A8/A4/A0):
 *   0xFBEE READ → X (8-bit wrapping counter, left -ve / right +ve)
 *   0xFBEF READ → Y (8-bit wrapping counter, up +ve / down -ve)
 *   0xFAEF READ → buttons, active-low: bit0 = Right, bit1 = Left, bits2-7 high
 *
 * AMX (joystick port = keyboard matrix line 9):
 *   bit0 up, bit1 down, bit2 left, bit3 right — LOW for one mickey per move
 *   bit4 Left button, bit5 Right button, bit6 Middle button — LOW while held
 *   A mickey is retired when the firmware deselects line 9.
 */

import { describe, it, expect } from 'vitest';
import { KempstonMouse } from '@/peripherals/kempston-mouse.ts';
import { CpcAmxMouse } from '@/peripherals/cpc-amx-mouse.ts';
import { CpcKeyboard } from '@/cpc/cpc-keyboard.ts';
import { CpcMachine } from '@/cpc/cpc-machine.ts';

describe('CPC Kempston mouse button layout', () => {
  // The CPC swaps the Spectrum's left/right bits and has no middle button.
  const cpcBits = { 0: 1, 2: 0 } as Record<number, number>;

  it('maps DOM left→bit1 and right→bit0, active-low', () => {
    const m = new KempstonMouse(cpcBits);
    expect(m.buttons).toBe(0xFF);

    m.setButton(0, true); // left → bit1
    expect(m.buttons).toBe(0xFF & ~0x02);
    m.setButton(2, true); // right → bit0
    expect(m.buttons).toBe(0xFF & ~0x03);

    m.setButton(0, false);
    expect(m.buttons).toBe(0xFF & ~0x01); // only right remains
  });

  it('ignores the middle button (CPC Kempston is two-button)', () => {
    const m = new KempstonMouse(cpcBits);
    m.setButton(1, true); // middle is unmapped on the CPC
    expect(m.buttons).toBe(0xFF);
  });
});

describe('CpcAmxMouse direction pulses', () => {
  it('drives the correct line-9 bit LOW for each direction', () => {
    const right = new CpcAmxMouse(); right.queueMovement(1, 0);
    expect(right.applyToLine9(0xFF)).toBe(0xFF & ~0x08); // bit3

    const left = new CpcAmxMouse(); left.queueMovement(-1, 0);
    expect(left.applyToLine9(0xFF)).toBe(0xFF & ~0x04);  // bit2

    const down = new CpcAmxMouse(); down.queueMovement(0, 1);
    expect(down.applyToLine9(0xFF)).toBe(0xFF & ~0x02);  // bit1

    const up = new CpcAmxMouse(); up.queueMovement(0, -1);
    expect(up.applyToLine9(0xFF)).toBe(0xFF & ~0x01);     // bit0
  });

  it('a pulse persists across reads but is retired one mickey per deselect', () => {
    const m = new CpcAmxMouse();
    m.queueMovement(2, 0); // two mickeys right

    // Reading repeatedly without deselecting returns the same pulse — this is
    // exactly why the naive "select once, poll forever" loop fails.
    expect(m.applyToLine9(0xFF)).toBe(0xF7);
    expect(m.applyToLine9(0xFF)).toBe(0xF7);

    m.consumeStep();                       // one mickey retired
    expect(m.applyToLine9(0xFF)).toBe(0xF7); // one still pending
    m.consumeStep();
    expect(m.applyToLine9(0xFF)).toBe(0xFF); // drained
    m.consumeStep();                        // underflow is a no-op
    expect(m.applyToLine9(0xFF)).toBe(0xFF);
  });

  it('maps buttons to line-9 bits 4/5/6 and holds them LOW', () => {
    const m = new CpcAmxMouse();
    m.setButton(0, true); // left → bit4
    expect(m.applyToLine9(0xFF)).toBe(0xFF & ~0x10);
    m.setButton(2, true); // right → bit5
    expect(m.applyToLine9(0xFF)).toBe(0xFF & ~0x30);
    m.setButton(1, true); // middle → bit6
    expect(m.applyToLine9(0xFF)).toBe(0xFF & ~0x70);

    // Held buttons are level, not consumed by deselect.
    m.consumeStep();
    expect(m.applyToLine9(0xFF)).toBe(0xFF & ~0x70);
    m.setButton(0, false);
    expect(m.applyToLine9(0xFF)).toBe(0xFF & ~0x60);
  });

  it('combines a movement pulse and a held button', () => {
    const m = new CpcAmxMouse();
    m.queueMovement(1, 0); // right → bit3
    m.setButton(0, true);  // left button → bit4
    expect(m.applyToLine9(0xFF)).toBe(0xFF & ~0x18);
  });

  it('caps the queued backlog so the pointer cannot glide after the mouse stops', () => {
    const m = new CpcAmxMouse();
    m.queueMovement(1000, 0); // a fast flick — far more than a frame can drain
    // The backlog must be small enough to clear within ~a frame of polling, so
    // the cursor stops promptly instead of coasting (no "momentum"). At the
    // ~6-7 deselects/frame an AMX driver manages, 8 drains inside one frame.
    let cycles = 0;
    while (m.active && cycles < 100) { m.consumeStep(); cycles++; }
    expect(cycles).toBeLessThanOrEqual(8);
  });

  it('reports active while pulses or buttons are outstanding', () => {
    const m = new CpcAmxMouse();
    expect(m.active).toBe(false);
    m.queueMovement(1, 0);
    expect(m.active).toBe(true);
    m.consumeStep();
    expect(m.active).toBe(false);
    m.setButton(2, true);
    expect(m.active).toBe(true);
  });
});

describe('CpcKeyboard ↔ AMX integration', () => {
  it('overlays AMX pulses on line 9 and retires them on deselect', () => {
    const kb = new CpcKeyboard();
    const amx = new CpcAmxMouse();
    kb.amx = amx;
    amx.enabled = true;
    amx.queueMovement(0, -2); // two mickeys up → bit0

    kb.selectLine(9);
    expect(kb.read()).toBe(0xFE);  // bit0 low
    kb.selectLine(0);              // deselect → consume one mickey
    kb.selectLine(9);
    expect(kb.read()).toBe(0xFE);  // one still pending
    kb.selectLine(0);              // consume the last
    kb.selectLine(9);
    expect(kb.read()).toBe(0xFF);  // drained
  });

  it('does not touch line 9 when the AMX is disabled', () => {
    const kb = new CpcKeyboard();
    const amx = new CpcAmxMouse();
    kb.amx = amx;
    amx.queueMovement(5, 5);
    amx.setButton(0, true);
    kb.selectLine(9);
    expect(kb.read()).toBe(0xFF); // enabled === false, so no overlay
  });

  it('leaves other matrix lines unaffected', () => {
    const kb = new CpcKeyboard();
    const amx = new CpcAmxMouse();
    kb.amx = amx;
    amx.enabled = true;
    amx.queueMovement(1, 0);
    kb.selectLine(6);
    expect(kb.read()).toBe(0xFF); // line 6 is joystick 1, not the AMX
  });
});

describe('CPC Kempston port decoding', () => {
  it('answers FBEE/FBEF/FAEF only when enabled', () => {
    const m = new CpcMachine('cpc6128', null);
    m.kempstonMouse.x = 0x12;
    m.kempstonMouse.y = 0x34;
    m.kempstonMouse.setButton(2, true); // right → bit0 → buttons 0xFE

    // Disabled: the buttons port (A8=0, clear of the FDC) floats high.
    expect(m.cpu.portIn(0xFAEF)).toBe(0xFF);

    m.kempstonMouse.enabled = true;
    expect(m.cpu.portIn(0xFBEE)).toBe(0x12); // X
    expect(m.cpu.portIn(0xFBEF)).toBe(0x34); // Y
    expect(m.cpu.portIn(0xFAEF)).toBe(0xFE); // buttons: right pressed
  });

  it('decodes on A10/A8/A4/A0, ignoring the don\'t-care bits', () => {
    const m = new CpcMachine('cpc6128', null);
    m.kempstonMouse.enabled = true;
    m.kempstonMouse.x = 0x55;
    m.kempstonMouse.y = 0xAA;
    // Clear several don't-care lines (A11, A9, A7) that are 1 in the canonical
    // address: 0xFBEE & ~0x0A80 = 0xF16E still keeps A10=0,A8=1,A4=0,A0=0 → X.
    expect(m.cpu.portIn(0xF16E)).toBe(0x55);
    // The same with A0=1 (0xF16F) selects Y.
    expect(m.cpu.portIn(0xF16F)).toBe(0xAA);
  });

  it('counts a mouse read into the activity LED counter', () => {
    const m = new CpcMachine('cpc6128', null);
    m.kempstonMouse.enabled = true;
    const before = m.activity.mouseReads;
    m.cpu.portIn(0xFBEE);
    expect(m.activity.mouseReads).toBe(before + 1);
  });
});
