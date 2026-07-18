/**
 * debug-state — 11 thin createSignal wrappers for the debug pane.
 *
 * No logic to test, but two classes of accidents are easy to make and
 * silent at runtime:
 *
 *   1. Swapping `[0]` and `[1]` when destructuring createSignal — the
 *      "getter" then returns the setter function and every read crashes
 *      the UI. We pin types to catch this.
 *
 *   2. Changing a default — e.g. flipping `tracing` from false to true
 *      would silently start the trace buffer on every page load.
 *
 * Revision counters (regsRev / sysvarRev) deserve special note: they
 * default to 0 and reactive consumers increment them to force re-render.
 * If the default ever changes to 1, every consumer's "did it change?"
 * comparison breaks on first render.
 *
 * Module signals leak across tests if you reset the module (Solid keeps
 * a global registry), so we instead reset values back to defaults in an
 * afterEach. Tests don't interleave because they each set+assert+restore.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as debug from '@/state/debug-state.ts';

afterEach(() => {
  debug.setRegsHtml('');
  debug.setRegsRev(0);
  debug.setSysvarHtml('');
  debug.setSysvarRev(0);
  debug.setBasicListing([]);
  debug.setBasicVars([]);
  debug.setBanksHtml('');
  debug.setDisasmText('');
  debug.setTracing(false);
  debug.setTrapLogHtml('');
  debug.setShowTrapLog(false);
});

describe('debug-state — defaults', () => {
  it('all HTML/text signals start empty', () => {
    expect(debug.regsHtml()).toBe('');
    expect(debug.sysvarHtml()).toBe('');
    expect(debug.banksHtml()).toBe('');
    expect(debug.disasmText()).toBe('');
    expect(debug.trapLogHtml()).toBe('');
  });

  it('structured BASIC signals start as empty arrays', () => {
    expect(debug.basicListing()).toEqual([]);
    expect(debug.basicVars()).toEqual([]);
  });

  it('revision counters start at 0 (consumers rely on this to detect first render)', () => {
    expect(debug.regsRev()).toBe(0);
    expect(debug.sysvarRev()).toBe(0);
  });

  it('tracing and showTrapLog default to false', () => {
    expect(debug.tracing()).toBe(false);
    expect(debug.showTrapLog()).toBe(false);
  });
});

describe('debug-state — getter/setter pairing', () => {
  // If a signal's [0] and [1] were swapped, the "getter" would be a
  // function-returning function and these assertions would crash before
  // ever reaching the value check.
  const pairs: { name: string; get: () => unknown; set: (v: any) => void; sample: unknown }[] = [
    { name: 'regsHtml',     get: debug.regsHtml,     set: debug.setRegsHtml,     sample: '<b>A</b>' },
    { name: 'regsRev',      get: debug.regsRev,      set: debug.setRegsRev,      sample: 42 },
    { name: 'sysvarHtml',   get: debug.sysvarHtml,   set: debug.setSysvarHtml,   sample: 'X' },
    { name: 'sysvarRev',    get: debug.sysvarRev,    set: debug.setSysvarRev,    sample: 99 },
    { name: 'basicListing', get: debug.basicListing, set: debug.setBasicListing, sample: [{ lineNumber: 10, text: 'PRINT' }] },
    { name: 'basicVars',    get: debug.basicVars,    set: debug.setBasicVars,    sample: [{ name: 'a', kind: 'number', value: '1' }] },
    { name: 'banksHtml',    get: debug.banksHtml,    set: debug.setBanksHtml,    sample: 'bank 0' },
    { name: 'disasmText',   get: debug.disasmText,   set: debug.setDisasmText,   sample: 'NOP' },
    { name: 'tracing',      get: debug.tracing,      set: debug.setTracing,      sample: true },
    { name: 'trapLogHtml',  get: debug.trapLogHtml,  set: debug.setTrapLogHtml,  sample: 'trap' },
    { name: 'showTrapLog',  get: debug.showTrapLog,  set: debug.setShowTrapLog,  sample: true },
  ];

  for (const p of pairs) {
    it(`${p.name}: setter writes a value the getter reads back`, () => {
      p.set(p.sample);
      expect(p.get()).toEqual(p.sample);
    });
  }
});
