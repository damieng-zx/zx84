/**
 * The Model B's parallel printer port: a Centronics printer on the User VIA.
 *
 * Wiring (Advanced User Guide, "The printer port"): data bits D0-D7 are User
 * VIA port A (PA0-PA7); /STROBE is CA2, an output; the printer's /ACKNOWLEDGE
 * is CA1, an input. There is no BUSY line on the connector and none of the
 * IC32 addressable-latch outputs (sound, keyboard, screen wrap, the two
 * lamps) belongs to the printer, so those play no part here.
 *
 * The MOS drives it in the usual 6522 handshake style: it writes the byte to
 * port A and CA2 (in handshake or pulse output mode, PCR bits 3-1 = 100 or
 * 101) goes low; the printer takes the byte as /STROBE falls, and its
 * /ACKNOWLEDGE pulse a little later (CA1) both interrupts the MOS, which sends
 * the next one, and — in handshake mode — sets CA2 high again. PCR modes 110
 * and 111 hold CA2 low or high by hand, which is how other software strobes
 * it; the printer sees the same falling edge.
 *
 * The printer here is an ideal one: it always accepts the byte, acknowledges
 * after `ACK_DELAY` cycles (a fast printer's busy time) with a pulse
 * `ACK_WIDTH` cycles wide, and keeps everything it was sent. Because the
 * pulse is a real CA1 edge, a program that reads port A or never sets the
 * handshake mode up behaves as it would against a real printer.
 */

import type { M6522 } from '@/cores/m6522.ts';
import type { StateSink, StateSource } from '@/utils/state-stream.ts';

/** Cycles (2 MHz) from the strobe to /ACKNOWLEDGE going low: 100 µs. */
const ACK_DELAY = 200;
/** Cycles /ACKNOWLEDGE stays low: 8 µs. */
const ACK_WIDTH = 16;
/** Most a run keeps; the oldest output is not dropped, the rest is. */
const MAX_BYTES = 1 << 22;

export class BbcPrinterPort {
  private buf = new Uint8Array(4096);
  private len = 0;
  /** Bytes dropped after `MAX_BYTES` (so the Save item can say so). */
  dropped = 0;

  /** /STROBE as the printer sees it (CA2): idle high. */
  private strobe = true;
  /** /ACKNOWLEDGE (CA1): idle high. */
  private ack = true;
  /** Cycle the next ACK edge is due, or -1. */
  private nextEdge = -1;

  constructor(private readonly via: M6522) {}

  /** Everything the printer has been sent, in order. */
  get bytes(): Uint8Array { return this.buf.subarray(0, this.len); }
  get length(): number { return this.len; }

  clear(): void { this.len = 0; this.dropped = 0; }

  /** Power-on: lines idle high. The captured output is not machine state and
   *  survives a reset, like paper in a printer. */
  reset(): void {
    this.strobe = true;
    this.ack = true;
    this.nextEdge = -1;
    this.via.setCA1(true);
  }

  /** Idle lines without touching the VIA (a restored state has its own). */
  settle(): void {
    this.strobe = true;
    this.ack = true;
    this.nextEdge = -1;
  }

  private take(byte: number): void {
    if (this.len >= MAX_BYTES) { this.dropped++; return; }
    if (this.len === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.len++] = byte;
  }

  /** The byte on the data lines: bits the VIA drives, the rest pulled high. */
  private dataLines(): number {
    return (this.via.ora & this.via.ddra) | (~this.via.ddra & 0xFF);
  }

  private setStrobe(level: boolean, now: number): void {
    if (level === this.strobe) return;
    this.strobe = level;
    // The printer latches the data as /STROBE goes low, and acknowledges it.
    if (!level) {
      this.take(this.dataLines());
      this.nextEdge = now + ACK_DELAY;
    }
  }

  /** CA2's output mode (PCR bits 3-1): 100 handshake, 101 pulse, 110 low,
   *  111 high; anything else is an input and the pin floats high. */
  private mode(): number { return (this.via.pcr >> 1) & 7; }

  /** A write to the User VIA, `reg` its register, after the VIA took it. */
  afterWrite(reg: number, now: number): void {
    reg &= 0x0F;
    if (reg === 12) {
      const m = this.mode();
      if (m === 6) this.setStrobe(false, now);
      else this.setStrobe(true, now);
    } else if (reg === 1) {
      // A write to port A with the handshake: the data is out, so strobe.
      const m = this.mode();
      if (m === 4) this.setStrobe(false, now);
      else if (m === 5) { this.setStrobe(false, now); this.setStrobe(true, now); }
    }
  }

  /** A read of port A with the handshake (the same CA2 behaviour as a write). */
  afterRead(reg: number, now: number): void {
    if ((reg & 0x0F) !== 1) return;
    const m = this.mode();
    if (m === 4) this.setStrobe(false, now);
    else if (m === 5) { this.setStrobe(false, now); this.setStrobe(true, now); }
  }

  /** Step to cycle `now`: deliver the printer's /ACKNOWLEDGE edges. */
  tick(now: number): void {
    while (this.nextEdge >= 0 && now >= this.nextEdge) {
      // Handshake mode: CA2 returns high on the active CA1 edge, the one PCR
      // bit 0 chooses (0 = falling, 1 = rising).
      const handshaking = this.mode() === 4 && !this.strobe;
      if (this.ack) {
        this.ack = false;
        this.via.setCA1(false);
        this.nextEdge += ACK_WIDTH;
        if (handshaking && (this.via.pcr & 1) === 0) this.strobe = true;
      } else {
        this.ack = true;
        this.via.setCA1(true);
        this.nextEdge = -1;
        if (handshaking && (this.via.pcr & 1) !== 0) this.strobe = true;
      }
    }
  }

  // ── Snapshot state ────────────────────────────────────────────────────────

  /** The lines and the pending edge; what was printed is output, not state. */
  saveState(w: StateSink): void {
    w.bool(this.strobe); w.bool(this.ack); w.f64(this.nextEdge);
  }

  loadState(r: StateSource): void {
    this.strobe = r.bool(); this.ack = r.bool(); this.nextEdge = r.f64();
  }

  // ── Export ───────────────────────────────────────────────────────────────

  /** The output as text: CR, LF and CR LF all become a line break, other bytes
   *  are kept as they are (control codes included) and read as Latin-1, so the
   *  file is UTF-8 text. */
  asText(): Uint8Array {
    const src = this.bytes;
    let text = '';
    let run: number[] = [];
    const flush = (): void => { text += String.fromCharCode(...run); run = []; };
    for (let i = 0; i < src.length; i++) {
      let b = src[i];
      if (b === 0x0D) {
        b = 0x0A;
        if (src[i + 1] === 0x0A) i++;
      }
      run.push(b);
      if (run.length === 4096) flush();
    }
    flush();
    return new TextEncoder().encode(text);
  }
}
