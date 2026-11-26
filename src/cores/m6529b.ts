/**
 * MOS 6529B single-port interface (a "PIO").
 *
 * One 8-bit port with a data-direction register, plus an output latch: the part
 * the Commodore Plus/4 and C16 use for their user port and for driving the
 * keyboard matrix rows. It has none of the handshake lines a 6522/6821 has —
 * one data address and one direction address.
 *
 *   register 0 (A0 = 0)  the peripheral register: writes latch the output,
 *                        reads return the pins (driven bits from the latch,
 *                        the rest from the board)
 *   register 1 (A0 = 1)  the data-direction register: 1 = output
 *
 * Reading either register clears nothing and has no other side effect. The
 * board supplies the input levels through `pins` and hears writes through
 * `onWrite`. The chip never calls back into the machine beyond those.
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';

export class M6529B {
  /** The output latch. */
  out = 0xFF;
  /** Data-direction register: 1 = output. */
  ddr = 0;
  /** Levels the outside world drives on the pins. */
  pins = 0xFF;

  /** Fired after a write to the peripheral register (the new value, and the DDR). */
  onWrite: ((value: number, ddr: number) => void) | null = null;

  reset(): void {
    this.out = 0xFF;
    this.ddr = 0;
    this.pins = 0xFF;
  }

  /** What the pins carry now: the latch on the outputs, the board on the inputs. */
  get value(): number { return (this.out & this.ddr) | (this.pins & ~this.ddr & 0xFF); }

  /** The bits the chip itself is driving. */
  get driven(): number { return this.out & this.ddr; }

  /** The pins the chip holds LOW: configured as outputs and latched 0. */
  get drivenLow(): number { return this.ddr & ~this.out & 0xFF; }

  /** Six bits of the latch (the KERNAL's scan uses the top two for the ports). */
  get latch(): number { return this.out & 0xFF; }

  /** Read register `rs` (0 data, 1 direction) without side effects. */
  peek(rs: number): number { return (rs & 1) === 1 ? this.ddr : this.value; }

  read(rs: number): number { return this.peek(rs); }

  write(rs: number, value: number): void {
    const v = value & 0xFF;
    if ((rs & 1) === 1) {
      this.ddr = v;
      return;
    }
    this.out = v;
    this.onWrite?.(this.out, this.ddr);
  }

  saveState(w: StateSink): void {
    w.u8(this.out); w.u8(this.ddr); w.u8(this.pins);
  }

  /** Restore what `saveState` wrote, without calling the write callback. */
  loadState(r: StateSource): void {
    this.out = r.u8(); this.ddr = r.u8(); this.pins = r.u8();
  }
}
