/**
 * Ferranti ZN428E 8-bit D/A converter.
 *
 * A latched, unsigned, voltage-output DAC: the byte most recently written is
 * held and the analogue output is proportional to it (code 0x00 = zero volts,
 * 0xFF = full scale). It has no clock and no reset pin — the output only
 * changes when the host writes a new code — so the whole chip is one latch.
 *
 * It was the digital-to-analogue stage in several 8-bit sound add-ons (the
 * Cheetah SpecDrum, and the Cheetah Amdrum for the CPC among them). The chip
 * knows nothing about which port it sits on, how fast the host streams samples
 * or what happens to the signal afterwards — the owning interface decides the
 * port decode, and the audio mixer time-weights `level` across each output
 * sample and applies any coupling/DC-blocking.
 *
 * Reference: Ferranti ZN428E data sheet.
 */

/** Full-scale code: every data line high. */
export const ZN428E_FULL_SCALE = 0xFF;

export class ZN428E {
  private latch = 0;

  /** The latched 8-bit input code, 0..255. */
  get code(): number { return this.latch; }

  /**
   * Analogue output as a fraction of full scale, 0..1 (unipolar, exactly as
   * the chip produces it — the idle level of a held code is a DC offset that
   * the consumer's coupling/high-pass stage removes).
   */
  get level(): number { return this.latch / ZN428E_FULL_SCALE; }

  /** Latch a new code. Only the low 8 bits reach the chip's data lines. */
  write(value: number): void {
    this.latch = value & 0xFF;
  }

  /** Power-on state: code 0x00, output at zero volts. */
  reset(): void {
    this.latch = 0;
  }
}
