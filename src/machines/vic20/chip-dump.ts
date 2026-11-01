/**
 * The VIC-20's chips for the debugger's `chip_state`: the VIC and the two VIAs.
 */

import type { ChipSection } from '@/debug/chip-state.ts';
import type { M6522 } from '@/cores/m6522.ts';
import { hex8, hex16 } from '@/utils/hex.ts';
import { VIC20_COLOUR_NAMES } from './palette.ts';
import type { Vic20Machine } from './vic20-machine.ts';

const hx = (v: number, digits = 2): string => `$${digits === 4 ? hex16(v) : hex8(v)}`;

function dumpVic(m: Vic20Machine): string {
  const v = m.vic;
  const r = v.regs;
  const t = m.cpu.tStates;
  const raster = v.rasterAt(t);
  const colour = (i: number): string => `${i} (${VIC20_COLOUR_NAMES[i]})`;
  const cpuAddr = (vicAddr: number): number => ((vicAddr & 0x2000) === 0 ? 0x8000 : 0) | (vicAddr & 0x1FFF);
  return [
    `$9000  ${hx(r[0])}  origin X ${r[0] & 0x7F} cycles${r[0] & 0x80 ? ', interlace' : ''}`,
    `$9001  ${hx(r[1])}  origin Y ${r[1]} (line ${r[1] * 2})`,
    `$9002  ${hx(r[2])}  ${r[2] & 0x7F} columns`,
    `$9003  ${hx(v.read(3, t))}  ${(r[3] >> 1) & 0x3F} rows of 8×${r[3] & 1 ? 16 : 8} characters`,
    `$9004  ${hx(v.read(4, t))}  raster line ${raster}`,
    `$9005  ${hx(r[5])}  screen ${hx(cpuAddr(v.screenAddress), 4)}, characters ${hx(cpuAddr(v.charAddress), 4)}`,
    `$9006  ${hx(r[6])} ${hx(r[7])}  light pen`,
    `$9008  ${hx(v.potX)} ${hx(v.potY)}  paddles`,
    `$900A  ${hx(r[10])} ${hx(r[11])} ${hx(r[12])} ${hx(r[13])}  voices (bass, alto, soprano, noise)`,
    `$900E  ${hx(r[14])}  volume ${r[14] & 15}, auxiliary colour ${colour(r[14] >> 4)}`,
    `$900F  ${hx(r[15])}  background ${colour(r[15] >> 4)}, border ${colour(r[15] & 7)}${r[15] & 8 ? '' : ', reverse mode'}`,
  ].join('\n');
}

function dumpVia(via: M6522, base: number, notes: string[]): string {
  const timer = (n: number, counter: number, latch: number, running: boolean): string =>
    `Timer ${n}  counter ${hx(counter, 4)}  latch ${hx(latch, 4)}  ${running ? 'running' : 'stopped'}`;
  return [
    `ORB/IRB ${hx(base, 4)} = ${hx(via.orb)}  DDRB ${hx(via.ddrb)}  pins in ${hx(via.portBInput)}`,
    `ORA/IRA ${hx(base + 1, 4)} = ${hx(via.ora)}  DDRA ${hx(via.ddra)}  pins in ${hx(via.portAInput)}`,
    ...notes,
    timer(1, via.t1Counter, via.t1Latch, via.t1Running) + `  ${via.acr & 0x40 ? 'free-running' : 'one-shot'}`,
    timer(2, via.t2Counter, via.t2Latch, via.t2Running),
    `ACR ${hx(via.acr)}  PCR ${hx(via.pcr)}  SR ${hx(via.sr)}`,
    `IFR ${hx(via.ifr)}  IER ${hx(via.ier)}  ${via.irq ? 'interrupt asserted' : ''}`.trimEnd(),
  ].join('\n');
}

export function vic20Chips(m: Vic20Machine): ChipSection[] {
  return [
    {
      name: 'vic',
      description: `The ${m.timing.ntsc ? '6560' : '6561'} VIC: video origin, size and addresses, colours, raster, voices`,
      dump: () => dumpVic(m),
    },
    {
      name: 'via1',
      description: 'VIA 1 ($9110): serial bus inputs and ATN, joystick, cassette sense and motor, RESTORE (NMI)',
      dump: () => {
        const out = m.serialOut;
        return dumpVia(m.via1, 0x9110, [
          `        serial out: ATN ${out & 1 ? 'low' : 'high'}  CLK ${out & 2 ? 'low' : 'high'}  DATA ${out & 4 ? 'low' : 'high'}`,
          `        RESTORE ${m.keyboard.restore ? 'down' : 'up'}`,
        ]);
      },
    },
    {
      name: 'via2',
      description: 'VIA 2 ($9120): keyboard matrix, joystick right, cassette read and write, serial CLK/DATA out (IRQ)',
      dump: () => dumpVia(m.via2, 0x9120, []),
    },
  ];
}
