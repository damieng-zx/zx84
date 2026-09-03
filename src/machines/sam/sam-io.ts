/**
 * SAM Coupé memory hooks and port decode.
 *
 * Decode is by the low byte, except for the two places where the SAM uses a
 * high address line as a chip-select — and both of those are easy to get
 * backwards, so they are spelled out here:
 *
 *   - **CLUT (0xF8)**: the palette entry written is taken from the port's HIGH
 *     byte, not from an index register. `OUT (&03F8), A` writes entry 3.
 *   - **SAA1099**: the chip's A0 is wired to Z80 A8, so 0x00FF is the DATA
 *     register and 0x01FF is the ADDRESS register. Same low byte, different
 *     chip register.
 *
 * This is a tier-1 hot path: the handlers stay direct closures on the CPU with
 * an ordered switch and early returns. No interfaces, no indirection.
 *
 * Phase 1 wires memory paging, the border/beeper latch and the status register.
 * Video (the ASIC), keyboard, sound and disk decode land in later phases; every
 * unimplemented port reads as open bus (0xFF) so a probing ROM sees "nothing
 * fitted" rather than a plausible-looking wrong answer.
 */

import type { SamMachine } from './sam-machine.ts';
import { SamDiskInterface } from './peripherals/sam-disk.ts';
import {
  PORT_BORDER, PORT_CLUT, PORT_HEPR, PORT_HMPR, PORT_KEMPSTON, PORT_LEPR,
  PORT_LMPR, PORT_MIDI, PORT_SAA_LOW, PORT_STATUS, PORT_VMPR,
  BORDER_BEEP, BORDER_COLOUR_MASK, BORDER_MIC, BORDER_SOFF,
  BORDER_EAR, BORDER_KEY_MASK, BORDER_SPEN,
} from './constants.ts';

/**
 * Install the SAM's memory access hooks on the Z80.
 *
 * Contention is NOT applied here, and NOT through `cpu.contend` either. The
 * SAM rounds up whole instruction durations rather than stalling individual bus
 * cycles, so it is applied once per instruction in the machine's frame loop —
 * see `contention.ts`. Both CPU contention hooks therefore stay no-ops.
 */
export function installSamMemoryHooks(m: SamMachine): void {
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

  cpu._contendAccurate = () => {};
  cpu.contend = () => {};
}

/** Wire the SAM's port decode onto the CPU's IN/OUT handlers. */
export function wireSamPortIO(m: SamMachine): void {
  const cpu = m.cpu;

  cpu.portOut = (port: number, value: number): void => {
    port &= 0xFFFF;
    value &= 0xFF;
    cpu.tStates += m.contention.portDelay(cpu.tStates, port);
    if (m.portWatchpoints.size > 0 && m.portWatchpoints.has(port) && m.portWatchHit === null) {
      m.portWatchHit = { port, value, dir: 'out' };
    }

    // The two drives occupy 0xE0-0xE7 and 0xF0-0xF7, which is a range test
    // rather than a single low byte, so it comes before the switch.
    if (SamDiskInterface.driveFor(port) >= 0) {
      m.disk.write(port, value);
      m.activity.fdcAccesses++;
      return;
    }

    switch (port & 0xFF) {
      case PORT_LEPR: m.memory.setLepr(value); return;
      case PORT_HEPR: m.memory.setHepr(value); return;

      case PORT_CLUT:
        // Entry index comes from the HIGH byte of the port address.
        m.asic.writeClut((port >> 8) & 0x0F, value, cpu.tStates);
        return;

      case PORT_STATUS:
        // Writing the status port sets the line-interrupt scanline, and
        // cancels any line interrupt already pending.
        m.asic.setLineInterrupt(value);
        return;

      case PORT_LMPR: m.memory.setLmpr(value); return;
      case PORT_HMPR: m.memory.setHmpr(value); return;
      case PORT_VMPR: m.memory.setVmpr(value); return;

      case PORT_MIDI:
        // MIDI / serial is decoded but not implemented; swallow the write so a
        // probing ROM doesn't fall through to another device.
        return;

      case PORT_BORDER: {
        // Border colour is oddly packed (BORDER_COLOUR_MASK = 0x27): bits 0-2
        // are the low three bits of the CLUT index and bit 5 is its top bit.
        const packed = value & BORDER_COLOUR_MASK;
        const index = (packed & 0x07) | ((packed & 0x20) >> 2);
        m.asic.writeBorder(index, (value & BORDER_SOFF) !== 0, cpu.tStates);
        m.beeperBit = (value & BORDER_BEEP) ? 1 : 0;
        m.micBit = (value & BORDER_MIC) ? 1 : 0;
        m.activity.beeperWrites++;
        return;
      }

      case PORT_SAA_LOW:
        // The SAA's A0 is wired to Z80 A8, so the SAME low byte reaches two
        // different chip registers: 0x01FF selects, 0x00FF writes.
        if (port & 0x0100) m.psg.writeAddress(value);
        else m.psg.writeData(value);
        m.activity.psgWrites++;
        return;

      default:
        return;
    }
  };

  cpu.portIn = (port: number): number => {
    port &= 0xFFFF;
    cpu.tStates += m.contention.portDelay(cpu.tStates, port);
    const value = dispatchIn(port);
    if (m.portWatchpoints.size > 0 && m.portWatchpoints.has(port) && m.portWatchHit === null) {
      m.portWatchHit = { port, value, dir: 'in' };
    }
    return value;
  };

  function dispatchIn(port: number): number {
    if (SamDiskInterface.driveFor(port) >= 0) {
      m.activity.fdcAccesses++;
      return m.disk.read(port);
    }

    switch (port & 0xFF) {
      case PORT_KEMPSTON:
        m.activity.joystickReads++;
        return m.readKempston();

      case PORT_STATUS:
        // Top three bits are the SAM's extra keys, low five the active-low
        // interrupt status. Reading acknowledges nothing on this machine.
        m.activity.kbdReads++;
        return (m.readKeyboardHigh(port >> 8) & 0xE0) | (m.status & 0x1F);

      case PORT_LMPR: return m.memory.lmpr;
      case PORT_HMPR: return m.memory.hmpr;
      case PORT_VMPR: return m.memory.vmpr;

      case PORT_BORDER: {
        m.activity.kbdReads++;
        // Bits 0-4 keyboard, 5 light pen, 6 cassette EAR, 7 screen-off latch.
        const keys = m.readKeyboardLow(port >> 8) & BORDER_KEY_MASK;
        const ear = m.earBit ? BORDER_EAR : 0;
        const soff = m.screenOff ? BORDER_SOFF : 0;
        return keys | BORDER_SPEN | ear | soff;
      }

      default:
        return 0xFF;
    }
  }
}
