/**
 * MOS 6526 CIA (Complex Interface Adapter).
 *
 * Two 8-bit ports with data-direction registers, two 16-bit interval timers,
 * a BCD time-of-day clock with alarm, a serial shift register and an
 * interrupt control register. Shipped in the Commodore 64, 128, the 1570/1571
 * drives and the Amiga.
 *
 * The chip is advanced lazily: the owning machine calls `advanceTo(t)` with
 * its running cycle count before every register access and after every CPU
 * instruction, and the timers are worked out arithmetically over the gap, so
 * a timer with a long period costs nothing per cycle.
 *
 * Timer behaviour (the 6526 data sheet): a running timer counts down once per
 * clock and, on the clock after it reaches zero, underflows — it reloads from
 * its latch, sets its interrupt flag and, in one-shot mode, stops. A timer
 * therefore underflows every latch + 1 clocks. Writing the high byte of a
 * stopped timer loads the counter from the latch; the LOAD strobe (control
 * bit 4) loads it whatever the state. Timer B can count timer A's underflows.
 *
 * The ports are pin-level: the machine supplies `portAIn`/`portBIn`, which are
 * given what the chip drives (an output bit's value; an input bit floats high)
 * and return what the pins actually read after the rest of the board (keyboard
 * matrix, joysticks, serial bus) has pulled on them.
 *
 * The core never calls back into the machine except through those two pin
 * functions and `onPortWrite`; the machine polls `irq` itself.
 */

import type { StateSink, StateSource } from '@/utils/state-stream.ts';

/** Interrupt sources, as ICR bits. */
export const CIA_INT_TA = 0x01;
export const CIA_INT_TB = 0x02;
export const CIA_INT_ALARM = 0x04;
export const CIA_INT_SP = 0x08;
export const CIA_INT_FLAG = 0x10;

const CR_START = 0x01;
const CR_PBON = 0x02;
const CR_OUTMODE = 0x04;
const CR_ONESHOT = 0x08;
const CR_LOAD = 0x10;

/** One interval timer's state. */
class CiaTimer {
  counter = 0xFFFF;
  latch = 0xFFFF;
  control = 0;
  /** Toggle output on PB6/PB7 (OUTMODE = toggle). */
  toggle = false;
  /** An underflow happened in the last advance (for PB pulse mode). */
  pulsed = false;

  get running(): boolean { return (this.control & CR_START) !== 0; }

  /**
   * Count `ticks` clocks; returns how many underflows that produced. A
   * one-shot timer stops on its first.
   */
  count(ticks: number): number {
    if (ticks <= 0 || !this.running) return 0;
    const first = this.counter + 1;
    if (ticks < first) {
      this.counter -= ticks;
      return 0;
    }
    if ((this.control & CR_ONESHOT) !== 0) {
      this.counter = this.latch;
      this.control &= ~CR_START;
      this.toggle = !this.toggle;
      return 1;
    }
    const period = this.latch + 1;
    const rest = ticks - first;
    const more = Math.floor(rest / period);
    const under = 1 + more;
    this.counter = this.latch - (rest - more * period);
    if ((under & 1) !== 0) this.toggle = !this.toggle;
    return under;
  }

  reset(): void {
    this.counter = 0xFFFF;
    this.latch = 0xFFFF;
    this.control = 0;
    this.toggle = false;
    this.pulsed = false;
  }

  saveState(w: StateSink): void {
    w.u16(this.counter); w.u16(this.latch); w.u8(this.control); w.bool(this.toggle);
  }

  loadState(r: StateSource): void {
    this.counter = r.u16(); this.latch = r.u16(); this.control = r.u8(); this.toggle = r.bool();
    this.pulsed = false;
  }
}

/** BCD increment of one TOD digit pair, wrapping at `limit` (BCD). */
function bcdInc(v: number): number {
  let lo = (v & 0x0F) + 1;
  let hi = v >> 4;
  if (lo > 9) { lo = 0; hi++; }
  return (hi << 4) | lo;
}

export class Mos6526 {
  /** Port registers and their directions (1 = output). */
  pra = 0;
  prb = 0;
  ddra = 0;
  ddrb = 0;

  readonly ta = new CiaTimer();
  readonly tb = new CiaTimer();

  /** Interrupt flags latched (ICR read side, bits 0-4) and the enable mask. */
  icrFlags = 0;
  icrMask = 0;
  /** The /IRQ output is asserted. */
  irq = false;

  /** Serial data register, and how many timer-A underflows remain until the
   *  byte being shifted out is done (0 = idle). */
  sdr = 0;
  private sdrShift = 0;

  // ── Time of day (BCD) ────────────────────────────────────────────────────
  todTenths = 0;
  todSec = 0;
  todMin = 0;
  todHr = 0x01;
  alarmTenths = 0;
  alarmSec = 0;
  alarmMin = 0;
  alarmHr = 0;
  /** Reading the hours freezes what the registers show until the tenths are read. */
  private todLatched = false;
  private latch = new Uint8Array(4);
  /** Writing the hours stops the clock until the tenths are written. */
  private todStopped = true;
  /** Power-line ticks counted towards the next tenth of a second. */
  private todDivider = 0;

  /** Cycle count the timers have been run to. */
  now = 0;

  /** Pin levels given what the chip drives (output bits as set, inputs high). */
  portAIn: (driven: number) => number = (d) => d;
  portBIn: (driven: number) => number = (d) => d;
  /** A port or its direction register was written (index 0 = A, 1 = B). */
  onPortWrite: ((port: number) => void) | null = null;

  /** Port A as the chip drives it: outputs as written, inputs pulled high. */
  get drivenA(): number { return (this.pra | ~this.ddra) & 0xFF; }
  /** Port B as the chip drives it, with the timer outputs on PB6/PB7. */
  get drivenB(): number {
    let v = (this.prb | ~this.ddrb) & 0xFF;
    v = this.timerOut(v, this.ta, 0x40);
    v = this.timerOut(v, this.tb, 0x80);
    return v;
  }

  private timerOut(v: number, t: CiaTimer, bit: number): number {
    if ((t.control & CR_PBON) === 0) return v;
    const high = (t.control & CR_OUTMODE) !== 0 ? t.toggle : t.pulsed;
    return high ? v | bit : v & ~bit;
  }

  reset(): void {
    this.pra = this.prb = this.ddra = this.ddrb = 0;
    this.ta.reset();
    this.tb.reset();
    this.icrFlags = 0;
    this.icrMask = 0;
    this.irq = false;
    this.sdr = 0;
    this.sdrShift = 0;
    this.todTenths = 0; this.todSec = 0; this.todMin = 0; this.todHr = 0x01;
    this.alarmTenths = 0; this.alarmSec = 0; this.alarmMin = 0; this.alarmHr = 0;
    this.todLatched = false;
    this.todStopped = true;
    this.todDivider = 0;
  }

  /** Set an interrupt flag and raise /IRQ if it is enabled. */
  private raise(bits: number): void {
    this.icrFlags |= bits;
    if ((this.icrFlags & this.icrMask) !== 0) this.irq = true;
  }

  /** A falling edge on the FLAG input (the cassette read line, the serial
   *  bus SRQ, the user port's /FLAG). */
  flag(): void { this.raise(CIA_INT_FLAG); }

  /** Run the timers to cycle `t`. */
  advanceTo(t: number): void {
    const n = t - this.now;
    if (n <= 0) return;
    this.now = t;
    this.ta.pulsed = false;
    this.tb.pulsed = false;
    // CNT is not driven by anything on the boards this models, so only the
    // phi2 and timer-A-underflow input modes count.
    const aUnder = (this.ta.control & 0x20) === 0 ? this.ta.count(n) : 0;
    if (aUnder > 0) {
      this.ta.pulsed = true;
      this.raise(CIA_INT_TA);
      if (this.sdrShift > 0) {
        this.sdrShift -= aUnder;
        if (this.sdrShift <= 0) { this.sdrShift = 0; this.raise(CIA_INT_SP); }
      }
    }
    const mode = (this.tb.control >> 5) & 3;
    const bTicks = mode === 0 ? n : mode === 2 ? aUnder : 0;
    if (bTicks > 0 && this.tb.count(bTicks) > 0) {
      this.tb.pulsed = true;
      this.raise(CIA_INT_TB);
    }
  }

  /** One cycle of the power-line clock that drives the time of day: 50 Hz
   *  or 60 Hz, as control register A's bit 7 tells the chip to expect. */
  todTick(): void {
    if (this.todStopped) return;
    const per = (this.ta.control & 0x80) !== 0 ? 5 : 6;
    if (++this.todDivider < per) return;
    this.todDivider = 0;
    this.todTenths = (this.todTenths + 1) & 0x0F;
    if (this.todTenths >= 10) {
      this.todTenths = 0;
      this.todSec = bcdInc(this.todSec);
      if (this.todSec >= 0x60) {
        this.todSec = 0;
        this.todMin = bcdInc(this.todMin);
        if (this.todMin >= 0x60) {
          this.todMin = 0;
          const pm = this.todHr & 0x80;
          let hr = this.todHr & 0x1F;
          if (hr === 0x11) { hr = 0x12; this.todHr = (pm ^ 0x80) | hr; }
          else if (hr === 0x12) this.todHr = pm | 0x01;
          else this.todHr = pm | bcdInc(hr);
        }
      }
    }
    if (this.todTenths === this.alarmTenths && this.todSec === this.alarmSec
      && this.todMin === this.alarmMin && this.todHr === this.alarmHr) {
      this.raise(CIA_INT_ALARM);
    }
  }

  /** Read register `reg` (0-15), with its side effects. */
  read(reg: number): number {
    switch (reg & 0x0F) {
      case 0x0: return this.portAIn(this.drivenA) & 0xFF;
      case 0x1: return this.portBIn(this.drivenB) & 0xFF;
      case 0x2: return this.ddra;
      case 0x3: return this.ddrb;
      case 0x4: return this.ta.counter & 0xFF;
      case 0x5: return this.ta.counter >> 8;
      case 0x6: return this.tb.counter & 0xFF;
      case 0x7: return this.tb.counter >> 8;
      case 0x8: {
        const v = this.todLatched ? this.latch[0] : this.todTenths;
        this.todLatched = false;
        return v;
      }
      case 0x9: return this.todLatched ? this.latch[1] : this.todSec;
      case 0xA: return this.todLatched ? this.latch[2] : this.todMin;
      case 0xB:
        if (!this.todLatched) {
          this.todLatched = true;
          this.latch[0] = this.todTenths; this.latch[1] = this.todSec;
          this.latch[2] = this.todMin; this.latch[3] = this.todHr;
        }
        return this.latch[3];
      case 0xC: return this.sdr;
      case 0xD: {
        const v = this.icrFlags | (this.irq ? 0x80 : 0);
        this.icrFlags = 0;
        this.irq = false;
        return v;
      }
      case 0xE: return this.ta.control & ~CR_LOAD;
      default: return this.tb.control & ~CR_LOAD;
    }
  }

  /** Read without side effects, for the debugger. */
  peek(reg: number): number {
    switch (reg & 0x0F) {
      case 0x8: return this.todTenths;
      case 0x9: return this.todSec;
      case 0xA: return this.todMin;
      case 0xB: return this.todHr;
      case 0xD: return this.icrFlags | (this.irq ? 0x80 : 0);
      default: return this.read(reg);
    }
  }

  write(reg: number, value: number): void {
    const v = value & 0xFF;
    switch (reg & 0x0F) {
      case 0x0: this.pra = v; this.onPortWrite?.(0); break;
      case 0x1: this.prb = v; this.onPortWrite?.(1); break;
      case 0x2: this.ddra = v; this.onPortWrite?.(0); break;
      case 0x3: this.ddrb = v; this.onPortWrite?.(1); break;
      case 0x4: this.ta.latch = (this.ta.latch & 0xFF00) | v; break;
      case 0x5:
        this.ta.latch = (this.ta.latch & 0x00FF) | (v << 8);
        if (!this.ta.running) this.ta.counter = this.ta.latch;
        break;
      case 0x6: this.tb.latch = (this.tb.latch & 0xFF00) | v; break;
      case 0x7:
        this.tb.latch = (this.tb.latch & 0x00FF) | (v << 8);
        if (!this.tb.running) this.tb.counter = this.tb.latch;
        break;
      case 0x8:
        if ((this.tb.control & 0x80) !== 0) this.alarmTenths = v & 0x0F;
        else { this.todTenths = v & 0x0F; this.todStopped = false; }
        break;
      case 0x9:
        if ((this.tb.control & 0x80) !== 0) this.alarmSec = v & 0x7F; else this.todSec = v & 0x7F;
        break;
      case 0xA:
        if ((this.tb.control & 0x80) !== 0) this.alarmMin = v & 0x7F; else this.todMin = v & 0x7F;
        break;
      case 0xB:
        if ((this.tb.control & 0x80) !== 0) this.alarmHr = v & 0x9F;
        else { this.todHr = v & 0x9F; this.todStopped = true; }
        break;
      case 0xC:
        this.sdr = v;
        // Output mode: the byte goes out over 16 timer-A underflows.
        if ((this.ta.control & 0x40) !== 0) this.sdrShift = 16;
        break;
      case 0xD:
        if ((v & 0x80) !== 0) this.icrMask |= v & 0x1F; else this.icrMask &= ~v & 0x1F;
        if ((this.icrFlags & this.icrMask) !== 0) this.irq = true;
        break;
      case 0xE:
        if ((v & CR_LOAD) !== 0) this.ta.counter = this.ta.latch;
        if ((v & CR_START) !== 0 && !this.ta.running) this.ta.toggle = true;
        this.ta.control = v & ~CR_LOAD;
        break;
      default:
        if ((v & CR_LOAD) !== 0) this.tb.counter = this.tb.latch;
        if ((v & CR_START) !== 0 && !this.tb.running) this.tb.toggle = true;
        this.tb.control = v & ~CR_LOAD;
        break;
    }
  }

  saveState(w: StateSink): void {
    w.u8(this.pra); w.u8(this.prb); w.u8(this.ddra); w.u8(this.ddrb);
    this.ta.saveState(w);
    this.tb.saveState(w);
    w.u8(this.icrFlags); w.u8(this.icrMask); w.bool(this.irq);
    w.u8(this.sdr); w.u8(this.sdrShift);
    w.u8(this.todTenths); w.u8(this.todSec); w.u8(this.todMin); w.u8(this.todHr);
    w.u8(this.alarmTenths); w.u8(this.alarmSec); w.u8(this.alarmMin); w.u8(this.alarmHr);
    w.bool(this.todLatched); w.raw(this.latch); w.bool(this.todStopped); w.u8(this.todDivider);
    w.f64(this.now);
  }

  loadState(r: StateSource): void {
    this.pra = r.u8(); this.prb = r.u8(); this.ddra = r.u8(); this.ddrb = r.u8();
    this.ta.loadState(r);
    this.tb.loadState(r);
    this.icrFlags = r.u8(); this.icrMask = r.u8(); this.irq = r.bool();
    this.sdr = r.u8(); this.sdrShift = r.u8();
    this.todTenths = r.u8(); this.todSec = r.u8(); this.todMin = r.u8(); this.todHr = r.u8();
    this.alarmTenths = r.u8(); this.alarmSec = r.u8(); this.alarmMin = r.u8(); this.alarmHr = r.u8();
    this.todLatched = r.bool(); r.rawInto(this.latch); this.todStopped = r.bool(); this.todDivider = r.u8();
    this.now = r.f64();
  }
}
