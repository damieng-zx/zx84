/**
 * National Semiconductor INS8154 "RAM I/O" — 128 bytes of static RAM plus two
 * 8-bit ports on one chip.
 *
 * The device occupies a 256-byte block of the CPU's address space. A7 selects
 * the half: below it, the four registers (mirrored every fourth address,
 * because only A0/A1 are decoded); at and above it, the 128-byte RAM. That is
 * why an Acorn System card decodes its 8154 as "I/O at &0E00, RAM at
 * &0E80-&0EFF" — two views of one chip.
 *
 *   +0x00  port A data      (read: output latch on output pins, pin level on inputs)
 *   +0x01  port B data
 *   +0x02  port A direction (1 = output)
 *   +0x03  port B direction
 *   +0x80  RAM, 128 bytes
 *
 * A port's pins are the outside world's business: `portXInput` is the level the
 * board presents to the chip (a keyboard's data lines, a printer's busy line),
 * and reading a port returns the latch on bits the DDR marks as outputs and
 * that level on the rest.
 *
 * The real part also offers a bit-addressed mode driven by address lines; the
 * Acorn System software uses the byte registers, so that is all this models.
 */

export class Ins8154 {
  /** The chip's 128 bytes of RAM, addressed as +0x80..+0xFF. */
  readonly ram = new Uint8Array(128);

  /** Output latches. */
  portA = 0;
  portB = 0;
  /** Data-direction registers: a 1 bit makes that pin an output. */
  ddrA = 0;
  ddrB = 0;

  /** Pin levels presented by the board to port A / port B (all high = nothing driving). */
  portAInput = 0xFF;
  portBInput = 0xFF;

  private static portValue(latch: number, ddr: number, input: number): number {
    return ((latch & ddr) | (input & (~ddr & 0xFF))) & 0xFF;
  }

  /** Read the byte at `offset` within the chip's 256-byte block. */
  read(offset: number): number {
    const o = offset & 0xFF;
    if ((o & 0x80) !== 0) return this.ram[o & 0x7F];
    switch (o & 3) {
      case 0: return Ins8154.portValue(this.portA, this.ddrA, this.portAInput);
      case 1: return Ins8154.portValue(this.portB, this.ddrB, this.portBInput);
      case 2: return this.ddrA;
      default: return this.ddrB;
    }
  }

  write(offset: number, value: number): void {
    const o = offset & 0xFF;
    const v = value & 0xFF;
    if ((o & 0x80) !== 0) { this.ram[o & 0x7F] = v; return; }
    switch (o & 3) {
      case 0: this.portA = v; break;
      case 1: this.portB = v; break;
      case 2: this.ddrA = v; break;
      default: this.ddrB = v; break;
    }
  }

  /** A read with no side effects, for the debugger (this chip has none either way). */
  peek(offset: number): number {
    return this.read(offset);
  }

  reset(): void {
    this.ram.fill(0);
    this.portA = 0;
    this.portB = 0;
    this.ddrA = 0;
    this.ddrB = 0;
    this.portAInput = 0xFF;
    this.portBInput = 0xFF;
  }
}
