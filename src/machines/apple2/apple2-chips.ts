/**
 * The Apple II's game port and video scanner as `chip_state` sections: what
 * the debugger shows of the hardware that has no registers on the bus. Every
 * dump reads the machine's own state, never the bus, so it flips no switch.
 */

import type { ChipSection } from '@/debug/chip-state.ts';
import type { Apple2Machine } from './apple2-machine.ts';
import { APPLE2_CYCLES_PER_LINE, APPLE2_TSTATES_PER_FRAME } from './constants.ts';

const hex = (v: number, w = 2): string => '$' + v.toString(16).toUpperCase().padStart(w, '0');
const onOff = (v: boolean): string => (v ? 'on' : 'off');

/** Frame, line and cycle in the line of a CPU cycle count. */
function where(t: number): string {
  const f = t % APPLE2_TSTATES_PER_FRAME;
  const line = Math.floor(f / APPLE2_CYCLES_PER_LINE);
  return `frame ${Math.floor(t / APPLE2_TSTATES_PER_FRAME)} line ${line} cycle ${f - line * APPLE2_CYCLES_PER_LINE}`;
}

function dumpGamePort(m: Apple2Machine): string {
  const p = m.paddles;
  const lines = [
    `Game connector ${p.fitted ? 'with paddles or a joystick' : 'empty (timers run to full scale, no button closes)'}`,
    `Paddles 0-3: ${[0, 1, 2, 3].map(n => p.positionOf(n)).join(' ')}   buttons 0-2: ${[0, 1, 2].map(n => (p.button(n) ? 'down' : 'up')).join(' ')}`,
    `Timers last started at cycle ${p.lastTrigger} (${where(p.lastTrigger)})`,
    `Annunciators AN0-AN3: ${p.annunciators.map(onOff).join(' ')}`,
  ];
  if (p.strobes === 0) lines.push('Utility strobe ($C040): not pulsed since reset');
  else lines.push(`Utility strobe ($C040): pulsed ${p.strobes} times, last on cycle ${p.strobeAt} (${where(p.strobeAt)})`);
  return lines.join('\n');
}

function dumpVideo(m: Apple2Machine): string {
  const lines = [
    `TEXT ${onOff(m.textMode)}  MIXED ${onOff(m.mixed)}  PAGE2 ${onOff(m.page2)}  HIRES ${onOff(m.hires)}`,
  ];
  if (m.isIie) {
    lines.push(`80COL ${onOff(m.col80)}  ALTCHARSET ${onOff(m.altCharset)}  DHIRES (AN3 off) ${onOff(m.dhires)}  80STORE ${onOff(m.mmu.store80)}`);
  }
  const t = m.cpu.tStates;
  const addr = m.scannerAddressAt(t);
  lines.push(
    `Beam now: ${where(t)} (${t % APPLE2_TSTATES_PER_FRAME < 192 * APPLE2_CYCLES_PER_LINE ? 'drawing' : 'vertical blanking'})`,
    `Scanner reading ${hex(addr, 4)} = ${hex(m.memory.ram[addr])}  (what an undriven read on this cycle returns)`,
  );
  return lines.join('\n');
}

export function apple2Chips(m: Apple2Machine): readonly ChipSection[] {
  return [
    { name: 'gameport', description: 'Game connector: paddles, push buttons, annunciators AN0-AN3, utility strobe', dump: () => dumpGamePort(m) },
    { name: 'video', description: 'Display switches, the beam, and the address the video scanner is reading (the floating bus)', dump: () => dumpVideo(m) },
  ];
}
