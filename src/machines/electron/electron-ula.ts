/**
 * The Acorn Electron's ULA (Ferranti 12C021): the single custom chip that holds
 * most of the BBC Micro's support circuitry. It generates the video, arbitrates
 * RAM between the display and the CPU, pages the ROMs, scans the keyboard
 * through ROM pages 8/9, produces the 1-bit sound, and talks to the cassette.
 *
 * Registers (16 bytes at 0xFE00, repeating through 0xFEFF):
 *
 *   &FE00  read: interrupt status; write: interrupt enable mask
 *   &FE02/3  screen start address (low / high)
 *   &FE04  cassette data shift register
 *   &FE05  write: ROM page (low nibble) + clear interrupts (bits 4-6)
 *   &FE06  sound / tape counter divider
 *   &FE07  misc: bits 1-2 comms mode, 3-5 display mode, 6 motor, 7 caps LED
 *   &FE08-F  palette
 *
 * Interrupt status bits: 1 power-on reset, 2 display end, 3 RTC (50 Hz), 4
 * receive data full, 5 transmit data empty, 6 high-tone detect; bit 0 is the
 * resulting IRQ. The comms mode in FE07 selects cassette input (00), sound
 * generation (01) or cassette output (10).
 *
 * Reference: Acorn Electron Advanced User Guide; MAME `electron_ula.cpp`
 * (register behaviour, palette wiring, mode tables); ElectrEm notes on memory
 * timing (see `ElectronMachine`).
 */

import { AsyncSerialReceiver, FORMAT_8N1 } from '@/utils/async-serial-rx.ts';
import type { CassetteDrive } from '@/machines/shared/cassette-drive.ts';
import {
  ELECTRON_ACTIVE_WIDTH, ELECTRON_BORDER_LEFT, ELECTRON_CPU_CLOCK, ELECTRON_SCREEN_WIDTH,
  ELECTRON_TAPE_BAUD,
} from './constants.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

export const INT_POWER_ON_RESET = 0x02;
export const INT_DISPLAY_END = 0x04;
export const INT_RTC = 0x08;
export const INT_RECEIVE_FULL = 0x10;
export const INT_TRANSMIT_EMPTY = 0x20;
export const INT_HIGH_TONE = 0x40;

/** Comms mode, FE07 bits 1-2. */
export const COMMS_TAPE_IN = 0;
export const COMMS_SOUND = 1;
export const COMMS_TAPE_OUT = 2;

/** Per display mode (0-7; the ULA treats mode 7 as mode 6): bytes of screen
 *  memory before the address wraps, last displayed line, character-row height
 *  in lines, and bits per pixel. Modes 3 and 6 are the gapped text modes. */
export const MODE_SIZE = [0x5000, 0x5000, 0x5000, 0x4000, 0x2800, 0x2800, 0x2000, 0x2000] as const;
export const MODE_DISPEND = [256, 256, 256, 250, 256, 256, 250, 250] as const;
export const MODE_MAX_RA = [8, 8, 8, 10, 8, 8, 10, 10] as const;
export const MODE_BPP = [1, 2, 4, 1, 1, 2, 1, 1] as const;

/** Colour index (r | g<<1 | b<<2) of each palette pen to RGBA. 'pal' is fully
 *  saturated; 'measured' uses the muted levels a real PAL receiver gave. */
const PAL_PALETTE32 = Uint32Array.from([
  0xFF000000, 0xFF0000FF, 0xFF00FF00, 0xFF00FFFF,
  0xFFFF0000, 0xFFFF00FF, 0xFFFFFF00, 0xFFFFFFFF,
]);
const MEASURED_PALETTE32 = Uint32Array.from([
  0xFF000000, 0xFF0000C0, 0xFF00C000, 0xFF00C0C0,
  0xFFC00000, 0xFFC000C0, 0xFFC0C000, 0xFFE0E0E0,
]);

const BLACK = 0xFF000000;

/** Palette pen groups: register pair → pens it colours (each by wiring, below). */
const PEN_BASE = [0, 4, 5, 1] as const;

export class ElectronUla {
  intStatus = INT_POWER_ON_RESET;
  intControl = 0;
  /** Latched screen start (FE02/FE03) and the running display address counters. */
  screenStart = 0x3000;
  screenAddr = 0x3000;
  screenRa = 0;
  dispMode = 0;
  commsMode = COMMS_TAPE_IN;
  cassMotor = false;
  capsLock = false;
  /** Last byte received from / written to the cassette data register. */
  tapeByte = 0;
  /** Counter divider (FE06). */
  divider = 0;
  /** Palette registers as the ULA holds them (the written value inverted). */
  readonly palette = new Uint8Array(8);
  /** Colour index (r | g<<1 | b<<2) of each of the 16 pens. */
  readonly pens = new Uint8Array(16);
  /** Palette family from the display setting. */
  paletteMode: 'pal' | 'measured' = 'pal';

  /** Speaker level while in sound mode. */
  soundLevel = 0;
  private soundCount = 0;

  private now = 0;
  private readonly rx = new AsyncSerialReceiver();
  private highTone = false;
  private txHold = -1;
  private txHoldAt = 0;
  private txEnd = 0;
  private readonly bitCycles = ELECTRON_CPU_CLOCK / ELECTRON_TAPE_BAUD;

  /** Called with the new value when the caps-lock LED bit changes. */
  onCapsLock: (on: boolean) => void = () => {};

  constructor(private readonly drive: CassetteDrive) {
    this.rx.bitCycles = this.bitCycles;
    this.rx.format = FORMAT_8N1;
    this.rx.onFrame = (f) => {
      // A frame with a bad stop bit is line noise, not a byte.
      if (f.framingError) return;
      this.tapeByte = f.value;
      this.intStatus |= INT_RECEIVE_FULL;
      this.updateInterrupts();
    };
  }

  /** Power-on reset. The power-on-reset flag is what lets the OS tell a cold
   *  start from the BREAK key (see `breakReset`). */
  reset(): void {
    this.intStatus = INT_POWER_ON_RESET;
    this.breakReset();
    this.intControl = 0;
    this.screenStart = 0x3000;
    this.palette.fill(0);
    this.pens.fill(0);
  }

  /** BREAK: the ULA keeps its status (and so doesn't flag a cold start) but the
   *  video/cassette/sound modes return to their defaults. */
  breakReset(): void {
    this.screenAddr = this.screenStart;
    this.screenRa = 0;
    this.dispMode = 0;
    this.commsMode = COMMS_TAPE_IN;
    this.cassMotor = false;
    if (this.capsLock) this.onCapsLock(false);
    this.capsLock = false;
    this.tapeByte = 0;
    this.divider = 0;
    this.soundLevel = 0;
    this.soundCount = 0;
    this.highTone = false;
    this.txHold = -1;
    this.txEnd = 0;
    this.rx.reset();
    this.updateInterrupts();
  }

  get irq(): boolean { return (this.intStatus & 1) !== 0; }

  private updateInterrupts(): void {
    if ((this.intStatus & this.intControl & ~0x83) !== 0) this.intStatus |= 1;
    else this.intStatus &= ~1;
  }

  /** Raise an interrupt condition (the machine's line events use this). */
  raise(bits: number): void {
    this.intStatus |= bits;
    this.updateInterrupts();
  }

  // ── Registers ────────────────────────────────────────────────────────────

  read(offset: number): number {
    switch (offset & 0x0F) {
      case 0x00: {
        const v = 0x80 | this.intStatus;
        this.intStatus &= ~INT_POWER_ON_RESET;
        return v;
      }
      case 0x04:
        this.intStatus &= ~INT_RECEIVE_FULL;
        this.updateInterrupts();
        return this.tapeByte;
      default:
        return 0xFF;
    }
  }

  /** Write a register. The ROM page (FE05 low nibble) is the memory's, so the
   *  machine applies that itself; this handles the interrupt clears. */
  write(offset: number, value: number): void {
    switch (offset & 0x0F) {
      case 0x00:
        this.intControl = value;
        this.updateInterrupts();
        break;
      case 0x02:
        this.screenStart = (this.screenStart & 0x7E00) | ((value & 0xE0) << 1);
        break;
      case 0x03:
        this.screenStart = (this.screenStart & 0x01FF) | ((value & 0x3F) << 9);
        break;
      case 0x04:
        this.writeTapeData(value);
        break;
      case 0x05:
        if (value & 0xF0) {
          if (value & 0x10) this.intStatus &= ~INT_DISPLAY_END;
          if (value & 0x20) this.intStatus &= ~INT_RTC;
          if (value & 0x40) this.intStatus &= ~INT_HIGH_TONE;
          this.updateInterrupts();
        }
        break;
      case 0x06:
        this.divider = value;
        break;
      case 0x07:
        this.writeMisc(value);
        break;
      default:
        if ((offset & 0x0F) >= 0x08) this.writePalette(offset & 7, value);
        break;
    }
  }

  private writeTapeData(value: number): void {
    this.intStatus &= ~INT_TRANSMIT_EMPTY;
    this.updateInterrupts();
    this.tapeByte = value;
    if (this.commsMode === COMMS_TAPE_OUT) {
      this.txHold = value;
      this.txHoldAt = this.now;
    }
  }

  private writeMisc(value: number): void {
    const mode = (value >> 1) & 3;
    const motor = (value & 0x40) !== 0;
    const caps = (value & 0x80) !== 0;
    this.dispMode = (value >> 3) & 7;
    if (mode !== this.commsMode) {
      this.commsMode = mode;
      this.rx.reset();
      this.highTone = false;
      this.txHold = -1;
      if (mode === COMMS_SOUND) {
        this.soundLevel = 1;
        this.soundCount = 32 * (this.divider + 1);
      } else {
        this.soundLevel = 0;
      }
      if (mode === COMMS_TAPE_OUT) {
        // Entering cassette output flags the (empty) transmit register, and
        // some titles (Southern Belle) rely on the receive-full flag too.
        this.intStatus |= INT_TRANSMIT_EMPTY | INT_RECEIVE_FULL;
        this.updateInterrupts();
      }
    }
    if (motor !== this.cassMotor) {
      this.cassMotor = motor;
      this.drive.setMotor(motor, this.now);
    }
    if (caps !== this.capsLock) {
      this.capsLock = caps;
      this.onCapsLock(caps);
    }
  }

  /** Palette register write. The six bits of each register pair wire straight
   *  to the R, G and B outputs of four pens (see MAME's electron_ula). */
  private writePalette(index: number, value: number): void {
    this.palette[index] = value ^ 0xFF;
    const even = index & 6;
    const p0 = this.palette[even];
    const p1 = this.palette[even + 1];
    const base = PEN_BASE[even >> 1];
    const bit = (v: number, n: number): number => (v >> n) & 1;
    const col = (r: number, g: number, b: number): number => r | (g << 1) | (b << 2);
    this.pens[base + 0] = col(bit(p1, 0), bit(p1, 4), bit(p0, 4));
    this.pens[base + 2] = col(bit(p1, 1), bit(p1, 5), bit(p0, 5));
    this.pens[base + 8] = col(bit(p1, 2), bit(p0, 2), bit(p0, 6));
    this.pens[base + 10] = col(bit(p1, 3), bit(p0, 3), bit(p0, 7));
  }

  // ── Time ─────────────────────────────────────────────────────────────────

  /** Advance the cassette, sound and serial engines by `elapsed` cycles to `now`. */
  tick(elapsed: number, now: number): void {
    this.now = now;
    if (this.commsMode === COMMS_SOUND) {
      this.soundCount -= elapsed;
      while (this.soundCount <= 0) {
        this.soundLevel ^= 1;
        this.soundCount += 32 * (this.divider + 1);
      }
    } else if (this.cassMotor) {
      if (this.commsMode === COMMS_TAPE_IN) this.tickReceive(now);
      else if (this.commsMode === COMMS_TAPE_OUT && this.txHold >= 0) this.tickTransmit(now);
    }
  }

  private tickReceive(now: number): void {
    const fsk = this.drive.fsk;
    this.rx.step(now, fsk.level, fsk.levelSince, fsk.startLevel);
    // High tone: the carrier has been steady long enough to be the leader.
    if (fsk.carrier) {
      if (!this.highTone) {
        this.highTone = true;
        this.raise(INT_HIGH_TONE);
      }
    } else {
      this.highTone = false;
    }
  }

  private tickTransmit(now: number): void {
    // An idle shifter takes the byte a bit time after the write, a busy one the
    // moment it finishes its frame; the register is free again once it has.
    const start = this.txEnd <= this.txHoldAt ? this.txHoldAt + this.bitCycles : this.txEnd;
    if (now < start) return;
    const value = this.txHold;
    this.txHold = -1;
    this.txEnd = start + 10 * this.bitCycles;
    this.drive.recorder.byte(value, start);
    this.intStatus |= INT_TRANSMIT_EMPTY;
    this.updateInterrupts();
  }

  // ── Display ──────────────────────────────────────────────────────────────

  /** The RGBA palette in use. */
  get colours(): Uint32Array {
    return this.paletteMode === 'measured' ? MEASURED_PALETTE32 : PAL_PALETTE32;
  }

  /** Latch the screen start at the top of the frame. */
  startFrame(): void {
    this.screenAddr = this.screenStart;
    this.screenRa = 0;
  }

  /** Scanline `y` (0 = first line of the 256-line picture) has finished: draw it
   *  into `out` (row `rowOffset`) from `ram`, then advance the address counters. */
  renderLine(y: number, ram: Uint8Array, out: Uint32Array, rowOffset: number): void {
    const mode = this.dispMode;
    const base = rowOffset * ELECTRON_SCREEN_WIDTH + ELECTRON_BORDER_LEFT;
    if (y >= MODE_DISPEND[mode] || this.screenRa >= 8) {
      out.fill(BLACK, base, base + ELECTRON_ACTIVE_WIDTH);
    } else {
      this.drawLine(mode, ram, out, base);
    }
    if (this.screenRa < 8) this.screenAddr++;
    this.screenRa++;
    if (this.screenRa === MODE_MAX_RA[mode]) {
      this.screenRa = 0;
      this.screenAddr += (mode & 4) ? 0x138 : 0x278;
    }
    if (this.screenAddr & 0x8000) this.screenAddr -= MODE_SIZE[mode];
  }

  private drawLine(mode: number, ram: Uint8Array, out: Uint32Array, base: number): void {
    const bpp = MODE_BPP[mode];
    const bytes = (mode & 4) ? 40 : 80;
    const wrap = MODE_SIZE[mode];
    const colours = this.colours;
    const pens = this.pens;
    const addr = this.screenAddr;
    const perByte = 8 / bpp;
    const width = bpp * (80 / bytes);       // screen pixels per ULA pixel
    let x = base;
    for (let hpos = 0; hpos < bytes; hpos++) {
      let a = addr + hpos * 8;
      if (a & 0x8000) a -= wrap;
      let data = ram[a & 0x7FFF];
      for (let p = 0; p < perByte; p++) {
        let pen: number;
        if (bpp === 1) pen = (data >> 4) & 8;
        else if (bpp === 2) pen = ((data >> 4) & 8) | ((data >> 2) & 2);
        else pen = ((data >> 4) & 8) | ((data >> 3) & 4) | ((data >> 2) & 2) | ((data >> 1) & 1);
        const c = colours[pens[pen]];
        for (let i = 0; i < width; i++) out[x++] = c;
        data <<= 1;
      }
    }
  }

  /** Fill the whole frame with black (power-on). */
  clear(out: Uint32Array): void { out.fill(BLACK); }

  // ── Snapshot state ────────────────────────────────────────────────────────

  /** Write the registers, the display address counters, the sound counter
   *  and the cassette shifters (the receiver's frame in progress, the byte
   *  held for transmission). The palette mode is a display setting. */
  saveState(w: StateWriter): void {
    w.u8(this.intStatus); w.u8(this.intControl);
    w.u16(this.screenStart); w.u16(this.screenAddr); w.u8(this.screenRa);
    w.u8(this.dispMode); w.u8(this.commsMode); w.bool(this.cassMotor); w.bool(this.capsLock);
    w.u8(this.tapeByte); w.u8(this.divider);
    w.raw(this.palette); w.raw(this.pens);
    w.u8(this.soundLevel); w.f64(this.soundCount);
    w.f64(this.now); w.bool(this.highTone);
    w.i32(this.txHold); w.f64(this.txHoldAt); w.f64(this.txEnd);
    this.rx.saveState(w);
  }

  /** Restore what `saveState` wrote, without the side effects of the register
   *  writes (the cassette relay and caps-lock LED are restored with their owners). */
  loadState(r: StateReader): void {
    this.intStatus = r.u8(); this.intControl = r.u8();
    this.screenStart = r.u16(); this.screenAddr = r.u16(); this.screenRa = r.u8();
    this.dispMode = r.u8() & 7; this.commsMode = r.u8(); this.cassMotor = r.bool(); this.capsLock = r.bool();
    this.tapeByte = r.u8(); this.divider = r.u8();
    r.rawInto(this.palette); r.rawInto(this.pens);
    this.soundLevel = r.u8(); this.soundCount = r.f64();
    this.now = r.f64(); this.highTone = r.bool();
    this.txHold = r.i32(); this.txHoldAt = r.f64(); this.txEnd = r.f64();
    this.rx.loadState(r);
  }
}
