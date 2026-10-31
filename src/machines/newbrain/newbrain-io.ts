/**
 * NewBrain port I/O dispatch + memory hooks.
 *
 * The board decodes only A2-A4 (the group) and A0-A1 (the register within it);
 * everything above bit 4 is ignored, which is why the ports repeat:
 *
 *   04       CLCLK  read or write clears the 50 Hz clock interrupt
 *   06       COP    the microcontroller's bus: read gets its Q register,
 *                   write hands it a byte
 *   07       ENRG   write-only enable register (see NewBrainMachine.enrg)
 *   08-0B    TVL    write-only video start address (port 8 sets A6, port 9
 *                   loads A7-A14)
 *   0C-0F    TVCTL  write-only video control
 *   14-15    UST    read-only status, port A
 *   16-17    UST    read-only status, port B
 *
 * Nothing else answers on the unexpanded machine — reads float high.
 */

import type { NewBrainMachine } from './newbrain-machine.ts';

export function installNewBrainMemoryHooks(m: NewBrainMachine): void {
  const memory = m.memory;
  const cpu = m.cpu;

  cpu.read8 = (addr: number): number => {
    addr &= 0xFFFF;
    const val = memory.readByte(addr);
    if (m.memWatchpoints.length > 0 && m.memWatchHit === null) m.recordMemWatch(addr, val, 'read');
    return val;
  };

  cpu.write8 = (addr: number, val: number): void => {
    addr &= 0xFFFF;
    memory.writeByte(addr, val);
    if (m.memWatchpoints.length > 0 && m.memWatchHit === null) m.recordMemWatch(addr, val & 0xFF, 'write');
  };

  // The video circuit steals no cycles from the CPU that the model tracks.
  cpu._contendAccurate = () => {};
  cpu.contend = () => {};
}

export function wireNewBrainPortIO(m: NewBrainMachine): void {
  m.cpu.portOutHandler = (port: number, val: number): void => {
    if (m.portWatchpoints.size > 0) m.recordPortWatch(port & 0xFFFF, val & 0xFF, 'out');
    const p = port & 0x1F;
    switch (p >> 2) {
      case 1:
        if ((p & 3) === 0) m.clearClockInterrupt();
        else if ((p & 3) === 2) m.copWrite(val & 0xFF);
        else if ((p & 3) === 3) m.writeEnable(val & 0xFF);
        break;
      case 2:
        m.writeTvl(val & 0xFF, (p & 1) === 0);
        break;
      case 3:
        m.tvctl = val & 0xFF;
        break;
      default:
        break;
    }
  };

  m.cpu.portInHandler = (port: number): number => {
    const p = port & 0x1F;
    let val = 0xFF;
    switch (p >> 2) {
      case 1:
        if ((p & 3) === 0) m.clearClockInterrupt();
        else if ((p & 3) === 2) val = m.copRead();
        break;
      case 5:
        val = (p & 2) === 0 ? m.statusA() : m.statusB();
        break;
      default:
        break;
    }
    if (m.portWatchpoints.size > 0) m.recordPortWatch(port & 0xFFFF, val, 'in');
    return val;
  };
}
