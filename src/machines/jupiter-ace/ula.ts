/**
 * AceUla — the Jupiter Ace's custom video/input chip.
 *
 * A stripped-down sibling of the Ferranti ULA: the same 8×5 keyboard scan on
 * port 0xFE and the same MIC/tape interface, minus colour attributes, the
 * border palette and the speaker. Port semantics (MAME cantab/jupace.cpp):
 *
 *   IN  0xFE (any even port): bits 0-4 = AND of the selected keyboard half-rows
 *           (active low), bit 5 = tape EAR input (low while the tape waveform
 *           is high), bits 6-7 float high.
 *   OUT 0xFE: bit 3 = tape MIC/save output, bit 4 = buzzer. The border bits
 *           exist on the Spectrum only — the Ace border is always paper.
 */

import type { AceKeyboard } from './keyboard.ts';

export class AceUla {
  /** True while the tape deck is feeding pulses. */
  tapeActive = false;

  /** Current deck EAR level (0/1), latched by the machine's advanceTapeTo(). */
  tapeEarBit = 0;

  /** Last value written to the MIC bit (bit 3) — the tape save output. */
  micBit = 0;

  /** Last value written to the buzzer bit (bit 4). */
  buzzerBit = 0;

  constructor(private readonly keyboard: AceKeyboard) {}

  readPort(highByte: number): number {
    // Idle: bit 5 reads high (no tape signal). Playing: bit 5 is the inverted
    // EAR level — the ULA pulls it low while the cassette waveform is high.
    const ear = this.tapeActive ? (this.tapeEarBit ^ 1) : 1;
    return this.keyboard.readHalfRows(highByte) | 0xC0 | (ear << 5);
  }

  writePort(val: number): void {
    this.micBit = (val >> 3) & 1;
    this.buzzerBit = (val >> 4) & 1;
  }
}
