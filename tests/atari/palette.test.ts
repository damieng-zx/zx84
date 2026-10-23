/**
 * GTIA palettes. NTSC follows the Atari800 emulator's generator (CGIA luma
 * table, 26.8 degrees per hue from the NTSC burst, gamma 2.35); PAL follows
 * the analogue video model in the Altirra Hardware Reference Manual (section
 * 6.3, appendix D): the PAL GTIA's per-line delays and the measured luma and
 * saturation of each model.
 */

import { describe, it, expect } from 'vitest';
import {
  atariPaletteOptions, buildAtariPalette, resolveAtariPalette,
} from '@/machines/atari/palette.ts';

const rgb = (c: number) => [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
const grey = (p: Uint32Array, l: number) => p[l] & 0xff;
/** Chroma strength of a colour: the spread between its channels. */
const spread = (c: number) => Math.max(...rgb(c)) - Math.min(...rgb(c));

describe('atari palette options', () => {
  it('offers NTSC the Atari800 palette and a 1702 tint, PAL its two', () => {
    expect(atariPaletteOptions(false).map(o => o.value)).toEqual(['tv', 'monitor']);
    expect(atariPaletteOptions(true).map(o => o.value)).toEqual(['tv', 'uncorrected']);
  });

  it('falls back to the region default for a palette the region lacks', () => {
    // A PAL set has no tint control to centre like a 1702's.
    expect(resolveAtariPalette(true, 'monitor')).toBe('tv');
    expect(resolveAtariPalette(false, 'monitor')).toBe('monitor');
    expect(resolveAtariPalette(false, 'nonsense')).toBe('tv');
    // Maps from before the Atari800 palette went in.
    expect(resolveAtariPalette(false, 'nominal')).toBe('tv');
    expect(resolveAtariPalette(false, 'uncorrected')).toBe('tv');
  });
});

describe('atari NTSC palette', () => {
  it('matches the Atari800 generator at its sample points', () => {
    const p = buildAtariPalette(false, 'tv');
    // Hue 1, luma 8, worked by hand from colours_ntsc.c: Y 0.431, I 0.095,
    // Q -0.147, so gamma-encoded RGB (0.431, 0.500, 0.076), then gamma 2.35
    // and sRGB. Grey ramp end points are black and white.
    const [r, g, b] = rgb(p[0x18]);
    expect([r, g, b].map((c, i) => Math.abs(c - [104, 123, 8][i])).every(d => d <= 1)).toBe(true);
    expect(rgb(p[0x00])).toEqual([0, 0, 0]);
    expect(rgb(p[0x0f])).toEqual([255, 255, 255]);
  });

  it('carries hue 15 past hue 1 with the 26.8 degree step', () => {
    const p = buildAtariPalette(false, 'tv');
    expect(p[0xf8]).not.toBe(p[0x18]);
    // 26.8 x 14 = 375.2, 15 degrees round from hue 1: still the same orange family.
    const [r, g, b] = rgb(p[0xf8]);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('does not depend on the machine\'s video board', () => {
    expect(buildAtariPalette(false, 'tv', '800')).toEqual(buildAtariPalette(false, 'tv', 'xl'));
  });

  it('turns hue 1 redder under a 1702 monitor\'s tint', () => {
    const [tr, tg] = rgb(buildAtariPalette(false, 'tv')[0x18]);
    const [mr, mg] = rgb(buildAtariPalette(false, 'monitor')[0x18]);
    expect(mr / mg).toBeGreaterThan(tr / tg);
  });

  it('leaves the greys alone under the 1702 tint', () => {
    const t = buildAtariPalette(false, 'tv');
    const m = buildAtariPalette(false, 'monitor');
    for (let l = 0; l < 16; l++) expect(m[l]).toBe(t[l]);
  });

  it('spaces the greys with the CGIA luma table, rising every step', () => {
    const p = buildAtariPalette(false, 'tv');
    for (let l = 1; l < 16; l++) expect(grey(p, l)).toBeGreaterThan(grey(p, l - 1));
  });

  it('keeps the OS background $94 blue in every palette', () => {
    for (const { value } of atariPaletteOptions(false)) {
      const [r, g, b] = rgb(buildAtariPalette(false, value)[0x94]);
      expect(b).toBeGreaterThan(r);
      expect(b).toBeGreaterThan(g);
    }
  });
});

describe('atari PAL palette', () => {
  it('makes hue 13 the stable -U reference that hue 1 is on NTSC', () => {
    // At the nominal step both lines of hue 13 decode to 180 degrees.
    expect(rgb(buildAtariPalette(true, 'uncorrected')[0xd8])).toEqual([136, 160, 12]);
  });

  it('always shows hue 15 as hue 1', () => {
    const p = buildAtariPalette(true, 'tv');
    for (let l = 0; l < 16; l++) expect(p[0xf0 | l]).toBe(p[0x10 | l]);
  });

  it('saturates most on the 800, then the 400, then the XL', () => {
    const at = (board: '400' | '800' | 'xl') => spread(buildAtariPalette(true, 'uncorrected', board)[0x88]);
    expect(at('800')).toBeGreaterThan(at('400'));
    expect(at('400')).toBeGreaterThan(at('xl'));
  });

  it('crowds luma 7 and 8 together, as the luma DAC does', () => {
    const p = buildAtariPalette(true, 'tv', 'xl');
    expect(grey(p, 8) - grey(p, 7)).toBeLessThan(grey(p, 7) - grey(p, 6));
  });
});
