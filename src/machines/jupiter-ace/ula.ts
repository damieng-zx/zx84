/**
 * AceUla — the Jupiter Ace's custom video/input chip.
 *
 * A stripped-down sibling of the Ferranti ULA: the same 8×5 keyboard scan on
 * port 0xFE and the same MIC/tape interface, minus colour attributes, the
 * border palette and the Spectrum's data-driven speaker level. Port
 * semantics (MAME cantab/jupace.cpp io_r/io_w):
 *
 *   IN  0xFE (any even port): bits 0-4 = AND of the selected keyboard half-rows
 *           (active low), bit 5 = tape EAR input (low while the tape waveform
 *           is high), bits 6-7 float high. The read also CLEARS the buzzer
 *           and drops the MIC line.
 *   OUT 0xFE: bit 3 = tape MIC/save output; the write SETS the buzzer
 *           whatever the data byte holds. The border bits exist on the
 *           Spectrum only — the Ace border is always paper.
 *
 * The buzzer is a flip-flop driven by the bus access, not by a data bit. The
 * ROM's BEEP loop (0x0BAF-0x0BC1) alternates IN A,(FE) with OUT (FE),A and
 * writes A = D — the high byte of its own countdown — so the pitch comes
 * from the loop's delay and nothing in the value written. Decoding a level
 * out of bit 4 instead turns BEEP and the key click into sparse clicks.
 */

import type { AceKeyboard } from './keyboard.ts';

export class AceUla {
  /** True while the tape deck is feeding pulses. */
  tapeActive = false;

  /** Current deck EAR level (0/1), latched by the machine's advanceTapeTo(). */
  tapeEarBit = 0;

  /** Tape MIC/save output: bit 3 of the last write, dropped by any read. */
  micBit = 0;

  /** Buzzer flip-flop: set by any write to the port, cleared by any read. */
  buzzerBit = 0;

  constructor(private readonly keyboard: AceKeyboard) {}

  readPort(highByte: number): number {
    // The access itself clears the buzzer and the MIC line — the other half
    // of the ROM's beep loop, and harmless mid-SAVE (the routine's break
    // check at 0x1879 only reads while MIC is already low).
    this.buzzerBit = 0;
    this.micBit = 0;
    // Idle: bit 5 reads high (no tape signal). Playing: bit 5 is the inverted
    // EAR level — the ULA pulls it low while the cassette waveform is high.
    const ear = this.tapeActive ? (this.tapeEarBit ^ 1) : 1;
    return this.keyboard.readHalfRows(highByte) | 0xC0 | (ear << 5);
  }

  writePort(val: number): void {
    this.micBit = (val >> 3) & 1;
    this.buzzerBit = 1;
  }
}
