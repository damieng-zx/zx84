/**
 * The 64's chips as the debugger's `chip_state` shows them: the VIC-II, the
 * SID, both CIAs, the PLA's banking and, when one is fitted, the 1541.
 *
 * Every dump reads the chips' own state, never the bus, so taking one clears
 * no interrupt flag and trips no watchpoint (a CIA ICR read would).
 */

import type { ChipSection } from '@/debug/chip-state.ts';
import { bits, dumpCia, dumpSid, dumpVic, hx } from '@/machines/shared/cbm/chip-dump.ts';
import { cbmDriveChips } from '@/machines/shared/cbm/drive-services.ts';
import type { C64Machine } from './c64-machine.ts';
import { C64_CART_TYPE_NAMES } from './cartridge.ts';

function dumpCia1(m: C64Machine): string {
  return dumpCia(m.cia1, 0xDC00, (c) => [
    `        port A: keyboard columns / joystick 2   port B: keyboard rows / joystick 1`,
    `        joystick 2 ${bits(~c.drivenA & 0x1F, ['up', 'down', 'left', 'right', 'fire'])} (as driven)`,
  ]);
}

function dumpCia2(m: C64Machine): string {
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

// ── PLA ───────────────────────────────────────────────────────────────────

function dumpPla(m: C64Machine): string {
  const mem = m.memory;
  return [
    `6510 port  $00 DDR = ${hx(mem.portDdr)}   $01 data = ${hx(mem.portData)}  (bits 0-2: LORAM, HIRAM, CHAREN)`,
    `Cassette   motor ${mem.motorOn ? 'on' : 'off'}`,
    '',
    `A000-BFFF  ${mem.basicIn ? 'BASIC ROM' : 'RAM'}`,
    `D000-DFFF  ${mem.ioIn ? 'I/O' : mem.charIn ? 'character ROM' : 'RAM'}`,
    `E000-FFFF  ${mem.kernalIn ? 'KERNAL ROM' : 'RAM'}`,
    `VIC bank   ${mem.vicBase >> 14} ($${hx(mem.vicBase, 4)}-$${hx(mem.vicBase + 0x3FFF, 4)})`,
  ].join('\n');
}

// ── Cartridge ─────────────────────────────────────────────────────────────

function dumpCart(m: C64Machine): string {
  const cart = m.cartridge;
  if (!cart) return 'No cartridge on the expansion port.';
  const mem = m.memory;
  const { exrom, game } = cart.lines;
  return [
    `Cartridge  ${cart.name || '(unnamed)'}  (${C64_CART_TYPE_NAMES[cart.type]})`,
    `Lines      EXROM ${exrom ? 'high' : 'LOW'}  GAME ${game ? 'high' : 'LOW'}  ${mem.ultimax ? 'Ultimax' : exrom === 0 && game === 0 ? '16K' : exrom === 0 ? '8K' : 'out of the way'}`,
    `Map        ROML $8000 ${mem.romlIn ? 'in' : 'out'}   ROMH ${mem.romhE ? '$E000 in' : mem.romhA ? '$A000 in' : 'out'}`,
    ...cart.describe(),
  ].join('\n');
}

export function c64Chips(m: C64Machine): readonly ChipSection[] {
  const chips: ChipSection[] = [
    { name: 'vic', description: 'VIC-II 6569: mode, memory pointers, raster, IRQ, colours, sprites', dump: () => dumpVic(m.vic, m.memory.vicBase) },
    { name: 'sid', description: 'SID 6581: three voices (frequency, waveform, envelope), filter, volume', dump: () => dumpSid(m.sid, m.cpuClockHz) },
    { name: 'cia1', description: 'CIA 1 ($DC00): keyboard, joysticks, timers, IRQ, cassette FLAG', dump: () => dumpCia1(m) },
    { name: 'cia2', description: 'CIA 2 ($DD00): VIC bank, serial bus, user port, timers, NMI', dump: () => dumpCia2(m) },
    { name: 'pla', description: '6510 I/O port and the PLA: which of BASIC, KERNAL, I/O and character ROM are banked in', dump: () => dumpPla(m) },
  ];
  if (m.cartridge) chips.push({ name: 'cart', description: 'The cartridge on the expansion port: board, EXROM/GAME lines, banks', dump: () => dumpCart(m) });
  chips.push(...cbmDriveChips(m.drives));
  return chips;
}
