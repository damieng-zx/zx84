/**
 * A ROM-less 128 started by hand: its Z80 BIOS copies a program to $1100,
 * points the 8502's reset vector at it and hands over through the MMU's mode
 * register, as the real BIOS does. For tests that need the two CPUs and
 * nothing else.
 */

import { C128Machine } from '@/machines/c128/c128-machine.ts';

/** The BIOS's instructions, by address: what a debugger test steps through. */
export const BIOS_AT = {
  ldCr: 0x00, ldHl: 0x05, ldBc: 0x0B, ldir: 0x0E, ldVector: 0x13, crOn: 0x16, outMcr: 0x20, halt: 0x22,
} as const;

/** Copy `program` to $1100 with I/O off, point the 8502's reset vector at it, hand over. */
export function machineRunning(program: number[]): C128Machine {
  const bios = [
    0x3E, 0x3F, 0x32, 0x00, 0xFF,                         // 00 LD A,$3F : LD ($FF00),A    CR: RAM above $4000, I/O off
    0x21, 0x30, 0x00,                                     // 05 LD HL,table
    0x11, 0x00, 0x11,                                     // 08 LD DE,$1100
    0x01, program.length & 0xFF, program.length >> 8,     // 0B LD BC,length
    0xED, 0xB0,                                           // 0E LDIR
    0x21, 0x00, 0x11,                                     // 10 LD HL,$1100
    0x22, 0xFC, 0xFF,                                     // 13 LD ($FFFC),HL              the 8502's reset vector, in RAM
    0x3E, 0x3E, 0x32, 0x00, 0xFF,                         // 16 LD A,$3E : LD ($FF00),A    CR: I/O on again
    0x01, 0x05, 0xD5,                                     // 1B LD BC,$D505
    0x3E, 0xB1,                                           // 1E LD A,$B1
    0xED, 0x79,                                           // 20 OUT (C),A                  MCR bit 0: the 8502
    0x76,                                                 // 22 HALT
  ];
  const kernal = new Uint8Array(0x4000);
  kernal.set(bios, 0x1000);
  kernal.set(program, 0x1030);
  const m = new C128Machine(null);
  m.loadRoms(null, null, kernal, null);
  m.reset();
  return m;
}

/** A counter loop from $1105 on: INC $FB, carrying into $FC, then `extra`, then JMP back.
 *  The first five bytes ($1100) set $D030 to `d030`. */
export function counter(d030: number, extra: number[] = []): number[] {
  const body = [
    0xE6, 0xFB,                                           // INC $FB
    0xD0, 0x02,                                           // BNE +2
    0xE6, 0xFC,                                           // INC $FC
    ...extra,
  ];
  return [0xA9, d030, 0x8D, 0x30, 0xD0, ...body, 0x4C, 0x05, 0x11];
}
