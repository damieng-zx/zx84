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
import { STATUS_LED_IDS, type SaveMenuItem } from '@/machines/machine.ts';
import { machineUi } from '@/ui/machine-ui.ts';

/** Every (entry, model) pair the registry knows about. */
const ALL = registry.flatMap(entry => entry.models.map(model => ({ entry, model })));

/** Snapshot Save-menu entries → the format the snapshot service must save. */
const SNAPSHOT_FORMAT: Partial<Record<SaveMenuItem, string>> = {
  'snapshot-szx': '.szx',
  'snapshot-z80': '.z80',
  'snapshot-sna-v2': '.sna',
  'snapshot-sna-v3': '.sna',
  'snapshot-a8state': '.a8state',
};

/** Build a machine headlessly — no renderer, no ROM. */
function build(entry: (typeof registry)[number], model: (typeof ALL)[number]['model']) {
  return entry.create(model, null);
}

/** Build a machine with the Hardware-pane peripherals named in `keys` switched on
 *  (what the shell does through prepare() before the machine is used). */
function buildWith(
  entry: (typeof registry)[number], model: (typeof ALL)[number]['model'], keys: string[],
) {
  const machine = build(entry, model);
  machine.prepare?.({
    get: <T>(key: string, fallback: T): T => (keys.includes(key) ? (true as T) : fallback),
  });
  return machine;
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
      // A drive capability gated on a Hardware-pane setting only holds with it on.
      const gate = caps.requires?.builtinDisk;
      const machine = buildWith(entry, model, gate ? [gate] : []);
      try {
        if (!caps.builtinDisk) return;
        const disks = machine.services.disks;
        expect(disks).not.toBeNull();
        // A controller that is a Hardware-pane option (the MSX disk interface)
        // lists no drives until it is fitted; the pane hides itself meanwhile.
        // Fitting it through the machine's own prepare() hook must produce them.
        if (!disks!.drives.some(d => d.id === 'a') && machine.prepare) {
          const reqs = machine.prepare({
            get: <T,>(_key: string, fallback: T): T => (typeof fallback === 'boolean' ? true : fallback) as T,
          });
          for (const r of reqs) r.apply(new Uint8Array(0x4000));
        }
        // The Drive pane addresses the built-ins as 'a' and 'b'.
        expect(disks!.drives.some(d => d.id === 'a')).toBe(true);
      } finally {
        machine.destroy();
      }
    },
  );

  it.each(ALL.map(a => [a.model, a] as const))(
    '%s hides gated drives and cartridge slot until their peripheral is fitted',
    (_model, { entry, model }) => {
      const caps = entry.descriptor(model).ui;
      const diskGate = caps.requires?.builtinDisk;
      const cartGate = caps.requires?.cartridge;
      if (!diskGate && !cartGate) return;
      const bare = build(entry, model);
      const fitted = buildWith(entry, model, [diskGate, cartGate].filter((k): k is string => !!k));
      try {
        // The gate must name a setting the shell can read back.
        for (const g of [diskGate, cartGate]) if (g) expect(g).toMatch(/^[a-z0-9-]+$/);
        if (diskGate) {
          expect(bare.services.disks?.drives ?? []).toHaveLength(0);
          expect(fitted.services.disks?.drives.length ?? 0).toBeGreaterThan(0);
        }
        if (cartGate) {
          expect(caps.cartridge).toBe(true);
          expect(bare.services.roms.cartridge).toBeNull();
          expect(fitted.services.roms.cartridge).not.toBeNull();
        }
      } finally {
        bare.destroy();
        fitted.destroy();
      }
    },
  );

  it.each(ALL.map(a => [a.model, a] as const))(
    '%s backs every Save-menu entry with a service that can produce it',
    (_model, { entry, model }) => {
      const machine = build(entry, model);
      try {
        for (const item of entry.descriptor(model).ui.saveMenu) {
          const ext = SNAPSHOT_FORMAT[item];
          if (ext) {
            const snapshots = machine.services.snapshots;
            expect(snapshots, `${item} needs a snapshot service`).not.toBeNull();
            const fmt = snapshots!.formats().find(f => f.ext === ext);
            expect(fmt?.canSave, `${item} needs a saveable ${ext}`).toBe(true);
          } else if (item === 'screen-scr') {
            expect(machine.services.debug.screenExport(), 'screen-scr needs screenExport')
              .not.toBeNull();
          } else if (item === 'ram-bin') {
            expect(machine.services.debug.ramExport(), 'ram-bin needs ramExport')
              .not.toBeNull();
          } else if (item === 'tape-tap') {
            // Naming the entry promises a tape service that records what the
            // machine writes to its cassette port; the menu calls this.
            const tape = machine.services.tape;
            expect(tape, 'tape-tap needs a tape service').not.toBeNull();
            expect(typeof tape!.recordedBytes, 'tape-tap needs recordedBytes')
              .toBe('function');
          }
        }
      } finally {
        machine.destroy();
      }
    },
  );

  it.each(ALL.map(a => [a.model, a] as const))(
    '%s always offers a raw RAM dump (.bin)',
    (_model, { entry, model }) => {
      const machine = build(entry, model);
      try {
        expect(entry.descriptor(model).ui.saveMenu).toContain('ram-bin');
        expect(machine.services.debug.ramExport()).not.toBeNull();
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

  it.each(ALL.map(a => [a.model, a] as const))(
    '%s shows the System Variables pane only when it has a view for it',
    (_model, { entry, model }) => {
      // The pane body is the machine's SysVars contribution; without one it
      // renders empty, which looks broken rather than absent.
      const hasView = machineUi(entry.kind).SysVars !== undefined;
      expect(entry.descriptor(model).ui.hiddenPanes.includes('sysvar-panel')).toBe(!hasView);
    },
  );
});
