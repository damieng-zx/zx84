/**
 * Camputers Lynx port decode.
 *
 * Only the low byte is decoded, mirrored across the top of the address — with
 * one exception that shapes everything else: the keyboard has no select
 * register. A read of port 0x80 carries the line number in A8-A11, so
 * `IN A,(0x80)` with B holding the line reads that line. That is why this
 * takes the whole 16-bit port address rather than the usual low byte.
 *
 * The 128K rearranges enough of this to be worth stating plainly: its banking
 * port is 0x82 rather than 0x7F, that same port reads back the cassette input
 * (which on the 48K/96K shares bit 0 of the keyboard's line 0), and the
 * cassette motor moves from port 0x80 bit 1 to bit 3.
 */

import {
  PORT_BANK_48, PORT_BANK_128, PORT_CONTROL, PORT_DAC, PORT_CRTC_ADDR,
  PORT_CRTC_DATA, PORT_FDC_READ, PORT_FDC_WRITE, PORT_FDC_SELECT,
} from './constants.ts';
import type { LynxMachine } from './lynx-machine.ts';

/** Wire the machine's port handlers onto its CPU. Hot path: direct closures. */
export function wireLynxPortIO(m: LynxMachine): void {
  m.cpu.portInHandler = (port: number): number => portIn(m, port);
  m.cpu.portOutHandler = (port: number, value: number): void => portOut(m, port, value);
}

function portIn(m: LynxMachine, port: number): number {
  const low = port & 0xff;

  if (low === PORT_CONTROL) {
    // The keyboard line is in A8-A11. On the 48K/96K line 0 doubles as the
    // cassette input: while the motor bit is set, bit 0 carries the tape
    // signal instead of the SHIFT column.
    const line = (port >> 8) & 0x0f;
    m.activity.kbdReads++;
    let data = m.keyboard.read(line);
    if (!m.memory.is128k && m.tapeMotorOn) {
      m.activity.casReads++;
      data = (data & 0xfe) | (m.cassetteInput() ? 0 : 1);
    }
    return data;
  }

  // The 128K's serial buffer, whose bit 2 is the cassette input.
  if (low === PORT_BANK_128 && m.memory.is128k) {
    m.activity.casReads++;
    return 0xfb | (m.cassetteInput() ? 4 : 0);
  }

  if (low === PORT_CRTC_ADDR) return m.crtc.readStatus();
  if (low === PORT_CRTC_DATA) return m.crtc.readRegister();

  if (m.hasDisk && low >= PORT_FDC_READ && low <= PORT_FDC_READ + 3) {
    m.activity.fdcAccesses++;
    switch (low & 3) {
      case 0: return m.fdc.readStatus();
      case 1: return m.fdc.trackReg;
      case 2: return m.fdc.readSectorReg();
      default: return m.fdc.readData();
    }
  }

  return 0xff;
}

function portOut(m: LynxMachine, port: number, value: number): void {
  const low = port & 0xff;
  const v = value & 0xff;

  if (m.hasDisk && low >= PORT_FDC_WRITE && low <= PORT_FDC_WRITE + 3) {
    m.activity.fdcAccesses++;
    switch (low & 3) {
      case 0: m.fdc.writeCommand(v); break;
      case 1: m.fdc.trackReg = v; break;
      case 2: m.fdc.writeSectorReg(v); break;
      default: m.fdc.writeData(v); break;
    }
    return;
  }

  switch (low) {
    case PORT_BANK_48:
      if (!m.memory.is128k) m.memory.writeBankPort(v);
      return;

    case PORT_BANK_128:
      if (m.memory.is128k) m.memory.writeBankPort(v);
      return;

    case PORT_CONTROL:
      // Bank decode, the alternate green plane, and the cassette motor.
      m.setPort80(v);
      return;

    case PORT_DAC:
      // With the motor running this is the cassette output (bit 5 as a square
      // wave); otherwise it is the sound DAC.
      if (m.tapeMotorOn) m.cassetteOutput((v & 0x20) === 0);
      else m.dacLevel = v;
      return;

    case PORT_CRTC_ADDR:
      m.crtc.selectRegister(v);
      return;

    case PORT_CRTC_DATA:
      m.crtc.writeRegister(v);
      return;

    case PORT_FDC_SELECT:
      if (!m.hasDisk) return;
      // d0,d1 drive, d2 side, d3 motor, d4 pages RAM over the DOS ROM.
      m.memory.setPort58(v);
      m.fdc.currentDrive = v & 3;
      m.fdc.side = (v >> 2) & 1;
      m.fdc.motorOn = (v & 0x08) !== 0;
      return;

    default:
      // Everything else is unclaimed on this bus.
  }
}
