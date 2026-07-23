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

import type { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';
import { V9938 } from '@/cores/v9938.ts';

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

/** Decode the drive-select latch write (port 0x23) onto the WD1770 (per MAME's
 *  drsel_w): drive select is one-hot on bits 0–3 (bit0 = drive 0, bit1 = drive
 *  1); bit4 selects the side. There is no motor or density bit — the WD1770 runs
 *  fixed double-density and the motor is effectively on while a drive is
 *  selected. */
function setDriveSelect(m: EinsteinMachine, val: number): void {
  if (val & 0x01) m.fdc.selectDrive(0);
  else if (val & 0x02) m.fdc.selectDrive(1);
  m.fdc.side = (val >> 4) & 1;
  m.fdc.motorOn = (val & 0x0F) !== 0;
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
  const is256 = vdp instanceof V9938;

  cpu.portOut = (port: number, val: number): void => {
    port &= 0xFFFF;
    val &= 0xFF;
    if (m.portWatchpoints.size > 0 && m.portWatchpoints.has(port) && m.portWatchHit === null) {
      m.portWatchHit = { port, value: val, dir: 'out' };
    }
    // Einstein 256: the VDP interrupt mask lives outside the on-board decode
    // (0x80, high byte ignored). Bit0 set = masked off.
    if (is256 && (port & 0xFF) === 0x80) {
      m.vdpIntEnabled = (val & 0x01) === 0;
      return;
    }
    // The on-board devices decode at 0x00–0x3F (A6=A7=0). A6/A7 are NOT aliased:
    // e.g. 0x48/0x49 must not fall through to the VDP at 0x08/0x09 (XtalDOS 1.31
    // writes there, and aliasing corrupted the VDP mode → blank screen).
    if (port & 0xC0) return;
    const p = port & 0x3F;
    const reg = p & 0x07;
    switch (p & 0x38) {
      case 0x00: // AY-3-8910
        if (reg === 2) ay.selectedReg = val & 0x0F;
        else if (reg === 3) {
          ay.writeRegister(ay.selectedReg, val);
          // Count only sound-register writes (0–13) for the AY LED — registers
          // 14/15 are the I/O ports used for the keyboard scan every frame.
          if (ay.selectedReg < 14) m.activity.ayWrites++;
          if (ay.selectedReg === AY_PORT_A) kbd.selectRows(val);
        }
        break;
      case 0x08: // VDP
        if (is256) {
          // V9938: 0x08 VRAM data, 0x09 control/status, 0x0A palette,
          // 0x0B indirect register (0x0C–0x0F alias 0x08–0x0B).
          const r = reg & 3;
          if (r === 0) vdp.writeData(val);
          else if (r === 1) vdp.writeControl(val);
          else if (r === 2) (vdp as V9938).writePalette(val);
          else (vdp as V9938).writeRegister(val);
        } else {
          if (reg === 0) vdp.writeData(val); else vdp.writeControl(val);
        }
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
        else if (reg === 2 && is256) kbd.toggleAlphaLock(); // 0x22 ALPHA LOCK (256)
        // reg 0/1/5 = keyboard/ADC/fire interrupt masks — not modelled.
        break;
      case 0x28: // Z80 CTC
        ctc.write(reg, val);
        break;
      case 0x30: // Einstein 256: port A = printer data low nibble + strobe;
        //          0x31 = port A interrupt mask. Not modelled (no printer).
        break;
      // 0x10 (8251), 0x38 (ADC / pseudo-ADC): no-op for now.
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
    if (port & 0xC0) return 0xFF; // A6/A7 not aliased — see portOut
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
        if (is256) {
          // V9938: 0x08 data, 0x09 status; 0x0A/0x0B are write-only.
          const r = reg & 3;
          if (r === 0) return vdp.readData();
          if (r === 1) return vdp.readStatus();
          return 0xFF;
        }
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
        if (is256 && reg === 2) { kbd.toggleAlphaLock(); return 0xFF; } // 0x22 toggles on read too
        if (is256 && reg === 6) return systemStatus(m); // 0x26 system status (256)
        return 0xFF;
      case 0x28: // Z80 CTC
        return ctc.read(reg);
      case 0x30: // Einstein 256: joystick/printer ports. 0x30 = joy 1 + printer
        //          status (idle high), 0x32 = joy 2; 0x31 is write-only.
        if (is256) {
          if (reg === 0) return 0x60 | kbd.joystickByte(1);
          if (reg === 2) return 0x60 | kbd.joystickByte(2);
          return 0xFF;
        }
        return 0xFF;
      case 0x38: // Einstein 256 pseudo-ADC: joystick centred.
        return is256 ? 0x7F : 0xFF;
      default:   // 8251 data, PIO, ADC, unmapped
        return 0xFF;
    }
  }

  /** Port 0x26 system status (Einstein 256, per MAME's system_r):
   *  b0 ALPHA LOCK key down, b1 ROM paged in, b2–b5 dipswitches (hardwired:
   *  625-line/50Hz, parallel printer, English), b6 no mouse, b7 cassette in. */
  function systemStatus(machine: EinsteinMachine): number {
    let v = 0x44;                          // 50Hz dipswitch + no mouse
    if (machine.keyboard.alphaLockKeyPressed()) v |= 0x01;
    if (machine.memory.romPagedIn) v |= 0x02;
    return v;
  }
}
