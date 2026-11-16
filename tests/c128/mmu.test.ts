/**
 * The 8722 MMU's registers, from the C128 Programmer's Reference Guide's
 * description of $D500-$D50B and $FF00-$FF04: what each register stores and
 * reads back, the load-configuration addresses, the common RAM boundaries at
 * every size, and the latched high bytes of the page 0 and 1 pointers.
 */

import { describe, it, expect } from 'vitest';
import { Mmu } from '@/machines/c128/mmu.ts';

const CR = 0, PCRA = 1, PCRB = 2, PCRC = 3, PCRD = 4, MCR = 5, RCR = 6, P0L = 7, P0H = 8, P1L = 9, P1H = 10, VER = 11;

function mmu(): Mmu {
  const m = new Mmu();
  m.reset();
  return m;
}

describe('MMU registers', () => {
  it('stores CR, the four preconfigurations and RCR as written', () => {
    const m = mmu();
    for (const [reg, v] of [[CR, 0xA5], [PCRA, 0x3F], [PCRB, 0x7F], [PCRC, 0x3E], [PCRD, 0x7E], [RCR, 0x0B]] as const) {
      m.write(reg, v);
      expect(m.read(reg), `register ${reg}`).toBe(v);
    }
  });

  it('keeps bits 4 and 5 of the mode register set when stored, and reads the cartridge pins in them', () => {
    const m = mmu();
    m.write(MCR, 0x00);
    expect(m.mcr).toBe(0x30);
    // Nothing in the cartridge port: both pins high, which read as 1; the key is up.
    expect(m.read(MCR)).toBe(0xB0);
    m.game = false;
    expect(m.read(MCR) & 0x10, '/GAME pulled low reads 0').toBe(0);
    m.exrom = false;
    expect(m.read(MCR) & 0x20, '/EXROM pulled low reads 0').toBe(0);
  });

  it('reads the 40/80 DISPLAY key in bit 7: 1 while it is up', () => {
    const m = mmu();
    expect(m.read(MCR) & 0x80).toBe(0x80);
    m.displayKeyUp = false;
    expect(m.read(MCR) & 0x80).toBe(0);
  });

  it('chooses the CPU, the mode and the fast serial direction from the mode register', () => {
    const m = mmu();
    expect(m.cpu8502, 'the Z80 starts').toBe(false);
    expect(m.c64Mode).toBe(false);
    m.write(MCR, 0x01);
    expect(m.cpu8502).toBe(true);
    m.write(MCR, 0x40);
    expect(m.c64Mode).toBe(true);
    expect(m.cpu8502).toBe(false);
    m.write(MCR, 0x08);
    expect(m.fastSerialOut).toBe(true);
  });

  it('says so when the CPU or the fast serial direction changes, and not otherwise', () => {
    const m = mmu();
    const cpu: boolean[] = [], dir: boolean[] = [];
    m.onCpuChange = (to8502) => cpu.push(to8502);
    m.onFastSerialDir = (out) => dir.push(out);
    m.write(MCR, 0x31);                    // to the 8502
    m.write(MCR, 0x31);                    // no change
    m.write(MCR, 0x38);                    // back to the Z80, fast serial out
    m.write(MCR, 0x39);                    // to the 8502 again
    m.write(MCR, 0x30);                    // the Z80, fast serial in
    expect(cpu).toEqual([true, false, true, false]);
    expect(dir).toEqual([true, false]);
  });

  it('reads the version register as two 64K blocks, version 0, and cannot write it', () => {
    const m = mmu();
    expect(m.read(VER)).toBe(0x20);
    m.write(VER, 0xFF);
    expect(m.read(VER)).toBe(0x20);
  });

  it('reads $FF everywhere else in the page', () => {
    const m = mmu();
    for (const reg of [0x0C, 0x0F, 0x80, 0xFF]) expect(m.read(reg)).toBe(0xFF);
  });

  it('powers on with the Z80 in charge, everything else cleared, page 1 at page 1', () => {
    const m = mmu();
    expect([m.cr, m.rcr, m.p0l, m.p0h, m.p1l, m.p1h]).toEqual([0, 0, 0, 0, 1, 0]);
    expect(m.cpu8502).toBe(false);
  });
});

describe('MMU load-configuration addresses', () => {
  it('writing $FF00 writes CR', () => {
    const m = mmu();
    m.writeFF(0xFF00, 0x3E);
    expect(m.cr).toBe(0x3E);
  });

  it('writing $FF01-$FF04 loads PCRA-PCRD into CR, whatever the value written', () => {
    const m = mmu();
    m.pcr.set([0x01, 0x42, 0x83, 0xC4]);
    for (let n = 1; n <= 4; n++) {
      m.writeFF(0xFF00 + n, 0x99);
      expect(m.cr, `$FF0${n}`).toBe(m.pcr[n - 1]);
    }
  });

  it('reads CR and the preconfigurations back from $FF00-$FF04', () => {
    const m = mmu();
    m.write(CR, 0x11);
    m.write(PCRA, 0x22); m.write(PCRB, 0x33); m.write(PCRC, 0x44); m.write(PCRD, 0x55);
    expect([0, 1, 2, 3, 4].map((n) => m.readFF(0xFF00 + n))).toEqual([0x11, 0x22, 0x33, 0x44, 0x55]);
  });
});

describe('MMU common RAM', () => {
  const cases: [number, number][] = [[0, 0x400], [1, 0x1000], [2, 0x2000], [3, 0x4000]];

  it.each(cases)('RCR size bits %i make the common RAM %i bytes', (bits, size) => {
    const m = mmu();
    m.write(RCR, bits);
    expect(m.commonSize).toBe(size);
  });

  it.each(cases)('size bits %i: top common starts at 64K less the size, bottom common ends at the size', (bits, size) => {
    const m = mmu();
    m.write(RCR, 0x0C | bits);
    expect(m.topCommonStart).toBe(0x10000 - size);
    expect(m.bottomCommonEnd).toBe(size);
  });

  it('has no common RAM at the top or the bottom unless bit 3 or bit 2 asks', () => {
    const m = mmu();
    m.write(RCR, 0x03);
    expect(m.topCommonStart).toBe(0x10000);
    expect(m.bottomCommonEnd).toBe(0);
    m.write(RCR, 0x0B);
    expect(m.topCommonStart).toBe(0xC000);
    expect(m.bottomCommonEnd).toBe(0);
    m.write(RCR, 0x07);
    expect(m.topCommonStart).toBe(0x10000);
    expect(m.bottomCommonEnd).toBe(0x4000);
  });

  it('always reaches block 0 inside the common RAM and the chosen block outside it', () => {
    const m = mmu();
    m.write(RCR, 0x0D);                    // 4K at both ends
    expect(m.ramAddress(0x0FFF, 1)).toBe(0x0FFF);
    expect(m.ramAddress(0x1000, 1)).toBe(0x11000);
    expect(m.ramAddress(0xEFFF, 1)).toBe(0x1EFFF);
    expect(m.ramAddress(0xF000, 1)).toBe(0xF000);
    expect(m.ramAddress(0x1234, 0)).toBe(0x1234);
  });

  it('reads the VIC-IIe block and the CPU block from the right bits', () => {
    const m = mmu();
    m.write(CR, 0x40);
    m.write(RCR, 0x40);
    expect([m.ramBlock, m.vicBlock]).toEqual([1, 1]);
    m.write(CR, 0x00);
    expect([m.ramBlock, m.vicBlock]).toEqual([0, 1]);
  });
});

describe('MMU page 0 and page 1 pointers', () => {
  it('latches a high byte until its low byte is written', () => {
    const m = mmu();
    m.write(P0H, 0x01);
    expect(m.p0h, 'not yet').toBe(0);
    m.write(P0L, 0x20);
    expect([m.p0l, m.p0h]).toEqual([0x20, 0x01]);
    m.write(P1H, 0x01);
    expect(m.p1h).toBe(0);
    m.write(P1L, 0x30);
    expect([m.p1l, m.p1h]).toEqual([0x30, 0x01]);
  });

  it('reads the unused upper bits of the high bytes as 1', () => {
    const m = mmu();
    expect(m.read(P0H)).toBe(0xF0);
    expect(m.read(P1H)).toBe(0xF0);
    m.write(P0H, 0x01); m.write(P0L, 0);
    expect(m.read(P0H)).toBe(0xF1);
  });

  it('reports no relocation at power-on and after the pointers are put back', () => {
    const m = mmu();
    expect(m.relocated).toBe(false);
    m.write(P0L, 5);
    expect(m.relocated).toBe(true);
    m.write(P0L, 0);
    expect(m.relocated).toBe(false);
  });

  it('relocates page 0 and page 1, swapping each with the page it went to', () => {
    const m = mmu();
    m.write(P0L, 0x40); m.write(P1L, 0x41);
    // Page 0 and 1 of the CPU are the pages at $4000 and $4100 of RAM.
    expect(m.relocate(0x0010)).toBe(0x4010);
    expect(m.relocate(0x0110)).toBe(0x4110);
    // And those pages are where page 0 and 1 were. ($4000 is RAM only when CR says so.)
    expect(m.relocate(0x4010), 'low BASIC ROM is in view: no swap').toBe(-1);
    m.write(CR, 0x02);
    expect(m.relocate(0x4010)).toBe(0x0010);
    expect(m.relocate(0x4110)).toBe(0x0110);
    expect(m.relocate(0x5000), 'an unrelated page').toBe(-1);
  });

  it('never moves the CPU port at $00 and $01', () => {
    const m = mmu();
    m.write(P0L, 0x40);
    expect(m.relocate(0x0000)).toBe(-1);
    expect(m.relocate(0x0001)).toBe(-1);
    expect(m.relocate(0x0002)).toBe(0x4002);
  });

  it('takes the RAM block for a relocated page from bit 0 of its high byte', () => {
    const m = mmu();
    m.write(P0H, 0x01); m.write(P0L, 0x20);
    expect(m.relocate(0x0005)).toBe(0x10000 + 0x2005);
  });

  it('keeps pages 0 and 1 in block 0 while the bottom common RAM holds them', () => {
    const m = mmu();
    m.write(P0H, 0x01); m.write(P0L, 0x20);
    m.write(RCR, 0x04);
    expect(m.relocate(0x0005)).toBe(0x2005);
  });
});
