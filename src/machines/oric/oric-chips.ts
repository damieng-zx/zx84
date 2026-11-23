/**
 * The Oric's chip dumps for the debugger: the ULA's state, the 6522 VIA and the
 * AY-3-8912 as it is wired (behind VIA port A rather than on the bus).
 *
 * Every line here reads a chip's own state, never through the CPU's bus, so
 * taking a dump does not clear an interrupt flag.
 */

import type { ChipSection } from '@/debug/chip-state.ts';
import { hex8 } from '@/utils/hex.ts';
import type { OricMachine } from './oric-machine.ts';
import { ORIC_PSG_PORT_A } from './constants.ts';

const VIA_REGS = [
  'ORB', 'ORA', 'DDRB', 'DDRA', 'T1CL', 'T1CH', 'T1LL', 'T1LH',
  'T2CL', 'T2CH', 'SR', 'ACR', 'PCR', 'IFR', 'IER', 'ORAh',
];

/** PCR handshake modes, for the one-line summary. */
const PCR_MODE = ['falling', 'rising', 'falling', 'rising', 'low', 'low', 'low', 'high'];

export function oricChips(m: OricMachine): readonly ChipSection[] {
  return [
    {
      name: 'ula',
      description: 'HCS10017 ULA - serial-attribute video, memory decode and clock generation',
      dump: () => {
        const ula = m.ula;
        return [
          `Mode  ${hex8(ula.mode)}  (${ula.hires ? 'HIRES' : 'TEXT'}, ${ula.sixtyHz ? '60' : '50'} Hz)`,
          `Blink field ${ula.fieldCounter}  (${(ula.fieldCounter & 0x20) !== 0 ? 'flash on' : 'flash off'})`,
          'Screen  text $BB80  hires $A000  tail $BF68',
          'Charset text $B400/$B800  hires $9800/$9C00',
        ].join('\n');
      },
    },
    {
      name: 'via',
      description: 'MOS 6522 VIA - keyboard row select, PSG bus, cassette and printer lines',
      dump: () => {
        const via = m.via;
        const regs = [
          via.orb, via.ora, via.ddrb, via.ddra, via.t1Counter & 0xFF, (via.t1Counter >> 8) & 0xFF,
          via.t1Latch & 0xFF, (via.t1Latch >> 8) & 0xFF, via.t2Counter & 0xFF, (via.t2Counter >> 8) & 0xFF,
          via.sr, via.acr, via.pcr, via.ifr, via.ier, via.ora,
        ];
        const lines: string[] = [];
        for (let i = 0; i < regs.length; i += 4) {
          lines.push(VIA_REGS.slice(i, i + 4).map((n, j) => `${n} ${hex8(regs[i + j])}`).join('   '));
        }
        const ca2 = (via.pcr >> 1) & 7;
        const cb2 = (via.pcr >> 5) & 7;
        lines.push(
          `CA2 ${PCR_MODE[ca2]}   CB2 ${PCR_MODE[cb2]}   CA1 ${(via.pcr & 0x01) ? 'rising' : 'falling'}`,
          `row select ${via.orb & 0x07}   sense ${(via.portBInput & 0x08) ? 'no key' : 'key'}`,
        );
        return lines.join('\n');
      },
    },
    {
      name: 'psg',
      description: 'AY-3-8912 - three tone channels, noise and envelope, behind VIA port A',
      dump: () => m.psg.describe().join('\n'),
    },
    {
      name: 'memory',
      description: 'ROM / overlay RAM / Microdisc EPROM select',
      dump: () => [
        `ROMDIS  ${m.memory.basicRomOn ? 'BASIC ROM at $C000' : 'overlay RAM at $C000'}`,
        `EPROM   ${m.memory.epromOn ? 'Microdisc EPROM at $E000' : 'off'}`,
        `PSG port A ${hex8(m.psg.ay.readRegister(ORIC_PSG_PORT_A))}`,
      ].join('\n'),
    },
  ];
}
