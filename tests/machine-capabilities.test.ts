/**
 * Cross-machine capability consistency.
 *
 * `MachineUiCapabilities` is a promise a machine makes to the generic panes,
 * and a promise it cannot keep is worse than one it never made: a pane that
 * offers a control nothing is listening to looks broken rather than absent.
 * These tests hold each declaration against the service that has to honour it,
 * for every registered machine at once — so a new machine cannot quietly ship
 * a dead pane, and neither can an existing one.
 *
 * They are deliberately built from the registry rather than a hand-written
 * list: adding a machine and forgetting to add it here is exactly the gap this
 * is meant to close.
 */

import { describe, expect, it } from 'vitest';
import { registry } from '@/machines/registry.ts';
import { STATUS_LED_IDS } from '@/machines/machine.ts';

/** Every (entry, model) pair the registry knows about. */
const ALL = registry.flatMap(entry => entry.models.map(model => ({ entry, model })));

/** Build a machine headlessly — no renderer, no ROM. */
function build(entry: (typeof registry)[number], model: (typeof ALL)[number]['model']) {
  return entry.create(model, null);
}

describe('machine capabilities', () => {
  it('covers every registered model', () => {
    expect(ALL.length).toBeGreaterThan(0);
    expect(new Set(ALL.map(a => a.model)).size).toBe(ALL.length);
  });

  it.each(ALL.map(a => [a.model, a] as const))(
    '%s declares mouse interfaces only if it can drive them',
    (_model, { entry, model }) => {
      const caps = entry.descriptor(model).ui;
      const machine = build(entry, model);
      try {
        const input = machine.services.input;
        if (caps.mouseTypes.length > 0) {
          // Something must accept the events the Mouse pane will send.
          expect(input.mice ?? input.mouse).toBeTruthy();
          for (const t of caps.mouseTypes) {
            expect(t.id).toBeTypeOf('string');
            expect(t.id.length).toBeGreaterThan(0);
            expect(t.label.length).toBeGreaterThan(0);
          }
          expect(new Set(caps.mouseTypes.map(t => t.id)).size).toBe(caps.mouseTypes.length);
        }
      } finally {
        machine.destroy();
      }
    },
  );

  it.each(ALL.map(a => [a.model, a] as const))(
    '%s declares the MOUSE indicator only alongside a mouse',
    (_model, { entry, model }) => {
      const caps = entry.descriptor(model).ui;
      if (caps.statusLeds.includes('mouse')) expect(caps.mouseTypes.length).toBeGreaterThan(0);
    },
  );

  it.each(ALL.map(a => [a.model, a] as const))(
    '%s only lists status LEDs the catalog knows',
    (_model, { entry, model }) => {
      for (const id of entry.descriptor(model).ui.statusLeds) {
        expect(STATUS_LED_IDS).toContain(id);
      }
    },
  );

  it.each(ALL.map(a => [a.model, a] as const))(
    '%s backs built-in drives with a disk service that has them',
    (_model, { entry, model }) => {
      const caps = entry.descriptor(model).ui;
      const machine = build(entry, model);
      try {
        if (!caps.builtinDisk) return;
        const disks = machine.services.disks;
        expect(disks).not.toBeNull();
        // The Drive pane addresses the built-ins as 'a' and 'b'.
        expect(disks!.drives.some(d => d.id === 'a')).toBe(true);
      } finally {
        machine.destroy();
      }
    },
  );

  it.each(ALL.map(a => [a.model, a] as const))(
    '%s does not hide a pane it also declares a capability for',
    (_model, { entry, model }) => {
      const caps = entry.descriptor(model).ui;
      // A hidden pane plus a live capability is a contradiction: one of the
      // two is stale, and the pane silently wins.
      if (caps.hiddenPanes.includes('mouse-panel')) expect(caps.mouseTypes).toEqual([]);
      if (caps.hiddenPanes.includes('banks-panel')) expect(caps.memoryLayout).toBe(false);
    },
  );
});
