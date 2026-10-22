/**
 * Cheetah SpecDrum — an 8-bit DAC on the Spectrum's expansion bus.
 *
 * The hardware is a single write-only port feeding a ZN428E converter: the Z80
 * software mixes drum samples itself and streams the result to the port, so the
 * interface has no ROM, RAM, timer or interrupt. Only the low address byte is
 * decoded (0xDF); the high byte is a don't-care, so `OUT (C),r` with any B works.
 *
 * Reads are not driven (the DAC is write-only), which is why this can sit next to
 * the Kempston and AMX mice — they also use 0xDF, but only for reads.
 *
 * The converter itself is `cores/zn428e.ts`; this class is the port decode and
 * the on/off switch. The frame loop time-weights `level` into the mixer.
 */

import { ZN428E } from '@/cores/zn428e.ts';

export class SpecDrum {
  /** Fitted (Hardware-pane toggle). A disabled SpecDrum ignores the bus. */
  enabled = false;

  /** The converter the port feeds. */
  readonly dac = new ZN428E();

  /** The low address byte the interface answers to. */
  static readonly PORT = 0xDF;

  /** The code the DAC rests at: mid-scale. The software writes it on start-up and
   *  between drums, and an unsigned converter has to idle there to swing both ways. */
  static readonly IDLE_CODE = 0x80;

  constructor() {
    this.dac.write(SpecDrum.IDLE_CODE);
  }

  /** Whether the interface decodes this port address (A0-A7 = 0xDF, A8-A15 free). */
  matchPort(port: number): boolean {
    return (port & 0xFF) === SpecDrum.PORT;
  }

  /** OUT to the interface: latch the byte into the DAC. */
  writePort(value: number): void {
    this.dac.write(value);
  }

  /** The DAC output as a 0..1 fraction of full scale (unipolar), as the chip makes it. */
  get level(): number {
    return this.dac.level;
  }

  /**
   * The signal the software means to play: the code centred on idle, so 0x80 is 0 and
   * the range is -1 (0x00) to +127/128 (0xFF). This is what the mixer takes — an idle
   * DAC is silence by construction, with no DC offset to filter off or prime.
   */
  get signedLevel(): number {
    return (this.dac.code - SpecDrum.IDLE_CODE) / SpecDrum.IDLE_CODE;
  }

  /** Machine reset: back to the idle code. The board has no reset line, so a real
   *  unit would hold its last code; resting at mid-scale instead gives a defined
   *  state and, unlike zero, doesn't put a full-scale step through the mixer. */
  reset(): void {
    this.dac.write(SpecDrum.IDLE_CODE);
  }
}
