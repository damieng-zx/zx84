/**
 * PCW joystick interfaces, from John Elliott's PCW hardware guide §12:
 *
 *   Kempston      &9F, active high: b4 fire, b3 down, b2 up, b1 left, b0 right
 *   Spectravideo  &E0, active high: b7 0, b4 right, b3 up, b2 left, b1 fire,
 *                 b0 down
 *   Cascade       &E0, active low: b7 fire, b4 up, b2 down, b1 right, b0 left
 *
 * and §10.3: the keyboard matrix's joystick bits (&3FF9) have no connector on
 * any PCW keyboard, so a host joystick must not show up there.
 */

import { describe, it, expect } from 'vitest';
import { PcwMachine } from '@/machines/pcw/pcw-machine.ts';
import type { SettingsView } from '@/machines/machine.ts';

function fitted(type: string): PcwMachine {
  const m = new PcwMachine('pcw8256', null);
  const view: SettingsView = { get: <T>(key: string, fallback: T): T => (key === 'joy-p1' ? type as T : fallback) };
  m.applySettings(view);
  return m;
}

describe('PCW joystick interfaces', () => {
  it('Kempston at &9F: active-high bits, nothing at &E0', () => {
    const m = fitted('kempston');
    const joy = m.services.input.joystick!;
    expect(m.cpu.portIn(0x009F)).toBe(0x00);
    joy.press('right', true, 'kempston', 0);
    joy.press('up', true, 'kempston', 0);
    joy.press('fire', true, 'kempston', 0);
    expect(m.cpu.portIn(0x009F)).toBe(0x10 | 0x04 | 0x01);
    expect(m.cpu.portIn(0x00E0)).toBe(0xFF);
  });

  it('Spectravideo at &E0: right b4, up b3, left b2, fire b1, down b0, b7 clear', () => {
    const m = fitted('spectravideo');
    const joy = m.services.input.joystick!;
    expect(m.cpu.portIn(0x00E0)).toBe(0x00);
    joy.press('left', true, 'spectravideo', 0);
    joy.press('down', true, 'spectravideo', 0);
    expect(m.cpu.portIn(0x00E0)).toBe(0x04 | 0x01);
    joy.press('fire', true, 'spectravideo', 0);
    expect(m.cpu.portIn(0x00E0)).toBe(0x04 | 0x02 | 0x01);
    expect(m.cpu.portIn(0x009F)).toBe(0xFF);            // no Kempston fitted
  });

  it('Cascade at &E0: active low, fire b7, up b4, down b2, right b1, left b0', () => {
    const m = fitted('cascade');
    const joy = m.services.input.joystick!;
    expect(m.cpu.portIn(0x00E0)).toBe(0xFF);
    joy.press('fire', true, 'cascade', 0);
    joy.press('up', true, 'cascade', 0);
    joy.press('right', true, 'cascade', 0);
    expect(m.cpu.portIn(0x00E0)).toBe(0xFF & ~0x80 & ~0x10 & ~0x02);
  });

  it('with no interface fitted both ports float high', () => {
    const m = fitted('none');
    m.services.input.joystick!.press('fire', true, 'none', 0);
    expect(m.cpu.portIn(0x009F)).toBe(0xFF);
    expect(m.cpu.portIn(0x00E0)).toBe(0xFF);
  });

  it('a Spectrum-only interface id falls back to Kempston', () => {
    const m = fitted('sinclair1');
    m.services.input.joystick!.press('left', true, 'sinclair1', 0);
    expect(m.cpu.portIn(0x009F)).toBe(0x02);
  });

  it('never drives the keyboard matrix joystick bits (no PCW keyboard has the socket)', () => {
    const m = fitted('kempston');
    const joy = m.services.input.joystick!;
    for (const d of ['up', 'down', 'left', 'right', 'fire']) joy.press(d, true, 'kempston', 0);
    m.keyboard.scan();
    expect(m.keyboard.matrix[0x9] & 0x3F).toBe(0);
    expect(m.keyboard.matrix[0xB] & 0x3F).toBe(0);
  });
});
