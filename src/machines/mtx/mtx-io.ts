import type { MtxMachine } from './mtx-machine.ts';

/** Install non-contended MTX memory hooks on the Z80. */
export function installMtxMemoryHooks(m: MtxMachine): void {
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

/**
 * MTX motherboard port decode.
 *
 * 00 paging, 01/02 TMS9929A, 03 cassette, 04 printer, 05/06 keyboard and
 * SN76489A, 08-0B Z80 CTC, 10-14 FDX/SDX floppy expansion, and 30-33/38-39
 * FDX 80-column board when fitted. The base MTX has no DART fitted.
 */
export function wireMtxPortIO(m: MtxMachine): void {
  const cpu = m.cpu;

  cpu.portOut = (port: number, value: number): void => {
    port &= 0xFFFF;
    value &= 0xFF;
    if (m.portWatchpoints.size > 0 && m.portWatchpoints.has(port) && m.portWatchHit === null) {
      m.portWatchHit = { port, value, dir: 'out' };
    }

    switch (port & 0xFF) {
      case 0x00: m.memory.setPageRegister(value); break;
      case 0x01: m.vdp.writeData(value); break;
      case 0x02: m.vdp.writeControl(value); break;
      case 0x03: m.tapeOutput = value; break;
      case 0x05: m.keyboard.selectDrive(value); break;
      case 0x06: m.psg.write(value); m.activity.psgWrites++; break;
      case 0x08:
      case 0x09:
      case 0x0A:
      case 0x0B:
        m.ctc.write(port & 3, value);
        break;
      case 0x10:
      case 0x11:
      case 0x12:
      case 0x13:
      case 0x14:
        if (!m.floppyEnabled) break;
        m.fdx.write(port, value);
        m.activity.fdcAccesses++;
        break;
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x38:
      case 0x39:
        if (m.column80.enabled) m.column80.write(port, value);
        break;
      // Port 4 printer and port 7 uncommitted PIO are not yet surfaced.
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
    switch (port & 0xFF) {
      case 0x01: return m.vdp.readData();
      case 0x02: return m.vdp.readStatus();
      // With no readable device on port 3, the bus returns the low port byte.
      // Pothole Pete relies on IN A,(3) producing 3.
      case 0x03: return 0x03;
      case 0x05: m.activity.kbdReads++; return m.keyboard.readSenseLow();
      case 0x06: m.activity.kbdReads++; return m.keyboard.readSenseHigh();
      case 0x08:
      case 0x09:
      case 0x0A:
      case 0x0B:
        return m.ctc.read(port & 3);
      case 0x10:
      case 0x11:
      case 0x12:
      case 0x13:
      case 0x14:
        if (!m.floppyEnabled) return 0xFF;
        m.activity.fdcAccesses++;
        return m.fdx.read(port);
      case 0x30:
      case 0x32:
      case 0x33:
      case 0x38:
      case 0x39:
        return m.column80.enabled ? m.column80.read(port) : 0xFF;
      default: return 0xFF;
    }
  }
}
