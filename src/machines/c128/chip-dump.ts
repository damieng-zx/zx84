/**
 * The 128's chips as the debugger's `chip_state` shows them: the VIC-IIe, the
 * SID, both CIAs, the 8563 VDC, the MMU with the 8502's port and, when drives
 * are fitted, the drives.
 *
 * Every dump reads the chips' own state, never the bus, so taking one clears
 * no interrupt flag and trips no watchpoint (a CIA ICR read would, and so
 * would a read of the VDC's data port).
 */

import type { ChipSection } from '@/debug/chip-state.ts';
import { bits, dumpCia, dumpSid, dumpVic, hx } from '@/machines/shared/cbm/chip-dump.ts';
import { cbmDriveChips } from '@/machines/shared/cbm/drive-services.ts';
import type { C128Machine } from './c128-machine.ts';
import { VDC_R } from './vdc.ts';

function dumpVicIIe(m: C128Machine): string {
  return [
    dumpVic(m.vic, m.memory.vicBase),
    '',
    `VIC-IIe  D02F = ${hx(0xF8 | m.keyboardLinesSelected)} (keyboard lines K0-K2 selected, low = on)  ` +
      `D030 = ${hx(0xFC | m.vicClockRegister)} (bit 0: 2 MHz, not modelled yet)`,
  ].join('\n');
}

function dumpCia1(m: C128Machine): string {
  return dumpCia(m.cia1, 0xDC00, (c) => [
    `        port A: keyboard columns / joystick 2   port B: keyboard rows / joystick 1`,
    `        fast serial port: shift register ${m.memory.mmu.fastSerialOut ? 'sending' : 'receiving'}` +
      ` (MMU mode register bit 3)`,
    `        joystick 2 ${bits(~c.drivenA & 0x1F, ['up', 'down', 'left', 'right', 'fire'])} (as driven)`,
  ]);
}

function dumpCia2(m: C128Machine): string {
  const drive = m.drive;
  return dumpCia(m.cia2, 0xDD00, (c) => {
    const a = c.drivenA;
    return [
      `        VIC bank ${(~a) & 3}   serial bus out: ATN ${a & 8 ? 'low' : 'high'}  CLK ${a & 0x10 ? 'low' : 'high'}  DATA ${a & 0x20 ? 'low' : 'high'}` +
        `${drive ? `   drive pulls: CLK ${drive.clkAsserted ? 'low' : 'high'}  DATA ${drive.dataAsserted ? 'low' : 'high'}` : ''}`,
      `        NMI source (with RESTORE): ${c.irq ? 'CIA 2' : 'none'}`,
    ];
  });
}

const VDC_NAMES: Readonly<Record<number, string>> = {
  0: 'HTOTAL', 1: 'HDISP', 2: 'HSYNC', 3: 'SYNCW', 4: 'VTOTAL', 5: 'VADJ', 6: 'VDISP', 7: 'VSYNC',
  8: 'INTERLACE', 9: 'CHARV', 10: 'CURSOR', 11: 'CUREND', 12: 'SCRHI', 13: 'SCRLO', 14: 'CURHI', 15: 'CURLO',
  16: 'LPV', 17: 'LPH', 18: 'UPDHI', 19: 'UPDLO', 20: 'ATRHI', 21: 'ATRLO', 22: 'CHARH', 23: 'CHARDV',
  24: 'SCROLLV', 25: 'MODE', 26: 'COLOUR', 27: 'ROWADD', 28: 'CHARSET', 29: 'ULINE', 30: 'COUNT', 31: 'DATA',
  32: 'SRCHI', 33: 'SRCLO', 34: 'DISPEN', 35: 'DISPEND', 36: 'DRAMREF', 37: 'SYNCPOL',
};

function dumpVdc(m: C128Machine): string {
  const v = m.vdc;
  const r = v.regs;
  const charset = (r[VDC_R.CHARSET] & 0xE0) << 8;
  const lines = [
    `Chip      MOS 8563  RAM ${v.ram.length >> 10}K   ${m.showing80 ? 'on the canvas' : 'not on the canvas'}   ` +
      `${v.vblank ? 'in vertical blanking' : 'beam in the display'}`,
    `Screen    $${hx((r[VDC_R.SCREEN_HI] << 8) | r[VDC_R.SCREEN_LO], 4)}  attributes $${hx((r[VDC_R.ATTR_HI] << 8) | r[VDC_R.ATTR_LO], 4)}` +
      `  ${r[VDC_R.MODE] & 0x40 ? 'attributes on' : 'attributes off'}, ${r[VDC_R.MODE] & 0x80 ? 'bitmap' : 'text'}`,
    `Geometry  ${r[VDC_R.HDISP]} columns x ${r[VDC_R.VDISP]} rows, character ${(r[VDC_R.CHARH] & 0x0F)}+ wide, ` +
      `${(r[VDC_R.CHARV] & 0x1F) + 1} lines (${r[VDC_R.CHAR_DISP_V] & 0x1F} shown)`,
    `Charset   $${hx(charset, 4)}  (R28 = ${hx(r[VDC_R.CHARSET])})`,
    `Colours   background ${r[VDC_R.COLOUR] & 15}  foreground ${r[VDC_R.COLOUR] >> 4}  ${r[VDC_R.SCROLL_V] & 0x40 ? 'screen reversed' : ''}`.trimEnd(),
    `Update    $${hx((r[VDC_R.UPDATE_HI] << 8) | r[VDC_R.UPDATE_LO], 4)}   cursor $${hx((r[14] << 8) | r[15], 4)}  mode ${(r[VDC_R.CURSOR_MODE] >> 5) & 3}`,
    '',
    'Registers:',
  ];
  for (let i = 0; i < 38; i += 8) {
    lines.push('  ' + Array.from({ length: Math.min(8, 38 - i) }, (_, k) => `${VDC_NAMES[i + k]}=${hx(r[i + k])}`).join(' '));
  }
  return lines.join('\n');
}

function dumpMmu(m: C128Machine): string {
  const mem = m.memory;
  const mmu = mem.mmu;
  const cr = mmu.cr;
  const rom = (n: number, names: readonly string[]): string => names[n];
  return [
    `CPU       ${m.cpuIs8502 ? '8502' : 'Z80'}   mode ${m.c64Mode ? 'C64' : 'C128'}   MCR $${hx(mmu.mcr)}  fast serial ${mmu.fastSerialOut ? 'out' : 'in'}`,
    `CR        $${hx(cr)}   RAM block ${mmu.ramBlock}  VIC-IIe sees block ${mmu.vicBlock}   RCR $${hx(mmu.rcr)}` +
      `  common ${mmu.commonSize >> 10}K${mmu.bottomCommonEnd ? ' bottom' : ''}${mmu.topCommonStart < 0x10000 ? ' top' : ''}`,
    `PCR       ${Array.from(mmu.pcr, v => hx(v)).join(' ')}`,
    `Pages     0 -> $${hx(mmu.p0l)} (block ${mmu.p0h & 1})   1 -> $${hx(mmu.p1l)} (block ${mmu.p1h & 1})`,
    '',
    `0000-3FFF RAM`,
    `4000-7FFF ${cr & 0x02 ? 'RAM' : 'BASIC low ROM'}`,
    `8000-BFFF ${rom((cr >> 2) & 3, ['BASIC high ROM', 'internal function ROM', 'external function ROM', 'RAM'])}`,
    `C000-FFFF ${rom((cr >> 4) & 3, ['system ROM', 'internal function ROM', 'external function ROM', 'RAM'])}`,
    `D000-DFFF ${mem.ioIn ? 'I/O' : 'character ROM / ROM / RAM'}`,
    '',
    `8502 port $00 DDR = ${hx(mem.portDdr)}   $01 data = ${hx(mem.portData)}  (bit 0/1: colour RAM bank CPU/VIC, bit 2: VIC character ROM, bits 3-5: cassette, bit 6: CAPS LOCK)`,
    `Cassette  motor ${mem.motorOn ? 'on' : 'off'}`,
  ].join('\n');
}

export function c128Chips(m: C128Machine): readonly ChipSection[] {
  return [
    { name: 'vic', description: 'VIC-IIe 8564/8566: mode, memory pointers, raster, IRQ, colours, sprites', dump: () => dumpVicIIe(m) },
    { name: 'vdc', description: 'VDC 8563 (80 columns): registers, screen and attribute addresses, character set, RAM size', dump: () => dumpVdc(m) },
    { name: 'sid', description: 'SID 6581: three voices (frequency, waveform, envelope), filter, volume', dump: () => dumpSid(m.sid, m.cpuClockHz) },
    { name: 'cia1', description: 'CIA 1 ($DC00): keyboard, joysticks, timers, IRQ, fast serial shift register', dump: () => dumpCia1(m) },
    { name: 'cia2', description: 'CIA 2 ($DD00): VIC bank, serial bus, user port, timers, NMI', dump: () => dumpCia2(m) },
    { name: 'mmu', description: 'MMU 8722 and the 8502 port: configuration, RAM block, common RAM, page relocation, which CPU runs', dump: () => dumpMmu(m) },
    ...cbmDriveChips(m.drives),
  ];
}
