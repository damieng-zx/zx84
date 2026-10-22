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

  /** Whether the interface decodes this port address (A0-A7 = 0xDF, A8-A15 free). */
  matchPort(port: number): boolean {
    return (port & 0xFF) === SpecDrum.PORT;
  }

  /** OUT to the interface: latch the byte into the DAC. */
  writePort(value: number): void {
    this.dac.write(value);
  }

  /** The DAC output as a 0..1 fraction of full scale (unipolar). */
  get level(): number {
    return this.dac.level;
  }

  /** Machine reset: clear the latch. The board has no reset line, so a real unit
   *  would hold its last code, but that is a DC offset the mixer blocks anyway and
   *  a defined state keeps runs deterministic. */
  reset(): void {
    this.dac.reset();
  }
}
