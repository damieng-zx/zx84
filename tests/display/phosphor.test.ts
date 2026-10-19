import { describe, it, expect } from 'vitest';
import { parsePhosphor, phosphorTint, PHOSPHORS } from '@/display/phosphor.ts';

describe('phosphor', () => {
  it('colour is the untinted default, and every listed phosphor round-trips', () => {
    expect(phosphorTint('color')).toBeNull();
    for (const p of PHOSPHORS) expect(parsePhosphor(p.id)).toBe(p.id);
  });

  it('falls back to colour for a stale or unknown saved value', () => {
    expect(parsePhosphor('')).toBe('color');
    expect(parsePhosphor('magenta')).toBe('color');
    expect(parsePhosphor('toString')).toBe('color');
  });

  it('every tint is a valid 0-1 colour that reaches full brightness in some channel', () => {
    for (const p of PHOSPHORS) {
      const t = phosphorTint(p.id);
      if (!t) continue;
      for (const c of t) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(1); }
      expect(Math.max(...t)).toBe(1);
    }
  });
});
