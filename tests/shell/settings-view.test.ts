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
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registry } from '@/machines/registry.ts';
import { buildSettingsView, settingsViewKnows } from '@/shell/settings.ts';

const SRC = resolve(__dirname, '../../src');

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
      // drives switched on. Every gate must be a setting with a getter.
      const requires = entry.descriptor(model).ui.requires;
      for (const key of Object.values(requires ?? {})) {
        if (!key) continue;
        expect(settingsViewKnows(key),
          `requires names ${key}, which shell/settings.ts cannot read`).toBe(true);
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
