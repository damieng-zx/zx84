/**
 * Apple II soft-switch decode for the $C000-$C0FF window.
 *
 *   0xC000-0xC00F  keyboard (data at $C000)
 *   0xC010-0xC01F  strobe clear ($C010) and mode status reads
 *   0xC020         cassette output toggle
 *   0xC030         speaker toggle
 *   0xC050-0xC057  display switches (text/mixed/page2/lores-hires)
 *   0xC058-0xC05F  annunciators AN0-AN3 off/on (game connector outputs)
 *   0xC060         cassette input (bit 7); 0xC061-0xC063 pushbuttons
 *   0xC064-0xC067  paddle timers (bit 7);  0xC070 paddle trigger
 *   0xC080-0xC08F  slot 0 I/O — the language card's bank/ROM switches
 *   0xC0E0-0xC0EF  slot 6 I/O — the Disk II controller
 *
 * Every one of these responds to both reads and writes (the switch is tripped
 * by the access, not by the data), which is why the same decode runs on both
 * paths.
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

  if (off <= 0x0F) {
    if (off !== 0x00) return 0x00;
    m.activity.kbdReads++;
    return m.keyboard.readData();
  }
  if (off <= 0x1F) {
    switch (off) {
      case 0x10: m.keyboard.clearStrobe(); return 0x00;
      case 0x19: return m.vblActive ? 0x80 : 0x00;
      case 0x1A: return m.textMode ? 0x80 : 0x00;
      case 0x1B: return m.mixed ? 0x80 : 0x00;
      case 0x1C: return m.page2 ? 0x80 : 0x00;
      case 0x1D: return m.hires ? 0x80 : 0x00;
      default: return 0x00;
    }
  }
  if (off === 0x20) { m.pulseCassetteOutput(false); return 0x00; }
  if (off <= 0x2F) return 0x00;
  if (off === 0x30) { m.toggleSpeaker(); return 0x00; }
  if (off <= 0x4F) return 0x00;
  if (off <= 0x57) { applyVideoSwitch(m, off - 0x50); return 0x00; }
  if (off <= 0x5F) { m.paddles.annunciator(off); return 0x00; }
  if (off <= 0x6F) {
    switch (off & 0x07) {
      case 0x00: return m.cassetteInputBit ? 0x80 : 0x00;
      case 0x01: case 0x02: case 0x03:                 // pushbuttons read high only while pressed
        return m.paddles.button((off & 0x07) - 1) ? 0x80 : 0x00;
      default:                                         // paddle timers
        return m.paddles.timerHigh((off & 0x07) - 4, m.cpu.tStates) ? 0x80 : 0x00;
    }
  }
  if (off <= 0x7F) { m.paddles.trigger(m.cpu.tStates); return 0x00; }
  if (off <= 0x8F) { m.memory.lcAccess(off, true); return 0xFF; }   // slot 0: language card

  const slot = (off >> 4) & 0x07;
  if (slot === DISK2_SLOT && m.options.disk2) return m.disk2.read(off & 0x0F);
  const card = m.memory.cards[slot];
  return card?.ioRead ? card.ioRead(off & 0x0F) & 0xFF : 0xFF;
}

export function writeApple2Io(m: Apple2Machine, addr: number, val: number): void {
  const off = addr & 0xFF;

  if (off <= 0x0F) return;
  if (off <= 0x1F) { if (off === 0x10) m.keyboard.clearStrobe(); return; }
  if (off === 0x20) { m.pulseCassetteOutput(true); return; }
  if (off === 0x30) { m.toggleSpeaker(); return; }
  if (off <= 0x4F) return;
  if (off <= 0x57) { applyVideoSwitch(m, off - 0x50); return; }
  if (off <= 0x5F) { m.paddles.annunciator(off); return; }
  if (off <= 0x7F) { if (off >= 0x70) m.paddles.trigger(m.cpu.tStates); return; }
  if (off <= 0x8F) { m.memory.lcAccess(off, false); return; }

  const slot = (off >> 4) & 0x07;
  if (slot === DISK2_SLOT && m.options.disk2) m.disk2.write(off & 0x0F, val);
  else m.memory.cards[slot]?.ioWrite?.(off & 0x0F, val);
}

/** Install the IO hooks on the machine's memory bus. Idempotent. */
export function wireApple2Io(m: Apple2Machine): void {
  m.memory.ioRead = (addr) => readApple2Io(m, addr);
  m.memory.ioWrite = (addr, val) => writeApple2Io(m, addr, val);
}
