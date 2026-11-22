/** The Atom's custom/commodity chips as the debugger's Chips tool sees them. */

import type { ChipSection } from '@/debug/chip-state.ts';
import { hex8 } from '@/utils/hex.ts';
import type { AtomMachine } from './atom-machine.ts';

const VIA_REGS = [
  'ORB', 'ORA', 'DDRB', 'DDRA', 'T1CL', 'T1CH', 'T1LL', 'T1LH',
  'T2CL', 'T2CH', 'SR', 'ACR', 'PCR', 'IFR', 'IER', 'ORAh',
];

export function atomChips(m: AtomMachine): readonly ChipSection[] {
  return [
    {
      name: 'ppi',
      description: 'Intel 8255 PPI — keyboard row select, VDG mode pins, cassette/speaker/colour lines',
      dump: () => {
        const ppi = m.ppi;
        return [
          `CTRL ${hex8(ppi.control)}  (mode set ${(ppi.control & 0x80) !== 0 ? 'yes' : 'no'})`,
          `Port A  out ${hex8(ppi.outputLatch(0))}  dir ${hex8(ppi.direction(0))}  driven ${hex8(ppi.driven(0))}`,
          `Port B  out ${hex8(ppi.outputLatch(1))}  dir ${hex8(ppi.direction(1))}  driven ${hex8(ppi.driven(1))}`,
          `Port C  out ${hex8(ppi.outputLatch(2))}  dir ${hex8(ppi.direction(2))}  driven ${hex8(ppi.driven(2))}`,
          `Inputs  A ${hex8(ppi.portAInput)}  B ${hex8(ppi.portBInput)}  C ${hex8(ppi.portCInput)}`,
        ].join('\n');
      },
    },
    {
      name: 'via',
      description: 'MOS 6522 VIA — printer port, timers and user I/O',
      dump: () => {
        const via = m.via;
        return [
          `ACR ${hex8(via.acr)}  PCR ${hex8(via.pcr)}  IFR ${hex8(via.ifr)}  IER ${hex8(via.ier)}`,
          `ORA ${hex8(via.ora)}  DDRA ${hex8(via.ddra)}  ORB ${hex8(via.orb)}  DDRB ${hex8(via.ddrb)}`,
          `T1 ${hex8(via.t1Counter >> 8)}${hex8(via.t1Counter)} latched ${hex8(via.t1Latch >> 8)}${hex8(via.t1Latch)}` +
            `${via.t1Running ? ' running' : ''}`,
          `T2 ${hex8(via.t2Counter >> 8)}${hex8(via.t2Counter)} latched ${hex8(via.t2Latch >> 8)}${hex8(via.t2Latch)}` +
            `${via.t2Running ? ' running' : ''}`,
          `IRQ ${via.irq ? 'asserted' : 'clear'}`,
        ].join('\n');
      },
    },
    {
      name: 'vdg',
      description: 'Motorola MC6847 VDG — 32x16 text and 64x64 to 256x192 graphics',
      dump: () => {
        const v = m.vdg;
        return [
          `Mode ${v.modeName}  A/G ${v.ag ? 1 : 0}  GM ${v.gm}  CSS ${v.css ? 1 : 0}`,
          `Fetch ${v.bytesPerRow} bytes/row × ${v.linesPerRow} lines  (${v.pixelsWide} pixels wide)`,
          `Pins AS ${v.as ? 1 : 0}  INTEXT ${v.intext ? 1 : 0}  INV ${v.inv ? 1 : 0}` +
            `${v.dataPins ? ' (from data bits 6/7)' : ''}`,
        ].join('\n');
      },
    },
  ];
}

/** Names for the portio trace summary (also used by the machine's tracer). */
export function atomViaRegName(reg: number): string {
  return VIA_REGS[reg & 0x0F] ?? '';
}
