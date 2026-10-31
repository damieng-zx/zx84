/**
 * TZX writer — the inverse of tzx.ts for the handful of block types a
 * recording of a machine's cassette output needs.
 *
 * Layout follows the TZX 1.20 specification: the 10-byte header
 * "ZXTape!" 0x1A, major 1, minor 20, then blocks, each an ID byte and a body:
 *
 *   0x10 Standard Speed Data   pause WORD, length WORD, data
 *   0x11 Turbo Speed Data      pilot, sync1, sync2, bit0, bit1, pilot count
 *                              (WORDs), used bits BYTE, pause WORD,
 *                              length BYTE[3], data
 *   0x18 CSW Recording         block length DWORD (after itself), pause WORD,
 *                              sample rate BYTE[3], compression BYTE (1 = RLE),
 *                              stored pulses DWORD, RLE data
 *   0x20 Pause                 pause WORD (ms; 0 would mean "stop the tape")
 *   0x30 Text Description      length BYTE, ASCII
 *
 * Every multi-byte field is little-endian. Pulse lengths are T-states of the
 * 3.5 MHz reference clock; a .cdt (Amstrad CPC) is the same container with
 * the same reference, so a 4 MHz machine scales its own clock to it.
 */

import { TAPE_REF_HZ } from '@/media/tape/tap.ts';

const MAGIC = [0x5A, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1A];  // "ZXTape!\x1A"
const VERSION_MAJOR = 1;
const VERSION_MINOR = 20;

export type TzxOutBlock =
  /** ROM-timed block; the player regenerates the pilot from the flag byte. */
  | { kind: 'standard'; data: Uint8Array; pause: number }
  | {
    kind: 'turbo'; data: Uint8Array; pause: number;
    pilot: number; sync1: number; sync2: number; bit0: number; bit1: number;
    pilotCount: number; usedBits: number;
  }
  /** Exact pulse widths in 3.5 MHz T-states, stored as an RLE CSW at a
   *  3.5 MHz sample rate so every width survives unchanged. */
  | { kind: 'csw'; pulses: ArrayLike<number>; pause: number }
  | { kind: 'pause'; ms: number }
  | { kind: 'text'; text: string };

/** Growable little-endian byte sink. */
class Sink {
  private buf = new Uint8Array(4096);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  u8(v: number): void { this.ensure(1); this.buf[this.length++] = v & 0xFF; }
  u16(v: number): void { this.u8(v); this.u8(v >> 8); }
  u24(v: number): void { this.u16(v); this.u8(v >>> 16); }
  u32(v: number): void { this.u16(v); this.u16(v >>> 16); }
  bytes(d: ArrayLike<number>): void {
    this.ensure(d.length);
    for (let i = 0; i < d.length; i++) this.buf[this.length++] = d[i];
  }
  /** Overwrite a DWORD already written at `at`. */
  patch32(at: number, v: number): void {
    this.buf[at] = v & 0xFF;
    this.buf[at + 1] = (v >> 8) & 0xFF;
    this.buf[at + 2] = (v >> 16) & 0xFF;
    this.buf[at + 3] = (v >>> 24) & 0xFF;
  }
  result(): Uint8Array { return this.buf.slice(0, this.length); }
}

const word = (v: number): number => Math.max(0, Math.min(0xFFFF, Math.round(v)));

function writeCsw(out: Sink, pulses: ArrayLike<number>, pause: number): void {
  out.u8(0x18);
  const lenAt = out.length;
  out.u32(0);                       // block length, patched below
  const bodyStart = out.length;
  out.u16(word(pause));
  out.u24(TAPE_REF_HZ);             // one sample per reference T-state
  out.u8(1);                        // compression: RLE
  out.u32(pulses.length);
  for (let i = 0; i < pulses.length; i++) {
    const p = Math.max(1, Math.min(0xFFFFFFFF, Math.round(pulses[i])));
    if (p <= 0xFF) out.u8(p);
    else { out.u8(0); out.u32(p); }
  }
  out.patch32(lenAt, out.length - bodyStart);
}

/** Serialise blocks into a complete .tzx / .cdt file. */
export function encodeTzx(blocks: readonly TzxOutBlock[]): Uint8Array {
  const out = new Sink();
  out.bytes(MAGIC);
  out.u8(VERSION_MAJOR);
  out.u8(VERSION_MINOR);
  for (const b of blocks) {
    switch (b.kind) {
      case 'standard':
        if (b.data.length > 0xFFFF) throw new Error('Standard TZX block longer than 65535 bytes');
        out.u8(0x10);
        out.u16(word(b.pause));
        out.u16(b.data.length);
        out.bytes(b.data);
        break;
      case 'turbo':
        out.u8(0x11);
        out.u16(word(b.pilot));
        out.u16(word(b.sync1));
        out.u16(word(b.sync2));
        out.u16(word(b.bit0));
        out.u16(word(b.bit1));
        out.u16(word(b.pilotCount));
        out.u8(b.usedBits >= 1 && b.usedBits <= 8 ? b.usedBits : 8);
        out.u16(word(b.pause));
        out.u24(b.data.length);
        out.bytes(b.data);
        break;
      case 'csw':
        writeCsw(out, b.pulses, b.pause);
        break;
      case 'pause':
        // 0 means "stop the tape" in a 0x20 block; a recorded gap is never that.
        out.u8(0x20);
        out.u16(Math.max(1, word(b.ms)));
        break;
      case 'text': {
        const text = b.text.slice(0, 255);
        out.u8(0x30);
        out.u8(text.length);
        for (let i = 0; i < text.length; i++) {
          const c = text.charCodeAt(i);
          out.u8(c >= 0x20 && c < 0x7F ? c : 0x3F);
        }
        break;
      }
    }
  }
  return out.result();
}
