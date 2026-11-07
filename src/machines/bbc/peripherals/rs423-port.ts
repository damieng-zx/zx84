/**
 * The Model B's RS423 serial port, as a host terminal on the far end.
 *
 * The 6850 ACIA is shared between the cassette and RS423 sockets by the serial
 * ULA (bit 6 of &FE10: 0 = cassette, 1 = RS423); the machine hands the ACIA's
 * transmitted bytes here when RS423 is selected, and drives its receive line
 * from here. Nothing else on the connector is modelled: the MOS's own handshake
 * lines (RTS, CTS, DCD) are not wired to a host, so a host that sends faster
 * than the MOS's 256-byte input buffer is emptied overruns it, exactly as a
 * real terminal that ignored RTS would.
 *
 * Transmitted bytes are kept for download as they left the ACIA (the baud rate
 * the ACIA took them at already set how long they took). Host text is sent as
 * 8 data bits, no parity, one stop bit, back to back at the receive rate the
 * ACIA is configured for; a frame the ACIA is not set up to read (7E1, say)
 * comes out wrong or with framing errors, as on the real cable.
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';

const MAX_OUT = 1 << 22;
const MAX_QUEUE = 1 << 20;
/** Start bit, eight data bits, stop bit. */
const FRAME_BITS = 10;

export class BbcRs423Port {
  private out = new Uint8Array(1024);
  private outLen = 0;
  /** Bytes the host has still to send. */
  private queue: number[] = [];
  /** Cycle the frame being driven started on, or -1 when the line is idle. */
  private frameStart = -1;
  private frameByte = 0;
  /** Cycles per bit of the frame being driven (fixed when it starts). */
  private frameBit = 0;

  /** A byte the ACIA has sent out of the RS423 connector. */
  take(byte: number): void {
    if (this.outLen >= MAX_OUT) return;
    if (this.outLen === this.out.length) {
      const bigger = new Uint8Array(this.out.length * 2);
      bigger.set(this.out);
      this.out = bigger;
    }
    this.out[this.outLen++] = byte & 0xFF;
  }

  /** Everything sent out so far. */
  get sent(): Uint8Array { return this.out.subarray(0, this.outLen); }
  clearSent(): void { this.outLen = 0; }

  /** Queue host text (bytes) to be sent to the BBC. Returns how many were taken. */
  send(bytes: ArrayLike<number>): number {
    let n = 0;
    for (; n < bytes.length && this.queue.length < MAX_QUEUE; n++) this.queue.push(bytes[n] & 0xFF);
    return n;
  }

  /** Bytes still waiting to be sent to the BBC (the frame in progress included). */
  get pending(): number { return this.queue.length + (this.frameStart >= 0 ? 1 : 0); }

  /** Forget everything in flight (power-on); what was sent stays. */
  reset(): void {
    this.queue.length = 0;
    this.frameStart = -1;
  }

  /** Bit `k` of the frame being driven: start (0), data LSB first, stop (1). */
  private bit(k: number): number {
    if (k === 0) return 0;
    if (k <= 8) return (this.frameByte >> (k - 1)) & 1;
    return 1;
  }

  /**
   * The line the ACIA's receiver sees at cycle `now`: its level, the cycle it
   * last changed and the level an idle receiver treats as a start bit. `bitCycles`
   * is the receive bit time the ACIA is clocked at.
   */
  line(now: number, bitCycles: number): { level: number; since: number } {
    if (this.frameStart < 0 && this.queue.length > 0) {
      this.frameStart = now;
      this.frameByte = this.queue.shift()!;
      this.frameBit = bitCycles;
    }
    while (this.frameStart >= 0 && now >= this.frameStart + FRAME_BITS * this.frameBit) {
      if (this.queue.length > 0) {
        // The next byte follows the stop bit with no gap.
        this.frameStart += FRAME_BITS * this.frameBit;
        this.frameByte = this.queue.shift()!;
        this.frameBit = bitCycles;
      } else {
        this.frameStart = -1;
      }
    }
    if (this.frameStart < 0) return { level: 1, since: 0 };
    const k = Math.floor((now - this.frameStart) / this.frameBit);
    const level = this.bit(k);
    let j = k;
    while (j > 0 && this.bit(j - 1) === level) j--;
    return { level, since: this.frameStart + j * this.frameBit };
  }

  // ── Snapshot state ────────────────────────────────────────────────────────

  saveState(w: StateSink): void {
    w.f64(this.frameStart); w.u8(this.frameByte); w.f64(this.frameBit);
    w.u32(this.queue.length);
    for (const b of this.queue) w.u8(b);
  }

  loadState(r: StateSource): void {
    this.frameStart = r.f64(); this.frameByte = r.u8(); this.frameBit = r.f64();
    const n = r.u32();
    if (n > MAX_QUEUE) throw new Error('Snapshot is corrupt');
    this.queue = [];
    for (let i = 0; i < n; i++) this.queue.push(r.u8());
  }
}
