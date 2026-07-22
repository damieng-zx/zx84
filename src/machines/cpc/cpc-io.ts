/**
 * CPC port I/O dispatch + memory hooks.
 *
 * The CPC analogue of `src/io-ports.ts`. Decode is by address *line*, not the
 * Spectrum's low-bit convention:
 *   - Gate Array / RAM banking  A15=0,A14=1   (&7Fxx, write)
 *   - CRTC 6845                 A14=0,A13=1   (&BCxx–&BFxx, fn = A9:A8)
 *   - ROM select                A13=0         (&DFxx, write)
 *   - 8255 PPI                  A11=0         (&F4xx–&F7xx, port = A9:A8)
 *   - uPD765A FDC               A10=0         (&FA7E motor / &FB7E/7F)
 *
 * The AY-3-8912 is reached *through* the PPI: data on Port A, function on Port
 * C bits 6/7 (BDIR/BC1). The keyboard sits on the AY's I/O port A and is
 * scanned via the same path. The AY and uPD765A cores are reused unchanged.
 */

import type { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import type { AY3891x } from '@/cores/ay-3-8910.ts';
import type { CpcKeyboard } from '@/machines/cpc/cpc-keyboard.ts';
import type { Asic } from '@/machines/cpc/asic.ts';

/** Manufacturer code reported on PPI Port B bits 1–3 (7 = Amstrad). */
const MANUFACTURER_AMSTRAD = 7;

/**
 * Intel 8255 PPI as wired on the CPC. Mode 0 only (the firmware never uses
 * other modes). Port A ↔ AY data bus, Port B = inputs (VSYNC + config),
 * Port C = outputs (keyboard line select + AY BDIR/BC1 + tape).
 */
export class Ppi8255 {
  private pA = 0;          // Port A output latch
  private pC = 0;          // Port C output latch
  private control = 0x9B;  // reset default: mode 0, all ports input

  constructor(
    private readonly ay: AY3891x,
    private readonly keyboard: CpcKeyboard,
    private readonly vsyncActive: () => boolean,
    /** Called whenever the firmware scans a keyboard line — drives the LED. */
    private readonly onKeyboardScan: () => void = () => {},
    /** Returns the current cassette read level (0/1) for Port B bit 7. The
     *  machine advances the tape to "now" inside this callback so each firmware
     *  read sees an up-to-date edge. */
    private readonly readTapeBit: () => number = () => 0,
    /** Called with the cassette motor state (Port C bit 4) whenever it changes. */
    private readonly setMotor: (on: boolean) => void = () => {},
  ) {}

  /** Port A is an input when control bit 4 is set. */
  private get portAInput(): boolean { return (this.control & 0x10) !== 0; }

  /** AY function from Port C: BDIR=PC7, BC1=PC6 → 0:none 1:read 2:write 3:select. */
  private get ayFunction(): number {
    return (((this.pC >> 7) & 1) << 1) | ((this.pC >> 6) & 1);
  }

  writeA(val: number): void {
    this.pA = val & 0xFF;
    this.strobeAy();
  }

  writeC(val: number): void {
    this.pC = val & 0xFF;
    this.keyboard.selectLine(this.pC & 0x0F);
    this.setMotor((this.pC & 0x10) !== 0);   // bit 4: cassette motor
    this.strobeAy();
  }

  writeControl(val: number): void {
    if (val & 0x80) {
      // Mode-set: 8255 clears its output latches.
      this.control = val & 0xFF;
      this.pA = 0;
      this.pC = 0;
      this.setMotor(false);                  // cleared latch → motor off
    } else {
      // Bit set/reset on a single Port C bit.
      const bit = (val >> 1) & 7;
      if (val & 1) this.pC |= (1 << bit);
      else this.pC &= ~(1 << bit) & 0xFF;
      this.keyboard.selectLine(this.pC & 0x0F);
      this.setMotor((this.pC & 0x10) !== 0); // bit 4: cassette motor
      this.strobeAy();
    }
  }

  readA(): number {
    if (this.portAInput) return this.ayRead();
    return this.pA;
  }

  readB(): number {
    let v = 0;
    if (this.vsyncActive()) v |= 0x01;        // bit 0: CRTC VSYNC
    v |= (MANUFACTURER_AMSTRAD & 7) << 1;      // bits 1–3: manufacturer
    v |= 0x10;                                 // bit 4: 1 = 50 Hz (PAL)
    if (this.readTapeBit()) v |= 0x80;         // bit 7: cassette read data
    return v;                                   // bits 5–6: printer/expansion = 0
  }

  readC(): number { return this.pC; }

  /** Act on the AY when Port C carries a select/write strobe. */
  private strobeAy(): void {
    switch (this.ayFunction) {
      case 3: this.ay.selectedReg = this.pA & 0x0F; break;      // select register
      case 2: this.ay.writeRegister(this.ay.selectedReg, this.pA); break; // write
      // read is satisfied lazily in ayRead()
    }
  }

  /** Resolve a Port-A read while the AY function is "read". Register 14 (the
   *  AY's I/O port A) returns the selected keyboard line when configured as an
   *  input — that is how the CPC scans its keyboard. */
  private ayRead(): number {
    if (this.ayFunction !== 1) return 0xFF;
    if (this.ay.selectedReg === 14) {
      const ioaInput = (this.ay.readRegister(7) & 0x40) === 0;
      if (ioaInput) { this.onKeyboardScan(); return this.keyboard.read(); }
    }
    return this.ay.readRegister(this.ay.selectedReg);
  }

  reset(): void {
    this.pA = 0;
    this.pC = 0;
    this.control = 0x9B;
  }

  // ── Snapshot state (.SNA) ─────────────────────────────────────────────

  /** Port A/C output latches + control register, for snapshot save. Port B is
   *  input-only (computed in readB) so it is not part of the saved state. */
  getState(): { portA: number; portC: number; control: number } {
    return { portA: this.pA, portC: this.pC, control: this.control };
  }

  /** Restore the latches directly — no AY strobe (the AY is restored
   *  separately), but the keyboard line + motor are re-derived from Port C so
   *  the live state matches the restored latch. */
  setState(s: { portA: number; portC: number; control: number }): void {
    this.pA = s.portA & 0xFF;
    this.pC = s.portC & 0xFF;
    this.control = s.control & 0xFF;
    this.keyboard.selectLine(this.pC & 0x0F);
    this.setMotor((this.pC & 0x10) !== 0);
  }
}

/** Install CPU memory read/write hooks (no contention in Phase 1). */
export function installCpcMemoryHooks(m: CpcMachine): void {
  const memory = m.memory;
  const cpu = m.cpu;
  // Plus ASIC register window (when paged in by RMR2) — CPU writes that land
  // in &4000–&7FFF go through the ASIC's `cpuWrite` so palette/sprite/scroll
  // side-effects fire. Null on non-Plus models.
  const asic = m.config.isPlus ? (m.gateArray as unknown as Asic) : null;

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
    // Plus ASIC register window intercepts slot 1 writes for side-effects.
    // The underlying storage write still happens through writePtr[1] →
    // registerPage, but the ASIC's decode (palette, sprite attrs, scroll, …)
    // must run too.
    if (asic !== null && asic.asicPageVisible && (addr >>> 14) === 1) {
      asic.cpuWrite(addr & 0x3FFF, val & 0xFF);
    } else {
      memory.writeByte(addr, val);
    }
    if (m.memWatchpoints.length > 0 && m.memWatchHit === null) {
      for (const wp of m.memWatchpoints) {
        if ((wp.mode === 'write' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          m.memWatchHit = { addr, value: val & 0xFF, dir: 'write' };
          break;
        }
      }
    }
  };

  // The CPC stretches every access to a 1µs boundary; that wait-state model is
  // a later accuracy refinement. No internal-bus contention for now.
  cpu._contendAccurate = () => {};
  cpu.contend = () => {};
}

/** Wire CPU port-in/out to the Gate Array, CRTC, PPI, ROM select, and FDC. */
export function wireCpcPortIO(m: CpcMachine): void {
  const cpu = m.cpu;
  const ppi = m.ppi;
  const ga = m.gateArray;
  const memory = m.memory;
  const fdc = m.fdc;
  // Plus ASIC: present on cpc6128plus / gx4000. Used to snoop the CRTC
  // register-select writes for the unlock sequence (every other Plus feature
  // is reached through CPU memory writes once the ASIC window is paged in).
  const asic = m.config.isPlus ? (ga as unknown as Asic) : null;

  cpu.portOut = (port: number, val: number): void => {
    port &= 0xFFFF;
    if (m.portWatchpoints.size > 0 && m.portWatchpoints.has(port) && m.portWatchHit === null) {
      m.portWatchHit = { port, value: val, dir: 'out' };
    }

    // Multiface Two: snoop every OUT into its RAM shadow (so the toolkit can
    // restore write-only chip state on Return), and handle its paging ports
    // (OUT &FEE8 page in / &FEEA page out, write-decoded).
    if (m.multiface.enabled) {
      m.multiface.recordOut(port, val);
      if (m.multiface.romLoaded) {
        const mf = m.multiface.matchPortOut(port);
        if (mf === 'in') m.multiface.pageIn(memory);
        else if (mf === 'out') m.multiface.pageOut(memory);
      }
    }

    // Gate Array + RAM banking: A15=0, A14=1
    if ((port & 0xC000) === 0x4000) ga.write(val);

    // CRTC: A14=0, A13=1
    if ((port & 0x6000) === 0x2000) {
      const fn = (port >> 8) & 3;
      if (fn === 0) {
        // CRTC register-select writes are snooped by the Plus ASIC for the
        // unlock sequence. The CRTC itself ignores the byte as an out-of-range
        // register select; the ASIC matcher advances/toggles independently.
        if (asic !== null) asic.pokeLockSequence(val);
        m.crtc.selectRegister(val);
      } else if (fn === 1) {
        m.crtc.writeRegister(val);
      }
    }

    // ROM select: A13=0
    if ((port & 0x2000) === 0) memory.selectUpperRom(val & 0xFF);

    // 8255 PPI: A11=0
    if ((port & 0x0800) === 0) {
      switch ((port >> 8) & 3) {
        case 0: ppi.writeA(val); break;
        case 2: ppi.writeC(val); break;
        case 3: ppi.writeControl(val); break;
        // case 1 (Port B) is input-only; writes are ignored.
      }
    }

    // FDC: A10=0
    if ((port & 0x0400) === 0) {
      if ((port & 0x0100) !== 0) {       // A8=1 → &FB7F data
        fdc.writeData(val);
        m.activity.fdcAccesses++;
      } else {                           // A8=0 → motor control (&FA7E)
        fdc.motorOn = (val & 0x01) !== 0;
      }
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
    // Kempston mouse (when fitted). Decoded on lines A10, A8, A4, A0 (the rest
    // are don't-care); the interface answers before the FDC, which it fully
    // decodes clear of (the FDC ports have A4=1, the mouse X/Y need A4=0):
    //   X  0xFBEE  A10=0 A8=1 A4=0 A0=0   (left -ve, right +ve)
    //   Y  0xFBEF  A10=0 A8=1 A4=0 A0=1   (up   +ve, down  -ve)
    //   B  0xFAEF  A10=0 A8=0 A4=0        (bit0=right, bit1=left, active-low)
    if (m.kempstonMouse.enabled) {
      const km = m.kempstonMouse;
      if ((port & 0x0511) === 0x0100) { m.activity.mouseReads++; return km.x & 0xFF; }
      if ((port & 0x0511) === 0x0101) { m.activity.mouseReads++; return km.y & 0xFF; }
      if ((port & 0x0510) === 0x0000) { m.activity.mouseReads++; return km.buttons; }
    }

    // On the Plus ASIC, IN from the Gate Array (&7Fxx, A15=0 A14=1) and from
    // CRTC ports (&BCxx/&BDxx, fn 0/1) performs the same write as an OUT would
    // — the bus value is written to the target register as a ghost-write.
    // Source: cpctech.cpcwiki.de/docs/cpcplus.html.
    if (asic !== null) {
      if ((port & 0xC000) === 0x4000) {
        const busVal = 0xFF;  // bus float value during an IN instruction
        ga.write(busVal);
      }
      if ((port & 0x6000) === 0x2000) {
        const fn = (port >> 8) & 3;
        if (fn === 0) {
          const busVal = 0xFF;
          if (asic !== null) asic.pokeLockSequence(busVal);
          m.crtc.selectRegister(busVal);
        } else if (fn === 1) {
          m.crtc.writeRegister(0xFF);
        }
      }
    }

    // CRTC read: A14=0, A13=1, fn 2/3
    if ((port & 0x6000) === 0x2000) {
      const fn = (port >> 8) & 3;
      if (fn === 2) return m.crtc.readStatus();
      if (fn === 3) return m.crtc.readRegister();
    }

    // 8255 PPI: A11=0
    if ((port & 0x0800) === 0) {
      switch ((port >> 8) & 3) {
        case 0: return ppi.readA();
        case 1: return ppi.readB();
        case 2: return ppi.readC();
        case 3: return 0xFF; // control register is not readable
      }
    }

    // FDC: A10=0, A8=1 → &FB7E status / &FB7F data
    if ((port & 0x0500) === 0x0100) {
      if (port & 1) { m.activity.fdcAccesses++; return fdc.readData(); }
      return fdc.readStatus();
    }

    return 0xFF; // unmapped — the CPC bus floats high
  }
}
