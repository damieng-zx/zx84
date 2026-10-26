/**
 * MC6821 / MC6820 Peripheral Interface Adapter.
 *
 * Two 8-bit ports, each with a data-direction register and a control register,
 * plus two interrupt inputs per port (C1 and C2). The Atari 8-bit uses a 6821
 * for the joysticks, the SIO bus lines and the cassette data/motor lines; the
 * Apple II and many 6502 peripherals use the same part, which is why the model
 * lives in `cores/` rather than in a machine folder.
 *
 * Not modelled: the C2 output modes' handshake timing. C2 is treated as a
 * plain input or a latched output, which is all the Atari wires it for (no C2
 * is connected on the 400/800). The two C1 inputs do generate interrupts.
 *
 * Register selection is deliberately *not* baked in: the 6821 has RS0/RS1
 * pins, and boards wire them differently (the Atari maps address bit 0 to the
 * A/B select and bit 1 to data/control, the reverse of the chip's nominal
 * ordering). The board calls `readData`/`readControl` directly.
 *
 * Control-register bits (same layout for both ports):
 *   bit 0  C1 interrupt enable
 *   bit 1  C1 active transition (0 = high-to-low, 1 = low-to-high)
 *   bit 2  data-register select (0 = DDR, 1 = peripheral register)
 *   bit 3  C2 interrupt enable
 *   bit 4  C2 direction (0 = input, 1 = output)
 *   bit 5  C2 input transition select (input) / output mode (output)
 *   bit 6  C2 interrupt flag (read only)
 *   bit 7  C1 interrupt flag (read only)
 */

export class M6821 {
  /** Data-direction registers: 1 = output. */
  readonly ddr = new Uint8Array(2);
  /** Output latches. */
  readonly out = new Uint8Array(2);
  /** Control registers, bits 0-5 only. */
  readonly cr = new Uint8Array(2);

  /** Live input pin levels on port A (1 = high). Supplied by the board. */
  inputA = 0xFF;
  /** Live input pin levels on port B (1 = high). Supplied by the board. */
  inputB = 0xFF;

  /** Fired after a write to an output port's latch. */
  onOutput: ((port: number) => void) | null = null;

  /** C1/C2 interrupt flags, indexed [port * 2 + (0 = C1, 1 = C2)]. */
  private readonly flag = new Uint8Array(4);
  /** Last sampled C1/C2 line levels, for edge detection. */
  private readonly c1 = new Uint8Array([1, 1]);
  private readonly c2 = new Uint8Array([1, 1]);

  reset(): void {
    this.ddr.fill(0);
    this.out.fill(0);
    this.cr.fill(0);
    this.flag.fill(0);
    this.c1.fill(1);
    this.c2.fill(1);
  }

  /** Every register and interrupt latch as 14 bytes (ddr, out, cr, flags, last
   *  C1 and C2 levels), for snapshots. The input pins belong to the board. */
  exportState(): Uint8Array {
    const s = new Uint8Array(14);
    s.set(this.ddr, 0);
    s.set(this.out, 2);
    s.set(this.cr, 4);
    s.set(this.flag, 6);
    s.set(this.c1, 10);
    s.set(this.c2, 12);
    return s;
  }

  importState(s: Uint8Array): void {
    this.ddr.set(s.subarray(0, 2));
    this.out.set(s.subarray(2, 4));
    this.cr.set(s.subarray(4, 6));
    this.flag.set(s.subarray(6, 10));
    this.c1.set(s.subarray(10, 12));
    this.c2.set(s.subarray(12, 14));
  }

  /** Pins as seen on the data register: driven bits from the latch, the rest
   *  from the board's inputs. */
  portValue(port: number): number {
    const ddr = this.ddr[port];
    const input = port === 0 ? this.inputA : this.inputB;
    return (this.out[port] & ddr) | (input & ~ddr & 0xFF);
  }

  /** Values the chip is actually driving (DDR = 1 bits). */
  outputPins(port: number): number {
    return this.out[port] & this.ddr[port];
  }

  readData(port: number): number {
    // CR2 = 0 selects the data-direction register.
    if ((this.cr[port] & 0x04) === 0) return this.ddr[port];
    const value = this.portValue(port);
    // Reading the peripheral register clears both interrupt flags.
    this.flag[port * 2] = 0;
    this.flag[port * 2 + 1] = 0;
    return value;
  }

  writeData(port: number, value: number): void {
    if ((this.cr[port] & 0x04) === 0) {
      this.ddr[port] = value & 0xFF;
      return;
    }
    this.out[port] = value & 0xFF;
    this.onOutput?.(port);
  }

  readControl(port: number): number {
    const flags = (this.flag[port * 2] ? 0x80 : 0) | (this.flag[port * 2 + 1] ? 0x40 : 0);
    return (this.cr[port] & 0x3F) | flags;
  }

  writeControl(port: number, value: number): void {
    // Only bits 0-5 are writable; the flag bits are read-only status.
    this.cr[port] = value & 0x3F;
  }

  /** Sample the C1 line (CA1 / CB1). */
  setC1(port: number, high: boolean): void {
    const level = high ? 1 : 0;
    if (this.c1[port] === level) return;
    this.c1[port] = level;
    const rising = (this.cr[port] & 0x02) !== 0;
    if (level === (rising ? 1 : 0)) this.flag[port * 2] = 1;
  }

  /** Sample the C2 line (CA2 / CB2), when it is configured as an input. */
  setC2(port: number, high: boolean): void {
    if ((this.cr[port] & 0x10) !== 0) return; // C2 is an output
    const level = high ? 1 : 0;
    if (this.c2[port] === level) return;
    this.c2[port] = level;
    const rising = (this.cr[port] & 0x20) !== 0;
    if (level === (rising ? 1 : 0)) this.flag[port * 2 + 1] = 1;
  }

  /** Any enabled interrupt source asserting /IRQ. */
  get irq(): boolean {
    const a = this.cr[0];
    const b = this.cr[1];
    return ((a & 0x01) !== 0 && this.flag[0] !== 0)
      || ((a & 0x08) !== 0 && this.flag[1] !== 0)
      || ((b & 0x01) !== 0 && this.flag[2] !== 0)
      || ((b & 0x08) !== 0 && this.flag[3] !== 0);
  }
}
