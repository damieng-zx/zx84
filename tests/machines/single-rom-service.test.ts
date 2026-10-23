/** SingleRomService — the one-socket RomService behind the Apple, Einstein, Ace, ZX80/81, PCW and MSX machines. */

import { describe, it, expect } from 'vitest';
import type { MachineHost } from '@/machines/machine.ts';
import { SingleRomService } from '@/machines/shared/single-rom-service.ts';
import { PcwRomService } from '@/machines/pcw/services/roms.ts';
import { Apple2RomService } from '@/machines/apple2/services/roms.ts';
import type { PcwMachine } from '@/machines/pcw/pcw-machine.ts';
import type { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';

function fakeHost(cached: { label: string; size: number; isCustom: boolean } | null) {
  const calls: string[] = [];
  const host = {
    roms: {
      cached: () => cached,
      persistFull: async (_d: Uint8Array, label: string) => { calls.push(`persist:${label}`); },
      clearFull: async () => { calls.push('clear'); },
      rebuild: async () => { calls.push('rebuild'); },
    },
  } as unknown as MachineHost;
  return { host, calls };
}

function fakeMachine() {
  const loaded: Uint8Array[] = [];
  return { machine: { loadROM: (d: Uint8Array) => { loaded.push(d); } }, loaded };
}

describe('SingleRomService', () => {
  it('lists one slot describing the cached ROM', () => {
    const { host } = fakeHost({ label: 'my.rom', size: 8192, isCustom: true });
    const svc = new SingleRomService(fakeMachine().machine, () => host);
    expect(svc.systemSlots).toEqual([{ index: 0, label: 'my.rom', size: 8192, overridden: true }]);
  });

  it('lists an empty slot before any ROM is cached, and when headless', () => {
    const empty = { index: 0, label: '', size: 0, overridden: false };
    expect(new SingleRomService(fakeMachine().machine, () => fakeHost(null).host).systemSlots).toEqual([empty]);
    expect(new SingleRomService(fakeMachine().machine, () => null).systemSlots).toEqual([empty]);
  });

  it('installs the image straight into the machine', () => {
    const { machine, loaded } = fakeMachine();
    const rom = new Uint8Array([1, 2, 3]);
    new SingleRomService(machine, () => null).installSystemRom(rom);
    expect(loaded).toEqual([rom]);
  });

  it('persists a new ROM and then rebuilds, in that order', async () => {
    const { host, calls } = fakeHost(null);
    await new SingleRomService(fakeMachine().machine, () => host).setSystemRom(new Uint8Array(1), 'a.rom');
    expect(calls).toEqual(['persist:a.rom', 'rebuild']);
  });

  it('clears the override and then rebuilds on reset', async () => {
    const { host, calls } = fakeHost(null);
    await new SingleRomService(fakeMachine().machine, () => host).resetSystemRom();
    expect(calls).toEqual(['clear', 'rebuild']);
  });

  it('does nothing without a host', async () => {
    const svc = new SingleRomService(fakeMachine().machine, () => null);
    await expect(svc.setSystemRom(new Uint8Array(1), 'x')).resolves.toBeUndefined();
    await expect(svc.resetSystemRom()).resolves.toBeUndefined();
  });

  it('has no cartridge slot', () => {
    expect(new SingleRomService(fakeMachine().machine, () => null).cartridge).toBeNull();
  });
});

describe('SingleRomService subclasses that hide the socket', () => {
  it('Apple II lists no system slot even with a ROM cached', () => {
    const { host } = fakeHost({ label: 'a2.rom', size: 12288, isCustom: false });
    const svc = new Apple2RomService(fakeMachine().machine as unknown as Apple2Machine, () => host);
    expect(svc.systemSlots).toEqual([]);
  });

  it('PCW lists no slot, accepts the empty boot image and persists nothing', async () => {
    const { machine, loaded } = fakeMachine();
    const svc = new PcwRomService(machine as unknown as PcwMachine);
    expect(svc.systemSlots).toEqual([]);
    svc.installSystemRom(new Uint8Array(0));
    expect(loaded).toHaveLength(1);
    await expect(svc.setSystemRom(new Uint8Array(1), 'x')).resolves.toBeUndefined();
  });
});
