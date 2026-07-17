/**
 * CPC Multiface Two — port decode, slot-0 overlay paging, RAM persistence and
 * the STOP-button NMI.
 *
 * Expectations come from the Multiface 2 hardware model (grimware/cpctech):
 * OUT &FEE8 pages in, &FEEA pages out (bit 0 don't-care, bit 1 selects); ROM
 * sits at 0x0000-0x1FFF, RAM at 0x2000-0x3FFF; STOP pages in + NMIs to 0x0066.
 */

import { describe, it, expect } from 'vitest';
import { CpcMemory } from '@/machines/cpc/cpc-memory.ts';
import { createCpcConfig } from '@/machines/cpc/config.ts';
import { CpcMultiface } from '@/machines/cpc/peripherals/cpc-multiface.ts';
import { Z80 } from '@/cores/z80.ts';

const SLOT = 0x4000;

/** 48KB ROM image: OS=0x11, BASIC=0x22, AMSDOS=0x33 (each 16KB). */
function makeRom(): Uint8Array {
  const img = new Uint8Array(SLOT * 3);
  img.fill(0x11, 0, SLOT);
  img.fill(0x22, SLOT, SLOT * 2);
  img.fill(0x33, SLOT * 2, SLOT * 3);
  return img;
}

function setup() {
  const mem = new CpcMemory(createCpcConfig('cpc6128'));
  mem.loadROM(makeRom());
  const mf = new CpcMultiface();
  mf.loadROM(new Uint8Array(8192).fill(0xC9)); // RET-filled MF2 ROM
  mf.enabled = true;
  return { mem, mf };
}

describe('CpcMultiface port decode', () => {
  it('decodes &FEE8 as page-in and &FEEA as page-out', () => {
    const mf = new CpcMultiface();
    expect(mf.matchPortOut(0xFEE8)).toBe('in');
    expect(mf.matchPortOut(0xFEEA)).toBe('out');
  });

  it('ignores address bit 0 (don\'t-care)', () => {
    const mf = new CpcMultiface();
    expect(mf.matchPortOut(0xFEE9)).toBe('in');  // &FEE8 | A0
    expect(mf.matchPortOut(0xFEEB)).toBe('out');  // &FEEA | A0
  });

  it('returns null for unrelated ports', () => {
    const mf = new CpcMultiface();
    expect(mf.matchPortOut(0xFEE0)).toBeNull();
    expect(mf.matchPortOut(0x7F00)).toBeNull(); // Gate Array
    expect(mf.matchPortOut(0xFEEC)).toBeNull(); // bit 2 set → out of pattern
  });
});

describe('CpcMultiface slot-0 overlay', () => {
  it('overlays ROM at 0x0000 and RAM at 0x2000 on page-in, restores on page-out', () => {
    const { mem, mf } = setup();
    // Before: lower OS ROM is visible at 0x0000.
    expect(mem.readByte(0x0000)).toBe(0x11);

    mf.pageIn(mem);
    expect(mem.readByte(0x0000)).toBe(0xC9);  // MF2 ROM
    expect(mem.readByte(0x1FFF)).toBe(0xC9);
    expect(mem.readByte(0x2000)).toBe(0x00);  // MF2 RAM (cleared)

    mf.pageOut(mem);
    expect(mem.readByte(0x0000)).toBe(0x11);  // OS ROM back
  });

  it('persists writes to MF2 RAM across a page-out/page-in cycle', () => {
    const { mem, mf } = setup();
    mf.pageIn(mem);
    mem.writeByte(0x2500, 0x42);             // into MF2 RAM
    expect(mem.readByte(0x2500)).toBe(0x42);
    mf.pageOut(mem);

    // Underlying CPC RAM was NOT written (the overlay caught the write).
    expect(mem.getRamBank(0)[0x2500]).toBe(0x00);

    mf.pageIn(mem);
    expect(mem.readByte(0x2500)).toBe(0x42); // preserved in mfRam
  });

  it('keeps the overlay across a RAM bank switch while paged in', () => {
    const { mem, mf } = setup();
    mf.pageIn(mem);
    mem.setRamConfig(2);                      // remap slots to expansion banks
    expect(mem.readByte(0x0000)).toBe(0xC9);  // MF2 ROM still overlaid
    mf.pageOut(mem);
    expect(mem.readByte(0x0000)).toBe(0x11);
  });
});

describe('CpcMultiface I/O shadow recording', () => {
  it('records GA / CRTC / ROM-select / PPI writes at the MF2 RAM offsets', () => {
    const { mem, mf } = setup();
    // The game programs the (write-only) chips; the MF2 PAL snoops each OUT.
    mf.recordOut(0x7F00, 0x8D); // GA RMR: mode + ROM bits (val bits 7-6 = 10)
    mf.recordOut(0x7FC0, 0xC5); // GA RAM config (bits 7-6 = 11)
    mf.recordOut(0x7F00, 0x00); // GA pen-select 0 (bits 00)
    mf.recordOut(0x7F40, 0x4A); // GA colour for pen 0 (bits 01)
    mf.recordOut(0x7F10, 0x10); // GA pen-select border (bit 4 set)
    mf.recordOut(0x7F40, 0x55); // GA border colour
    mf.recordOut(0xBC00, 6);    // CRTC register-select 6
    mf.recordOut(0xBD00, 30);   // CRTC data → reg 6
    mf.recordOut(0xDF00, 7);    // upper-ROM select
    mf.recordOut(0xF700, 0x82); // PPI control

    // Page in so the shadow is readable at its CPU addresses (0x2000-0x3FFF).
    mf.pageIn(mem);
    expect(mem.readByte(0x3fef)).toBe(0x8D); // RMR
    expect(mem.readByte(0x3fff)).toBe(0xC5); // RAM config
    expect(mem.readByte(0x3fcf)).toBe(0x10); // last pen-select
    expect(mem.readByte(0x3f90)).toBe(0x4A); // pen 0 colour
    expect(mem.readByte(0x3fd0)).toBe(0x55); // border colour (0x3f90|0x40)
    expect(mem.readByte(0x3cff)).toBe(6);    // CRTC select
    expect(mem.readByte(0x3db6)).toBe(30);   // CRTC reg 6 data (0x3db0|6)
    expect(mem.readByte(0x3aac)).toBe(7);    // upper-ROM select
    expect(mem.readByte(0x37ff)).toBe(0x82); // PPI control
  });

  it('freezes recording while paged in so Return restores the program, not the toolkit', () => {
    const { mem, mf } = setup();
    // Program's pre-STOP state: screen mode 1, RAM config 0, ROM select 0.
    mf.recordOut(0x7F00, 0x8C); // GA RMR (bits 7-6 = 10): mode 0 + ROMs
    mf.recordOut(0x7FC0, 0xC0); // GA RAM config 0
    mf.recordOut(0xDF00, 0x00); // upper-ROM select 0

    // STOP: page the toolkit in. From here the toolkit reprograms the chips for
    // its own UI — those OUTs must NOT overwrite the captured shadow.
    mf.pageIn(mem);
    mf.recordOut(0x7F00, 0x8E); // toolkit picks a different mode + ROM state
    mf.recordOut(0x7FC0, 0xC3); // toolkit remaps RAM
    mf.recordOut(0xDF00, 0x07); // toolkit pages in AMSDOS

    // The shadow the toolkit's Return reads back is still the program's state.
    expect(mem.readByte(0x3fef)).toBe(0x8C); // RMR — program's, not 0x8E
    expect(mem.readByte(0x3fff)).toBe(0xC0); // RAM config — program's, not 0xC3
    expect(mem.readByte(0x3aac)).toBe(0x00); // upper-ROM — program's, not 0x07
  });

  it('resumes recording after the toolkit pages out', () => {
    const { mem, mf } = setup();
    mf.pageIn(mem);
    mf.recordOut(0x7F00, 0x8E); // ignored while paged in
    mf.pageOut(mem);
    mf.recordOut(0x7F00, 0x8D); // program runs again → recorded
    mf.pageIn(mem);
    expect(mem.readByte(0x3fef)).toBe(0x8D);
  });
});

describe('CpcMultiface shadow seeding (enabled mid-session)', () => {
  /** A representative live chip state to seed from. */
  function liveState() {
    const pens = Array.from({ length: 17 }, (_, i) => i); // pen n → colour n
    pens[16] = 0x0B;                                       // border colour 11
    const crtcRegs = new Array(18).fill(0);
    crtcRegs[3] = 0x8E;                                    // sync widths
    crtcRegs[6] = 25;                                      // vertical displayed
    return {
      pens, selectedPen: 2, mode: 1,
      lowerRomEnabled: false,   // RMR bit 2 set
      upperRomEnabled: true,
      ramConfig: 3, ram64kBlock: 0,
      selectedUpperRom: 7,
      crtcRegs, crtcSelected: 6,
      ppiControl: 0x82,
    };
  }

  it('reconstructs the shadow from live chip state so Return works without a reboot', () => {
    const { mem, mf } = setup();
    mf.seedShadow(liveState());
    mf.pageIn(mem);

    // RMR = 0x80 | mode 1 | lower-ROM-off (0x04) = 0x85.
    expect(mem.readByte(0x3fef)).toBe(0x85);
    // RAM config = 0xC0 | 3.
    expect(mem.readByte(0x3fff)).toBe(0xC3);
    // Pen colours land at 0x3f90|pen as the colour OUT byte (0x40 | colour).
    expect(mem.readByte(0x3f90)).toBe(0x40);       // pen 0 → colour 0
    expect(mem.readByte(0x3f95)).toBe(0x45);       // pen 5 → colour 5
    expect(mem.readByte(0x3fd0)).toBe(0x4B);       // border → colour 11
    // The firmware's selected pen (2) is left current, not pen 15 / border.
    expect(mem.readByte(0x3fcf)).toBe(2);
    // CRTC register data + restored select.
    expect(mem.readByte(0x3db3)).toBe(0x8E);       // reg 3 data
    expect(mem.readByte(0x3db6)).toBe(25);         // reg 6 data
    expect(mem.readByte(0x3cff)).toBe(6);          // selected register
    // Upper-ROM select + PPI control.
    expect(mem.readByte(0x3aac)).toBe(7);
    expect(mem.readByte(0x37ff)).toBe(0x82);
  });

  it('encodes upper-ROM disable in the RMR bit when the upper ROM is off', () => {
    const { mem, mf } = setup();
    mf.seedShadow({ ...liveState(), mode: 2, lowerRomEnabled: true, upperRomEnabled: false });
    mf.pageIn(mem);
    // 0x80 | mode 2 | upper-ROM-off (0x08) = 0x8A.
    expect(mem.readByte(0x3fef)).toBe(0x8A);
  });

  it('does not seed while the cartridge is paged in', () => {
    const { mem, mf } = setup();
    mf.pageIn(mem);                 // toolkit active — shadow must stay frozen
    mf.seedShadow(liveState());
    expect(mem.readByte(0x3fef)).toBe(0x00); // nothing written
    expect(mem.readByte(0x37ff)).toBe(0x00);
  });
});

describe('CpcMultiface STOP button', () => {
  it('pages in and NMIs to 0x0066 when enabled with a ROM', () => {
    const { mem, mf } = setup();
    const cpu = new Z80();
    cpu.read8 = (a) => mem.readByte(a);
    cpu.write8 = (a, v) => mem.writeByte(a, v);
    cpu.pc = 0x8000;
    cpu.sp = 0xBFF0;

    mf.pressButton(mem, cpu);

    expect(mf.pagedIn).toBe(true);
    expect(cpu.pc).toBe(0x0066);             // NMI vector
    expect(cpu.iff1).toBe(false);            // NMI clears IFF1
  });

  it('does nothing when disabled or no ROM loaded', () => {
    const { mem } = setup();
    const cpu = new Z80();
    cpu.read8 = (a) => mem.readByte(a);
    cpu.write8 = (a, v) => mem.writeByte(a, v);
    cpu.pc = 0x8000;

    const off = new CpcMultiface();          // enabled=false, romLoaded=false
    off.pressButton(mem, cpu);
    expect(off.pagedIn).toBe(false);
    expect(cpu.pc).toBe(0x8000);

    const noRom = new CpcMultiface();
    noRom.enabled = true;                     // enabled but no ROM
    noRom.pressButton(mem, cpu);
    expect(noRom.pagedIn).toBe(false);
    expect(cpu.pc).toBe(0x8000);
  });
});
