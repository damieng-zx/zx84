/**
 * A cartridge mounted from a file stays in the slot across a browser reload:
 * the shell persists it on mount, restores it at boot (applyBootCartridge),
 * drops it on eject, and a snapshot with an empty slot does not bring a stale
 * one back. The C64 has no hidden default cartridge, so a slot with nothing
 * persisted stays empty and an eject just restarts the machine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({
  saved: null as { data: Uint8Array; name: string } | null,
  calls: [] as string[],
}));

vi.mock('@/shell/lifecycle.ts', () => ({ unpause: () => {}, autoBootLoad: () => {} }));
vi.mock('@/store/persistence.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/persistence.ts')>()),
  persistCartridge: async (_key: string, data: Uint8Array, name: string) => {
    store.calls.push(`persist ${name}`);
    store.saved = { data, name };
  },
  restoreCartridge: async () => store.saved,
  clearCartridge: () => { store.calls.push('clear'); store.saved = null; },
}));

import { setMachine, setRomData } from '@/shell/context.ts';
import { applyBootCartridge, ejectCartridge, loadFile } from '@/shell/media.ts';
import { c64Descriptor } from '@/machines/c64/descriptor.ts';
import type { Machine, MountResult } from '@/machines/machine.ts';

interface Fake { machine: Machine; slot: { name: string; inserted: string[] }; started: number }

function fakeC64(): Fake {
  const slot = {
    name: '',
    inserted: [] as string[],
    insert(_data: Uint8Array, name: string) { this.name = name; this.inserted.push(name); },
    eject() { this.name = ''; },
  };
  const f: Fake = { slot, started: 0, machine: null as unknown as Machine };
  f.machine = {
    kind: 'c64',
    model: 'c64',
    descriptor: c64Descriptor('c64'),
    start: () => { f.started++; },
    services: {
      roms: { cartridge: slot },
      media: {
        accepts: () => [{ ext: '.crt', target: 'cartridge' }],
        mount: async (_d: Uint8Array, filename: string): Promise<MountResult> => {
          slot.name = filename;
          return { ok: true, target: 'cartridge', message: `Cartridge: ${filename}` };
        },
      },
    },
  } as unknown as Machine;
  return f;
}

const crt = new Uint8Array([0x43, 0x36, 0x34, 1, 2, 3]);

describe('C64 cartridge persistence', () => {
  let f: Fake;
  beforeEach(() => {
    store.saved = null;
    store.calls.length = 0;
    f = fakeC64();
    setMachine(f.machine);
    setRomData(new Uint8Array([1]));
  });

  it('declares a persisted slot without a hidden default cartridge', () => {
    expect(f.machine.descriptor.ui.bootCartridge).toBe(true);
  });

  it('persists a cartridge mounted from a file', async () => {
    await loadFile(crt, 'game.crt');
    expect(store.calls).toEqual(['persist game.crt']);
    expect(store.saved?.data).toEqual(crt);
  });

  it('puts the persisted cartridge back into an empty slot at boot', async () => {
    await loadFile(crt, 'game.crt');
    const reloaded = fakeC64();
    setMachine(reloaded.machine);
    await applyBootCartridge();
    expect(reloaded.slot.inserted).toEqual(['game.crt']);
  });

  it('leaves an empty slot empty when nothing was persisted', async () => {
    await applyBootCartridge();
    expect(f.slot.inserted).toEqual([]);
    expect(f.slot.name).toBe('');
  });

  it('does not replace a cartridge already in the slot (a restored snapshot)', async () => {
    store.saved = { data: crt, name: 'old.crt' };
    f.slot.name = 'Cartridge';
    await applyBootCartridge();
    expect(f.slot.inserted).toEqual([]);
  });

  it('forgets the cartridge on eject and restarts the machine', async () => {
    await loadFile(crt, 'game.crt');
    const before = f.started;
    ejectCartridge();
    expect(store.saved).toBeNull();
    expect(f.started).toBe(before + 1);
    await applyBootCartridge();
    expect(f.slot.inserted).toEqual([]);
  });
});
