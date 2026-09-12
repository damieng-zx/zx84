/**
 * PCW memory hooks and port decode.
 *
 * Decode is by the low byte, with one range test that has to come first: the
 * uPD765A is selected by Z80 **A7 low**, so it answers the whole of &00-&7F
 * rather than a pair of addresses, with A0 choosing the status or data
 * register. CP/M only ever uses &00 and &01, but software that pokes &40 must
 * reach the FDC too, which a `switch (port & 0xFF)` would quietly miss.
 *
 * This is a tier-1 hot path: the handlers stay direct closures on the CPU with
 * an ordered switch and early returns. No interfaces, no indirection.
 *
 * Unimplemented ports read as open bus (0xFF) so that a probing program sees
 * "nothing fitted" rather than a plausible-looking wrong answer.
 */

import type { PcwMachine } from './pcw-machine.ts';
import {
  PCW_FDC_REGISTER_BIT, PCW_FDC_SELECT_MASK,
  PORT_BANK0, PORT_BANK1, PORT_BANK2, PORT_BANK3, PORT_MEMCTL, PORT_PRINTER_CTRL,
  PORT_PRINTER_DATA, PORT_ROLLER, PORT_SYSTEM, PORT_VERTICAL, PORT_VIDEO,
} from './constants.ts';

/**
 * Printer status read back from &FD, per John Elliott's PCW hardware guide:
 *
 *   b7 bail bar (1 = in)      b3 sheet feeder present
 *   b6 0 = executing, 1 = finished   b2 paper sensor (1 = paper)
 *   b5 always 0, except 1 on a booted daisywheel machine (the printer-type test)
 *   b4 0 = head at left margin       b1 0 = ready for a command, 1 = busy
 *                                    b0 1 = controller fault (read &FC for it)
 *
 * The emulated printer is idle, ready, fault-free, at the left margin, with
 * paper loaded and the bail bar in — b7, b6 and b2 set. **b6 matters**: the
 * XBIOS's printer handshake spins on `IN A,(&FD) / AND &41` waiting for either
 * "finished" or "fault", so a status that never reports finished wedges the
 * boot after the CP/M banner. Nothing is printed — see `PcwMachine.printerWrite`.
 */
const PRINTER_STATUS_READY = 0xC4;

/** Daisywheel machines (the 9512) additionally show b5 once booted, which is
 *  how software tells a daisywheel PCW from a dot-matrix one. */
const PRINTER_STATUS_DAISYWHEEL = PRINTER_STATUS_READY | 0x20;

/**
 * Printer-controller error code read back from &FC: &F8 is "normal operation,
 * no error". The XBIOS treats *any* other value as no printer being fitted, so
 * this must not be left to read as open bus — the other documented codes are
 * 0 underrun, 1 printer RAM fault, 3 bad command, 5 print error.
 */
const PRINTER_NO_ERROR = 0xF8;

/** Install the PCW's memory access hooks on the Z80. */
export function installPcwMemoryHooks(m: PcwMachine): void {
  const cpu = m.cpu;
  const memory = m.memory;

  cpu.read8 = (addr: number): number => {
    addr &= 0xFFFF;
    const value = memory.readByte(addr);
    if (m.memWatchpoints.length > 0 && m.memWatchHit === null) {
      for (const wp of m.memWatchpoints) {
        if ((wp.mode === 'read' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          m.memWatchHit = { addr, value, dir: 'read' };
          break;
        }
      }
    }
    return value;
  };

  cpu.write8 = (addr: number, value: number): void => {
    addr &= 0xFFFF;
    memory.writeByte(addr, value);
    if (m.memWatchpoints.length > 0 && m.memWatchHit === null) {
      for (const wp of m.memWatchpoints) {
        if ((wp.mode === 'write' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          m.memWatchHit = { addr, value: value & 0xFF, dir: 'write' };
          break;
        }
      }
    }
  };

  // Video memory contention is folded into the flat 3.4MHz clock (see
  // constants.ts), so there is nothing to charge per access.
  cpu._contendAccurate = () => {};
  cpu.contend = () => {};
}

/** Wire the PCW's port decode onto the CPU's IN/OUT handlers. */
export function wirePcwPortIO(m: PcwMachine): void {
  const cpu = m.cpu;

  cpu.portOut = (port: number, value: number): void => {
    port &= 0xFFFF;
    value &= 0xFF;
    if (m.portWatchpoints.size > 0 && m.portWatchpoints.has(port) && m.portWatchHit === null) {
      m.portWatchHit = { port, value, dir: 'out' };
    }

    // A7 low selects the uPD765A; A0 picks the register. Only the data
    // register is writable — the main status register is read-only.
    if ((port & PCW_FDC_SELECT_MASK) === 0) {
      if (port & PCW_FDC_REGISTER_BIT) m.fdc.writeData(value);
      m.activity.fdcAccesses++;
      return;
    }

    switch (port & 0xFF) {
      case PORT_BANK0: m.memory.setBank(0, value); return;
      case PORT_BANK1: m.memory.setBank(1, value); return;
      case PORT_BANK2: m.memory.setBank(2, value); return;
      case PORT_BANK3: m.memory.setBank(3, value); return;
      case PORT_MEMCTL: m.memory.setMemCtl(value); return;

      case PORT_ROLLER: m.asic.rollerBase = value; return;
      case PORT_VERTICAL: m.asic.verticalPos = value; return;
      case PORT_VIDEO: m.asic.videoCtl = value; return;

      case PORT_SYSTEM: m.systemCommand(value); return;

      case PORT_PRINTER_DATA: m.printerWrite(value, false); return;
      case PORT_PRINTER_CTRL: m.printerWrite(value, true); return;

      default: return;
    }
  };

  cpu.portIn = (port: number): number => {
    port &= 0xFFFF;
    const value = dispatchIn(port);
    if (m.portWatchpoints.size > 0 && m.portWatchpoints.has(port) && m.portWatchHit === null) {
      m.portWatchHit = { port, value, dir: 'in' };
    }
    return value;
  };

  function dispatchIn(port: number): number {
    if ((port & PCW_FDC_SELECT_MASK) === 0) {
      m.activity.fdcAccesses++;
      return (port & PCW_FDC_REGISTER_BIT) ? m.fdc.readData() : m.fdc.readStatus();
    }

    switch (port & 0xFF) {
      // &F4 returns the same status byte as &F8 but clears the interrupt
      // counter on the way out; the BIOS uses it to find out how many 300Hz
      // ticks it missed.
      case PORT_MEMCTL: return m.asic.readMemCtlStatus();
      case PORT_SYSTEM: return m.asic.status;
      case PORT_PRINTER_DATA: return PRINTER_NO_ERROR;
      case PORT_PRINTER_CTRL:
        return m.config.printer === 'daisywheel'
          ? PRINTER_STATUS_DAISYWHEEL : PRINTER_STATUS_READY;
      default: return 0xFF;
    }
  }
}
