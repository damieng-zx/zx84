/**
 * BBC Micro memory-mapped IO ("sheila") decode.
 *
 * Wires the System/User 6522 VIAs, the 6845 CRTC, the Video ULA, the ROM-select
 * latch and the IC32 addressable latch (driven by the System VIA's port B). The
 * machine installs `readBbcIo`/`writeBbcIo` on its memory bus.
 *
 * Address map (from the MOS Memory Mapped IO chapter):
 *   0xFE00/0xFE01  CRTC address/data
 *   0xFE08/0xFE09  ACIA 6850 status/data
 *   0xFE10         serial ULA
 *   0xFE20/0xFE21  Video ULA control / palette
 *   0xFE30         ROM select latch
 *   0xFE40-0xFE5F  System VIA
 *   0xFE60-0xFE7F  User VIA
 *   0xFE80-0xFE9F  floppy controller (8271 or WD1770, whichever is fitted)
 *   0xFEA0-0xFEBF  Econet
 *   0xFEC0-0xFEDF  uPD7002 ADC
 *   0xFEE0-0xFEFF  Tube ULA
 * Everything else in 0xFC00-0xFEFF floats high (0xFF).
 */

import type { BbcMachine } from './bbc-machine.ts';

/** Decode the System VIA port B write into the IC32 74LS259 addressable latch.
 *  Bits 0-2 select the latch output, bit 3 is the data. */
export function writeIc32(m: BbcMachine, value: number, ddr: number): void {
  const v = value & ddr & 0x0F;
  const latch = v & 7;
  const data = (v >> 3) & 1;
  switch (latch) {
    case 0: m.ic32.soundEnabled = data === 0; break;
    case 1: case 2: break;                       // speech processor
    case 3: m.ic32.keyboardScan = data === 1; break;
    case 4: m.ic32.c0 = data; break;
    case 5: m.ic32.c1 = data; break;
    case 6: m.ic32.capsLock = data === 0; break;
    case 7: m.ic32.shiftLock = data === 0; break;
  }
}

/** System VIA port A bit 7 as seen by the keyboard interrogate routine: high
 *  (1) when the selected key is pressed, low (0) when up. */
export function keyboardPortAInput(m: BbcMachine): number {
  const sel = m.sysVia.ora & 0x7F;
  const drive = sel & 0x0F;
  const sense = (sel >> 4) & 0x07;
  const pressed = m.keyboard.isDown(drive, sense);
  return pressed ? 0x80 : 0x00;
}

export function readBbcIo(m: BbcMachine, addr: number): number {
  const a = addr & 0xFFFF;
  switch (a & 0xFFF0) {
    case 0xFE00: return m.crtc.readStatus();
    case 0xFE40:
      m.sysVia.portAInput = keyboardPortAInput(m);
      return m.sysVia.read(a & 0x0F);
    case 0xFE50:
      return m.sysVia.read(a & 0x0F);
    case 0xFE60:
      return m.userVia.read(a & 0x0F);
    case 0xFE70:
      return m.userVia.read(a & 0x0F);
    default: break;
  }
  if (a === 0xFE08) return 0x02;                 // ACIA status: TDRE set
  if (a === 0xFE09) return 0xFF;                 // ACIA data
  if (a === 0xFE10) return 0x00;                 // serial ULA (write-only)
  // Video ULA: A0 selects control (0) / palette (1); the whole 0xFE20-0xFE2F
  // block aliases to those two registers (Acorn DFS 1.20 probes 0xFE29).
  if ((a & 0xFFF0) === 0xFE20) return (a & 1) ? m.videoPaletteRegister : m.videoUlaControl;
  if (a === 0xFE30) return m.memory.romsel;
  // The floppy window hosts either controller (8271: FE80-FE84; WD1770: FE80
  // + FE84-FE87); each claims its own registers and floats the rest high.
  if (a >= 0xFE80 && a <= 0xFE87) return m.disc ? m.disc.read(a) : 0xFF;
  // The Tube ULA is absent: the MOS's presence test ($DB3D) reads 0xFE E0 and
  // requires bit 0 clear, so a no-Tube bus reads 0x00 rather than 0xFF.
  if (a >= 0xFEE0) return 0x00;
  return 0xFF;                                   // unclaimed bus
}

export function writeBbcIo(m: BbcMachine, addr: number, val: number): void {
  const a = addr & 0xFFFF;
  const v = val & 0xFF;
  switch (a & 0xFFF0) {
    case 0xFE00:
      if (a === 0xFE00) m.crtc.selectRegister(v);
      else if (a === 0xFE01) m.crtc.writeRegister(v);
      return;
    case 0xFE20:
      // Video ULA block: A0 selects control (0) / palette (1); 0xFE20-0xFE2F
      // all alias to the two registers.
      if ((a & 1) === 0) {
        m.videoUlaControl = v;
      } else {
        m.videoPaletteRegister = v;
        // Bottom four bits are the physical colour EOR 7. The logical-colour
        // field depends on the mode's colour count, which follows the chars-per-
        // line bits and the clock: high clock gives 2/4/16 colours for 80/40/20
        // columns; low clock gives 2 colours except 20-column (4 colours).
        const physical = (v & 0x0F) ^ 7;
        const cpl = (m.videoUlaControl >> 2) & 3;   // 3=80, 2=40, 1=20 cols
        const highClock = (m.videoUlaControl & 0x10) !== 0;
        const colours = highClock ? (cpl === 3 ? 2 : cpl === 2 ? 4 : 16)
          : (cpl === 1 ? 4 : 2);
        let logical: number;
        if (colours === 2) logical = (v >> 7) & 1;
        else if (colours === 4) logical = (((v >> 7) & 1) << 1) | ((v >> 5) & 1);
        else logical = (v >> 4) & 0x0F;
        m.palette[logical & 0x0F] = physical;
      }
      return;
    case 0xFE40:
    case 0xFE50:
      m.sysVia.write(a & 0x0F, v);
      return;
    case 0xFE60:
    case 0xFE70:
      m.userVia.write(a & 0x0F, v);
      return;
    default: break;
  }
  switch (a) {
    case 0xFE08: m.aciaControl = v; return;
    case 0xFE09: return;                         // ACIA data (transmit)
    case 0xFE10: m.serialUlaControl = v; return;
    case 0xFE30: m.memory.romsel = v & 0x0F; return;
    default:
      if (a >= 0xFE80 && a <= 0xFE87) { m.disc?.write(a, v); return; }
      return;                                    // Econet/ADC/Tube: ignored
  }
}

/** Install the IO hooks and wire the VIA port callbacks. Idempotent. */
export function wireBbcIo(m: BbcMachine): void {
  m.memory.ioRead = (addr) => readBbcIo(m, addr);
  m.memory.ioWrite = (addr, val) => writeBbcIo(m, addr, val);

  // System VIA port A is the slow bus: sound writes go to the SN76489 when the
  // IC32 latch has the sound chip enabled. In keyboard mode (DDRA bit 7 clear)
  // writing port A selects a matrix cell, and the keyboard asserts CA2 when
  // that cell is pressed — this is what the MOS's manual scan tests.
  m.sysVia.onPortAWrite = (value, ddr) => {
    if (m.ic32.soundEnabled) { m.psg.write(value); m.activity.psgWrites++; }
    if ((ddr & 0x80) === 0) {
      m.sysVia.setCA2(m.keyboard.anyInColumn(value & 0x0F));
    }
  };
  // Port B drives the addressable latch (DDRB low nibble only).
  m.sysVia.onPortBWrite = (value, ddr) => writeIc32(m, value, ddr);

  // User VIA port A is the printer port; nothing to wire yet.
  m.userVia.portAInput = 0xFF;
  m.userVia.portBInput = 0xFF;
}
