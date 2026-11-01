/**
 * Synthetic VIC-20 firmware for the tests, which cannot count on the real
 * ROMs being present.
 */

import { Vic20Machine } from '@/machines/vic20/vic20-machine.ts';
import { Asm, OP } from '../snapshot/native-state-helpers.ts';

/**
 * A KERNAL-shaped firmware: the VIC set up as the real KERNAL leaves it
 * (22 × 23 text, screen at $1E00, white on cyan), VIA 2 timer 1 free-running
 * with its interrupt on, VIA 1's CA1 (RESTORE) interrupt on, then a loop
 * counting in $04. The IRQ handler counts in $03 and acknowledges timer 1 by
 * reading $9124; the NMI handler counts in $05 and acknowledges CA1 by
 * reading $9111.
 *
 * With `ready`, it also does what BASIC's start-up leaves behind: the start
 * of BASIC (TXTTAB, $2B) at `ready` and READY. on the top line of the screen
 * (screen codes R E A D Y .).
 */
export function firmware(ready?: number): Uint8Array {
  const a = new Asm(0xE000);
  a.label('reset').b(OP.SEI, OP.CLD, OP.LDX_IMM, 0xFF, OP.TXS);
  if (ready !== undefined) {
    a.b(OP.LDA_IMM, ready & 0xFF, OP.STA_ZP, 0x2B, OP.LDA_IMM, ready >> 8, OP.STA_ZP, 0x2C);
    [18, 5, 1, 4, 25, 46].forEach((code, i) => a.b(OP.LDA_IMM, code).abs(OP.STA_ABS, 0x1E00 + i));
  }
  a.b(OP.LDA_IMM, 12).abs(OP.STA_ABS, 0x9000);
  a.b(OP.LDA_IMM, 38).abs(OP.STA_ABS, 0x9001);
  a.b(OP.LDA_IMM, 0x96).abs(OP.STA_ABS, 0x9002);
  a.b(OP.LDA_IMM, 0x2E).abs(OP.STA_ABS, 0x9003);
  a.b(OP.LDA_IMM, 0xF0).abs(OP.STA_ABS, 0x9005);
  a.b(OP.LDA_IMM, 0x1B).abs(OP.STA_ABS, 0x900F);
  // VIA 2 timer 1: free-running, about 60 Hz, interrupt enabled.
  a.b(OP.LDA_IMM, 0x40).abs(OP.STA_ABS, 0x912B);
  a.b(OP.LDA_IMM, 0x26).abs(OP.STA_ABS, 0x9124);
  a.b(OP.LDA_IMM, 0x48).abs(OP.STA_ABS, 0x9125);
  a.b(OP.LDA_IMM, 0xC0).abs(OP.STA_ABS, 0x912E);
  // VIA 1 CA1 (RESTORE, negative edge): interrupt enabled.
  a.b(OP.LDA_IMM, 0x82).abs(OP.STA_ABS, 0x911E);
  a.b(OP.CLI);
  a.label('loop').b(OP.INC_ZP, 0x04).abs(OP.JMP, 'loop');
  a.label('irq').b(OP.PHA).abs(OP.LDA_ABS, 0x9124).b(OP.INC_ZP, 0x03, OP.PLA, OP.RTI);
  a.label('nmi').b(OP.PHA).abs(OP.LDA_ABS, 0x9111).b(OP.INC_ZP, 0x05, OP.PLA, OP.RTI);
  const code = a.assemble();
  const kernal = new Uint8Array(0x2000);
  kernal.set(code, 0);
  const vec = (at: number, label: string): void => {
    kernal[at] = a.addr(label) & 0xFF; kernal[at + 1] = a.addr(label) >> 8;
  };
  vec(0x1FFA, 'nmi');
  vec(0x1FFC, 'reset');
  vec(0x1FFE, 'irq');
  // BASIC (zeros), the KERNAL, then a character ROM whose every row is $F0.
  const rom = new Uint8Array(0x5000);
  rom.set(kernal, 0x2000);
  rom.fill(0xF0, 0x4000, 0x5000);
  return rom;
}

export function machine(rom: Uint8Array, ntsc = false): Vic20Machine {
  const m = new Vic20Machine('vic20', null, ntsc);
  m.loadROM(rom);
  m.reset();
  return m;
}
