/**
 * The Plus/4's chips for the debugger's `chip_state`: the TED, the two PIOs,
 * the ACIA and the disk drives.
 */

import type { ChipSection } from '@/debug/chip-state.ts';
import type { M6529B } from '@/cores/m6529b.ts';
import { hex8, hex16 } from '@/utils/hex.ts';
import { PLUS4_COLOUR_NAMES } from './palette.ts';
import { cbmDriveChips } from '@/machines/shared/cbm/drive-services.ts';
import type { Plus4Machine } from './plus4-machine.ts';

const hx = (v: number, digits = 2): string => `$${digits === 4 ? hex16(v) : hex8(v)}`;

/** The TED's own colour register, as "38 (luminance 2, chroma 6)". */
function colour(value: number): string {
  const idx = value & 0x7F;
  return `${idx} (${PLUS4_COLOUR_NAMES[idx] ?? '?'})`;
}

function dumpTed(m: Plus4Machine): string {
  const t = m.ted;
  const r = t.regs;
  const cpuAddr = (a: number): number => a;
  return [
    `$FF06  ${hx(r[0x06])}  ${r[0x06] & 0x10 ? 'display on' : 'display off'}, ${r[0x06] & 0x40 ? 'ECM ' : ''}${r[0x06] & 0x20 ? 'BMM ' : ''}${r[0x06] & 0x08 ? '25 rows' : '24 rows'}, YSCROLL ${r[0x06] & 7}`,
    `$FF07  ${hx(r[0x07])}  ${r[0x07] & 0x80 ? 'reverse' : 'normal'}, ${r[0x07] & 0x08 ? '40 columns' : '38 columns'}, ${r[0x07] & 0x10 ? 'MCM' : 'hires'}, ${r[0x07] & 0x04 ? 'stop' : 'run'}${r[0x07] & 0x40 ? ', PAL' : ', NTSC'}, XSCROLL ${r[0x07] & 7}`,
    `$FF09  ${hx(t.irqStatus)}  status  $FF0A ${hx(t.irqMask)}  mask  ${t.irq ? 'IRQ asserted' : ''}`.trimEnd(),
    `$FF0B  ${hx(t.rasterIrqLine, 4)}  raster compare line; raster counter ${t.raster}`,
    `$FF0E  ${hx(r[0x0E])} ${hx(r[0x0F])} ${hx(r[0x10] & 3)} ${hx(r[0x11])}  voices: f1 ${(r[0x0E] | ((r[0x12] & 3) << 8)).toString(10)}, f2 ${(r[0x0F] | ((r[0x10] & 3) << 8)).toString(10)}, volume ${r[0x11] & 15}`,
    `$FF12  ${hx(r[0x12])}  bitmap ${hx(cpuAddr(t.bitmapAddress), 4)}`,
    `$FF13  ${hx(r[0x13])}  characters ${hx(cpuAddr(t.charAddress), 4)}${r[0x13] & 2 ? ', 1 MHz' : ''}`,
    `$FF14  ${hx(r[0x14])}  matrix ${hx(cpuAddr(t.screenAddress), 4)}, colour ${hx(cpuAddr(t.colourAddress), 4)}`,
    `$FF15  ${hx(r[0x15])}  background ${colour(r[0x15])}`,
    `$FF16  ${hx(r[0x16])} ${hx(r[0x17])} ${hx(r[0x18])} ${hx(r[0x19])}  colours 1-3 ${colour(r[0x16])}, ${colour(r[0x17])}, ${colour(r[0x18])}; extended ${colour(r[0x19])}`,
    `$FF1C  line ${t.raster}  ${t.displayOn ? (t.bitmapMode ? 'bitmap' : 'text') : 'blanked'}  mode ${t.videoMode}`,
  ].join('\n');
}

function dumpPio(pio: M6529B, base: number, notes: string[]): string {
  return [
    `data  ${hx(base, 4)} = ${hx(pio.out)}  DDR ${hx(base + 1, 4)} = ${hx(pio.ddr)}  pins in ${hx(pio.pins)}  reads ${hx(pio.value)}`,
    ...notes,
  ].join('\n');
}

export function plus4Chips(m: Plus4Machine): ChipSection[] {
  const chips: ChipSection[] = [
    {
      name: 'ted',
      description: 'The 7360 TED: register file, timers, raster compare, video addresses and colours, the two voices',
      dump: () => dumpTed(m),
    },
    {
      name: 'pio1',
      description: '6529B PIO 1 ($FD10): the user port, with the cassette PLAY line on bit 2',
      dump: () => dumpPio(m.pio1, 0xFD10, [`        cassette ${m.tapeSense ? 'PLAY down' : 'PLAY up'}`]),
    },
    {
      name: 'pio2',
      description: '6529B PIO 2 ($FD30): drives the keyboard matrix rows low, which the TED reads back',
      dump: () => dumpPio(m.pio2, 0xFD30, [`        columns the TED reads ${hx(m.ted.keyboardValue)}`]),
    },
  ];
  if (m.aciaFitted) {
    chips.push({
      name: 'acia',
      description: '6551A ACIA ($FD00): the RS-232 port',
      dump: () => [
        `data ${hx(m.acia.peek(0))}  status ${hx(m.acia.peek(1))}`,
        `command ${hx(m.acia.peek(2))}  control ${hx(m.acia.peek(3))}`,
        m.acia.irq ? 'IRQ asserted' : 'IRQ clear',
      ].join('\n'),
    });
  }
  return [...chips, ...cbmDriveChips(m.drives)];
}
