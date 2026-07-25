import { describe, expect, it, vi } from 'vitest';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import type { MachineHost } from '@/machines/machine.ts';

/**
 * The MTX ROM/Carts pane surfaces five independently-overridable 8K firmware
 * slots (OS / BASIC / ASSEM / CP/M / FDX), reusing the shared host ROM-override
 * ops. This lock-in covers MtxRomService's slot enumeration and per-slot
 * upload/revert plumbing at the MTX's 8K stride.
 */

const SLOT_SIZE = 0x2000;

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
  const host = { roms: ops, setStatus: vi.fn() } as unknown as MachineHost;
  return { host, ops, pages };
}

function service() {
  const machine = new MtxMachine('mtx512', null);
  const { host, ops, pages } = makeHost();
  machine.attachHost(host);
  return { roms: machine.services.roms, ops, pages };
}

describe('MtxRomService system slots', () => {
  it('enumerates five default slots named by ROM identity', () => {
    const { roms } = service();
    const slots = roms.systemSlots;
    expect(slots.map(s => s.label)).toEqual([
      'MTX OS', 'MTX BASIC', 'MTX ASSEM', 'CP/M Bootstrap', 'FDX Disk BASIC',
    ]);
    expect(slots.map(s => s.index)).toEqual([0, 1, 2, 3, 4]);
    expect(slots.every(s => !s.overridden)).toBe(true);
  });

  it('reflects a per-slot override in that slot only', async () => {
    const { roms } = service();
    await roms.setSystemRom(new Uint8Array(SLOT_SIZE).fill(0xAA), 'my-assem.rom', 2);

    const slots = roms.systemSlots;
    expect(slots[2]).toMatchObject({ index: 2, label: 'my-assem.rom', overridden: true });
    expect(slots[0].overridden).toBe(false);
    expect(slots[4].overridden).toBe(false);
  });
});

describe('MtxRomService per-slot upload', () => {
  it('persists a single 8K image to the targeted slot and rebuilds', async () => {
    const { roms, ops } = service();
    await roms.setSystemRom(new Uint8Array(SLOT_SIZE).fill(0x12), 'os.rom', 0);

    expect(ops.persistPage).toHaveBeenCalledTimes(1);
    expect(ops.persistPage).toHaveBeenCalledWith(0, expect.any(Uint8Array), 'os.rom');
    expect(ops.persistPage.mock.calls[0][1].length).toBe(SLOT_SIZE);
    expect(ops.rebuild).toHaveBeenCalledTimes(1);
  });

  it('splits a full concatenated firmware image across all five 8K slots', async () => {
    const { roms, ops } = service();
    await roms.setSystemRom(new Uint8Array(SLOT_SIZE * 5), 'firmware.rom', 3);

    expect(ops.persistPage).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      const [page, data] = ops.persistPage.mock.calls[i];
      expect(page).toBe(i);
      expect(data.length).toBe(SLOT_SIZE);
    }
    expect(ops.rebuild).toHaveBeenCalledTimes(1);
  });

  it('reverts one slot to its default via clearPage', async () => {
    const { roms, ops } = service();
    await roms.resetSystemRom(1);

    expect(ops.clearPage).toHaveBeenCalledWith(1);
    expect(ops.clearFull).not.toHaveBeenCalled();
    expect(ops.rebuild).toHaveBeenCalledTimes(1);
  });
});
