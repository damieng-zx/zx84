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
import { MODEL_LABELS, MODEL_MENU, menuModels } from '@/ui/panes/model-menu.ts';

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

  it('gives every entry a label, and every group a name and children', () => {
    for (const group of MODEL_MENU) {
      expect(group.label, group.value).toBeTruthy();
      expect(group.children?.length, group.value).toBeGreaterThan(0);
      for (const item of group.children ?? []) {
        expect(item.label, item.value).toBe(MODEL_LABELS[item.value as keyof typeof MODEL_LABELS]);
      }
    }
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
    ].sort());
  });

  it('leaves no one-maker submenu for a machine folded into British Obscure', () => {
    const labels = MODEL_MENU.map(group => group.label);
    for (const maker of ['Tatung', 'Memotech', 'Camputers', 'Jupiter Cantab', 'Enterprise']) {
      expect(labels).not.toContain(maker);
    }
  });
});
