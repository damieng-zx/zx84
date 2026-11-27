/**
 * The model picker against the machine registry.
 *
 * A model that is registered but missing from the menu cannot be selected —
 * the machine exists, boots, and passes every other test, and nobody can reach
 * it. `MODEL_LABELS` is exhaustive over `MachineModel` so the compiler catches
 * a missing label, but a missing menu entry is silent. This is the check that
 * is not silent.
 */

import { describe, expect, it } from 'vitest';
import { registry } from '@/machines/registry.ts';
import { MODEL_LABELS, MODEL_MENU, menuLabel, menuModels } from '@/ui/panes/model-menu.ts';
import type { MenuItem } from '@/ui/components/DropDownMenuButton.tsx';

const registered = registry.flatMap(entry => entry.models);

describe('model menu', () => {
  it('can reach every registered model', () => {
    const missing = registered.filter(m => !menuModels().includes(m));
    expect(missing).toEqual([]);
  });

  it('offers nothing the registry does not have', () => {
    const stray = menuModels().filter(m => !(registered as string[]).includes(m));
    expect(stray).toEqual([]);
  });

  it('lists each model once', () => {
    const models = menuModels();
    expect(new Set(models).size).toBe(models.length);
  });

  it('gives every entry a label, and every group (at any depth) a name and children', () => {
    // British Obscure mixes makers, so its entries keep the maker's name;
    // everywhere else the submenu names it and the label drops it.
    const walk = (items: readonly MenuItem[], full = false): void => {
      for (const item of items) {
        if (item.children) {
          expect(item.label, item.value).toBeTruthy();
          expect(item.children.length, item.value).toBeGreaterThan(0);
          walk(item.children, full);
        } else {
          const name = item.value as keyof typeof MODEL_LABELS;
          expect(item.label, item.value).toBe(full ? MODEL_LABELS[name] : menuLabel(name));
        }
      }
    };
    for (const group of MODEL_MENU) {
      expect(group.children?.length, group.value).toBeGreaterThan(0);
      walk(group.children ?? [], group.label === 'British Obscure');
    }
  });

  it('files Timex and the clones as submenus inside Sinclair, after its own models', () => {
    const sinclair = MODEL_MENU.find(group => group.label === 'Sinclair')!;
    const entries = (sinclair.children ?? []).map(item => item.label);
    expect(entries.slice(-2)).toEqual(['Timex', 'Clones']);
    const sub = (label: string) => (sinclair.children ?? []).find(item => item.label === label)!.children!.map(item => item.value);
    expect(sub('Timex')).toEqual(['ts1000', 'ts1500', 'tc2048', 'ts2068']);
    expect(sub('Clones')).toEqual(['pentagon128', 'pentagon512', 'pentagon1024', 'scorpion256']);
    const top = MODEL_MENU.map(group => group.label);
    expect(top).not.toContain('Timex Sinclair');
    expect(top).not.toContain('Sinclair Clones');
  });

  it('files the niche British machines under one British Obscure group at the end', () => {
    const british = MODEL_MENU.filter(group => group.label === 'British Obscure');
    expect(british).toHaveLength(1);
    expect(MODEL_MENU[MODEL_MENU.length - 1].label).toBe('British Obscure');
    expect((british[0].children ?? []).map(item => item.value).sort()).toEqual([
      'einstein-tc01', 'einstein-256',
      'mtx500', 'mtx512', 'rs128',
      'lynx48', 'lynx96', 'lynx128',
      'jupiter-ace',
      'ep64', 'ep128',
      'atmos', 'oric1',
    ].sort());
    // The group names no maker, so each entry keeps its maker's own name.
    expect((british[0].children ?? []).map(item => item.label)).toEqual([
      'Einstein TC-01', 'Einstein 256',
      'Memotech MTX500', 'Memotech MTX512', 'Memotech RS128',
      'Camputers Lynx 48K', 'Camputers Lynx 96K', 'Camputers Lynx 128K',
      'Jupiter Ace',
      'Enterprise 64', 'Enterprise 128',
      'Oric Atmos', 'Oric-1',
    ]);
  });

  it('leaves no one-maker submenu for a machine folded into British Obscure', () => {
    const labels = MODEL_MENU.map(group => group.label);
    for (const maker of ['Tangerine', 'Oric', 'Tatung', 'Memotech', 'Camputers', 'Jupiter Cantab', 'Enterprise']) {
      expect(labels).not.toContain(maker);
    }
  });

  it('drops the maker from a second-level label, and keeps MODEL_LABELS full for the model box', () => {
    // The menu drops the maker the submenu already names.
    expect(menuLabel('atom')).toBe('Atom');
    expect(menuLabel('acorn-system3')).toBe('System 3');
    expect(menuLabel('c64')).toBe('64');
    expect(menuLabel('vic20')).toBe('VIC-20');
    expect(menuLabel('hx-10')).toBe('HX-10');
    expect(menuLabel('hb-55')).toBe('HB-55');
    expect(menuLabel('mtx500')).toBe('MTX500');
    expect(menuLabel('lynx48')).toBe('Lynx 48K');
    expect(menuLabel('ts1000')).toBe('Sinclair 1000');
    expect(menuLabel('ts2068')).toBe('2068');
    expect(menuLabel('apple2e')).toBe('//e');
    expect(menuLabel('atari800xl')).toBe('800XL');
    expect(menuLabel('atmos')).toBe('Atmos');
    // A label with no maker prefix, or whose maker is part of the model's
    // name, stands as it is — here and on the model box.
    expect(menuLabel('zx48k')).toBe('ZX Spectrum 48K');
    expect(menuLabel('bbc-a')).toBe('BBC Micro Model A');
    expect(menuLabel('einstein-tc01')).toBe('Einstein TC-01');
    expect(menuLabel('oric1')).toBe('Oric-1');
    expect(MODEL_LABELS.atom).toBe('Acorn Atom');
    expect(MODEL_LABELS.c64).toBe('Commodore 64');
  });
});
