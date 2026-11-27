/**
 * The Hardware-pane options that reach a machine through `applySettings`.
 *
 * These five were broken the same way: the machine read its key from the
 * SettingsView, the view had no getter for it, and the machine was handed the
 * fallback — which for the two long-standing ones was written to look like the
 * default, so the toggle appeared to do nothing at all. The companion guard
 * (`settings-view.test.ts`) checks the table statically; this checks the
 * machines actually change when the keys are set, so a machine that reads a
 * key into a field nothing consults is caught too.
 */

import { describe, expect, it } from 'vitest';
import type { SettingsView } from '@/machines/machine.ts';
import { Plus4Machine } from '@/machines/plus4/plus4-machine.ts';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import { PcwMachine } from '@/machines/pcw/pcw-machine.ts';
import { PCW_GREEN_INK, PCW_WHITE_INK } from '@/machines/pcw/constants.ts';

/** A SettingsView returning `overrides` for named keys, the fallback otherwise. */
function view(overrides: Record<string, unknown> = {}): SettingsView {
  return {
    get<T>(key: string, fallback: T): T {
      return (key in overrides ? overrides[key] : fallback) as T;
    },
  };
}

/** Build without booting: these options are applied to a stopped machine. */
function build<T extends { start?: () => Promise<void>; destroy: () => void }>(m: T): T {
  m.start = async () => {};
  return m;
}

describe('Plus/4 — the hardware options reach the machine', () => {
  it('fits and removes the 256K board from plus4-expansion', () => {
    const m = build(new Plus4Machine('plus4', null));
    try {
      m.applySettings(view({ 'plus4-expansion': 'hannes' }));
      expect(m.memoryExpansion).toBe('hannes');
      m.applySettings(view({ 'plus4-expansion': 'csory' }));
      expect(m.memoryExpansion).toBe('csory');
      m.applySettings(view({ 'plus4-expansion': 'none' }));
      expect(m.memoryExpansion).toBe('none');
    } finally { m.destroy(); }
  });

  it('unplugs the serial-bus drive from plus4-drive', () => {
    const fitted = build(new Plus4Machine('plus4', null));
    const removed = build(new Plus4Machine('plus4', null));
    try {
      expect(fitted.prepare(view({}))).not.toHaveLength(0);          // drive on by default
      fitted.prepare(view({ 'plus4-drive': false }));
      expect(fitted.services.disks.drives).toEqual([]);
      removed.prepare(view({ 'plus4-drive': true }));
      expect(removed.services.disks.drives.length).toBeGreaterThan(0);
    } finally { fitted.destroy(); removed.destroy(); }
  });
});

describe('Lynx — the hardware option reaches the machine', () => {
  it('removes the FD1793 disk interface from lynx-fdc', async () => {
    const m = new LynxMachine('lynx128', null);
    try {
      expect(m.hasDisk).toBe(true);
      expect(await m.services.media.mount(new Uint8Array(80 * 2 * 10 * 512), 'game.ldf'))
        .toMatchObject({ ok: true });
      m.services.disks.eject('a');
      m.applySettings(view({ 'lynx-fdc': false }));
      expect(m.hasDisk).toBe(false);
      // Without the interface there is nowhere for a disk to go.
      expect((await m.services.media.mount(new Uint8Array(80 * 2 * 10 * 512), 'game.ldf')).ok)
        .toBe(false);
      m.applySettings(view({ 'lynx-fdc': true }));
      expect(m.hasDisk).toBe(true);
      expect((await m.services.media.mount(new Uint8Array(80 * 2 * 10 * 512), 'game.ldf')).ok)
        .toBe(true);
    } finally { m.destroy(); }
  });

  it('cannot fit the interface on a model that never had one', () => {
    const m = new LynxMachine('lynx48', null);
    try {
      m.applySettings(view({ 'lynx-fdc': true }));
      expect(m.hasDisk).toBe(false);
    } finally { m.destroy(); }
  });
});

describe('MTX — the hardware option reaches the machine', () => {
  it('removes the FDX floppy from mtx-floppy', () => {
    const m = new MtxMachine('mtx512', null);
    try {
      m.applySettings(view({ 'mtx-floppy': true }));
      expect(m.floppyEnabled).toBe(true);
      // The MTX addresses the FDX's units as drives B: and C:.
      expect(m.services.disks.drives.map(d => d.label)).toEqual(['Drive B:', 'Drive C:']);
      m.applySettings(view({ 'mtx-floppy': false }));
      expect(m.floppyEnabled).toBe(false);
      expect(m.services.disks.drives).toEqual([]);
    } finally { m.destroy(); }
  });
});

describe('PCW — the phosphor option reaches the machine', () => {
  const ink = (model: 'pcw8256' | 'pcw9512', phosphor?: string): number => {
    const m = new PcwMachine(model, null);
    try {
      m.applySettings(view(phosphor ? { 'pcw-phosphor': phosphor } : {}));
      return m.asic.ink;
    } finally { m.destroy(); }
  };

  it("follows the model's own monitor on 'auto'", () => {
    // The 9512 shipped paper-white; every other PCW was green.
    expect(ink('pcw8256', 'auto')).toBe(PCW_GREEN_INK);
    expect(ink('pcw9512', 'auto')).toBe(PCW_WHITE_INK);
    expect(ink('pcw8256')).toBe(PCW_GREEN_INK);   // no stored choice yet
  });

  it('forces either tube when the user picks one', () => {
    expect(ink('pcw8256', 'white')).toBe(PCW_WHITE_INK);
    expect(ink('pcw9512', 'green')).toBe(PCW_GREEN_INK);
  });

  it('ignores a stale saved value and keeps the model default', () => {
    expect(ink('pcw8256', 'amber')).toBe(PCW_GREEN_INK);
  });
});
