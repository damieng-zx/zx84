/**
 * Mockingboard sound card (Sweet Micro Systems, model A).
 *
 * Two 6522 VIAs, each driving an AY-3-8910 through its port A (the data bus)
 * and the low three bits of its port B (BC1, BDIR and an active-low reset). The
 * card puts its chips in the card's own `$CNxx` page — the first VIA at
 * `$CN00-$CN7F` and the second at `$CN80-$CNFF`, sixteen registers each,
 * mirrored — and shares the 6502's IRQ line, which the VIA timers use for music
 * tick interrupts. The two AYs are the left and right channels.
 *
 * A write to a VIA's port B is a bus cycle for its AY: with BDIR/BC1 at 11 the
 * byte on port A is the register to select, at 10 it is the data to write, at 01
 * the chip drives port A with the selected register, and at 00 the bus is idle.
 */

import { AY3891x } from '@/cores/ay-3-8910.ts';
import { M6522 } from '@/cores/m6522.ts';
import type { StereoAudioSource } from '@/machines/shared/audio-mixer.ts';
import type { Apple2Card } from '../cards.ts';

/** Output gain per AY into the mix. */
const AY_GAIN = 0.5;

export class Mockingboard implements Apple2Card, StereoAudioSource {
  readonly via: [M6522, M6522] = [new M6522(), new M6522()];
  readonly ay: [AY3891x, AY3891x];

  constructor(readonly slot: number, cpuClock: number, sampleRate: number) {
    this.ay = [
      new AY3891x(cpuClock, sampleRate, 'MONO'),
      new AY3891x(cpuClock, sampleRate, 'MONO'),
    ];
    for (let i = 0; i < 2; i++) this.wire(i);
  }

  private wire(i: number): void {
    const via = this.via[i];
    const ay = this.ay[i];
    via.onPortBWrite = (value, ddr) => {
      // Pins the VIA is not driving float high on the card's pull-ups.
      const pins = (value & ddr) | (~ddr & 0xFF);
      if ((pins & 0x04) === 0) { ay.reset(); return; }       // active-low reset
      const data = (via.ora & via.ddra) | (~via.ddra & 0xFF);
      switch (pins & 0x03) {
        case 0x03: ay.selectRegister(data); break;            // latch address
        case 0x02: ay.writeRegister(ay.selectedReg, data); break;
        case 0x01: via.portAInput = ay.readRegister(ay.selectedReg); break;
        default: break;                                       // inactive
      }
    };
  }

  // ── Apple2Card ──────────────────────────────────────────────────────────

  pageRead(offset: number): number {
    return this.via[(offset >> 7) & 1].read(offset & 0x0F);
  }

  pageWrite(offset: number, val: number): void {
    this.via[(offset >> 7) & 1].write(offset & 0x0F, val);
  }

  reset(): void {
    for (const via of this.via) via.reset();
    for (const ay of this.ay) ay.reset();
  }

  // ── Time and sound ──────────────────────────────────────────────────────

  /** Advance the VIA timers by elapsed CPU cycles. */
  tick(cycles: number): void {
    this.via[0].addCycles(cycles);
    this.via[1].addCycles(cycles);
  }

  /** Either VIA is pulling the IRQ line. */
  get irq(): boolean { return this.via[0].irq || this.via[1].irq; }

  setSampleRate(rate: number): void {
    for (const ay of this.ay) ay.setSampleRate(rate);
  }

  setDcBlocking(enabled: boolean): void {
    for (const ay of this.ay) ay.setDcBlocking(enabled);
  }

  generateSampleStereo(): { left: number; right: number } {
    return {
      left: this.ay[0].generateSample() * AY_GAIN,
      right: this.ay[1].generateSample() * AY_GAIN,
    };
  }
}
