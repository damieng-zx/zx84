/**
 * NEC uPD7002 analogue-to-digital converter — the BBC Micro's analogue port
 * (two joysticks, four channels) at SHEILA &FEC0-&FEDF.
 *
 * Registers (A1 A0; the block repeats every four bytes):
 *
 *   write 0  start a conversion: b1-b0 channel, b2 flag (user bit, read back),
 *            b3 0 = 8-bit (about 4 ms), 1 = 12-bit (about 10 ms)
 *   read 0   status: b7 /EOC (1 while converting), b6 /BUSY (0 while
 *            converting), b5-b4 the two most significant result bits, b3-b0
 *            what was written to b3-b0
 *   read 1   result bits 11-4
 *   read 2/3 result bits 3-0 in b7-b4 (the low nibble reads 0)
 *
 * End of conversion drives System VIA CB1 low — the MOS's ADC interrupt, which
 * reads the result into its channel table and starts the next channel. Writes
 * to registers 1-3 are ignored.
 *
 * Channel 0 is joystick 1's left/right, 1 joystick 1's up/down, 2 and 3 the
 * same for joystick 2 (ADVAL(1)-ADVAL(4)). The sticks are potentiometers that
 * read their highest value at full left and full up and 0 at full right and
 * full down (BBC Microcomputer User Guide, ADVAL; Advanced User Guide,
 * Analogue to Digital Converter).
 *
 * Reference: NEC uPD7002 data sheet; BBC Micro Advanced User Guide §§ 18, 28.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/** Conversion times in 2 MHz CPU cycles: 4 ms for 8-bit, 10 ms for 12-bit. */
export const ADC_8BIT_CYCLES = 8_000;
export const ADC_12BIT_CYCLES = 20_000;

export class Upd7002 {
  /** The analogue input on each channel, as the 12-bit value it converts to. */
  readonly inputs = new Uint16Array([0x800, 0x800, 0x800, 0x800]);
  /** Status register: /EOC and /BUSY plus the latched control nibble. */
  private status = 0x40;
  /** The last completed conversion (12 bits). */
  private result = 0;
  /** CPU cycle the conversion in progress completes, or -1 when idle. */
  doneAt = -1;
  /** Drives System VIA CB1 (the /EOC pin): high while converting, low when done. */
  onEoc: (level: boolean) => void = () => {};

  reset(): void {
    this.status = 0x40;
    this.result = 0;
    this.doneAt = -1;
  }

  /** A write to &FEC0-&FEDF at CPU cycle `now`. */
  write(reg: number, val: number, now: number): void {
    if ((reg & 3) !== 0) return;
    this.status = 0x80 | (val & 0x0F);        // converting: /EOC high, /BUSY low
    this.doneAt = now + ((val & 0x08) ? ADC_12BIT_CYCLES : ADC_8BIT_CYCLES);
    this.onEoc(true);
  }

  read(reg: number): number {
    switch (reg & 3) {
      case 0: return this.status;
      case 1: return (this.result >> 4) & 0xFF;
      default: return (this.result << 4) & 0xF0;
    }
  }

  /** Finish the conversion if its time has come. Called as the CPU runs. */
  tick(now: number): void {
    if (this.doneAt < 0 || now < this.doneAt) return;
    this.doneAt = -1;
    const ch = this.status & 3;
    let v = this.inputs[ch] & 0xFFF;
    if ((this.status & 0x08) === 0) v &= 0xFF0;  // an 8-bit conversion has no low nibble
    this.result = v;
    this.status = 0x40 | (((v >> 10) & 3) << 4) | (this.status & 0x0F);
    this.onEoc(false);
  }

  /** Snapshot: the status and result registers, the conversion in progress
   *  and the inputs the sticks are driving. */
  saveState(w: StateWriter): void {
    w.u8(this.status); w.u16(this.result); w.f64(this.doneAt);
    for (let ch = 0; ch < 4; ch++) w.u16(this.inputs[ch]);
  }

  loadState(r: StateReader): void {
    this.status = r.u8(); this.result = r.u16() & 0xFFF; this.doneAt = r.f64();
    for (let ch = 0; ch < 4; ch++) this.inputs[ch] = r.u16() & 0xFFF;
  }
}
