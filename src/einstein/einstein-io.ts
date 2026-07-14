/**
 * Einstein port I/O dispatch + memory hooks.
 *
 * The Einstein analogue of `src/io-ports.ts` / `cpc/cpc-io.ts`. I/O is decoded
 * into 8-port blocks (address lines A3–A5 select the block, A0–A2 the register
 * within it; A8–A15 are ignored, so every port mirrors throughout I/O space):
 *
 *   0x00–07  reset strobe (0/1) + AY-3-8910 (0x02 addr/data-r, 0x03 data-w)
 *   0x08–0F  TMS9929A VDP (0x08 VRAM data, 0x09 control/status)
 *   0x10–17  Intel 8251 USART (stubbed)
 *   0x18–1F  WD1770 FDC (0x18 cmd/status, 0x19 track, 0x1A sector, 0x1B data)
 *   0x20–27  keyboard status/int-mask (0x20), ADC mask (0x21), drive select
 *            (0x23), ROM/RAM overlay toggle (0x24), fire mask (0x25)
 *   0x28–2F  Z80 CTC (channels 0–3)
 *   0x30–37  Z80 PIO (stubbed)
 *   0x38–3F  ADC0844 (stubbed)
 *
 * The keyboard is scanned through the AY: writing AY register 14 selects the
 * rows, reading register 15 returns the columns — intercepted here so the AY
 * core stays unchanged (as on the CPC).
 */

import type { EinsteinMachine } from '@/einstein/einstein-machine.ts';

/** AY register 14 = I/O port A (keyboard row select). */
const AY_PORT_A = 14;
/** AY register 15 = I/O port B (keyboard column read). */
const AY_PORT_B = 15;

/** Install CPU memory read/write hooks (no contention). */
export function installEinsteinMemoryHooks(m: EinsteinMachine): void {
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

/** Decode a drive-select latch write (port 0x23) onto the WD1770. */
function setDriveSelect(m: EinsteinMachine, val: number): void {
  // bit0/1 select the drive, bit2 the side; motor spins while any drive bit set.
  m.fdc.selectDrive(val & 1);
  m.fdc.side = (val >> 2) & 1;
  m.fdc.motorOn = (val & 0x03) !== 0;
}

/** Wire CPU port-in/out to the AY, VDP, FDC, CTC and the ROM toggle. */
export function wireEinsteinPortIO(m: EinsteinMachine): void {
  const cpu = m.cpu;
  const ay = m.ay;
  const vdp = m.vdp;
  const fdc = m.fdc;
  const ctc = m.ctc;
  const kbd = m.keyboard;
  const memory = m.memory;

  cpu.portOut = (port: number, val: number): void => {
    port &= 0xFFFF;
    val &= 0xFF;
    if (m.portWatchpoints.size > 0 && m.portWatchpoints.has(port) && m.portWatchHit === null) {
      m.portWatchHit = { port, value: val, dir: 'out' };
    }
    const p = port & 0x3F;
    const reg = p & 0x07;
    switch (p & 0x38) {
      case 0x00: // AY-3-8910
        if (reg === 2) ay.selectedReg = val & 0x0F;
        else if (reg === 3) {
          ay.writeRegister(ay.selectedReg, val);
          if (ay.selectedReg === AY_PORT_A) kbd.selectRows(val);
        }
        break;
      case 0x08: // VDP
        if (reg === 0) vdp.writeData(val); else vdp.writeControl(val);
        break;
      case 0x18: // WD1770 FDC
        if (reg === 0) fdc.writeCommand(val);
        else if (reg === 1) fdc.writeTrack(val);
        else if (reg === 2) fdc.writeSectorReg(val);
        else { fdc.writeData(val); m.activity.fdcAccesses++; }
        break;
      case 0x20: // control latches
        if (reg === 4) memory.toggleRom();          // 0x24 ROM/RAM toggle
        else if (reg === 3) setDriveSelect(m, val); // 0x23 drive select
        // reg 0/1/5 = keyboard/ADC/fire interrupt masks — not modelled.
        break;
      case 0x28: // Z80 CTC
        ctc.write(reg, val);
        break;
      // 0x10 (8251), 0x30 (PIO), 0x38 (ADC): no-op for now.
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
    const p = port & 0x3F;
    const reg = p & 0x07;
    switch (p & 0x38) {
      case 0x00: // AY data read (keyboard on port B)
        if (reg === 2) {
          if (ay.selectedReg === AY_PORT_B) { m.activity.kbdReads++; return kbd.readColumns(); }
          return ay.readRegister(ay.selectedReg);
        }
        return 0xFF;
      case 0x08: // VDP
        return reg === 0 ? vdp.readData() : vdp.readStatus();
      case 0x10: // 8251 USART: report Tx ready / empty, no Rx.
        return reg === 1 ? 0x05 : 0x00;
      case 0x18: // WD1770 FDC
        if (reg === 0) return fdc.readStatus();
        if (reg === 1) return fdc.readTrack();
        if (reg === 2) return fdc.readSectorReg();
        m.activity.fdcAccesses++;
        return fdc.readData();
      case 0x20:
        if (reg === 0) return kbd.statusByte();      // 0x20 keyboard status
        if (reg === 4) { memory.toggleRom(); return 0xFF; } // 0x24 also toggles on read
        return 0xFF;
      case 0x28: // Z80 CTC
        return ctc.read(reg);
      default:   // 8251 data, PIO, ADC, unmapped
        return 0xFF;
    }
  }
}
