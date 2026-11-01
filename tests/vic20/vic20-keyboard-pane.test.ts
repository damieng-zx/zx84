/**
 * The on-screen keyboard on the VIC-20: the breadbin caps the C64 uses cover
 * the VIC-20's matrix too (the two machines have the same keys), and a cap
 * pressed on the pane is seen where the KERNAL scans for it.
 */

import { describe, it, expect } from 'vitest';
import { VIC20_MATRIX } from '@/machines/vic20/keyboard.ts';
import { CBM_KEYS, type CbmKeyDef } from '@/machines/shared/ui/cbm-keyboard/layout.ts';
import { CbmOnScreenKeys } from '@/machines/shared/ui/cbm-keyboard/pad.ts';
import { firmware, machine } from './firmware.ts';

const cap = (id: string): CbmKeyDef => {
  const key = CBM_KEYS.find(k => k.id === id);
  if (!key) throw new Error(`no cap ${id}`);
  return key;
};

describe('VIC-20 on-screen keyboard', () => {
  it('has a cap for every key of the VIC-20 matrix exactly once', () => {
    const named = CBM_KEYS.filter(k => k.name !== undefined).map(k => k.name);
    expect([...named].sort()).toEqual([...VIC20_MATRIX.flat()].sort());
  });

  it('presses the matrix where the KERNAL table puts the key (Z: column 4, row 1)', () => {
    const m = machine(firmware());
    const pad = new CbmOnScreenKeys(m.keyboard);
    pad.press(cap('z'));
    m.memory.writeByte(0x9122, 0xFF);
    m.memory.writeByte(0x9120, 0xEF);                 // column 4 low
    expect(m.memory.readByte(0x9121)).toBe(0xFD);     // row 1 low
    pad.release(cap('z'));
    expect(m.memory.readByte(0x9121)).toBe(0xFF);
    m.destroy();
  });

  it('pulls RESTORE onto the NMI line while held', () => {
    const m = machine(firmware());
    const pad = new CbmOnScreenKeys(m.keyboard);
    m.tick();
    pad.press(cap('restore'));
    m.tick();
    expect(m.memory.ram[0x05]).toBe(1);
    pad.release(cap('restore'));
    m.destroy();
  });
});
