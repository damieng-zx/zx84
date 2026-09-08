/**
 * The browser's resize grip has no element to hit-test, so a floating pane
 * reserves its corner by hand — otherwise a press there resizes *and* starts a
 * move, and the pane wanders off under the pointer as it grows.
 */

import { describe, it, expect } from 'vitest';
import { inResizeGrip } from '@/ui/panes.ts';

const pane = { right: 400, bottom: 300 };

describe('floating pane resize grip', () => {
  it('claims the bottom-right corner', () => {
    expect(inResizeGrip(pane, 399, 299)).toBe(true);
    expect(inResizeGrip(pane, 390, 290)).toBe(true);
  });

  it('leaves the rest of the case draggable', () => {
    expect(inResizeGrip(pane, 200, 150)).toBe(false);   // middle
    expect(inResizeGrip(pane, 399, 150)).toBe(false);   // right edge, mid height
    expect(inResizeGrip(pane, 200, 299)).toBe(false);   // bottom edge, mid width
    expect(inResizeGrip(pane, 1, 1)).toBe(false);       // top-left
  });

  it('only claims the other three corners never', () => {
    expect(inResizeGrip(pane, 1, 299)).toBe(false);     // bottom-left
    expect(inResizeGrip(pane, 399, 1)).toBe(false);     // top-right
  });
});
