/**
 * Enterprise port decode. Only the low byte of the port address counts.
 *
 *   0x10-0x17  EXDOS card: WD1770 registers (mirrored every four)
 *   0x18-0x1F  EXDOS card: drive/side/density latch and status
 *   0x80-0x8F  Nick (four registers, mirrored)
 *   0xA0-0xAF  Dave sound registers (write only)
 *   0xB0-0xB3  Dave page registers (read back)
 *   0xB4       Dave interrupt enables / latches
 *   0xB5       keyboard row select and cassette remotes / keyboard row read
 *   0xB6       printer data / joystick, printer status and tape input
 *   0xB7       serial out / serial in
 *   0xBF       Dave system configuration (wait states, clock)
 */

import type { EnterpriseMachine } from './enterprise-machine.ts';

/** Wire the machine's port handlers onto its CPU. Hot path: direct closures. */
export function wireEnterprisePortIO(m: EnterpriseMachine): void {
  m.cpu.portInHandler = (port: number): number => {
    const value = portIn(m, port & 0xFF);
    if (m.portWatchpoints.size > 0) m.recordPortWatch(port & 0xFFFF, value, 'in');
    return value;
  };
  m.cpu.portOutHandler = (port: number, value: number): void => {
    if (m.portWatchpoints.size > 0) m.recordPortWatch(port & 0xFFFF, value & 0xFF, 'out');
    portOut(m, port & 0xFF, value & 0xFF);
  };
}

function portIn(m: EnterpriseMachine, port: number): number {
  if ((port & 0xF0) === 0x80) {
    m.nickPortWait();
    return m.nick.readPort();
  }
  if ((port & 0xF0) === 0xB0) {
    switch (port) {
      case 0xB0: case 0xB1: case 0xB2: case 0xB3:
        return m.memory.pages[port & 3];
      case 0xB4:
        return m.dave.readInterrupts();
      case 0xB5:
        m.activity.kbdReads++;
        return m.keyboard.read(m.dave.keyboardRow);
      case 0xB6:
        return m.readControlPort();
      default:
        return 0xFF;
    }
  }
  if ((port & 0xF0) === 0x10) {
    if (!m.exdos) return 0xFF;
    m.activity.fdcAccesses++;
    return (port & 0x08) ? m.exdos.readStatus() : m.exdos.readFdc(port & 3);
  }
  return 0xFF;
}

function portOut(m: EnterpriseMachine, port: number, value: number): void {
  if ((port & 0xF0) === 0x80) {
    m.nickPortWait();
    m.nick.writePort(port, value);
    return;
  }
  if ((port & 0xE0) === 0xA0) {
    switch (port) {
      case 0xB0: case 0xB1: case 0xB2: case 0xB3:
        m.memory.setPage(port & 3, value);
        return;
      case 0xB5:
        m.keyboardRowSelected(value & 0x0F);
        m.dave.write(0x15, value);
        return;
      case 0xB6: case 0xB7:
        // Printer data and serial outputs: nothing attached.
        return;
      default:
        m.syncAudio();
        m.dave.write(port & 0x1F, value);
        return;
    }
  }
  if ((port & 0xF0) === 0x10) {
    if (!m.exdos) return;
    m.activity.fdcAccesses++;
    if (port & 0x08) m.exdos.writeControl(value);
    else m.exdos.writeFdc(port & 3, value);
  }
}
