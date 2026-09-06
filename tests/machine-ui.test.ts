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
    for (const kind of ['spectrum', 'cpc', 'einstein', 'msx', 'mtx', 'zx8x', 'sam']) {
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
    expect(isLazyLoader(spectrum.LibraryBrowser)).toBe(true);

    const cpc = machineUi('cpc');
    expect(isLazyLoader(cpc.HardwareSection)).toBe(true);
    expect(isLazyLoader(cpc.Keyboard)).toBe(true);
    expect(cpc.SysVars).toBeUndefined();

    expect(isLazyLoader(machineUi('einstein').HardwareSection)).toBe(true);
    expect(isLazyLoader(machineUi('mtx').HardwareSection)).toBe(true);

    expect(isLazyLoader(machineUi('msx').Keyboard)).toBe(true);

    expect(isLazyLoader(machineUi('sam').HardwareSection)).toBe(true);
    expect(isLazyLoader(machineUi('sam').Keyboard)).toBe(true);
    expect(isLazyLoader(machineUi('sam').SysVars)).toBe(true);
    expect(isLazyLoader(machineUi('sam').LibraryBrowser)).toBe(true);

    expect(isLazyLoader(machineUi('zx8x').HardwareSection)).toBe(true);
    expect(isLazyLoader(machineUi('zx8x').LibraryBrowser)).toBe(true);
  });

  it('exposes only known contribution keys per kind', () => {
    const allowed = new Set(['HardwareSection', 'Keyboard', 'SysVars', 'LibraryBrowser', 'HuntFonts']);
    for (const kind of ['spectrum', 'cpc', 'einstein', 'msx', 'mtx', 'zx8x', 'sam']) {
      for (const key of Object.keys(machineUi(kind))) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  it('HuntFonts is a plain dynamic-import thunk, only where registered', () => {
    // Not a lazy component — the pane calls it imperatively; the import must
    // only fire on first call.
    const hunt = machineUi('spectrum').HuntFonts;
    expect(typeof hunt).toBe('function');
    expect(isLazyLoader(hunt)).toBe(false);
    for (const kind of ['cpc', 'einstein', 'msx', 'mtx', 'zx8x', 'sam']) {
      expect(machineUi(kind).HuntFonts).toBeUndefined();
    }
  });
});
