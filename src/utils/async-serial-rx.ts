/**
 * Asynchronous serial receiver: start bit, 7 or 8 data bits LSB first, optional
 * parity, one or two stop bits — the framing a UART (the 6850 ACIA, the
 * Electron ULA's cassette shifter) recovers from a data line.
 *
 * Time is the owning machine's CPU cycle count. The caller feeds the line each
 * step as its current level plus the cycle it last changed; the receiver
 * starts its bit clock from that change (as a UART's divide-by-N counter does
 * from the start-bit edge) and samples every bit in the middle of its cell.
 */

import type { StateSink, StateSource } from './state-stream.ts';

export interface RxFormat {
  readonly dataBits: 7 | 8;
  readonly parity: 'none' | 'even' | 'odd';
  readonly stopBits: 1 | 2;
}

export const FORMAT_8N1: RxFormat = { dataBits: 8, parity: 'none', stopBits: 1 };

export interface RxFrame {
  readonly value: number;
  readonly framingError: boolean;
  readonly parityError: boolean;
}

const enum S { IDLE, START, DATA, PARITY, STOP }

export class AsyncSerialReceiver {
  /** CPU cycles per bit (fractional). */
  bitCycles = 1000;
  format: RxFormat = FORMAT_8N1;
  onFrame: (frame: RxFrame) => void = () => {};

  private state = S.IDLE;
  private next = 0;
  private bit = 0;
  private shift = 0;
  private ones = 0;
  private parityBad = false;
  private stopSeen = 0;
  private stopBad = false;

  reset(): void { this.state = S.IDLE; }

  get idle(): boolean { return this.state === S.IDLE; }

  /** Advance to `now` with the line at `level` (1 = mark) since `since`.
   *  `startLevel` is the level an idle receiver treats as a start bit; it differs
   *  from `level` only for a line whose low level takes a moment to confirm. */
  step(now: number, level: number, since: number, startLevel = level): void {
    if (this.state === S.IDLE) {
      if (startLevel !== 0) return;
      // The bit clock starts at the true falling edge, unless the line has
      // simply been low for ages (receiver just enabled on a break).
      const start = now - since < this.bitCycles ? since : now;
      this.state = S.START;
      this.next = start + this.bitCycles / 2;
    }
    while ((this.state as S) !== S.IDLE && now >= this.next) {
      const v = level;
      switch (this.state) {
        case S.START:
          if (v !== 0) { this.state = S.IDLE; return; }     // glitch, not a start bit
          this.state = S.DATA; this.bit = 0; this.shift = 0; this.ones = 0;
          this.parityBad = false;
          break;
        case S.DATA:
          this.shift |= v << this.bit;
          this.ones += v;
          if (++this.bit >= this.format.dataBits) {
            this.state = this.format.parity === 'none' ? S.STOP : S.PARITY;
            this.stopSeen = 0; this.stopBad = false;
          }
          break;
        case S.PARITY: {
          const total = this.ones + v;
          const even = (total & 1) === 0;
          this.parityBad = this.format.parity === 'even' ? !even : even;
          this.state = S.STOP; this.stopSeen = 0; this.stopBad = false;
          break;
        }
        case S.STOP:
          if (v !== 1) this.stopBad = true;
          if (++this.stopSeen >= this.format.stopBits) {
            this.state = S.IDLE;
            this.onFrame({ value: this.shift, framingError: this.stopBad, parityError: this.parityBad });
            return;
          }
          break;
      }
      this.next += this.bitCycles;
    }
  }

  // ── Snapshot state ────────────────────────────────────────────────────────

  /** Write the frame in progress (state, next sample time, bits so far). The
   *  bit time and format are the owner's to restore. */
  saveState(w: StateSink): void {
    w.u8(this.state); w.f64(this.next);
    w.u8(this.bit); w.u16(this.shift); w.u8(this.ones);
    w.bool(this.parityBad); w.u8(this.stopSeen); w.bool(this.stopBad);
  }

  loadState(r: StateSource): void {
    this.state = r.u8() as S; this.next = r.f64();
    this.bit = r.u8(); this.shift = r.u16(); this.ones = r.u8();
    this.parityBad = r.bool(); this.stopSeen = r.u8(); this.stopBad = r.bool();
  }
}
