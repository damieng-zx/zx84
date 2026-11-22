/**
 * Intel 8255 Programmable Peripheral Interface (PPI).
 *
 * A commodity chip (Acorn Atom, IBM PC/XT, many industrial boards): three 8-bit
 * ports whose directions are set by a control word, plus a mode 0 handshake-free
 * data path and bit set/reset on port C. The Atom wires it to the keyboard
 * matrix, the MC6847 mode pins and the cassette/speaker lines.
 *
 * The owning machine supplies the external pin levels (`portAInput` etc.), is
 * told when an output pin level changes (`onPort*Write`, given the latch value
 * and the port's direction mask), and advances nothing: the PPI has no timers.
 * Configuration is synchronous; the chip never calls back into the machine.
 *
 * Only the mode 0 data path is modelled in full. Modes 1 and 2 (strobed
 * handshake) are accepted and their direction/control semantics are kept, but
 * the handshake lines are not driven; no supported machine uses them.
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';

/** Control word bits. */
const CTRL_MODE_SET = 0x80;
const CTRL_A_DIR = 0x10; // 1 = input
const CTRL_C_UPPER_DIR = 0x08; // 1 = input
const CTRL_B_DIR = 0x02; // 1 = input
const CTRL_C_LOWER_DIR = 0x01; // 1 = input

/** Power-on control word: mode 0, every port an input. */
const RESET_CONTROL = 0x9B;

export class I8255 {
  /** Output latches, ports A, B and C. */
  private readonly out = new Uint8Array(3);
  /** Direction masks: 1 = output (a set bit drives the pin). */
  private readonly ddr = new Uint8Array(3);
  /** The control register as last written (reads back the same byte). */
  control = RESET_CONTROL;

  /** External pin levels for the input bits of each port. */
  portAInput = 0xFF;
  portBInput = 0xFF;
  portCInput = 0xFF;

  /** Called when port A/B/C's driven pins change, with the raw latch and the
   *  port's direction mask (the effective output is `latch & ddr`). */
  onPortAWrite: (value: number, ddr: number) => void = () => {};
  onPortBWrite: (value: number, ddr: number) => void = () => {};
  onPortCWrite: (value: number, ddr: number) => void = () => {};

  constructor() {
    this.reset();
  }

  reset(): void {
    this.out[0] = this.out[1] = this.out[2] = 0;
    this.ddr[0] = this.ddr[1] = this.ddr[2] = 0;
    this.control = RESET_CONTROL;
    this.portAInput = this.portBInput = this.portCInput = 0xFF;
  }

  /** Direction mask for port C, from the control word (mode 0 halves; in
   *  modes 1/2 the handshake bits keep their hardware direction). */
  private cDirection(): number {
    let mask = 0;
    if ((this.control & CTRL_C_LOWER_DIR) === 0) mask |= 0x0F;
    if ((this.control & CTRL_C_UPPER_DIR) === 0) mask |= 0xF0;
    return mask;
  }

  /** A port read: the latch for output bits, the external pins for input bits.
   *  (A mode-1/2 port still behaves this way for the data bits the machine can
   *  observe; the handshake status bits are not modelled.) */
  private readPort(index: number, input: number): number {
    const mask = index === 2 ? this.cDirection() : this.ddr[index];
    return ((this.out[index] & mask) | (input & ~mask)) & 0xFF;
  }

  read(reg: number): number {
    switch (reg & 3) {
      case 0: return this.readPort(0, this.portAInput);
      case 1: return this.readPort(1, this.portBInput);
      case 2: return this.readPort(2, this.portCInput);
      default: return this.control;
    }
  }

  /** Side-effect-free read (the PPI has none, but the debugger's contract has
   *  this shape). */
  peek(reg: number): number { return this.read(reg); }

  write(reg: number, value: number): void {
    const v = value & 0xFF;
    switch (reg & 3) {
      case 0: this.setOut(0, v); break;
      case 1: this.setOut(1, v); break;
      case 2: this.setOut(2, v); break;
      default: this.writeControl(v); break;
    }
  }

  private setOut(index: number, value: number): void {
    this.out[index] = value;
    this.notify(index);
  }

  private notify(index: number): void {
    if (index === 0) this.onPortAWrite(this.out[0], this.ddr[0]);
    else if (index === 1) this.onPortBWrite(this.out[1], this.ddr[1]);
    else this.onPortCWrite(this.out[2], this.cDirection());
  }

  private writeControl(value: number): void {
    if ((value & CTRL_MODE_SET) !== 0) {
      this.control = value;
      this.ddr[0] = (value & CTRL_A_DIR) ? 0 : 0xFF;
      this.ddr[1] = (value & CTRL_B_DIR) ? 0 : 0xFF;
      this.ddr[2] = this.cDirection();
      // A direction change makes the driven pin levels change even though the
      // output latches did not.
      this.notify(0);
      this.notify(1);
      this.notify(2);
      return;
    }
    // Bit set/reset on port C: bit 3 selects the bit, bit 0 its new level.
    const bit = (value >> 1) & 0x07;
    if ((value & 0x01) !== 0) this.out[2] |= 1 << bit;
    else this.out[2] &= ~(1 << bit) & 0xFF;
    this.notify(2);
  }

  /** The output latch of a port (debugger dump). */
  outputLatch(port: number): number { return this.out[port & 3] & 0xFF; }

  /** The direction mask of a port: 1 = output (debugger dump). */
  direction(port: number): number { return port === 2 ? this.cDirection() : this.ddr[port & 3]; }

  /** Effective driven pins of a port (latch & direction). */
  driven(port: number): number {
    return (this.out[port & 3] & (port === 2 ? this.cDirection() : this.ddr[port & 3])) & 0xFF;
  }

  saveState(w: StateSink): void {
    w.u8(this.out[0]); w.u8(this.out[1]); w.u8(this.out[2]);
    w.u8(this.ddr[0]); w.u8(this.ddr[1]); w.u8(this.ddr[2]);
    w.u8(this.control);
    w.u8(this.portAInput); w.u8(this.portBInput); w.u8(this.portCInput);
  }

  loadState(r: StateSource): void {
    this.out[0] = r.u8(); this.out[1] = r.u8(); this.out[2] = r.u8();
    this.ddr[0] = r.u8(); this.ddr[1] = r.u8(); this.ddr[2] = r.u8();
    this.control = r.u8();
    this.portAInput = r.u8(); this.portBInput = r.u8(); this.portCInput = r.u8();
  }
}
