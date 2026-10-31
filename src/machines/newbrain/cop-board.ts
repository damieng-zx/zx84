/**
 * The COP420's side of the NewBrain board.
 *
 * The microcontroller owns everything slow and human: it scans the keyboard,
 * shifts characters out to the vacuum-fluorescent display, switches the
 * cassette motors and keeps the Z80 informed over its bus (port 6). All of
 * that is firmware; what lives here is the wiring around the chip.
 *
 *   G0  out  interrupt request to the Z80 (high = asking)
 *   G1  out  cassette 1 relay, low = motor on    (also reads K9)
 *   G2  in   keyboard line K7
 *   G3  out  cassette 2 relay, low = motor on    (also reads K3)
 *   D0  out  low resets the 7-bit key counter
 *   D1  out  TDO, the data the COP sends to both cassette recorders
 *   D2  out  low is the counting clock; high gates the key lines through
 *   IN0 in   keyboard line K8
 *   SO/SK    the 16-bit shift register that feeds the display
 *   SI  in   the tape input, exclusive-ORed with TDO
 *
 * The keyboard is a 16 × 4 matrix: the counter's low four bits pick one of 16
 * rows (Y0-Y15) and the four columns come back on K3, K7, K8 and K9.
 */

import { Cop420, type Cop420Pins } from '@/cores/cop420.ts';
import type { StateSink, StateSource } from '@/utils/state-stream.ts';

/** Columns of the key matrix, as bits of a row's byte. */
export const K3 = 0x01;
export const K7 = 0x02;
export const K8 = 0x04;
export const K9 = 0x08;

/**
 * The firmware dump in circulation has two bits missing, each a bit-2 dropout
 * in an operand: the DISPCOM entry of the jump table at 0x200 (0x20A reads C2,
 * the code needs C6) and the call that carries the display's flash counter
 * (0x231 reads A2, the code needs A6). Repair them when — and only when —
 * they hold the bad values, so a good dump passes through untouched.
 */
function patchCopRom(rom: Uint8Array): Uint8Array {
  const out = rom.slice();
  if (out.length > 0x231) {
    if (out[0x20A] === 0xC2) out[0x20A] = 0xC6;
    if (out[0x231] === 0xA2) out[0x231] = 0xA6;
  }
  return out;
}

export class NewBrainCopBoard implements Cop420Pins {
  readonly cop: Cop420;

  /** Keys held, per matrix row: bits are {@link K3} {@link K7} {@link K8} {@link K9}. */
  readonly keys = new Uint8Array(16);

  /** The G and D output latches as the COP last wrote them. */
  g = 0;
  d = 0;
  /** The 7-bit key counter (4024). */
  counter = 0;
  /** Display shift register and the digits latched from it. */
  shift = 0;
  readonly digits = new Uint16Array(16);
  private sk = 0;

  /** Tape: the level on the cassette input, and the data the COP sends out. */
  tapeIn = 0;
  tdo = 0;

  /** The interrupt request the COP is making of the Z80 (G0 high). */
  get interrupt(): boolean { return (this.g & 1) !== 0; }
  /** Cassette motors: G1 / G3 low turn the relays on. */
  get motor1(): boolean { return (this.g & 2) === 0; }
  get motor2(): boolean { return (this.g & 8) === 0; }

  /** Called when a G/D change should be reported (the machine watches the relays). */
  onRelays: (() => void) | null = null;
  /** Called with the level the COP is sending to the cassette recorders (TDO)
   *  every time it writes the D port. */
  onTape: ((level: number) => void) | null = null;

  constructor(rom: Uint8Array) {
    this.cop = new Cop420(patchCopRom(rom), this);
  }

  reset(): void {
    this.g = 0; this.d = 0; this.counter = 0; this.shift = 0; this.sk = 0;
    this.digits.fill(0); this.tdo = 0;
    this.cop.reset();
  }

  // ── Cop420Pins ──────────────────────────────────────────────────────────

  private row(): number { return this.keys[this.counter & 15]; }

  readG(): number {
    // The key lines are active high and gated through while D2 is low; G0 reads
    // back the interrupt request the COP is making.
    const k = (this.d & 4) === 0 ? this.row() : 0;
    return (this.g & 1) | (k & K9 ? 2 : 0) | (k & K7 ? 4 : 0) | (k & K3 ? 8 : 0);
  }

  readIN(): number {
    const k = (this.d & 4) === 0 ? this.row() : 0;
    return (k & K8 ? 1 : 0) | 0x0E;
  }

  readL(): number { return 0xFF; }
  readSI(): number { return this.tapeIn ^ this.tdo; }

  writeG(v: number): void {
    const was = this.g;
    this.g = v & 0xF;
    if ((was ^ this.g) & 0xA) this.onRelays?.();
  }

  writeD(v: number): void {
    const was = this.d;
    this.d = v & 0xF;
    this.tdo = (this.d >> 1) & 1;
    this.onTape?.(this.tdo);
    // D0 low resets the counter; each D2 transition clocks it on.
    if ((this.d & 1) === 0) this.counter = 0;
    else if ((was ^ this.d) & 4 && (this.d & 4) !== 0) this.counter = (this.counter + 1) & 0x7F;
    // D2 high latches the display register into the digit selected by the counter.
    if ((this.d & 4) !== 0 && (was & 4) === 0) this.digits[this.counter & 15] = this.shift & 0xFFFF;
  }

  writeL(_v: number): void {}
  writeSO(_v: number): void {}

  writeSK(v: number): void {
    // SK rising shifts the serial data into the display register.
    if (v && !this.sk) this.shift = ((this.shift << 1) | this.serialOut) & 0xFFFF;
    this.sk = v;
  }
  /** SO as last driven. */
  serialOut = 0;

  saveState(w: StateSink): void {
    for (const k of this.keys) w.u8(k);
    w.u8(this.g); w.u8(this.d); w.u8(this.counter); w.u16(this.shift);
    for (const v of this.digits) w.u16(v);
    w.u8(this.sk); w.u8(this.tapeIn); w.u8(this.tdo); w.u8(this.serialOut);
    this.cop.saveState(w);
  }

  loadState(r: StateSource): void {
    for (let i = 0; i < 16; i++) this.keys[i] = r.u8();
    this.g = r.u8(); this.d = r.u8(); this.counter = r.u8(); this.shift = r.u16();
    for (let i = 0; i < 16; i++) this.digits[i] = r.u16();
    this.sk = r.u8(); this.tapeIn = r.u8(); this.tdo = r.u8(); this.serialOut = r.u8();
    this.cop.loadState(r);
  }
}
