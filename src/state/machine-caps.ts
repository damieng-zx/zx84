/**
 * Reactive machine descriptor / UI-capability accessors.
 *
 * The generic UI panes must stay machine-blind: instead of `isCpcModel(...)` /
 * `is128kClass(...)` predicates, they read the active model's *descriptor* —
 * which each machine declares purely, per model. This module exposes those
 * descriptor views reactively (keyed off `currentModel()`), so a pane's
 * `caps().memoryLayout` re-evaluates the moment the model changes.
 *
 * Deriving from the descriptor (not the live machine instance) is deliberate:
 * `switchModel` updates `currentModel` *before* the new machine is built, so a
 * capability read that depended on the live instance would briefly see the old
 * (destroyed) machine. The descriptor is a pure function of the model, so it is
 * always correct and available construction-free.
 *
 * State may reach the registry (a leaf manifest of pure descriptors); it never
 * pulls a concrete machine folder — see the `ui-no-concrete-machines` rule.
 */

import { entryForModel } from '@/machines/registry.ts';
import type { MachineDescriptor, MachineUiCapabilities } from '@/machines/machine.ts';
import { currentModel, currentLocale } from '@/state/machine-state.ts';

/** The active model's full descriptor (reactive on `currentModel` + `currentLocale`). */
export function machineDescriptor(): MachineDescriptor {
  const model = currentModel();
  const locale = currentLocale();
  return entryForModel(model).descriptor(model, locale);
}

/** The active model's UI capabilities (reactive on `currentModel`). */
export function machineCaps(): MachineUiCapabilities {
  return machineDescriptor().ui;
}

/** The active machine kind — a string for CSS/manifest lookup only. */
export function machineKind(): string {
  return machineDescriptor().kind;
}
