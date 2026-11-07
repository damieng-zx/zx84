/**
 * The debugger's chip dumps for the 64: they name every chip, decode what the
 * program set up, and leave the chips alone (a CIA's ICR read would clear it).
 */

import { describe, it, expect } from 'vitest';
import { C64Machine } from '@/machines/c64/c64-machine.ts';
import { Drive1541 } from '@/machines/shared/cbm/drive/drive-1541.ts';
import { parseCrt } from '@/machines/c64/cartridge.ts';
import { buildCrt, rom8k } from './crt-helper.ts';

const dump = (m: C64Machine, name: string): string => {
  const chip = m.services.debug.chips?.().find(c => c.name === name);
  expect(chip, name).toBeDefined();
  return chip!.dump();
};

describe('C64 chip_state', () => {
  it('offers the VIC-II, SID, both CIAs and the PLA, and the drive when fitted', () => {
    const m = new C64Machine('c64', null);
    expect(m.services.debug.chips?.().map(c => c.name)).toEqual(['vic', 'sid', 'cia1', 'cia2', 'pla']);
    m.installDrive(new Uint8Array(0x4000));
    expect(m.services.debug.chips?.().map(c => c.name)).toEqual(['vic', 'sid', 'cia1', 'cia2', 'pla', 'drive']);
    m.destroy();
  });

  it('decodes the VIC-II: mode, pointers and a sprite', () => {
    const m = new C64Machine('c64', null);
    m.reset();
    const r = m.vic.regs;
    r[0x11] = 0x3B;                 // bitmap, display on, 25 rows, YSCROLL 3
    r[0x16] = 0x18;                 // multicolour, 40 columns
    r[0x18] = 0x38;                 // screen $0C00, bitmap $2000
    r[0x15] = 0x04; r[0x04] = 100; r[0x05] = 60; r[0x10] = 0x04; r[0x29] = 7;
    const text = dump(m, 'vic');
    expect(text).toContain('bitmap multicolour');
    expect(text).toContain('25 rows, YSCROLL 3');
    expect(text).toContain('screen $0C00, bitmap $2000');
    expect(text).toMatch(/2 +on +356 +60 +7/);
    m.destroy();
  });

  it('decodes a SID voice into a pitch and waveform', () => {
    const m = new C64Machine('c64', null);
    m.reset();
    m.sid.write(0, 0x00); m.sid.write(1, 0x1D);       // $1D00 = 7424: about 436 Hz
    m.sid.write(4, 0x41);                             // pulse + gate
    m.sid.write(24, 0x1F);
    const text = dump(m, 'sid');
    expect(text).toMatch(/Voice 1 .*freq 1D00 \(436\.\d Hz\)/);
    expect(text).toContain('pulse  GATE');
    expect(text).toContain('volume 15');
    m.destroy();
  });

  it('shows the CIA timers and the serial bus lines', () => {
    const m = new C64Machine('c64', null);
    m.reset();
    m.cia2.pra = 0x3F; m.cia2.ddra = 0x3F;
    const text = dump(m, 'cia2');
    expect(text).toContain('Timer A');
    expect(text).toContain('ATN low');
    m.destroy();
  });

  it('does not disturb the chips it reads', () => {
    const m = new C64Machine('c64', null);
    m.reset();
    m.cia1.icrFlags = 0x81; m.cia1.icrMask = 0x01;
    m.vic.irqFlags = 0x01;
    for (const c of m.services.debug.chips!()) c.dump();
    expect(m.cia1.icrFlags).toBe(0x81);
    expect(m.vic.irqFlags).toBe(0x01);
    m.destroy();
  });

  it('reports the drive: head, bus and VIAs', () => {
    const m = new C64Machine('c64', null);
    m.installDrive(new Uint8Array(0x4000));
    m.reset();
    const text = dump(m, 'drive');
    expect(text).toContain('DOS ROM loaded');
    expect(text).toContain('track 18');
    expect(text).toContain('VIA 2 disk controller');
    expect(new Drive1541().hasRom).toBe(false);
    m.destroy();
  });

  it('reports a cartridge: board, lines and bank', () => {
    const m = new C64Machine('c64', null);
    const parsed = parseCrt(buildCrt(32, 1, 0, [
      { bank: 0, load: 0x8000, data: rom8k(1) }, { bank: 0, load: 0xA000, data: rom8k(2) },
    ], 'EF'));
    if ('error' in parsed) throw new Error(parsed.error);
    m.setCartridge(parsed.cart);
    m.reset();
    expect(m.services.debug.chips?.().map(c => c.name)).toContain('cart');
    const text = dump(m, 'cart');
    expect(text).toContain('EasyFlash');
    expect(text).toContain('Ultimax');
    expect(text).toContain('ROMH $E000 in');
    expect(m.services.probe.panes.memoryMap!()!.slots.find(s => s.range === 'E000-FFFF')?.read).toBe('Cartridge ROMH');
    expect(m.services.probe.panes.memoryMap!()!.registers.some(r => r.name === 'Cartridge')).toBe(true);
    m.destroy();
  });
});
