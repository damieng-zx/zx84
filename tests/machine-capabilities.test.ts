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
import { machineUi } from '@/ui/machine-ui.ts';
import { buildSettingsView } from '@/shell/settings.ts';

/** A value no setting could hold, to prove the view answered. */
const SENTINEL = Symbol('unset');

/** Every (entry, model) pair the registry knows about. */
const ALL = registry.flatMap(entry => entry.models.map(model => ({ entry, model })));

/** Build a machine headlessly — no renderer, no ROM. */
function build(entry: (typeof registry)[number], model: (typeof ALL)[number]['model']) {
  return entry.create(model, null);
}

/** The value that means "this choice setting's add-on is not fitted". */
const CHOICE_OFF = 'none';

/**
 * A SettingsView that answers `on` for the keys in `keys` and `off` for
 * everything else, with the machine's own fallback ignored — the shell's view
 * always has a value, so a test that wants a peripheral *absent* must say so.
 */
function viewWith(keys: readonly string[], on: boolean): { get<T>(key: string, fallback: T): T } {
  return {
    get: <T>(key: string, fallback: T): T => {
      if (!keys.includes(key)) return fallback;
      // A switch is on/off; a choice setting turns its add-on off at `none`
      // (the BBC's disc interface: 'none' | 'acorn' | '1770').
      if (on) return true as T;
      return (typeof fallback === 'string' ? CHOICE_OFF : false) as T;
    },
  };
}

/** Build a machine with the Hardware-pane peripherals named in `keys` switched on
 *  (what the shell does through prepare() before the machine is used). */
function buildWith(
  entry: (typeof registry)[number], model: (typeof ALL)[number]['model'], keys: string[],
) {
  const machine = build(entry, model);
  // Mirrors the shell: prepare() before the machine is used, then applySettings
  // (machines read their Hardware options in one or the other).
  machine.prepare?.(viewWith(keys, true));
  machine.applySettings?.(viewWith(keys, true));
  return machine;
}

/** Build a machine with every listed gate switched *off*, whatever the machine's
 *  own fallback is. The settings are not all off by default (the Lynx's FD1793
 *  and the Apple II's Disk II ship fitted), so "bare" has to say so explicitly
 *  or the test would be asserting against the add-on being present. */
function buildWithout(
  entry: (typeof registry)[number], model: (typeof ALL)[number]['model'], keys: string[],
) {
  const machine = build(entry, model);
  machine.prepare?.(viewWith(keys, false));
  machine.applySettings?.(viewWith(keys, false));
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
      // A drive capability gated on a Hardware-pane setting only holds with it
      // fitted: name its key, and treat a choice gate as "set to a fitted value".
      const gate = caps.requires?.builtinDisk;
      const gateKey = gate === undefined ? undefined : typeof gate === 'string' ? gate : gate.setting;
      const machine = buildWith(entry, model, gateKey ? [gateKey] : []);
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
      // A drive capability gated on a Hardware-pane setting only holds with it
      // fitted: name its key, and treat a choice gate as "set to a fitted value".
      const gate = caps.requires?.builtinDisk;
      const gateKey = gate === undefined ? undefined : typeof gate === 'string' ? gate : gate.setting;
      const cartKey = ((): string | undefined => {
        const c = caps.requires?.cartridge;
        return c === undefined ? undefined : typeof c === 'string' ? c : c.setting;
      })();
      if (!gateKey && !cartKey) return;
      const bare = buildWithout(entry, model, [gateKey, cartKey].filter((k): k is string => !!k));
      const fitted = buildWith(entry, model, [gateKey, cartKey].filter((k): k is string => !!k));
      try {
        // The gate must name a setting the shell can read back.
        for (const g of [gateKey, cartKey]) if (g) expect(g).toMatch(/^[a-z0-9-]+$/);
        if (gateKey) {
          // The invariant the pane relies on: remove the peripheral and the
          // drives are gone. Fitting it is proved by the capability test above
          // ("backs built-in drives with a disk service"), which builds with the
          // gate on; a machine whose service also needs a ROM this headless
          // build cannot supply (the MSX's Disk BASIC) legitimately stays empty.
          expect(bare.services.disks?.drives ?? []).toHaveLength(0);
        }
        if (cartKey) {
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
          if (item === 'screen-scr') {
            expect(machine.services.debug.screenExport(), 'screen-scr needs screenExport')
              .not.toBeNull();
          } else if (item === 'screen-mlt') {
            expect(machine.services.debug.screenExport('mlt'), 'screen-mlt needs screenExport(\'mlt\')')
              .not.toBeNull();
          } else if (item === 'ram-bin') {
            expect(machine.services.debug.ramExport(), 'ram-bin needs ramExport')
              .not.toBeNull();
          } else if (item === 'printer-txt') {
            // The menu calls this; it answers null until something is printed.
            expect(typeof machine.services.debug.printerExport, 'printer-txt needs printerExport')
              .toBe('function');
          } else if (item === 'tape-tap') {
            // Naming the entry promises a tape service that records what the
            // machine writes to its cassette port; the menu calls this.
            // A cassette interface that is a Hardware-pane option (the Apple
            // I's ACI) has no deck until it is fitted; the Save menu then
            // reports nothing saved. Fitting it must produce the recorder.
            let tape = machine.services.tape;
            if (!tape && machine.prepare) {
              machine.prepare({
                get: <T,>(_key: string, fallback: T): T => (typeof fallback === 'boolean' ? true : fallback) as T,
              });
              tape = machine.services.tape;
            }
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

  // Snapshots are not named in `ui.saveMenu`: the pane builds those entries
  // from `SnapshotService.formats()`. So the invariant is the other way round —
  // every format the machine says it can *save* must actually serialise, or the
  // Save menu would offer an entry that throws.
  it.each(ALL.map(a => [a.model, a] as const))(
    '%s offers every snapshot format its service says it can save',
    (_model, { entry, model }) => {
      const machine = build(entry, model);
      try {
        const saveable = (machine.services.snapshots?.formats() ?? []).filter(f => f.canSave);
        if (saveable.length === 0) return;
        // A snapshot format with no handoff token cannot be driven by the pane.
        for (const fmt of saveable) expect(fmt.ext).toMatch(/^\.[a-z0-9]+$/);
        // Two saveable entries may share an extension only if each names its own
        // token (the CPC's v2/v3 `.sna`); otherwise the menu can't tell them apart.
        const byExt = new Map<string, string[]>();
        for (const fmt of saveable) {
          const at = byExt.get(fmt.ext) ?? [];
          at.push(fmt.save ?? fmt.ext);
          byExt.set(fmt.ext, at);
        }
        for (const tokens of byExt.values()) {
          expect(new Set(tokens).size, 'duplicate save tokens for one extension')
            .toBe(tokens.length);
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
    '%s backs its Color-map choice with a readable, writable setting',
    (_model, { entry, model }) => {
      const caps = entry.descriptor(model).ui;
      // No choice declared means the pane hides the control (a mono machine).
      if (!caps.colorMapChoice) return;

      const opts = typeof caps.colorMapChoice.options === 'function'
        ? caps.colorMapChoice.options() : caps.colorMapChoice.options;
      expect(opts.length, 'a Color-map choice needs at least one option').toBeGreaterThan(0);
      for (const o of opts) {
        expect(o.value.length).toBeGreaterThan(0);
        expect(o.label.length).toBeGreaterThan(0);
      }
      // The control writes through the shell's view, so the setting must be
      // readable there; an unknown key would silently do nothing.
      const view = buildSettingsView();
      expect(view.get<string | boolean>(caps.colorMapChoice.setting, SENTINEL as never),
        `${caps.colorMapChoice.setting} is the Color-map setting but the view cannot read it`)
        .not.toBe(SENTINEL);
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
