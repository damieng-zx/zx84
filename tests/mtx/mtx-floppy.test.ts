import { describe, expect, it } from 'vitest';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import type { SettingsView } from '@/machines/machine.ts';

function machine(model: 'mtx500' | 'mtx512' | 'rs128' = 'mtx512'): MtxMachine {
  const m = new MtxMachine(model, null);
  m.reset();
  return m;
}

/** A SettingsView returning `overrides` for named keys, the fallback otherwise. */
function view(overrides: Record<string, unknown> = {}): SettingsView {
  return {
    get<T>(key: string, fallback: T): T {
      return (key in overrides ? overrides[key] : fallback) as T;
    },
  };
}

/**
 * The FDX floppy subsystem is a fitted-hardware option (default on). Removing it
 * takes away drives B:/C: and the FDX Disk BASIC ROM; CP/M — which boots from a
 * floppy — force-fits it regardless of the toggle.
 */
describe('MTX floppy (FDX) hardware option', () => {
  it('fits drives B: and C: by default', () => {
    const m = machine();
    m.applySettings(view());
    expect(m.floppyEnabled).toBe(true);
    expect(m.services.disks.drives.map(d => d.label)).toEqual(['Drive B:', 'Drive C:']);
  });

  it('removes the floppy drives when mtx-floppy is off', () => {
    const m = machine();
    m.applySettings(view({ 'mtx-floppy': false }));
    expect(m.floppyEnabled).toBe(false);
    expect(m.services.disks.drives).toEqual([]);
  });

  it('CP/M force-fits the floppy even when mtx-floppy is off', () => {
    const m = machine();
    m.applySettings(view({ 'mtx-floppy': false, 'mtx-cpm': true }));
    expect(m.cpmSystemEnabled).toBe(true);
    expect(m.floppyEnabled).toBe(true);
    expect(m.services.disks.drives.length).toBe(2);
  });

  it('gates the FDX Disk BASIC ROM (page 5) to 0xFF when the floppy is not fitted', () => {
    const m = machine();
    // 40K firmware: OS·BASIC·ASSEM·CP/M·FDX, marker at the start of the FDX ROM.
    const rom = new Uint8Array(0x2000 * 5);
    rom[0x2000 * 4] = 0xAB;
    m.memory.loadRom(rom);
    m.memory.setPageRegister(0x50); // select switchable ROM page 5 (FDX)

    m.applySettings(view()); // floppy on
    expect(m.memory.readByte(0x2000)).toBe(0xAB);

    m.applySettings(view({ 'mtx-floppy': false }));
    expect(m.memory.readByte(0x2000)).toBe(0xFF);
  });
});
