/**
 * Motorola MC6820 Peripheral Interface Adapter (PIA).
 *
 * A commodity chip (Apple I, Ohio Scientific, SWTPC 6800; the 6821 is the same
 * part with a different output stage): two 8-bit ports, each with a data
 * direction register, an output register and a control register, plus two
 * handshake lines per port (CA1/CA2 and CB1/CB2).
 *
 * Four register addresses (RS1:RS0) select the registers:
 *
 *   0  port A data register, or its DDR when CRA bit 2 is clear
 *   1  control register A
 *   2  port B data register, or its DDR when CRB bit 2 is clear
 *   3  control register B
 *
 * Control register bits:
 *
 *   7    IRQ1 flag (read only) — set by an active edge on C1
 *   6    IRQ2 flag (read only) — set by an active edge on C2, when C2 is an input
 *   5-3  C2 control. Bit 5 clear: C2 is an input, bit 4 selects the active edge
 *        (1 = rising) and bit 3 enables its interrupt. Bit 5 set: C2 is an
 *        output — bits 5-3 = 100 handshake, 101 pulse, 110 low, 111 high.
 *   2    1 selects the data register, 0 the DDR
 *   1    C1 active edge (1 = rising)
 *   0    C1 interrupt enable
 *
 * Reading a port's data register clears both flags. The owning machine wires
 * the pins through `portAInput`/`portBInput`, the `onPort*Write` callbacks and
 * the `setCA1`/`setCB1`/`setCA2`/`setCB2` input lines, and reads `irqA`/`irqB`
 * for its interrupt line. The chip never calls back into the machine beyond
 * those callbacks.
 */

export const PIA_CR_IRQ1 = 0x80;
export const PIA_CR_IRQ2 = 0x40;

/** One half of the chip. */
class PiaPort {
  or = 0;
  ddr = 0;
  cr = 0;
  /** Levels the outside world drives on the data pins. */
  pins = 0xFF;
  /** Control line 1 (input only). */
  c1 = false;
  /** Control line 2 as an input. */
  c2In = false;
  /** Control line 2 as an output. */
  c2Out = true;

  onWrite: (value: number, ddr: number) => void = () => {};
  /** The C2 output changed level. */
  onC2: (level: boolean) => void = () => {};

  reset(): void {
    this.or = this.ddr = this.cr = 0;
    this.pins = 0xFF;
    this.c1 = this.c2In = false;
    this.c2Out = true;
  }

  get dataSelected(): boolean { return (this.cr & 0x04) !== 0; }
  get c2IsOutput(): boolean { return (this.cr & 0x20) !== 0; }

  get irq(): boolean {
    const c1 = (this.cr & PIA_CR_IRQ1) !== 0 && (this.cr & 0x01) !== 0;
    const c2 = (this.cr & PIA_CR_IRQ2) !== 0 && (this.cr & 0x08) !== 0 && !this.c2IsOutput;
    return c1 || c2;
  }

  /** What the CPU would read, without clearing flags or pulsing handshake lines. */
  peekData(): number {
    if (!this.dataSelected) return this.ddr;
    return (this.or & this.ddr) | (this.pins & ~this.ddr & 0xFF);
  }

  private setC2Out(level: boolean): void {
    if (this.c2Out === level) return;
    this.c2Out = level;
    this.onC2(level);
  }

  /** A read-triggered handshake (port A): C2 goes low until the next C1 edge
   *  in handshake mode, or pulses low in pulse mode. */
  handshake(): void {
    if ((this.cr & 0x30) !== 0x20) return;       // not handshake/pulse mode
    if ((this.cr & 0x08) === 0) {
      this.setC2Out(false);
    } else {
      this.setC2Out(false);
      this.setC2Out(true);
    }
  }

  readData(handshakeOnRead: boolean): number {
    if (!this.dataSelected) return this.ddr;
    const value = this.peekData();
    this.cr &= 0x3F;
    if (handshakeOnRead) this.handshake();
    return value;
  }

  writeData(value: number, handshakeOnWrite: boolean): void {
    value &= 0xFF;
    if (!this.dataSelected) {
      this.ddr = value;
      return;
    }
    this.or = value;
    this.onWrite(this.or, this.ddr);
    if (handshakeOnWrite) this.handshake();
  }

  writeCr(value: number): void {
    const wasHandshake = (this.cr & 0x30) === 0x20;
    this.cr = (this.cr & 0xC0) | (value & 0x3F);
    if (this.c2IsOutput) {
      if ((this.cr & 0x10) !== 0) {
        this.setC2Out((this.cr & 0x08) !== 0);   // manual: bit 3 is the level
      } else if (!wasHandshake) {
        this.setC2Out(true);                     // entering handshake/pulse idles high
      }
    }
  }

  /** C1 input edge. An active edge sets IRQ1 and, in handshake mode, lets C2 go
   *  high again. */
  setC1(level: boolean): void {
    if (level === this.c1) return;
    this.c1 = level;
    const rising = (this.cr & 0x02) !== 0;
    if (level !== rising) return;
    this.cr |= PIA_CR_IRQ1;
    if ((this.cr & 0x38) === 0x20) this.setC2Out(true);
  }

  /** C2 input edge (only meaningful while C2 is an input). */
  setC2(level: boolean): void {
    if (level === this.c2In) return;
    this.c2In = level;
    if (this.c2IsOutput) return;
    const rising = (this.cr & 0x10) !== 0;
    if (level === rising) this.cr |= PIA_CR_IRQ2;
  }
}

export class M6820 {
  private readonly a = new PiaPort();
  private readonly b = new PiaPort();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.a.reset();
    this.b.reset();
  }

  // ── Registers ───────────────────────────────────────────────────────────
  get ora(): number { return this.a.or; }
  get orb(): number { return this.b.or; }
  get ddra(): number { return this.a.ddr; }
  get ddrb(): number { return this.b.ddr; }
  get cra(): number { return this.a.cr; }
  get crb(): number { return this.b.cr; }

  // ── Pins ────────────────────────────────────────────────────────────────
  /** Levels driven onto the port pins from outside; output bits ignore them. */
  get portAInput(): number { return this.a.pins; }
  set portAInput(v: number) { this.a.pins = v & 0xFF; }
  get portBInput(): number { return this.b.pins; }
  set portBInput(v: number) { this.b.pins = v & 0xFF; }

  /** Called when an output register is written (value + current DDR). */
  set onPortAWrite(fn: (value: number, ddr: number) => void) { this.a.onWrite = fn; }
  set onPortBWrite(fn: (value: number, ddr: number) => void) { this.b.onWrite = fn; }
  /** Called when a C2 output changes level. */
  set onCa2Change(fn: (level: boolean) => void) { this.a.onC2 = fn; }
  set onCb2Change(fn: (level: boolean) => void) { this.b.onC2 = fn; }

  /** CA2/CB2 as driven by the chip when programmed as outputs. */
  get ca2(): boolean { return this.a.c2Out; }
  get cb2(): boolean { return this.b.c2Out; }

  /** True while an enabled interrupt flag of the port is set. */
  get irqA(): boolean { return this.a.irq; }
  get irqB(): boolean { return this.b.irq; }

  // ── Handshake inputs ────────────────────────────────────────────────────
  setCA1(level: boolean): void { this.a.setC1(level); }
  setCB1(level: boolean): void { this.b.setC1(level); }
  setCA2(level: boolean): void { this.a.setC2(level); }
  setCB2(level: boolean): void { this.b.setC2(level); }

  // ── Bus interface ───────────────────────────────────────────────────────
  /** CPU read of register `rs` (0-3). Clears the interrupt flags when it reads
   *  a data register. */
  read(rs: number): number {
    switch (rs & 3) {
      case 0: return this.a.readData(true);
      case 1: return this.a.cr;
      case 2: return this.b.readData(false);
      default: return this.b.cr;
    }
  }

  /** Register `rs` as the CPU would read it, with no side effects (debugger). */
  peek(rs: number): number {
    switch (rs & 3) {
      case 0: return this.a.peekData();
      case 1: return this.a.cr;
      case 2: return this.b.peekData();
      default: return this.b.cr;
    }
  }

  write(rs: number, value: number): void {
    switch (rs & 3) {
      case 0: this.a.writeData(value, false); break;
      case 1: this.a.writeCr(value & 0xFF); break;
      case 2: this.b.writeData(value, true); break;
      default: this.b.writeCr(value & 0xFF); break;
    }
  }
}
