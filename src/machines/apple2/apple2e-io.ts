/**
 * Apple //e soft-switch decode for the $C000-$C0FF window.
 *
 *   $C000-$C00F  read: keyboard data;  write: the MMU and video switches
 *                ($C000/1 80STORE, 2/3 RAMRD, 4/5 RAMWRT, 6/7 INTCXROM, 8/9
 *                ALTZP, A/B SLOTC3ROM, C/D 80COL, E/F ALTCHARSET)
 *   $C010        strobe clear; read returns any-key-down in bit 7
 *   $C011-$C01F  read: the state of each of those switches in bit 7
 *   $C020/$C030  cassette out, speaker
 *   $C050-$C057  TEXT / MIXED / PAGE2 / HIRES
 *   $C058-$C05F  annunciators AN0-AN3 off/on; $C05E/$C05F (AN3) also turn
 *                double hi-res on/off
 *   $C061-$C063  Open-Apple, Solid-Apple, SHIFT as buttons 0-2
 *   $C080-$C08F  the language card (built in);  $C0E0-$C0EF  the Disk II
 *
 * As on the ][, every address answers both reads and writes — except that the
 * first sixteen only *set* switches when written, and read back the keyboard.
 */

import { DISK2_SLOT } from './constants.ts';
import type { Apple2Machine } from './apple2-machine.ts';
import { applyVideoSwitch } from './apple2-io.ts';

const bit7 = (on: boolean): number => (on ? 0x80 : 0x00);

/** The $C000-$C00F write side: an MMU or video switch. */
function setSwitch(m: Apple2Machine, off: number): void {
  const n = off >> 1;
  const on = (off & 1) === 1;
  if (m.mmu.setMmuSwitch(n, on)) return;
  if (n === 6) m.col80 = on;
  else if (n === 7) m.altCharset = on;
}

/** A $C050-$C057 display switch, plus the //e's mirror of the ones that 80STORE paging needs. */
function videoSwitch(m: Apple2Machine, sw: number): void {
  applyVideoSwitch(m, sw);
  m.mmu.page2 = m.page2;
  m.mmu.hires = m.hires;
}

/** $C058-$C05F: an annunciator latch; AN3 off is also double hi-res on. */
function annunciator(m: Apple2Machine, off: number): void {
  m.paddles.annunciator(off);
  if (off === 0x5E) m.dhires = true;
  else if (off === 0x5F) m.dhires = false;
}

export function readApple2eIo(m: Apple2Machine, addr: number): number {
  const off = addr & 0xFF;
  const mmu = m.mmu;

  if (off <= 0x0F) {
    m.activity.kbdReads++;
    return m.keyboard.readData();
  }
  if (off <= 0x1F) {
    switch (off) {
      case 0x10: {
        const anyDown = m.keyboard.anyPressed;
        m.keyboard.clearStrobe();
        return bit7(anyDown) | m.keyboard.lastKey;
      }
      case 0x11: return bit7(mmu.lcBank2Selected);
      case 0x12: return bit7(mmu.lcReadsRam);
      case 0x13: return bit7(mmu.ramrd);
      case 0x14: return bit7(mmu.ramwrt);
      case 0x15: return bit7(mmu.intcxrom);
      case 0x16: return bit7(mmu.altzp);
      case 0x17: return bit7(mmu.slotc3rom);
      case 0x18: return bit7(mmu.store80);
      case 0x19: return bit7(!m.vblActive);       // RDVBLBAR: high while the beam is drawing
      case 0x1A: return bit7(m.textMode);
      case 0x1B: return bit7(m.mixed);
      case 0x1C: return bit7(m.page2);
      case 0x1D: return bit7(m.hires);
      case 0x1E: return bit7(m.altCharset);
      case 0x1F: return bit7(m.col80);
      default: return 0x00;
    }
  }
  if (off === 0x20) { m.pulseCassetteOutput(false); return 0x00; }
  if (off <= 0x2F) return 0x00;
  if (off === 0x30) { m.toggleSpeaker(); return 0x00; }
  if (off <= 0x4F) return 0x00;
  if (off <= 0x57) { videoSwitch(m, off - 0x50); return 0x00; }
  if (off <= 0x5F) { annunciator(m, off); return 0x00; }
  if (off <= 0x6F) {
    switch (off & 0x07) {
      case 0x00: return m.cassetteInputBit ? 0x80 : 0x00;
      case 0x01: return bit7(m.keyboard.button(0) || m.paddles.button(0));
      case 0x02: return bit7(m.keyboard.button(1) || m.paddles.button(1));
      case 0x03: return bit7(m.keyboard.button(2) || m.paddles.button(2));
      default: return bit7(m.paddles.timerHigh((off & 0x07) - 4, m.cpu.tStates));
    }
  }
  if (off === 0x7F) return bit7(m.dhires);
  if (off <= 0x7F) { if (off <= 0x7D) m.paddles.trigger(m.cpu.tStates); return 0x00; }
  if (off <= 0x8F) { m.memory.lcAccess(off, true); return 0xFF; }

  const slot = (off >> 4) & 0x07;
  if (slot === DISK2_SLOT && m.options.disk2) return m.disk2.read(off & 0x0F);
  const card = m.memory.cards[slot];
  return card?.ioRead ? card.ioRead(off & 0x0F) & 0xFF : 0xFF;
}

export function writeApple2eIo(m: Apple2Machine, addr: number, val: number): void {
  const off = addr & 0xFF;

  if (off <= 0x0F) { setSwitch(m, off); return; }
  if (off <= 0x1F) { if (off === 0x10) m.keyboard.clearStrobe(); return; }
  if (off === 0x20) { m.pulseCassetteOutput(true); return; }
  if (off === 0x30) { m.toggleSpeaker(); return; }
  if (off <= 0x4F) return;
  if (off <= 0x57) { videoSwitch(m, off - 0x50); return; }
  if (off <= 0x5F) { annunciator(m, off); return; }
  if (off <= 0x7F) { if (off >= 0x70 && off <= 0x7D) m.paddles.trigger(m.cpu.tStates); return; }
  if (off <= 0x8F) { m.memory.lcAccess(off, false); return; }

  const slot = (off >> 4) & 0x07;
  if (slot === DISK2_SLOT && m.options.disk2) m.disk2.write(off & 0x0F, val);
  else m.memory.cards[slot]?.ioWrite?.(off & 0x0F, val);
}

/** Install the //e's $C0xx hooks on the machine's memory bus. */
export function wireApple2eIo(m: Apple2Machine): void {
  m.memory.ioRead = (addr) => readApple2eIo(m, addr);
  m.memory.ioWrite = (addr, val) => writeApple2eIo(m, addr, val);
}
