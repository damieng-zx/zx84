/**
 * The Lynx's ROM sockets and the FD1793 hardware toggle.
 *
 * Every socket is one 8K image: two system images on the 48K, three plus the
 * DOS ROM on the 96K/128K. The Hardware pane's disk-interface checkbox removes
 * the DOS socket, the .ldf media and the Drives pane.
 */

import { describe, expect, it, vi } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import type { MachineHost, SettingsView } from '@/machines/machine.ts';
import { createFrameIndicators } from '@/machines/machine.ts';
import { defaultRomPageLabel, romPageSlotCount, romSlotSize } from '@/models.ts';

const SLOT = 0x2000;

function view(overrides: Record<string, unknown> = {}): SettingsView {
  return {
    get<T>(key: string, fallback: T): T {
      return (key in overrides ? overrides[key] : fallback) as T;
    },
  };
}

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

describe('Lynx ROM sockets', () => {
  it('gives the 48K two system sockets and no DOS socket', () => {
    const m = new LynxMachine('lynx48', null);
    expect(m.services.roms.systemSlots.map(s => s.title)).toEqual(['System 1', 'System 2']);
    m.destroy();
  });

  it('gives the 128K three system sockets plus the DOS ROM', () => {
    const m = new LynxMachine('lynx128', null);
    expect(m.services.roms.systemSlots.map(s => s.title))
      .toEqual(['System 1', 'System 2', 'System 3', 'DOS ROM']);
    m.destroy();
  });

  it('drops the DOS socket when the interface is switched off', () => {
    const m = new LynxMachine('lynx128', null);
    m.applySettings(view({ 'lynx-fdc': false }));
    expect(m.hasDisk).toBe(false);
    expect(m.services.roms.systemSlots.map(s => s.title))
      .toEqual(['System 1', 'System 2', 'System 3']);
    m.destroy();
  });

  it('persists a per-socket override and reflects it', async () => {
    const m = new LynxMachine('lynx128', null);
    const { host, ops } = makeHost();
    m.attachHost(host);
    await m.services.roms.setSystemRom(new Uint8Array(SLOT).fill(0xAA), 'dos.rom', 3);
    expect(ops.persistPage).toHaveBeenCalledWith(3, expect.any(Uint8Array), 'dos.rom');
    expect(m.services.roms.systemSlots[3])
      .toMatchObject({ index: 3, label: 'dos.rom', overridden: true });
    m.destroy();
  });
});

describe('Lynx ROM slot geometry', () => {
  it('is 2/4 sockets of 8K, named per socket', () => {
    expect(romPageSlotCount('lynx48')).toBe(2);
    expect(romPageSlotCount('lynx96')).toBe(4);
    expect(romPageSlotCount('lynx128')).toBe(4);
    expect(romSlotSize('lynx128')).toBe(0x2000);
    expect(defaultRomPageLabel('lynx128', 0)).toBe('System 1');
    expect(defaultRomPageLabel('lynx128', 3)).toBe('DOS ROM');
  });
});

describe('Lynx FD1793 hardware toggle', () => {
  it('fits the interface by default on the 128K', () => {
    const m = new LynxMachine('lynx128', null);
    m.applySettings(view());
    expect(m.hasDisk).toBe(true);
    expect(m.services.media.accepts().some(t => t.ext === '.ldf')).toBe(true);
    m.destroy();
  });

  it('removes the FDC, .ldf media, drives and DOS ROM when off', async () => {
    const m = new LynxMachine('lynx128', null);
    m.applySettings(view({ 'lynx-fdc': false }));
    expect(m.hasDisk).toBe(false);
    expect(m.services.media.accepts().some(t => t.ext === '.ldf')).toBe(false);
    const res = await m.services.media.mount(new Uint8Array(819200), 'x.ldf');
    expect(res.ok).toBe(false);
    const out = createFrameIndicators();
    m.services.probe.sample(out);
    expect(out.driveLed[0]).toBe(-1);
    expect(out.driveLed[1]).toBe(-1);
    expect(m.resolveMemoryRegion('rom-dos')).toBeNull();
    m.destroy();
  });

  it('never fits it on the 48K', () => {
    const m = new LynxMachine('lynx48', null);
    m.applySettings(view({ 'lynx-fdc': true }));
    expect(m.hasDisk).toBe(false);
    m.destroy();
  });
});
