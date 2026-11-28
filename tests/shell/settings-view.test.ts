/**
 * shell/settings — the SettingsView must know every key a machine reads.
 *
 * `SettingsView.get(key, fallback)` silently answers `fallback` for a key it
 * has no getter for, and a machine that passes the saved value as its fallback
 * then looks like it is honouring a setting it never sees: the control in the
 * Hardware pane moves and the machine never changes. That shipped four times
 * (Plus/4 drive, Plus/4 expansion, Lynx FDC, MTX floppy) before anyone noticed,
 * because nothing ties the pane's key to the getter table.
 *
 * These tests derive the key set from the source rather than a hand-written
 * list, so a new machine option cannot be added without this failing first.
 */

import { describe, it, expect } from 'vitest';
import { createComputed, createRoot } from 'solid-js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registry } from '@/machines/registry.ts';
import * as settings from '@/store/settings.ts';
import { buildSettingsView, settingEnabled, settingsViewKnows } from '@/shell/settings.ts';

const SRC = resolve(__dirname, '../../src');

/**
 * The values each choice-style (non-boolean) setting can hold, as its
 * Hardware-pane control offers them. Kept here so a `requires` gate naming a
 * value the control does not offer fails the suite; add an entry when a machine
 * gains a new choice gate. (Boolean settings need no entry — "on" is the only
 * value a simple gate can mean.)
 */
const CHOICES: Readonly<Record<string, readonly string[]>> = {
  // src/machines/bbc/ui/hardware-section.tsx DISK_OPTIONS
  'bbc-disk-system': ['none', 'acorn', '1770'],
};

/** Every file under `dir`, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * The literal keys machines ask the view for: `view.get('x')` or
 * `view.get<T>('x')`. Computed keys (`view.get('write-protect-' + 'abcd'[i])`)
 * are skipped by the lookahead — they are built from the drive letters, and
 * the per-letter keys they produce are in the table.
 */
function machineKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(join(SRC, 'machines'))) {
    // A machine's `ui/` folder reads the store directly, not the view.
    if (/[\\/]ui[\\/]/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/view\.get(?:<[^>]*>)?\(\s*'([^']*)'(?=\s*[,)])/g)) {
      const key = m[1];
      const at = found.get(key) ?? [];
      at.push(file.slice(SRC.length + 1).replace(/\\/g, '/'));
      found.set(key, at);
    }
  }
  return found;
}

describe('shell/settings — every key a machine reads is a real setting', () => {
  const keys = machineKeys();

  it('finds the machine settings it is meant to cover', () => {
    // Guards the scan itself: a refactor that renames the parameter (a machine
    // reading `s.get(...)`) would otherwise make this whole file vacuous.
    expect(keys.size).toBeGreaterThan(50);
    expect(keys.has('volume')).toBe(true);
    expect(keys.has('multiface')).toBe(true);
  });

  it.each([...keys.keys()].sort())(
    'the view knows %s',
    (key) => {
      const readers = keys.get(key)!.join(', ');
      expect(settingsViewKnows(key),
        `${key} is read by ${readers} but has no getter in shell/settings.ts`).toBe(true);
    },
  );

  it.each(registry.flatMap(entry => entry.models.map(model => [model, entry, model] as const)))(
    '%s gates only on keys the view knows',
    (_model, entry, model) => {
      // An unknown gate is *open*, so a typo quietly keeps a pane and its
      // drives switched on. Every gate must be a setting with a getter, and a
      // choice gate's "fitted" values must be values that setting can hold.
      const requires = entry.descriptor(model).ui.requires;
      for (const gate of Object.values(requires ?? {})) {
        if (!gate) continue;
        const key = typeof gate === 'string' ? gate : gate.setting;
        expect(settingsViewKnows(key),
          `requires names ${key}, which shell/settings.ts cannot read`).toBe(true);
        if (typeof gate === 'string' || !gate.when) continue;
        // A `when` list naming a value the setting can never take is a gate that
        // never opens, which silently hides the hardware for ever. The choices
        // are declared by the machine's own Hardware-pane control, so the gate
        // is checked against the same list the pane offers.
        const offered = CHOICES[key];
        expect(offered, `requires gates ${key} on specific values but no choice list is known`)
          .toBeDefined();
        for (const value of gate.when) {
          expect(offered, `${key} gates on '${value}', which its control does not offer`)
            .toContain(value);
        }
      }
    },
  );
});

describe('shell/settings — the view serves the options each machine reads', () => {
  // These had getters missing while the machines already read them, so the
  // control moved in the pane and the machine was handed the fallback. The
  // fallback below is a string where the setting is a boolean/string, so a
  // missing getter shows up as the wrong *value*, not just a wrong type.
  const SENTINEL = 'sentinel';

  it.each([
    ['plus4-drive', true],
    ['lynx-fdc', true],
    ['mtx-floppy', true],
    ['plus4-expansion', 'none'],
    ['pcw-phosphor', 'auto'],
  ] as const)('answers %s from the store, not its fallback', (key, expected) => {
    const view = buildSettingsView();
    expect(view.get<string | boolean>(key, SENTINEL)).toBe(expected);
  });

  it('keeps the saved drive setup readable for every machine kind', () => {
    const view = buildSettingsView();
    for (const kind of registry.map(entry => entry.kind)) {
      // No saved value: the machine's own default stands.
      expect(view.get(`drive-count:${kind}`, 2)).toBe(2);
      expect(view.get(`drive-models:${kind}`, null)).toBeNull();
    }
  });
});

describe('shell/settings — capability gates', () => {
  // The generic panes hide a capability on `requires`, so these are what decide
  // whether the Drives/Joysticks panes appear at all. They used to be answered
  // by machine-family checks inside the panes themselves.

  it('a plain key is on when its setting is, and off when it is not', () => {
    settings.setFlagSetting('lynx-fdc', true);
    expect(settingEnabled('lynx-fdc'), 'fitted').toBe(true);
    settings.setFlagSetting('lynx-fdc', false);
    expect(settingEnabled('lynx-fdc'), 'removed').toBe(false);
  });

  it('a choice gate is fitted at any of its values and absent at none', () => {
    const gate = { setting: 'bbc-disk-system', when: ['acorn', '1770'] } as const;
    settings.setTextSetting('bbc-disk-system', '1770');
    expect(settingEnabled(gate), '1770 fitted').toBe(true);
    settings.setTextSetting('bbc-disk-system', 'acorn');
    expect(settingEnabled(gate), 'acorn fitted').toBe(true);
    settings.setTextSetting('bbc-disk-system', 'none');
    expect(settingEnabled(gate), 'none fitted').toBe(false);
  });

  it('a gate with no key, or a key the view cannot read, is open', () => {
    // Hardware must never vanish because a gate was omitted or its key renamed.
    expect(settingEnabled(undefined), 'no gate').toBe(true);
    expect(settingEnabled('no-such-setting'), 'unknown key').toBe(true);
  });

  it('gates are read reactively, so a pane follows the Hardware switch', () => {
    settings.setFlagSetting('msx-floppy', false);
    const seen: boolean[] = [];
    createRoot(dispose => {
      // createComputed runs at once and again on each tracked change, which is
      // what a pane's `visible={...gate}` does.
      createComputed(() => seen.push(settingEnabled('msx-floppy')));
      settings.setFlagSetting('msx-floppy', true);
      dispose();
    });
    expect(seen).toEqual([false, true]);
  });
});
