/**
 * Acorn Plus 1 expansion: two ROM cartridge slots, an analogue interface (two
 * joystick channels through an ADC0844) and a Centronics printer port, with the
 * expansion OS in ROM 12.
 *
 *   &FC70  ADC: write starts a conversion on a channel, read returns the result
 *   &FC71  printer data (writing pulses the strobe)
 *   &FC72  status: b7 printer busy, b6 the ADC's /INTR (0 = a conversion has
 *                  finished and not been read), b5 joystick 2 fire, b4
 *                  joystick 1 fire (both low while pressed), b3-b0 read high
 *
 * The ADC0844 takes its channel from the MUX address written to &FC70: the
 * Plus 1 ROM writes 4-7 (b2 set: single-ended) for channels 1-4, ADVAL(1)-
 * ADVAL(4), so the channel is b1-b0. A conversion takes about 40 µs; /INTR
 * then goes low, and reading the result (or starting another conversion)
 * puts it high again. The ROM polls b6 and reads the result when it is low.
 * The sticks are wired as on the BBC Micro: full left and full up read 255,
 * full right and full down 0.
 *
 * The first slot (SK1) is paged as ROM 2/3 — the two 16K banks of a 32K
 * cartridge — and the second (SK2) as ROM 0/1. A plain cartridge is read-only
 * ROM and answers only those pages. Nothing is attached to the printer port,
 * so it never reports busy.
 *
 * Reference: Acorn Electron Plus 1 User Guide; National Semiconductor ADC0844
 * data sheet; the Plus 1 Expansion ROM 1.00's ADC poll (BIT &FC72 / BVS) and
 * channel table (4, 5, 6, 7).
 */

import { ELECTRON_ROM_SIZE } from '../models.ts';

export const PLUS1_ROM_PAGE = 12;
/** SK1's two bank pages. */
export const CART_PAGES = [2, 3] as const;

const ADC_CENTRE = 0x80;
/** ADC0844 conversion time, 40 µs, in 2 MHz CPU cycles. */
export const PLUS1_ADC_CONVERSION_CYCLES = 80;

export class ElectronPlus1 {
  /** Bytes written to the printer port (the strobed data), most recent last. */
  printed: number[] = [];
  /** Channel the last conversion was started on (0-3). */
  adcChannel = 0;
  /** The analogue input on each channel, as the byte it converts to. */
  readonly adc = [ADC_CENTRE, ADC_CENTRE, ADC_CENTRE, ADC_CENTRE];
  /** Fire buttons on joysticks 1 and 2 (status b4 and b5). */
  readonly fire = [false, false];
  /** The ADC's output latch: the last completed conversion. */
  private result = ADC_CENTRE;
  /** CPU cycle the conversion in progress ends, or -1 when none is. */
  private doneAt = -1;
  /** /INTR is low: a finished conversion has not been read yet. */
  private intr = false;

  reset(): void {
    this.adcChannel = 0;
    this.printed = [];
    // The joystick inputs (`adc`, `fire`) are the stick's, not the chip's:
    // a reset leaves them as the host holds them.
    this.result = ADC_CENTRE;
    this.doneAt = -1;
    this.intr = false;
  }

  /** Latch the conversion in progress if it has finished by `now`. */
  private settle(now: number): void {
    if (this.doneAt >= 0 && now >= this.doneAt) {
      this.doneAt = -1;
      this.result = this.adc[this.adcChannel & 3] & 0xFF;
      this.intr = true;
    }
  }

  /** Read from FRED (`addr` is the full 0xFCxx address) at CPU cycle `now`;
   *  null when not ours. */
  read(addr: number, now = 0): number | null {
    switch (addr) {
      case 0xFC70:
        this.settle(now);
        this.intr = false;                          // /RD puts /INTR high again
        return this.result;
      case 0xFC72: {
        this.settle(now);
        let v = 0x0F;                               // printer ready; b3-b0 high
        if (!this.intr) v |= 0x40;
        if (!this.fire[0]) v |= 0x10;
        if (!this.fire[1]) v |= 0x20;
        return v;
      }
      default: return null;
    }
  }

  write(addr: number, val: number, now = 0): boolean {
    switch (addr) {
      case 0xFC70:                                  // MUX address: start a conversion
        this.adcChannel = val & 3;
        this.intr = false;
        this.doneAt = now + PLUS1_ADC_CONVERSION_CYCLES;
        return true;
      case 0xFC71:
        if (this.printed.length < 0x10000) this.printed.push(val);
        return true;
      default: return false;
    }
  }

  /** The two 16K banks a cartridge image presents (a 16K image repeats). */
  static cartridgeBanks(data: Uint8Array): [Uint8Array, Uint8Array] {
    const lo = data.slice(0, ELECTRON_ROM_SIZE);
    const hi = data.length > ELECTRON_ROM_SIZE
      ? data.slice(ELECTRON_ROM_SIZE, ELECTRON_ROM_SIZE * 2)
      : lo;
    return [lo, hi];
  }
}
