/**
 * The CPC's Hardware-pane fit: RAM expansion banking, the PPI links, the CRTC
 * type's effect on the Gate Array interrupt, and the 464's DDI-1 port decode.
 *
 * Expectations from the hardware documentation, not the implementation:
 *   - Gate Array RAM command %11bbbccc (CPCWiki "Gate Array" / "I/O port
 *     summary"): ccc picks one of the eight standard configurations, bbb the
 *     64K block that supplies the configuration's banks 4–7. Configuration 4
 *     maps block bank 0 at &4000, configuration 2 maps all four at &0000–&FFFF.
 *     The 6128's own logic ignores bbb (its internal 64K is block 0), so with a
 *     Dk'tronics expansion fitted the expansion's block 0 is hidden; a block
 *     nothing answers for leaves the internal 64K on a 6128 and the base RAM on
 *     a 464.
 *   - .SNA memory sizes 64K, 128K, 320K (64+256) and 576K (64+512) (CPCWiki
 *     "SNA snapshot file format").
 *   - PPI Port B bits 3..1 = distributor (7 Amstrad, 5 Schneider, 4 Awa, ...),
 *     bit 4 = 1 for 50 Hz (CPCWiki "8255").
 *   - HSYNC width 0 is no HSYNC on CRTC types 0/1 and 16 characters on type 2
 *     (CPCWiki "CRTC"); the Gate Array counts HSYNCs for its interrupt.
 *   - DDI-1: the uPD765A at &FB7E (status) / &FB7F (data) (CPCWiki "765 FDC").
 */

import { describe, it, expect } from 'vitest';
import { CpcMemory } from '@/machines/cpc/cpc-memory.ts';
import { createCpcConfig } from '@/machines/cpc/config.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { CPC_DEFAULT_OPTIONS, type CpcOptions } from '@/machines/cpc/options.ts';


/** Mark every bank with its own number at offset 0 so a read shows which bank
 *  is mapped. */
function marked(model: 'cpc464' | 'cpc6128', kb: 0 | 256 | 512): CpcMemory {
  const m = new CpcMemory(createCpcConfig(model));
  m.setExpansion(kb);
  for (let b = 0; b < m.ramBankCount; b++) m.getRamBank(b)[0] = b;
  return m;
}

function ramCommand(block: number, config: number): number {
  return 0xC0 | (block << 3) | config;
}

describe('RAM expansion banking', () => {
  it('fits 320K on a 6128 with 256K and 576K with 512K', () => {
    expect(marked('cpc6128', 256).ramBankCount * 16).toBe(320);
    expect(marked('cpc6128', 512).ramBankCount * 16).toBe(576);
    expect(marked('cpc464', 256).ramBankCount * 16).toBe(320);
    expect(marked('cpc6128', 0).ramBankCount * 16).toBe(128);
  });

  it('configuration 4 of block 2 maps that block\'s first bank at &4000', () => {
    const m = marked('cpc6128', 256);
    m.setRamConfig(ramCommand(2, 4));
    expect(m.readByte(0x4000)).toBe(4 + 2 * 4);          // bank 12
    expect(m.readByte(0x8000)).toBe(2);                  // base bank 2 untouched
  });

  it('configuration 2 of block 7 maps the whole 64K block on a 512K expansion', () => {
    const m = marked('cpc6128', 512);
    m.setRamConfig(ramCommand(7, 2));
    m.setLowerRomEnabled(false);
    m.setUpperRomEnabled(false);
    expect([0x0000, 0x4000, 0x8000, 0xC000].map(a => m.readByte(a))).toEqual([32, 33, 34, 35]);
  });

  it('writes land in the selected block only', () => {
    const m = marked('cpc6128', 256);
    m.setRamConfig(ramCommand(3, 4));
    m.writeByte(0x4001, 0x5A);
    expect(m.getRamBank(16)[1]).toBe(0x5A);
    expect(m.getRamBank(1)[1]).toBe(0);
    expect(m.getRamBank(4)[1]).toBe(0);
  });

  it('a block the 256K expansion does not have falls back to the 6128\'s internal 64K', () => {
    const m = marked('cpc6128', 256);
    m.setRamConfig(ramCommand(5, 4));
    expect(m.readByte(0x4000)).toBe(4);
  });

  it('an unexpanded 6128 ignores the block bits (internal 64K for every block)', () => {
    const m = marked('cpc6128', 0);
    m.setRamConfig(ramCommand(3, 7));
    expect(m.readByte(0x4000)).toBe(7);
  });

  it('a 464 banks only with an expansion fitted', () => {
    const plain = marked('cpc464', 0);
    plain.setRamConfig(ramCommand(0, 4));
    expect(plain.readByte(0x4000)).toBe(1);
    const expanded = marked('cpc464', 256);
    expanded.setRamConfig(ramCommand(0, 4));
    expect(expanded.readByte(0x4000)).toBe(4);           // expansion block 0
    expanded.setRamConfig(ramCommand(6, 4));             // not fitted on 256K
    expect(expanded.readByte(0x4000)).toBe(1);           // base RAM stays
  });

  it('the video fetch always reads the base 64K', () => {
    const m = marked('cpc6128', 512);
    m.setRamConfig(ramCommand(4, 2));
    expect(m.readVideo(0xC000)).toBe(3);
  });
});

function machine(model: 'cpc464' | 'cpc6128', over: Partial<CpcOptions>): CpcMachine {
  const m = new CpcMachine(model, null);
  m.fit({ ...CPC_DEFAULT_OPTIONS, ...over });
  return m;
}

describe('PPI configuration links', () => {
  it('reports Amstrad and 50 Hz by default (bits 3..1 = 7, bit 4 = 1)', () => {
    expect(new CpcMachine('cpc6128', null).ppi.readB() & 0x1E).toBe(0x1E);
  });

  it('reports the fitted distributor and the 60 Hz link', () => {
    const m = machine('cpc6128', { manufacturerCode: 5, fiftyHz: false });
    expect(m.ppi.readB() & 0x1E).toBe(5 << 1);
    m.reset();                                            // links are wiring, not state
    expect(m.ppi.readB() & 0x1E).toBe(5 << 1);
  });
});

/** Program the standard CPC CRTC set with the given R3. */
function programCrtc(m: CpcMachine, r3: number): void {
  const vals: [number, number][] = [
    [0, 63], [1, 40], [2, 46], [3, r3], [4, 38], [5, 0], [6, 25], [7, 30], [9, 7], [12, 0x30], [13, 0],
  ];
  for (const [r, v] of vals) { m.crtc.selectRegister(r); m.crtc.writeRegister(v); }
}

describe('Gate Array interrupt with an HSYNC width of 0', () => {
  // The CPU runs DI'd NOPs from empty ROM, so a requested interrupt stays
  // pending: the request is what the Gate Array raised.
  it('type 0 raises no interrupt in a whole frame (no HSYNC to count)', () => {
    const m = machine('cpc6128', { crtcType: 0 });
    m.reset();
    programCrtc(m, 0x80);
    m.tick();
    m.tick();
    expect(m.gateArray.interruptRequested).toBe(false);
    expect(m.gateArray.rasterCount).toBe(0);
  });

  it('type 2 still counts 16-character HSYNCs and raises the interrupt', () => {
    const m = machine('cpc6128', { crtcType: 2 });
    m.reset();
    programCrtc(m, 0x80);
    m.tick();
    expect(m.gateArray.interruptRequested).toBe(true);
  });
});

describe('DDI-1 on the 464', () => {
  it('without it the FDC status port floats high; with it the uPD765A answers (RQM)', () => {
    const plain = machine('cpc464', {});
    expect(plain.hasFdc).toBe(false);
    expect(plain.cpu.portIn(0xFB7E)).toBe(0xFF);
    const ddi = machine('cpc464', { ddi1: true });
    expect(ddi.hasFdc).toBe(true);
    // Idle uPD765A main status: RQM (bit 7) set, DIO (bit 6) clear.
    expect(ddi.cpu.portIn(0xFB7E) & 0xC0).toBe(0x80);
  });

  it('brings drives A: and B: to the disk service', () => {
    const m = machine('cpc464', { ddi1: true });
    expect(m.services.disks.drives.map(d => d.label)).toEqual(['A:', 'B:']);
    expect(machine('cpc464', {}).services.disks.drives).toEqual([]);
  });
});
