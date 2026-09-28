/**
 * MOS 6522 Versatile Interface Adapter (VIA).
 *
 * A commodity chip (BBC Micro, Commodore PET, Apple II, …): two 8-bit ports
 * with data-direction registers, two 16-bit timers (T1 one-shot/free-run, T2
 * timed/counted), a shift register, and CA1/CA2/CB1/CB2 handshake lines.
 *
 * The owning machine advances the timers via `addCycles()` once per executed
 * instruction's elapsed cycles, wires the port pins through `portAInput`/
 * `portBInput` and the `onPort*Write` callbacks, and reads `irq` to drive its
 * CPU interrupt line. The chip never calls back into the machine.
 */

// Interrupt flag register bits.
export const VIA_IFR_CA2 = 0x01;
export const VIA_IFR_CA1 = 0x02;
export const VIA_IFR_SR = 0x04;
export const VIA_IFR_CB2 = 0x08;
export const VIA_IFR_CB1 = 0x10;
export const VIA_IFR_T2 = 0x20;
export const VIA_IFR_T1 = 0x40;
export const VIA_IFR_ANY = 0x80;

export class M6522 {
  // ── Registers ───────────────────────────────────────────────────────────
  ora = 0;
  orb = 0;
  ddra = 0;
  ddrb = 0;
  acr = 0;
  pcr = 0;
  sr = 0;
  ifr = 0;
  ier = 0;

  // ── Timers ──────────────────────────────────────────────────────────────
  t1Counter = 0xFFFF;
  t1Latch = 0xFFFF;
  t1Running = false;
  t2Counter = 0xFFFF;
  t2Latch = 0xFFFF;
  t2Running = false;
  /** PB7 output level driven by T1 when ACR bit 7 is set. */
  pb7 = false;

  // ── External pins/callbacks ─────────────────────────────────────────────
  /** External input levels on port A/B (bits with DDR=1 are ignored on read). */
  portAInput = 0xFF;
  portBInput = 0xFF;
  /** Called when the output register is written (value + current DDR). */
  onPortAWrite: (value: number, ddr: number) => void = () => {};
  onPortBWrite: (value: number, ddr: number) => void = () => {};

  private ca1 = false;
  private cb1 = false;
  private ca2 = false;
  private cb2 = false;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.ora = this.orb = 0;
    this.ddra = this.ddrb = 0;
    this.acr = this.pcr = 0;
    this.sr = 0;
    this.ifr = this.ier = 0;
    this.t1Counter = this.t1Latch = 0xFFFF;
    this.t2Counter = this.t2Latch = 0xFFFF;
    this.t1Running = this.t2Running = false;
    this.pb7 = false;
    this.portAInput = this.portBInput = 0xFF;
    this.ca1 = this.cb1 = false;
    this.ca2 = this.cb2 = false;
  }

  /** True while any enabled interrupt flag is set. */
  get irq(): boolean { return (this.ifr & this.ier & 0x7F) !== 0; }

  // ── Ports ───────────────────────────────────────────────────────────────
  private outputA(): number { return (this.ora & this.ddra) | (this.portAInput & ~this.ddra & 0xFF); }
  private outputB(): number { return (this.orb & this.ddrb) | (this.portBInput & ~this.ddrb & 0xFF); }

  private setIFR(bit: number): void { this.ifr |= bit; }

  // ── Handshake inputs ────────────────────────────────────────────────────
  /** CA1 edge: PCR bit 0 selects positive (1) or negative (0) edge. */
  setCA1(level: boolean): void {
    if (level === this.ca1) return;
    this.ca1 = level;
    const positive = (this.pcr & 0x01) !== 0;
    if (positive === level) this.setIFR(VIA_IFR_CA1);
  }

  /** CB1 edge: PCR bit 4 selects positive (1) or negative (0) edge. */
  setCB1(level: boolean): void {
    if (level === this.cb1) return;
    this.cb1 = level;
    const positive = (this.pcr & 0x10) !== 0;
    if (positive === level) this.setIFR(VIA_IFR_CB1);
  }

  /** CA2 input edge (PCR bits 1-3 select the mode): modes 0/1 are negative
   *  edge, 2/3 positive edge; 4-7 are output modes and ignore the input. */
  setCA2(level: boolean): void {
    if (level === this.ca2) return;
    this.ca2 = level;
    const mode = (this.pcr >> 1) & 7;
    if ((mode === 2 || mode === 3) && level) this.setIFR(VIA_IFR_CA2);
    else if ((mode === 0 || mode === 1) && !level) this.setIFR(VIA_IFR_CA2);
  }

  /** CB2 input edge (PCR bits 5-7 select the mode). */
  setCB2(level: boolean): void {
    if (level === this.cb2) return;
    this.cb2 = level;
    const mode = (this.pcr >> 5) & 7;
    if ((mode === 2 || mode === 3) && level) this.setIFR(VIA_IFR_CB2);
    else if ((mode === 0 || mode === 1) && !level) this.setIFR(VIA_IFR_CB2);
  }

  // ── Register access ─────────────────────────────────────────────────────
  read(reg: number): number {
    switch (reg & 0x0F) {
      case 0: {
        const v = this.outputB();
        this.ifr &= ~(VIA_IFR_CB1 | VIA_IFR_CB2);
        return v;
      }
      case 1: {
        const v = this.outputA();
        this.ifr &= ~(VIA_IFR_CA1 | VIA_IFR_CA2);
        return v;
      }
      case 2: return this.ddrb;
      case 3: return this.ddra;
      case 4: this.ifr &= ~VIA_IFR_T1; return this.t1Counter & 0xFF;
      case 5: return (this.t1Counter >> 8) & 0xFF;
      case 6: return this.t1Latch & 0xFF;
      case 7: return (this.t1Latch >> 8) & 0xFF;
      case 8: this.ifr &= ~VIA_IFR_T2; return this.t2Counter & 0xFF;
      case 9: return (this.t2Counter >> 8) & 0xFF;
      case 10: return this.sr;
      case 11: return this.acr;
      case 12: return this.pcr;
      case 13: return this.ifr | (this.irq ? VIA_IFR_ANY : 0);
      case 14: return this.ier | ((this.ier & 0x7F) !== 0 ? VIA_IFR_ANY : 0);
      case 15: return this.outputA();
      default: return 0xFF;
    }
  }

  write(reg: number, val: number): void {
    val &= 0xFF;
    switch (reg & 0x0F) {
      case 0:
        this.orb = val;
        this.onPortBWrite(val, this.ddrb);
        return;
      case 1:
      case 15:
        this.ora = val;
        this.onPortAWrite(val, this.ddra);
        return;
      case 2: this.ddrb = val; return;
      case 3: this.ddra = val; return;
      case 4: this.t1Latch = (this.t1Latch & 0xFF00) | val; return;
      case 5:
        this.t1Latch = (this.t1Latch & 0x00FF) | (val << 8);
        this.t1Counter = this.t1Latch;
        this.t1Running = true;
        this.ifr &= ~VIA_IFR_T1;
        return;
      case 6: this.t1Latch = (this.t1Latch & 0xFF00) | val; return;
      case 7:
        this.t1Latch = (this.t1Latch & 0x00FF) | (val << 8);
        return;
      case 8: this.t2Latch = (this.t2Latch & 0xFF00) | val; return;
      case 9:
        this.t2Latch = (this.t2Latch & 0x00FF) | (val << 8);
        this.t2Counter = this.t2Latch;
        this.t2Running = true;
        this.ifr &= ~VIA_IFR_T2;
        return;
      case 10: this.sr = val; return;
      case 11: this.acr = val; return;
      case 12: this.pcr = val; return;
      case 13: this.ifr &= ~(val & 0x7F); return;
      case 14:
        if (val & VIA_IFR_ANY) this.ier |= val & 0x7F;
        else this.ier &= ~(val & 0x7F);
        return;
      default: return;
    }
  }

  // ── Timer stepping ──────────────────────────────────────────────────────
  addCycles(n: number): void {
    this.stepTimer1(n);
    this.stepTimer2(n);
  }

  /** T1 counts down once per cycle; on underflow it sets the flag and, in
   *  free-run mode (ACR bit 6), reloads from the latch. The counter keeps
   *  running after a one-shot underflow so callers can read the elapsed time. */
  private stepTimer1(n: number): void {
    if (!this.t1Running) return;
    let remaining = n;
    while (remaining > 0) {
      if (remaining <= this.t1Counter) {
        this.t1Counter -= remaining;
        return;
      }
      remaining -= this.t1Counter + 1; // cycles to wrap past zero
      this.t1Counter = 0xFFFF;
      this.ifr |= VIA_IFR_T1;
      if (this.acr & 0x40) this.t1Counter = this.t1Latch;
      if (this.acr & 0x80) this.pb7 = !this.pb7;
    }
  }

  /** T2 is a one-shot: on underflow it sets the flag and does not reload. */
  private stepTimer2(n: number): void {
    if (!this.t2Running) return;
    let remaining = n;
    while (remaining > 0) {
      if (remaining <= this.t2Counter) {
        this.t2Counter -= remaining;
        return;
      }
      remaining -= this.t2Counter + 1;
      this.t2Counter = 0xFFFF;
      this.ifr |= VIA_IFR_T2;
    }
  }
}
