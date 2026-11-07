/**
 * The C64's ROM sockets: BASIC, the KERNAL and the character ROM, each one
 * chip (8K, 8K, 4K) at an 8K stride in the 20K system image.
 */

import { describe, expect, it, vi } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import type { MachineHost } from '@/machines/machine.ts';
import { defaultRomPageLabel, romPageSlotCount, romSlotSize } from '@/models.ts';

function makeHost() {
  const pages = new Map<number, { label: string; size: number }>();
  const ops = {
    persistFull: vi.fn(async () => {}),
    clearFull: vi.fn(async () => {}),
    persistPage: vi.fn(async (page: number, data: Uint8Array, label: string) => {
      pages.set(page, { label, size: data.length });
    }),
    clearPage: vi.fn(async (page: number) => { pages.delete(page); }),
    cached: vi.fn(() => null),
    cachedPage: vi.fn((page: number) => pages.get(page) ?? null),
    rebuild: vi.fn(async () => {}),
  };
  return { host: { roms: ops, setStatus: vi.fn() } as unknown as MachineHost, ops, pages };
}

describe('C64 ROM sockets', () => {
  it('has a socket per chip', () => {
    const m = new C64Machine('c64', null);
    expect(m.services.roms.systemSlots.map(s => s.title)).toEqual(['BASIC', 'KERNAL', 'Character ROM']);
    m.destroy();
  });

  it('cuts an override to its chip', async () => {
    const m = new C64Machine('c64', null);
    const { host, pages } = makeHost();
    m.attachHost(host);
    await m.services.roms.setSystemRom(new Uint8Array(0x2000), 'chars.rom', 2);
    expect(pages.get(2)).toEqual({ label: 'chars.rom', size: 0x1000 });
    expect(m.services.roms.systemSlots[2]).toMatchObject({ label: 'chars.rom', overridden: true });
    expect(m.services.roms.systemSlots[1].overridden).toBe(false);
    m.destroy();
  });

  it('splits the three ROMs end to end across every socket', async () => {
    const m = new C64Machine('c64', null);
    const { host, ops, pages } = makeHost();
    m.attachHost(host);
    const all = new Uint8Array(0x5000);
    all.fill(1, 0, 0x2000);
    all.fill(2, 0x2000, 0x4000);
    all.fill(3, 0x4000);
    await m.services.roms.setSystemRom(all, 'c64.rom', 0);
    expect([...pages.values()].map(p => p.size)).toEqual([0x2000, 0x2000, 0x1000]);
    const written = ops.persistPage.mock.calls.map(c => c[1][0]);
    expect(written).toEqual([1, 2, 3]);
    m.destroy();
  });
});

describe('C64 ROM slot geometry', () => {
  it('is three sockets at an 8K stride', () => {
    expect(romPageSlotCount('c64')).toBe(3);
    expect(romSlotSize('c64')).toBe(0x2000);
    expect(defaultRomPageLabel('c64', 1)).toBe('KERNAL');
  });
});
