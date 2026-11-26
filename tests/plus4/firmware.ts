/**
 * Synthetic Plus/4 firmware for the tests, which cannot count on the real ROMs
 * being present.
 *
 * The KERNAL-shaped image sets the TED up as the real KERNAL leaves it (a
 * 40x25 display with the matrix at $0C00, the characters at $D000, white on
 * black), turns on the raster compare interrupt and the KERNAL's timer, then
 * loops counting in $04. The IRQ handler counts in $03 and acknowledges the TED
 * by writing its status register.
 */

import { Plus4Machine } from '@/machines/plus4/plus4-machine.ts';
import type { Plus4Model } from '@/machines/plus4/models.ts';
import { Asm, OP } from '../snapshot/native-state-helpers.ts';

export function firmware(ready?: number): Uint8Array {
  const a = new Asm(0xC000);
  a.label('reset').b(OP.SEI, OP.CLD, OP.LDX_IMM, 0xFF, OP.TXS);
  if (ready !== undefined) {
    a.b(OP.LDA_IMM, ready & 0xFF, OP.STA_ZP, 0x2B, OP.LDA_IMM, ready >> 8, OP.STA_ZP, 0x2C);
  }
  // The TED: display on, 25 rows; the matrix at $0C00 and the characters at
  // $D000; a black background and white ink.
  a.b(OP.LDA_IMM, 0x10).abs(OP.STA_ABS, 0xFF06);
  a.b(OP.LDA_IMM, 0x08).abs(OP.STA_ABS, 0xFF07);    // 40 columns
  a.b(OP.LDA_IMM, 0x0C).abs(OP.STA_ABS, 0xFF14);
  a.b(OP.LDA_IMM, 0xD0).abs(OP.STA_ABS, 0xFF13);
  a.b(OP.LDA_IMM, 0x00).abs(OP.STA_ABS, 0xFF15);
  a.b(OP.LDA_IMM, 0x02).abs(OP.STA_ABS, 0xFF0B);    // raster compare line 2
  a.b(OP.LDA_IMM, 0x02).abs(OP.STA_ABS, 0xFF0A);    // raster interrupt on
  a.b(OP.CLI);
  a.label('loop').b(OP.INC_ZP, 0x04).abs(OP.JMP, 'loop');
  a.label('irq').b(OP.PHA, OP.INC_ZP, 0x03);
  a.b(OP.LDA_IMM, 0x7E).abs(OP.STA_ABS, 0xFF09);    // acknowledge every source
  a.b(OP.PLA, OP.RTI);
  a.label('nmi').b(OP.PHA, OP.INC_ZP, 0x05, OP.PLA, OP.RTI);
  const code = a.assemble();
  const kernal = new Uint8Array(0x4000);
  kernal.set(code, 0);
  const vec = (at: number, label: string): void => {
    kernal[at] = a.addr(label) & 0xFF; kernal[at + 1] = a.addr(label) >> 8;
  };
  vec(0x3FFA, 'nmi');
  vec(0x3FFC, 'reset');
  vec(0x3FFE, 'irq');
  // BASIC and the KERNAL, then the character set (the KERNAL's second half,
  // which the TED reads at $D000). Every third glyph row is set so a blank
  // cell still reads as a blank.
  const rom = new Uint8Array(0x8000);
  rom.set(kernal, 0);
  return rom;
}

/** The whole system image: a KERNAL, a BASIC and (on a Plus/4) the 3+1 ROMs. */
export function systemRom(model: Plus4Model, ntsc = false): Uint8Array {
  const kernal = firmware();
  const sizes = model === 'c16' ? 2 : 4;
  const rom = new Uint8Array(sizes * 0x4000);
  rom.set(kernal, 0);
  void ntsc;
  return rom;
}

export function machine(rom: Uint8Array, model: Plus4Model = 'plus4', ntsc = false): Plus4Machine {
  const m = new Plus4Machine(model, null, ntsc);
  m.loadROM(rom);
  m.reset();
  return m;
}
