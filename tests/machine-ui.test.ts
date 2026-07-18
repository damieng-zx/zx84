/**
 * The UI-side machine manifest (src/ui/machine-ui.ts) maps each machine
 * kind to lazily-imported Solid components. These tests assert the manifest is
 * wired correctly: every declared contribution is a well-formed Solid `lazy`
 * loader (a component exposing `.preload`), and each kind exposes exactly the
 * pieces it should.
 *
 * The vitest environment here is `node` (no DOM), so we deliberately do NOT
 * evaluate the components — their compiled JSX calls `delegateEvents(window)` at
 * module scope. Import-path and named-export correctness is already guaranteed
 * statically by `tsc` (it type-checks each `import(...).then(m => m.Export)`
 * target); this test guards the runtime manifest shape.
 */

import { describe, it, expect } from 'vitest';
import { machineUi } from '@/ui/machine-ui.ts';

/** A Solid `lazy()` component is a function carrying a `.preload` method. */
function isLazyLoader(v: unknown): boolean {
  return typeof v === 'function' && typeof (v as { preload?: unknown }).preload === 'function';
}

describe('machine-ui manifest', () => {
  it('gives every registered kind a (possibly empty) contribution object', () => {
    for (const kind of ['spectrum', 'cpc', 'einstein', 'msx']) {
      expect(machineUi(kind)).toBeTypeOf('object');
    }
    // Unknown kinds degrade to an empty contribution, never undefined.
    expect(machineUi('bbc-micro')).toEqual({});
  });

  it('declares the expected per-kind contributions as lazy loaders', () => {
    const spectrum = machineUi('spectrum');
    expect(isLazyLoader(spectrum.HardwareSection)).toBe(true);
    expect(isLazyLoader(spectrum.Keyboard)).toBe(true);
    expect(isLazyLoader(spectrum.SysVars)).toBe(true);

    const cpc = machineUi('cpc');
    expect(isLazyLoader(cpc.HardwareSection)).toBe(true);
    expect(cpc.Keyboard).toBeUndefined();      // CPC has its own physical keyboard
    expect(cpc.SysVars).toBeUndefined();

    expect(isLazyLoader(machineUi('einstein').HardwareSection)).toBe(true);

    // The MSX contributes no bespoke UI (fixed hardware, no sysvars/keyboard).
    expect(machineUi('msx')).toEqual({});
  });

  it('exposes only known contribution keys per kind', () => {
    const allowed = new Set(['HardwareSection', 'Keyboard', 'SysVars']);
    for (const kind of ['spectrum', 'cpc', 'einstein', 'msx']) {
      for (const key of Object.keys(machineUi(kind))) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });
});
