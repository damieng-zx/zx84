/**
 * Commodore 64 memory: 64K of RAM, the BASIC, KERNAL and character ROMs, the
 * 1K × 4-bit colour RAM, the 6510's on-chip I/O port and the PLA that decides
 * what the CPU sees where.
 *
 * The 6510's port (data direction at $00, data at $01) drives the PLA's
 * LORAM, HIRAM and CHAREN lines from bits 0-2 and the Datasette from bits 3-5
 * (write, play-button sense, motor). With no cartridge (EXROM and GAME high)
 * the PLA maps:
 *
 *   $A000-$BFFF  BASIC when LORAM and HIRAM are both high, else RAM
 *   $D000-$DFFF  I/O when CHAREN is high, the character ROM when it is low,
 *                and RAM when LORAM and HIRAM are both low
 *   $E000-$FFFF  KERNAL when HIRAM is high, else RAM
 *
 * A cartridge pulls EXROM and/or GAME low and the PLA then maps its ROML at
 * $8000 (when LORAM and HIRAM are high), its ROMH over BASIC at $A000 (16K
 * cartridges, when HIRAM is high), or in Ultimax mode (GAME low, EXROM high)
 * ROML at $8000 and ROMH at $E000 with the RAM above $1000 gone, whatever the
 * port says. Writes under a ROM window reach the RAM below it.
 *
 * Writes always reach RAM, except to I/O when it is mapped in. The VIC-II has
 * its own 16K view, chosen by CIA 2's port A; in its banks 0 and 2 the
 * character ROM appears at $1000-$1FFF.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { C64_BASIC_SIZE, C64_CHARGEN_SIZE, C64_KERNAL_SIZE } from './constants.ts';
import type { C64Cartridge } from './cartridge.ts';

/** I/O handlers the machine installs for $D000-$DFFF. */
export type IoRead = (addr: number) => number;
export type IoWrite = (addr: number, value: number) => void;

export class C64Memory implements IMachineMemory {
  readonly ram = new Uint8Array(0x10000);
  readonly basic = new Uint8Array(C64_BASIC_SIZE);
  readonly kernal = new Uint8Array(C64_KERNAL_SIZE);
  readonly chargen = new Uint8Array(C64_CHARGEN_SIZE);
  /** Colour RAM: the low nybble of each byte is the stored colour. */
  readonly colorRam = new Uint8Array(0x400);

  /** 6510 port: direction (1 = output) and output latch. */
  portDdr = 0;
  portData = 0;
  /** What the floating bits 6-7 last held: they keep a written value a while. */
  private portFloat = 0;
  /** The Datasette's PLAY (or another) button is down: bit 4 reads low. */
  cassetteSense = false;
  /** Reads of the port (the machine's PLAY detector counts them). */
  portReads = 0;

  // PLA decode, recomputed whenever the port changes.
  basicIn = true;
  kernalIn = true;
  ioIn = true;
  charIn = false;
  /** The cartridge on the expansion port, and what its lines make of the map. */
  cart: C64Cartridge | null = null;
  romlIn = false;
  romhA = false;
  romhE = false;
  ultimax = false;

  /** VIC-II bank base (0, $4000, $8000 or $C000) and whether its character
   *  ROM window is in view (banks 0 and 2). */
  vicBase = 0;
  private vicCharRom = true;

  ioRead: IoRead = () => 0xFF;
  ioWrite: IoWrite = () => {};
  /** I/O as the debugger sees it: no clear-on-read side effects. */
  ioPeek: IoRead = () => 0xFF;
  /** The port changed the motor or write line (the machine follows them). */
  onPortChange: (() => void) | null = null;

  constructor() {
    this.reset();
  }

  /** Power-on: RAM in the pattern the 64's DRAMs settle into (64 bytes of
   *  $00, then 64 of $FF), the port as inputs. */
  reset(): void {
    for (let i = 0; i < 0x10000; i++) this.ram[i] = (i & 0x40) === 0 ? 0x00 : 0xFF;
    for (let i = 0; i < 0x400; i++) this.colorRam[i] = (i * 7 + 3) & 0x0F;
    this.portDdr = 0;
    this.portData = 0;
    this.portFloat = 0;
    this.cart?.reset();
    this.updatePla();
  }

  /** Power-up of the cartridge, after the CPU's clock has restarted. */
  resetCartridge(): void {
    if (!this.cart) return;
    this.cart.reset();
    this.updatePla();
  }

  /** Put a cartridge on the port (null takes it off). */
  setCartridge(cart: C64Cartridge | null, clock: () => number): void {
    if (this.cart) this.cart.onLines = null;
    this.cart = cart;
    if (cart) {
      cart.clock = clock;
      cart.onLines = () => this.updatePla();
    }
    this.updatePla();
  }

  loadRoms(basic: Uint8Array | null, kernal: Uint8Array | null, chargen: Uint8Array | null): void {
    if (basic) this.basic.set(basic.subarray(0, C64_BASIC_SIZE));
    if (kernal) this.kernal.set(kernal.subarray(0, C64_KERNAL_SIZE));
    if (chargen) this.chargen.set(chargen.subarray(0, C64_CHARGEN_SIZE));
  }

  /** The port pins: outputs as latched; inputs pulled high, except the
   *  cassette sense (low while a button is down) and the floating bits 6-7. */
  get portPins(): number {
    const inputs = (0x2F | (this.cassetteSense ? 0 : 0x10) | (this.portFloat & 0xC0)) & 0xFF;
    return ((this.portData & this.portDdr) | (inputs & ~this.portDdr)) & 0xFF;
  }

  /** The Datasette motor runs while the port drives bit 5 low. */
  get motorOn(): boolean { return (this.portPins & 0x20) === 0; }
  /** The cassette write line (bit 3). */
  get cassetteWrite(): boolean { return (this.portPins & 0x08) !== 0; }

  private updatePla(): void {
    const pins = this.portPins;
    const loram = (pins & 1) !== 0;
    const hiram = (pins & 2) !== 0;
    const charen = (pins & 4) !== 0;
    const cart = this.cart;
    const exrom = cart ? cart.lines.exrom : 1;
    const game = cart ? cart.lines.game : 1;
    this.ultimax = exrom === 1 && game === 0;
    if (this.ultimax) {
      this.romlIn = true; this.romhE = true; this.romhA = false;
      this.basicIn = false; this.kernalIn = false;
      this.ioIn = true; this.charIn = false;
      return;
    }
    this.romhE = false;
    this.romlIn = exrom === 0 && loram && hiram;
    this.romhA = exrom === 0 && game === 0 && hiram;
    this.basicIn = loram && hiram && game === 1;
    this.kernalIn = hiram;
    const anyRom = loram || hiram;
    this.ioIn = anyRom && charen;
    this.charIn = anyRom && !charen;
  }

  private writePort(addr: number, value: number): void {
    if (addr === 0) this.portDdr = value; else this.portData = value;
    // A bit switched to output, or written while one, charges the floating line.
    this.portFloat = (this.portFloat & ~this.portDdr) | (this.portData & this.portDdr);
    this.updatePla();
    this.onPortChange?.();
  }

  /** Point the VIC-II at bank 0-3 (CIA 2 port A bits 0-1, inverted). */
  setVicBank(bank: number): void {
    this.vicBase = (bank & 3) << 14;
    this.vicCharRom = (bank & 1) === 0;
  }

  // ── CPU bus ──────────────────────────────────────────────────────────────

  readByte(addr: number): number {
    switch (addr >> 12) {
      case 0x0:
        if (addr === 0) return this.portDdr;
        if (addr === 1) { this.portReads++; return this.portPins; }
        return this.ram[addr];
      case 0x8: case 0x9:
        if (this.cart !== null) {
          // The Epyx FastLoad's capacitor decides this by the clock.
          if (this.cart.dynamicLines) this.updatePla();
          if (this.romlIn) return this.cart.readRoml(addr & 0x1FFF);
        }
        return this.ram[addr];
      case 0xA: case 0xB:
        if (this.romhA) return this.cart!.readRomh(addr & 0x1FFF);
        if (this.ultimax) return 0xFF;
        return this.basicIn ? this.basic[addr - 0xA000] : this.ram[addr];
      case 0xD:
        if (this.ioIn) return this.ioRead(addr);
        return this.charIn ? this.chargen[addr - 0xD000] : this.ram[addr];
      case 0xE: case 0xF:
        if (this.romhE) return this.cart!.readRomh(addr & 0x1FFF);
        return this.kernalIn ? this.kernal[addr - 0xE000] : this.ram[addr];
      case 0x1: case 0x2: case 0x3: case 0x4: case 0x5: case 0x6: case 0x7: case 0xC:
        return this.ultimax ? 0xFF : this.ram[addr];
      default:
        return this.ram[addr];
    }
  }

  writeByte(addr: number, value: number): void {
    const v = value & 0xFF;
    if (addr < 2) {
      // The port is written, and so is the RAM underneath it (the VIC sees that).
      this.ram[addr] = v;
      this.writePort(addr, v);
      return;
    }
    if ((addr >> 12) === 0xD && this.ioIn) { this.ioWrite(addr, v); return; }
    // Ultimax has no RAM above $1000 and ROM where the KERNAL goes.
    if (this.ultimax && addr >= 0x1000) return;
    this.ram[addr] = v;
  }

  /** What the CPU would read, without I/O side effects (for the debugger). */
  peekByte(addr: number): number {
    addr &= 0xFFFF;
    if ((addr >> 12) === 0xD && this.ioIn) return this.ioPeek(addr) & 0xFF;
    if (this.cart?.dynamicLines && ((addr >> 12) === 0x8 || (addr >> 12) === 0x9)) {
      // A look must not discharge the FastLoad's capacitor.
      this.updatePla();
      return this.romlIn ? this.cart.peekRoml(addr & 0x1FFF) : this.ram[addr];
    }
    return this.readByte(addr);
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.peekByte((addr + i) & 0xFFFF);
    return out;
  }

  /** A whole 64K view as the CPU sees it (I/O registers peeked). */
  snapshot(): Uint8Array { return this.readBlock(0, 0x10000); }

  get ramBankCount(): number { return 4; }

  /** One 16K quarter of the RAM, live. */
  getRamBank(n: number): Uint8Array {
    const bank = ((n % 4) + 4) % 4;
    return this.ram.subarray(bank << 14, (bank + 1) << 14);
  }

  // ── VIC-II bus ───────────────────────────────────────────────────────────

  /** A byte of the VIC-II's 16K view. */
  vicRead(addr14: number): number {
    const a = addr14 & 0x3FFF;
    // In Ultimax mode the VIC-II sees the ROMH at $3000-$3FFF of every bank.
    if (this.ultimax && (a & 0x3000) === 0x3000) return this.cart!.readRomh(0x1000 | (a & 0x0FFF));
    if (this.vicCharRom && (a & 0x3000) === 0x1000) return this.chargen[a & 0x0FFF];
    return this.ram[this.vicBase | a];
  }

  saveState(w: StateWriter): void {
    w.raw(this.ram);
    w.raw(this.colorRam);
    w.u8(this.portDdr); w.u8(this.portData); w.u8(this.portFloat);
    w.u8(this.vicBase >> 14);
  }

  loadState(r: StateReader): void {
    r.rawInto(this.ram);
    r.rawInto(this.colorRam);
    this.portDdr = r.u8(); this.portData = r.u8(); this.portFloat = r.u8();
    this.setVicBank(r.u8());
    this.updatePla();
  }
}
