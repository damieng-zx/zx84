/**
 * Apple II soft-switch decode for the $C000-$C0FF window.
 *
 * The ][ and ][+ decode this window in sixteen-address blocks (a 74LS138 on
 * A4-A6 selects the block; only the keyboard, the 74LS259 switch latch and the
 * 74LS251 input multiplexer look at the low four bits), so each function below
 * answers at every address of its block:
 *
 *   $C000-$C00F  keyboard data (bit 7 the strobe)
 *   $C010-$C01F  clear the keyboard strobe
 *   $C020-$C02F  cassette output toggle
 *   $C030-$C03F  speaker toggle
 *   $C040-$C04F  game connector utility strobe
 *   $C050-$C057  display switches (text/mixed/page2/lores-hires)
 *   $C058-$C05F  annunciators AN0-AN3 off/on (game connector outputs)
 *   $C060-$C06F  cassette input, pushbuttons and paddle timers, in bit 7 (the
 *                eight inputs repeat at +8)
 *   $C070-$C07F  paddle trigger
 *   $C080-$C08F  slot 0 I/O — the language card's bank/ROM switches
 *   $C090-$C0FF  slot I/O; slot 6 ($C0E0-$C0EF) is the Disk II controller
 *
 * Every function but the keyboard read drives nothing onto the data bus, so a
 * read of it returns what the video scanner is fetching (`floatingBus`); the
 * 74LS251 drives only bit 7 and leaves the other seven floating. The switch is
 * tripped by the access, not by the data, which is why the same decode runs on
 * both reads and writes. (The ][ and ][+ have no read-back of the display
 * switches and no vertical-blanking flag — the //e added those.)
 */

import { DISK2_SLOT } from './constants.ts';
import type { Apple2Machine } from './apple2-machine.ts';

/** Trip one of the $C050-$C057 display switches (0 = graphics, … 7 = hires). */
export function applyVideoSwitch(m: Apple2Machine, sw: number): void {
  const on = (sw & 1) === 1;
  switch (sw >> 1) {
    case 0: m.textMode = on; break;
    case 1: m.mixed = on; break;
    case 2: m.page2 = on; break;
    case 3: m.hires = on; break;
    default: break;
  }
}

export function readApple2Io(m: Apple2Machine, addr: number): number {
  const off = addr & 0xFF;
  const bus = (): number => m.floatingBus(addr);

  switch (off >> 4) {
    case 0x0:
      m.activity.kbdReads++;
      return m.keyboard.readData();
    case 0x1: m.keyboard.clearStrobe(); return bus();
    case 0x2: m.pulseCassetteOutput(false); return bus();
    case 0x3: m.toggleSpeaker(); return bus();
    case 0x4: m.paddles.strobe(m.accessCycle(addr, false)); return bus();
    case 0x5:
      if (off <= 0x57) applyVideoSwitch(m, off - 0x50);
      else m.paddles.annunciator(off);
      return bus();
    case 0x6: {
      // Bit 7 from the 74LS251, the rest from the bus.
      let high: boolean;
      switch (off & 0x07) {
        case 0x00: high = m.cassetteInputBit; break;
        case 0x01: case 0x02: case 0x03:                 // pushbuttons read high only while pressed
          high = m.paddles.button((off & 0x07) - 1); break;
        default:                                         // paddle timers
          high = m.paddles.timerHigh((off & 0x07) - 4, m.accessCycle(addr, false));
      }
      return (high ? 0x80 : 0x00) | (bus() & 0x7F);
    }
    case 0x7: m.paddles.trigger(m.accessCycle(addr, false)); return bus();
    case 0x8: m.memory.lcAccess(off, true); return bus();
    default: break;
  }

  const slot = (off >> 4) & 0x07;
  if (slot === DISK2_SLOT && m.options.disk2) {
    // The data register drives the bus on even addresses only.
    const reg = m.disk2.read(off & 0x0F);
    return (off & 1) === 0 ? reg : bus();
  }
  const card = m.memory.cards[slot];
  return card?.ioRead ? card.ioRead(off & 0x0F) & 0xFF : bus();
}

export function writeApple2Io(m: Apple2Machine, addr: number, val: number): void {
  const off = addr & 0xFF;

  switch (off >> 4) {
    case 0x0: return;
    case 0x1: m.keyboard.clearStrobe(); return;
    case 0x2: m.pulseCassetteOutput(true); return;
    case 0x3: m.toggleSpeaker(); return;
    case 0x4: m.paddles.strobe(m.accessCycle(addr, true)); return;
    case 0x5:
      if (off <= 0x57) applyVideoSwitch(m, off - 0x50);
      else m.paddles.annunciator(off);
      return;
    case 0x6: return;
    case 0x7: m.paddles.trigger(m.accessCycle(addr, true)); return;
    case 0x8: m.memory.lcAccess(off, false); return;
    default: break;
  }

  const slot = (off >> 4) & 0x07;
  if (slot === DISK2_SLOT && m.options.disk2) m.disk2.write(off & 0x0F, val);
  else m.memory.cards[slot]?.ioWrite?.(off & 0x0F, val);
}

/** Install the IO hooks on the machine's memory bus. Idempotent. */
export function wireApple2Io(m: Apple2Machine): void {
  m.memory.ioRead = (addr) => readApple2Io(m, addr);
  m.memory.ioWrite = (addr, val) => writeApple2Io(m, addr, val);
}
