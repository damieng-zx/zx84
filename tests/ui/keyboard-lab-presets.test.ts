import { describe, expect, it } from 'vitest';
import { cpcKeyboardLabPresets } from '@/machines/cpc/ui/keyboard/lab-preset.ts';
import { hx10KeyboardLabPresets } from '@/machines/msx/ui/keyboard/lab-preset.ts';
import { spectrumKeyboardLabPresets } from '@/machines/spectrum/ui/keyboard/lab-preset.ts';
import { zx8xKeyboardLabPresets } from '@/machines/zx8x/ui/keyboard/lab-preset.ts';

describe('keyboard lab presets', () => {
  it('adapts all current fixed keyboard scenes without losing keys', () => {
    const presets = [
      ...spectrumKeyboardLabPresets(),
      ...zx8xKeyboardLabPresets(),
      ...cpcKeyboardLabPresets(),
      ...hx10KeyboardLabPresets(),
    ];

    expect(presets.map((preset) => preset.id)).toEqual([
      'spectrum-48k',
      'spectrum-128k',
      'spectrum-plus2',
      'spectrum-plus2a',
      'spectrum-plus3',
      'zx80',
      'zx81',
      'cpc464',
      'cpc664',
      'cpc6128',
      'toshiba-hx10',
    ]);
    expect(presets.map((preset) => preset.keys.length)).toEqual([
      40, 58, 58, 58, 58, 40, 40, 74, 74, 74, 73,
    ]);
    for (const preset of presets) {
      expect(new Set(preset.keys.map((key) => key.id)).size).toBe(preset.keys.length);
    }
  });

  it('preserves special face shapes and multi-position legends', () => {
    const cpc664 = cpcKeyboardLabPresets()[1];
    const cpc6128 = cpcKeyboardLabPresets()[2];
    const hx10 = hx10KeyboardLabPresets()[0];
    const spectrum48 = spectrumKeyboardLabPresets()[0];
    const spectrum128 = spectrumKeyboardLabPresets()[1];
    const zx81 = zx8xKeyboardLabPresets()[1];

    expect(cpc664.keys.find((key) => key.id === 'cursor-left')?.shape).toBe('wedge-left');
    expect(cpc6128.keys.find((key) => key.id === 'return')?.shape).toBe('return');
    expect(hx10.keys.find((key) => key.id === 'f1')?.legends.aux).toBe('F6');
    expect(hx10.keys.find((key) => key.id === 'return')?.clipPath).toMatch(/^polygon/);
    expect(spectrum48.keys.find((key) => key.id === 'q')?.legends.shift).toContain('PLOT');
    expect(spectrum128.keys.find((key) => key.shape === 'return')?.clipPath).toMatch(/^polygon/);
    expect(zx81.keys.find((key) => key.legends.main === 'Q')?.legends.aux).toContain('PLOT');
  });

  it('keeps every editable key within its preset scene', () => {
    const presets = [
      ...spectrumKeyboardLabPresets(),
      ...zx8xKeyboardLabPresets(),
      ...cpcKeyboardLabPresets(),
      ...hx10KeyboardLabPresets(),
    ];

    for (const preset of presets) {
      for (const key of preset.keys) {
        expect(key.box.x, `${preset.id}/${key.id} left`).toBeGreaterThanOrEqual(0);
        expect(key.box.y, `${preset.id}/${key.id} top`).toBeGreaterThanOrEqual(0);
        expect(key.box.x + key.box.width, `${preset.id}/${key.id} right`)
          .toBeLessThanOrEqual(preset.scene.width);
        expect(key.box.y + key.box.height, `${preset.id}/${key.id} bottom`)
          .toBeLessThanOrEqual(preset.scene.height);
      }
    }
  });
});
