/**
 * MSX port I/O dispatch + memory hooks (Toshiba HX-10).
 *
 * The MSX analogue of `src/io-ports.ts` / `einstein/einstein-io.ts`. On-board
 * devices decode on the low byte of the port:
 *
 *   0x98/0x99  TMS9929A VDP   (0x98 VRAM data, 0x99 control/status)
 *   0xA0/0xA1  AY-3-8910 PSG  (0xA0 address latch, 0xA1 data write)
 *   0xA2       AY-3-8910 PSG  data read
 *   0xA8–0xAB  Intel 8255 PPI (A8 port A = slot select, A9 port B = keyboard
 *              columns, AA port C = keyboard row + LEDs, AB control)
 *
 * The keyboard is scanned through the 8255 (port C low nibble selects the row,
 * port B reads its columns) — not through the AY as on the Einstein/CPC.
 */

import type { MsxMachine } from '@/machines/msx/msx-machine.ts';
import type { MsxMemory } from '@/machines/msx/msx-memory.ts';
import type { MsxKeyboard } from '@/machines/msx/msx-keyboard.ts';

/**
 * MsxPpi — the Intel 8255 as wired on the MSX.
 *
 * Port A (output) is the primary-slot select register, fed straight to the
 * memory pager. Port C (output) carries the keyboard row select in its low
 * nibble; the high nibble drives the CAPS LED, key-click and cassette
 * motor/output, which we latch but don't act on (cassette is a follow-up).
 * Port B (input) returns the selected keyboard row's columns. The control port
 * does standard 8255 mode-set / bit-set-reset (BSR) on port C.
 */
export class MsxPpi {
  private portA = 0;
  private portC = 0;

  constructor(
    private readonly memory: MsxMemory,
    private readonly keyboard: MsxKeyboard,
  ) {}

  /** Port A write (0xA8): primary-slot select. */
  writeA(val: number): void {
    this.portA = val & 0xFF;
    this.memory.setPrimarySlots(this.portA);
  }

  /** Port A read: mode-0 output latch reads back. */
  readA(): number { return this.portA; }

  /** Port B read (0xA9): the selected keyboard row's columns (active-low). */
  readB(): number { return this.keyboard.readColumns(); }

  /** Port C write (0xAA): low nibble = keyboard row; high nibble = LEDs/motor. */
  writeC(val: number): void {
    this.portC = val & 0xFF;
    this.keyboard.selectRow(this.portC & 0x0F);
  }

  /** Port C read: output latch reads back. */
  readC(): number { return this.portC; }

  /** Control port write (0xAB): mode-set (bit7=1) or bit-set-reset on port C. */
  writeControl(val: number): void {
    val &= 0xFF;
    if (val & 0x80) {
      // Mode-set: the MSX uses the fixed configuration (A/C-hi out, B/C-lo in),
      // so there is nothing to reconfigure — just accept the write.
    } else {
      // BSR: bit3–1 select a port-C bit, bit0 sets (1) or resets (0) it.
      const bit = (val >> 1) & 7;
      if (val & 1) this.portC |= (1 << bit);
      else this.portC &= ~(1 << bit) & 0xFF;
      this.keyboard.selectRow(this.portC & 0x0F);
    }
  }

  reset(): void {
    this.portA = 0;
    this.portC = 0;
    this.memory.setPrimarySlots(0);
    this.keyboard.selectRow(0);
  }
}

/** Install CPU memory read/write hooks (no contention on the MSX). */
export function installMsxMemoryHooks(m: MsxMachine): void {
  const memory = m.memory;
  const cpu = m.cpu;

  cpu.read8 = (addr: number): number => {
    addr &= 0xFFFF;
    const val = memory.readByte(addr);
    if (m.memWatchpoints.length > 0 && m.memWatchHit === null) {
      for (const wp of m.memWatchpoints) {
        if ((wp.mode === 'read' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          m.memWatchHit = { addr, value: val, dir: 'read' };
          break;
        }
      }
    }
    return val;
  };

  cpu.write8 = (addr: number, val: number): void => {
    addr &= 0xFFFF;
    memory.writeByte(addr, val);
    if (m.memWatchpoints.length > 0 && m.memWatchHit === null) {
      for (const wp of m.memWatchpoints) {
        if ((wp.mode === 'write' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          m.memWatchHit = { addr, value: val & 0xFF, dir: 'write' };
          break;
        }
      }
    }
  };

  cpu._contendAccurate = () => {};
  cpu.contend = () => {};
}

/** Wire CPU port-in/out to the VDP, PSG and PPI. */
export function wireMsxPortIO(m: MsxMachine): void {
  const cpu = m.cpu;
  const ay = m.ay;
  const vdp = m.vdp;
  const ppi = m.ppi;
  const joy = m.joystick;

  /** PSG register 14 = I/O port A: the selected joystick's directions/triggers. */
  const AY_PORT_A = 14;
  /** PSG register 15 = I/O port B: bit 6 selects the joystick port to read. */
  const AY_PORT_B = 15;

  cpu.portOut = (port: number, val: number): void => {
    port &= 0xFFFF;
    val &= 0xFF;
    if (m.portWatchpoints.size > 0 && m.portWatchpoints.has(port) && m.portWatchHit === null) {
      m.portWatchHit = { port, value: val, dir: 'out' };
    }
    switch (port & 0xFF) {
      case 0x98: vdp.writeData(val); break;
      case 0x99: vdp.writeControl(val); break;
      case 0xA0: ay.selectedReg = val & 0x0F; break;
      case 0xA1:
        ay.writeRegister(ay.selectedReg, val);
        if (ay.selectedReg < 14) m.activity.ayWrites++;
        // PSG port B (reg 15) bit 6 selects which joystick port reg 14 reads.
        else if (ay.selectedReg === AY_PORT_B) joy.setSelect(val);
        break;
      case 0xA8: ppi.writeA(val); break;
      case 0xAA: ppi.writeC(val); break;
      case 0xAB: ppi.writeControl(val); break;
      // 0xA9 (port B) is input-only; 0x99 handled above.
    }
  };

  cpu.portIn = (port: number): number => {
    port &= 0xFFFF;
    const val = dispatchIn(port);
    if (m.portWatchpoints.size > 0 && m.portWatchpoints.has(port) && m.portWatchHit === null) {
      m.portWatchHit = { port, value: val, dir: 'in' };
    }
    return val;
  };

  function dispatchIn(port: number): number {
    switch (port & 0xFF) {
      case 0x98: return vdp.readData();
      case 0x99: return vdp.readStatus();
      case 0xA2:
        // PSG port A (reg 14) is the joystick input on the MSX.
        return ay.selectedReg === AY_PORT_A ? joy.read() : ay.readRegister(ay.selectedReg);
      case 0xA8: return ppi.readA();
      case 0xA9: m.activity.kbdReads++; return ppi.readB();
      case 0xAA: return ppi.readC();
      default: return 0xFF;
    }
  }
}
