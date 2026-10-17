/**
 * Acorn Plus 1 expansion: two ROM cartridge slots, an analogue interface (two
 * joystick channels through an ADC0844) and a Centronics printer port, with the
 * expansion OS in ROM 12.
 *
 *   &FC70  ADC: write starts a conversion on a channel, read returns the result
 *   &FC71  printer data (writing pulses the strobe)
 *   &FC72  status: b7 printer busy, b6 ADC conversion end, b5/b4 fire buttons
 *                  (high when released), b3-b0 read high
 *
 * The first slot (SK1) is paged as ROM 2/3 — the two 16K banks of a 32K
 * cartridge — and the second (SK2) as ROM 0/1. A plain cartridge is read-only
 * ROM and answers only those pages. Nothing is attached to the printer port,
 * so it never reports busy; the analogue channels read centred.
 *
 * Reference: Acorn Electron Plus 1 User Guide; MAME `plus1.cpp` (decode,
 * status bits).
 */

import { ELECTRON_ROM_SIZE } from '../models.ts';

export const PLUS1_ROM_PAGE = 12;
/** SK1's two bank pages. */
export const CART_PAGES = [2, 3] as const;

const ADC_CENTRE = 0x80;

export class ElectronPlus1 {
  /** Bytes written to the printer port (the strobed data), most recent last. */
  printed: number[] = [];
  /** Channel the last conversion was started on (0-3). */
  adcChannel = 0;
  /** Joystick channel values (centred until a joystick is wired in). */
  readonly adc = [ADC_CENTRE, ADC_CENTRE, ADC_CENTRE, ADC_CENTRE];

  reset(): void {
    this.adcChannel = 0;
    this.printed = [];
    this.adc.fill(ADC_CENTRE);
  }

  /** Read from FRED (`addr` is the full 0xFCxx address); null when not ours. */
  read(addr: number): number | null {
    switch (addr) {
      case 0xFC70: return this.adc[this.adcChannel & 3];
      case 0xFC72: return 0x40 | 0x30 | 0x0F;       // conversion done, no fire, printer ready
      default: return null;
    }
  }

  write(addr: number, val: number): boolean {
    switch (addr) {
      case 0xFC70: this.adcChannel = val & 3; return true;       // start conversion (instant)
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
