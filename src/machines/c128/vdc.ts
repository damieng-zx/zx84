/**
 * The 8563 VDC's register file, RAM and block copy/fill. (`vdc-display.ts`
 * draws what the registers describe.) A block operation finishes at once. The
 * chip has two ports: $D600
 * selects a register (a read gives the status: bit 7 is set when the chip is
 * ready, bit 5 while the beam is in the vertical blanking, and the low bits are
 * its version), $D601 reads or writes the selected register. Registers 18 and
 * 19 are the update address and register 31 the data port: a read or write
 * there goes to the VDC's RAM at that address, which then moves on by one. The
 * RAM is 16K as fitted to the 128 and wraps at its size; the 128D and later
 * boards carry 64K (R28 bit 4 says so, and the machine is built with it).
 *
 * Block operations: writing the word-count register (30) copies or fills that
 * many bytes (0 is 256) from the update address on. With bit 7 of register 24
 * set it copies, from the block start address (registers 32 and 33); otherwise
 * it fills with the byte last written to the data port, so a fill is "write
 * the first byte through register 31, then the count less one to register 30".
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

const VDC_REGISTERS = 38;
export const VDC_RAM_16K = 0x4000;
export const VDC_RAM_64K = 0x10000;

/** Register numbers the display and the block operations use. */
export const VDC_R = {
  HTOTAL: 0, HDISP: 1, HSYNC: 2, SYNCW: 3, VTOTAL: 4, VADJ: 5, VDISP: 6, VSYNC: 7, INTERLACE: 8,
  CHARV: 9, CURSOR_MODE: 10, CURSOR_END: 11,
  SCREEN_HI: 12, SCREEN_LO: 13, CURSOR_HI: 14, CURSOR_LO: 15,
  UPDATE_HI: 18, UPDATE_LO: 19, ATTR_HI: 20, ATTR_LO: 21,
  CHARH: 22, CHAR_DISP_V: 23, SCROLL_V: 24, MODE: 25, COLOUR: 26, ROW_ADD: 27,
  CHARSET: 28, UNDERLINE: 29, COUNT: 30, DATA: 31, SOURCE_HI: 32, SOURCE_LO: 33,
} as const;

/** The version in the status register's low bits: 0 for the 8563. */
const VDC_VERSION = 0;

export class Vdc {
  readonly regs = new Uint8Array(VDC_REGISTERS);
  /** The chip's RAM: 16K, or 64K on the boards that have it (`setRamBytes`). */
  ram: Uint8Array;
  /** The beam is in the vertical blanking (status bit 5); the machine sets it. */
  vblank = false;
  /** Frames drawn so far: the flash and cursor blink counters run on it. */
  frame = 0;
  private selected = 0;
  /** The byte last passed through the data port (what a fill writes). */
  private dataByte = 0;
  private mask: number;

  constructor(ramBytes: number = VDC_RAM_16K) {
    this.ram = new Uint8Array(ramBytes);
    this.mask = ramBytes - 1;
  }

  /** Fit 16K or 64K of RAM (the board's choice, made before power-on). */
  setRamBytes(ramBytes: number): void {
    if (ramBytes === this.ram.length) return;
    this.ram = new Uint8Array(ramBytes);
    this.mask = ramBytes - 1;
  }

  saveState(w: StateWriter): void {
    w.u32(this.ram.length);
    w.raw(this.regs); w.raw(this.ram);
    w.u8(this.selected); w.u8(this.dataByte);
    w.bool(this.vblank); w.u32(this.frame >>> 0);
  }

  /** Read it back; throws for a state saved with the other amount of VDC RAM. */
  loadState(r: StateReader): void {
    const size = r.u32();
    if (size !== this.ram.length) {
      throw new Error(`The snapshot was saved with ${size >> 10}K of VDC RAM: choose that in Hardware first`);
    }
    r.rawInto(this.regs); r.rawInto(this.ram);
    this.selected = r.u8(); this.dataByte = r.u8();
    this.vblank = r.bool(); this.frame = r.u32() | 0;
  }

  reset(): void {
    this.regs.fill(0);
    this.ram.fill(0);
    this.selected = 0;
    this.dataByte = 0;
    this.vblank = false;
    this.frame = 0;
  }

  /** One displayed frame has gone by (the flash and blink phases move on). */
  tickFrame(): void { this.frame = (this.frame + 1) | 0; }

  /**
   * Where the beam is in the frame, from 0 (top) to 1 (bottom): it is in the
   * vertical blanking once it is past the displayed rows, out of the frame's
   * `(R4 + 1)` rows and `R5` adjust lines.
   */
  setBeam(fraction: number): void {
    const rowTotal = (this.regs[VDC_R.CHARV] & 0x1F) + 1;
    const total = (this.regs[VDC_R.VTOTAL] + 1) * rowTotal + (this.regs[VDC_R.VADJ] & 0x1F);
    const shown = this.regs[VDC_R.VDISP] * rowTotal;
    this.vblank = fraction * total >= shown;
  }

  private get updateAddress(): number { return (this.regs[VDC_R.UPDATE_HI] << 8) | this.regs[VDC_R.UPDATE_LO]; }
  private set updateAddress(a: number) {
    this.regs[VDC_R.UPDATE_HI] = (a >> 8) & 0xFF;
    this.regs[VDC_R.UPDATE_LO] = a & 0xFF;
  }

  private get status(): number { return 0x80 | (this.vblank ? 0x20 : 0) | VDC_VERSION; }

  /** A read of $D600 (port 0, the status) or $D601 (port 1, the register). */
  read(port: number): number {
    if ((port & 1) === 0) return this.status;
    if (this.selected === VDC_R.DATA) {
      const a = this.updateAddress;
      this.updateAddress = (a + 1) & 0xFFFF;
      this.dataByte = this.ram[a & this.mask];
      return this.dataByte;
    }
    return this.selected < VDC_REGISTERS ? this.regs[this.selected] : 0xFF;
  }

  /** What a read would give, without moving the update address. */
  peek(port: number): number {
    if ((port & 1) === 0) return this.status;
    if (this.selected === VDC_R.DATA) return this.ram[this.updateAddress & this.mask];
    return this.selected < VDC_REGISTERS ? this.regs[this.selected] : 0xFF;
  }

  write(port: number, value: number): void {
    const v = value & 0xFF;
    if ((port & 1) === 0) { this.selected = v & 0x3F; return; }
    if (this.selected === VDC_R.DATA) {
      const a = this.updateAddress;
      this.ram[a & this.mask] = v;
      this.dataByte = v;
      this.updateAddress = (a + 1) & 0xFFFF;
    } else if (this.selected < VDC_REGISTERS) {
      this.regs[this.selected] = v;
      if (this.selected === VDC_R.COUNT) this.blockOperation(v === 0 ? 256 : v);
    }
  }

  /** Copy or fill `count` bytes from the update address on. */
  private blockOperation(count: number): void {
    const mask = this.mask;
    let dst = this.updateAddress;
    if ((this.regs[VDC_R.SCROLL_V] & 0x80) !== 0) {
      let src = (this.regs[VDC_R.SOURCE_HI] << 8) | this.regs[VDC_R.SOURCE_LO];
      for (let i = 0; i < count; i++) {
        this.ram[dst & mask] = this.ram[src & mask];
        dst = (dst + 1) & 0xFFFF;
        src = (src + 1) & 0xFFFF;
      }
      this.regs[VDC_R.SOURCE_HI] = src >> 8;
      this.regs[VDC_R.SOURCE_LO] = src & 0xFF;
    } else {
      for (let i = 0; i < count; i++) {
        this.ram[dst & mask] = this.dataByte;
        dst = (dst + 1) & 0xFFFF;
      }
    }
    this.updateAddress = dst;
  }
}
