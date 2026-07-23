/**
 * Status-bar LED declarations per machine.
 *
 * Each machine's descriptor lists the activity indicators its hardware actually
 * has (and its frame probe drives) via `ui.statusLeds`; StatusBar renders only
 * those. These tests lock in that no machine advertises an indicator for absent
 * hardware — the ZX80/81 have no AY or disk, the CPC has no beeper, a 48K
 * Spectrum has no AY, and so on.
 */

import { describe, it, expect } from 'vitest';
import { entryForModel } from '@/machines/registry.ts';
import type { MachineModel } from '@/models.ts';
import type { StatusLedId } from '@/machines/machine.ts';

function leds(model: MachineModel): readonly StatusLedId[] {
  return entryForModel(model).descriptor(model).ui.statusLeds;
}

describe('status-bar LED declarations', () => {
  it('ZX80/ZX81 show no sound chip, disk, mouse, joystick or EAR indicators', () => {
    for (const model of ['zx80', 'zx81'] as const) {
      const l = leds(model);
      expect(l).toContain('kbd');
      expect(l).toContain('text');
      for (const absent of ['ay', 'dsk', 'beep', 'mouse', 'kemp', 'ear', 'rainbow', 'load'] as const) {
        expect(l).not.toContain(absent);
      }
    }
  });

  it('Spectrum shows AY only on 128K-class models', () => {
    expect(leds('16k')).not.toContain('ay');
    expect(leds('48k')).not.toContain('ay');
    expect(leds('128k')).toContain('ay');
    expect(leds('+2')).toContain('ay');
    expect(leds('+2A')).toContain('ay');
    expect(leds('+3')).toContain('ay');
  });

  it('Spectrum shows the DISK indicator only on the +3', () => {
    expect(leds('48k')).not.toContain('dsk');
    expect(leds('128k')).not.toContain('dsk');
    expect(leds('+3')).toContain('dsk');
  });

  it('every Spectrum keeps its Kempston/EAR/rainbow/beep indicators', () => {
    for (const led of ['kemp', 'ear', 'rainbow', 'beep'] as const) {
      expect(leds('48k')).toContain(led);
    }
  });

  it('CPC shows AY but never the (absent) beeper', () => {
    for (const model of ['cpc464', 'cpc6128', 'gx4000'] as const) {
      expect(leds(model)).toContain('ay');
      expect(leds(model)).not.toContain('beep');
    }
  });

  it('CPC gates TAPE/DISK by cassette and drive fitment', () => {
    // 6128: drive + cassette; 464: cassette only; GX4000: neither.
    expect(leds('cpc6128')).toEqual(expect.arrayContaining(['load', 'dsk']));
    expect(leds('cpc464')).toContain('load');
    expect(leds('cpc464')).not.toContain('dsk');
    expect(leds('gx4000')).not.toContain('load');
    expect(leds('gx4000')).not.toContain('dsk');
  });

  it('MSX shows PSG + cassette, Einstein shows PSG + disk', () => {
    expect(leds('hx-10')).toEqual(expect.arrayContaining(['ay', 'load']));
    expect(leds('hx-10')).not.toContain('dsk');
    expect(leds('einstein-tc01')).toEqual(expect.arrayContaining(['ay', 'dsk']));
    expect(leds('einstein-tc01')).not.toContain('load');
  });
});
