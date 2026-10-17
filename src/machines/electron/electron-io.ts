/**
 * Electron memory-mapped IO decode (0xFC00-0xFEFF).
 *
 *   0xFC00-0xFCFF  FRED  (1 MHz bus: the Plus 1's ADC/printer at &FC70-72 and
 *                         the Plus 3's disc controller at &FCC0-&FCC7, when fitted)
 *   0xFD00-0xFDFF  JIM   (1 MHz bus paged memory — absent)
 *   0xFE00-0xFEFF  the ULA's 16 registers, repeating every 16 bytes
 *
 * Anything nothing decodes floats high.
 */

import type { ElectronMachine } from './electron-machine.ts';

export function readElectronIo(m: ElectronMachine, addr: number): number {
  if ((addr & 0xFF00) === 0xFE00) return m.ula.read(addr & 0x0F);
  if ((addr & 0xFF00) === 0xFC00) {
    // FRED: whichever fitted expansion decodes the address; the rest floats high.
    if (m.plus1Fitted) { const v = m.plus1.read(addr); if (v !== null) return v; }
    if (m.plus3Fitted) { const v = m.plus3.read(addr); if (v !== null) return v; }
  }
  return 0xFF;
}

export function writeElectronIo(m: ElectronMachine, addr: number, val: number): void {
  if ((addr & 0xFF00) === 0xFC00) {
    if (m.plus1Fitted && m.plus1.write(addr, val)) return;
    if (m.plus3Fitted) m.plus3.write(addr, val);
    return;
  }
  if ((addr & 0xFF00) !== 0xFE00) return;
  const reg = addr & 0x0F;
  if (reg === 0x05) m.memory.writePage(val);      // FE05 pages the ROM and clears interrupts
  m.ula.write(reg, val);
}

/** Install the IO and keyboard hooks on the memory bus. */
export function wireElectronIo(m: ElectronMachine): void {
  m.memory.ioRead = (addr) => readElectronIo(m, addr);
  m.memory.ioWrite = (addr, val) => writeElectronIo(m, addr, val);
  m.memory.kbdRead = (addr) => m.keyboard.read(addr);
  m.memory.kbdPeek = (addr) => m.keyboard.peek(addr);
}
