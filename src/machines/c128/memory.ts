/**
 * Commodore 128 memory: two 64K blocks of RAM, the ROMs, two 1K banks of
 * colour RAM, the 8502's on-chip port, and the MMU (`mmu.ts`) that decides
 * what the CPU sees where. C128 mode is described first; C64 mode (the MMU's
 * mode register bit 6) is at the end of this comment.
 *
 * The 8502's view (C128 Programmer's Reference Guide, the MMU's configuration
 * register):
 *
 *   $0000-$3FFF  RAM
 *   $4000-$7FFF  low BASIC ROM, or RAM when CR bit 1 is set
 *   $8000-$BFFF  high BASIC ROM, an internal or external function ROM, or RAM
 *                (CR bits 3-2)
 *   $C000-$FFFF  the system ROM (screen editor, KERNAL), a function ROM, or
 *                RAM (CR bits 5-4)
 *   $D000-$DFFF  I/O when CR bit 0 is 0; otherwise the same as the rest of
 *                $C000-$FFFF, where the system ROM shows the character ROM
 *   $FF00-$FF04  the MMU's configuration register and the four load-config
 *                addresses, over whatever is at the top of memory
 *
 * Writes always reach RAM (except to I/O and $FF00-$FF04), so ROM can be
 * copied to the RAM under it. Which of the two RAM blocks an access reaches
 * is CR bits 7-6 (RAM block 0 or 1), except in the common RAM (RCR) at the
 * bottom or top of the address space, which is always block 0; pages 0 and 1
 * can be relocated (P0, P1). The 8502's port ($00 data direction, $01 data)
 * drives, in this mode, the colour RAM bank each of the CPU (bit 0) and the
 * VIC-IIe (bit 1) uses (1 = bank 0), whether the VIC-IIe sees the character
 * ROM (bit 2 low) and the Datasette (bits 3-5); bit 6 reads low while CAPS
 * LOCK is down.
 *
 * The Z80 sees the same memory with three differences (it starts the machine
 * and runs the BIOS): while the RAM block is 0, its $0000-$0FFF is the BIOS
 * ROM, which sits under the 8502's I/O page; its $1000-$13FF is the colour RAM
 * while I/O is on; and its $D000-$DFFF is never I/O: it reaches I/O through
 * its IN and OUT instructions, whose 16-bit port address is the $Dxxx address.
 *
 * The VIC-IIe reads its own 16K window of RAM in the block RCR bits 7-6 name,
 * at the bank CIA 2 chooses; with the 8502 port's bit 2 low the character ROM
 * shows at $1000-$1FFF of every bank.
 *
 * C64 mode: the MMU lets the 8502's port steer the map exactly as on a 64.
 * 64K of RAM (the block CR names), the 64's BASIC at $A000 (LORAM and HIRAM
 * high), its KERNAL at $E000 (HIRAM high), and at $D000 the character ROM
 * (the first 4K of the 128's) or I/O (CHAREN high), either of them only while
 * LORAM or HIRAM is high. The port's bits 0-2 are those three lines, not the
 * colour RAM banks (colour RAM is bank 0 for both chips), the VIC-II sees
 * the character ROM only in banks 0 and 2, the MMU's $FF00-$FF04 are plain
 * memory, and page 0 and 1 relocation is off (the C64 mode start-up leaves
 * the pointers at their defaults). The 128's own ROMs are out of the map.
 * No cartridge is modelled yet: /GAME and /EXROM are taken as high.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import type { VicBus } from '@/cores/vic-ii.ts';
import {
  C128_BASIC64_SIZE, C128_BASIC_HI_SIZE, C128_BASIC_LO_SIZE, C128_CHARGEN_128_OFFSET, C128_CHARGEN_SIZE,
  C128_KERNAL64_SIZE, C128_KERNAL_SIZE, C128_Z80_BIOS_OFFSET,
} from './constants.ts';
import { Mmu } from './mmu.ts';

/** I/O handlers the machine installs for $D000-$DFFF. */
export type IoRead = (addr: number) => number;
export type IoWrite = (addr: number, value: number) => void;

/** The 8502 port bits in C128 mode. */
const PORT_COLOUR_CPU = 0x01;
const PORT_COLOUR_VIC = 0x02;
const PORT_VIC_NO_CHARGEN = 0x04;
const PORT_CAS_WRITE = 0x08;
const PORT_CAS_SENSE = 0x10;
const PORT_CAS_MOTOR = 0x20;
const PORT_CAPS = 0x40;
/** The bits that read high with nothing driving them (the others read low). */
const PORT_PULLED_UP = PORT_COLOUR_CPU | PORT_COLOUR_VIC | PORT_VIC_NO_CHARGEN | PORT_CAS_SENSE | PORT_CAPS;

/** How `c64Byte` is asked: a read (I/O side effects), a peek, or with no I/O. */
const C64_READ = 0;
const C64_PEEK = 1;
/** What C64 mode shows at $D000. */
const C64_RAM = 0;
const C64_CHARGEN = 1;
const C64_IO = 2;

export class C128Memory implements IMachineMemory, VicBus {
  /** Both 64K RAM blocks, block 0 first. */
  readonly ram = new Uint8Array(0x20000);
  readonly basicLo = new Uint8Array(C128_BASIC_LO_SIZE);
  readonly basicHi = new Uint8Array(C128_BASIC_HI_SIZE);
  /** The system ROM: $C000-$FFFF as the 8502 sees it, with the Z80 BIOS at $1000. */
  readonly kernal = new Uint8Array(C128_KERNAL_SIZE);
  /** The character ROM: the C64's set, then the 128's. */
  readonly chargen = new Uint8Array(C128_CHARGEN_SIZE);
  /** C64 mode's BASIC and KERNAL. */
  readonly basic64 = new Uint8Array(C128_BASIC64_SIZE);
  readonly kernal64 = new Uint8Array(C128_KERNAL64_SIZE);
  /** Colour RAM: two 1K banks, the low nybble of each byte is the colour. */
  readonly colorBanks: readonly [Uint8Array, Uint8Array] = [new Uint8Array(0x400), new Uint8Array(0x400)];

  readonly mmu = new Mmu();

  /** 8502 port: direction (1 = output) and output latch. */
  portDdr = 0;
  portData = 0;
  /** A Datasette button is down (bit 4 reads low). */
  cassetteSense = false;
  /** CAPS LOCK is down (bit 6 reads low). */
  capsLockDown = false;
  /** Reads of the port (the machine's PLAY detector counts them). */
  portReads = 0;

  /** VIC-IIe bank base (0, $4000, $8000 or $C000): CIA 2's choice. */
  vicBase = 0;
  /** The colour RAM bank each of the CPU and the VIC-IIe uses, from the port. */
  private cpuColor: Uint8Array = this.colorBanks[0];
  private vicColor: Uint8Array = this.colorBanks[0];
  private vicChargen = false;
  /** The mode the port-dependent state was last worked out for. */
  private portForC64 = false;

  ioRead: IoRead = () => 0xFF;
  ioWrite: IoWrite = () => {};
  /** I/O as the debugger sees it: no clear-on-read side effects. */
  ioPeek: IoRead = () => 0xFF;
  /** The port changed the motor or write line (the machine follows them). */
  onPortChange: (() => void) | null = null;

  constructor() {
    // A change of mode changes what the port's bits steer.
    this.mmu.onChange = () => { if (this.mmu.c64Mode !== this.portForC64) this.updatePort(); };
    this.reset();
  }

  /** Power-on: RAM in the pattern the DRAMs settle into (64 bytes of $00,
   *  then 64 of $FF) in both blocks, the port as inputs, the MMU cleared. */
  reset(): void {
    for (let i = 0; i < 0x20000; i++) this.ram[i] = (i & 0x40) === 0 ? 0x00 : 0xFF;
    for (const bank of this.colorBanks) {
      for (let i = 0; i < 0x400; i++) bank[i] = (i * 7 + 3) & 0x0F;
    }
    this.portDdr = 0;
    this.portData = 0;
    this.mmu.reset();
    this.updatePort();
  }

  /** Install the ROM images; one that is null or left out keeps what it has. */
  loadRoms(
    basicLo: Uint8Array | null, basicHi: Uint8Array | null,
    kernal: Uint8Array | null, chargen: Uint8Array | null,
    basic64: Uint8Array | null = null, kernal64: Uint8Array | null = null,
  ): void {
    if (basic64) this.basic64.set(basic64.subarray(0, C128_BASIC64_SIZE));
    if (kernal64) this.kernal64.set(kernal64.subarray(0, C128_KERNAL64_SIZE));
    if (basicLo) this.basicLo.set(basicLo.subarray(0, C128_BASIC_LO_SIZE));
    if (basicHi) this.basicHi.set(basicHi.subarray(0, C128_BASIC_HI_SIZE));
    if (kernal) this.kernal.set(kernal.subarray(0, C128_KERNAL_SIZE));
    if (chargen) this.chargen.set(chargen.subarray(0, C128_CHARGEN_SIZE));
  }

  // ── The 8502 port ────────────────────────────────────────────────────────

  /** The port pins: outputs as latched; inputs pulled up where the board
   *  does, except the Datasette's sense and CAPS LOCK (low while down). */
  get portPins(): number {
    let inputs = PORT_PULLED_UP;
    if (this.cassetteSense) inputs &= ~PORT_CAS_SENSE;
    if (this.capsLockDown) inputs &= ~PORT_CAPS;
    return ((this.portData & this.portDdr) | (inputs & ~this.portDdr)) & 0xFF;
  }

  /** The Datasette motor runs while the port drives bit 5 low. */
  get motorOn(): boolean { return (this.portPins & PORT_CAS_MOTOR) === 0; }
  /** The cassette write line. */
  get cassetteWrite(): boolean { return (this.portPins & PORT_CAS_WRITE) !== 0; }

  /** Follow the port's bits that steer the colour RAM and the VIC-IIe. */
  private updatePort(): void {
    const pins = this.portPins;
    this.portForC64 = this.mmu.c64Mode;
    if (this.portForC64) {
      // The port's low bits are the PLA lines, not colour bank selects.
      this.cpuColor = this.colorBanks[0];
      this.vicColor = this.colorBanks[0];
      this.vicChargen = false;
      return;
    }
    this.cpuColor = this.colorBanks[(pins & PORT_COLOUR_CPU) !== 0 ? 0 : 1];
    this.vicColor = this.colorBanks[(pins & PORT_COLOUR_VIC) !== 0 ? 0 : 1];
    this.vicChargen = (pins & PORT_VIC_NO_CHARGEN) === 0;
  }

  /** The machine says a pin the port reads changed (CAPS LOCK, a Datasette button). */
  pinsChanged(): void { this.updatePort(); }

  private writePort(addr: number, value: number): void {
    if (addr === 0) this.portDdr = value; else this.portData = value;
    this.updatePort();
    this.onPortChange?.();
  }

  /** Point the VIC-IIe at bank 0-3 (CIA 2 port A bits 0-1, inverted). */
  setVicBank(bank: number): void { this.vicBase = (bank & 3) << 14; }

  // ── The 8502's bus ───────────────────────────────────────────────────────

  /** The colour RAM byte at $D800 + `offset` as the CPU sees it. */
  colorRead(offset: number): number { return this.cpuColor[offset & 0x3FF]; }
  colorWrite(offset: number, value: number): void { this.cpuColor[offset & 0x3FF] = value & 0x0F; }

  /** RAM at a CPU address: the block CR names, or block 0 in the common RAM. */
  private ramRead(addr: number): number {
    const mmu = this.mmu;
    return this.ram[mmu.ramAddress(addr, mmu.ramBlock)];
  }

  /** The byte the map puts at `addr` (not page 0 or 1, which relocation may
   *  move, nor the CPU port). With `io` false $D000-$DFFF is never I/O. */
  private mapped(addr: number, io: boolean): number {
    const mmu = this.mmu;
    const cr = mmu.cr;
    switch (addr >> 14) {
      case 0:
        return this.ramRead(addr);
      case 1:
        return (cr & 0x02) !== 0 ? this.ramRead(addr) : this.basicLo[addr - 0x4000];
      case 2:
        switch ((cr >> 2) & 3) {
          case 0: return this.basicHi[addr - 0x8000];
          case 3: return this.ramRead(addr);
          default: return 0xFF;               // a function ROM socket with nothing in it
        }
      default: {
        if (addr >= 0xFF00 && addr <= 0xFF04) return mmu.readFF(addr);
        const hi = (cr >> 4) & 3;
        if (addr >= 0xD000 && addr < 0xE000) {
          if ((cr & 0x01) === 0 && io) return this.ioRead(addr);
          if (hi === 0) return this.chargen[C128_CHARGEN_128_OFFSET + (addr - 0xD000)];
        } else if (hi === 0) {
          return this.kernal[addr - 0xC000];
        }
        return hi === 3 ? this.ramRead(addr) : 0xFF;
      }
    }
  }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr < 2) {
      if (addr === 0) return this.portDdr;
      this.portReads++;
      return this.portPins;
    }
    const mmu = this.mmu;
    if (mmu.c64Mode) return this.c64Byte(addr, C64_READ);
    if (mmu.relocated) {
      const page = addr >> 8;
      if (page <= 1 || page === mmu.p0l || page === mmu.p1l) {
        const phys = mmu.relocate(addr);
        if (phys >= 0) return this.ram[phys];
      }
    }
    return this.mapped(addr, true);
  }

  writeByte(addr: number, value: number): void {
    addr &= 0xFFFF;
    const v = value & 0xFF;
    const mmu = this.mmu;
    if (addr < 2) {
      // The port is written, and so is the RAM underneath it.
      this.ram[mmu.ramAddress(addr, mmu.ramBlock)] = v;
      this.writePort(addr, v);
      return;
    }
    if (mmu.c64Mode) { this.c64Store(addr, v); return; }
    if (mmu.relocated) {
      const page = addr >> 8;
      if (page <= 1 || page === mmu.p0l || page === mmu.p1l) {
        const phys = mmu.relocate(addr);
        if (phys >= 0) { this.ram[phys] = v; return; }
      }
    }
    this.store(addr, v, true);
  }

  /** A write that is not to the port or a relocated page. */
  private store(addr: number, v: number, io: boolean): void {
    const mmu = this.mmu;
    if (addr >= 0xFF00 && addr <= 0xFF04) { mmu.writeFF(addr, v); return; }
    if (io && addr >= 0xD000 && addr < 0xE000 && (mmu.cr & 0x01) === 0) { this.ioWrite(addr, v); return; }
    this.ram[mmu.ramAddress(addr, mmu.ramBlock)] = v;
  }

  /** What the CPU would read, without I/O side effects (for the debugger). */
  peekByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr < 2) return addr === 0 ? this.portDdr : this.portPins;
    const mmu = this.mmu;
    if (mmu.c64Mode) return this.c64Byte(addr, C64_PEEK);
    if (mmu.relocated) {
      const page = addr >> 8;
      if (page <= 1 || page === mmu.p0l || page === mmu.p1l) {
        const phys = mmu.relocate(addr);
        if (phys >= 0) return this.ram[phys];
      }
    }
    if (addr >= 0xD000 && addr < 0xE000 && (mmu.cr & 0x01) === 0) return this.ioPeek(addr) & 0xFF;
    return this.mapped(addr, false);
  }

  /** Whether $D000-$DFFF is I/O to the 8502 now. */
  get ioIn(): boolean { return this.mmu.c64Mode ? this.c64Plane === C64_IO : (this.mmu.cr & 0x01) === 0; }

  // ── C64 mode ─────────────────────────────────────────────────────────────

  /** What $D000-$DFFF is in C64 mode: RAM, the character ROM or I/O. */
  private get c64Plane(): number {
    const p = this.portPins;
    if ((p & 3) === 0) return C64_RAM;
    return (p & 4) !== 0 ? C64_IO : C64_CHARGEN;
  }

  /** The byte the 64's PLA puts at `addr` for the CPU (`how` is a read, a peek
   *  or a read with no I/O). */
  private c64Byte(addr: number, how: number): number {
    const p = this.portPins;
    switch (addr >> 12) {
      case 0xA: case 0xB:
        if ((p & 3) === 3) return this.basic64[addr - 0xA000];
        break;
      case 0xD:
        if ((p & 3) !== 0) {
          if ((p & 4) === 0) return this.chargen[addr - 0xD000];
          if (how === C64_READ) return this.ioRead(addr);
          if (how === C64_PEEK) return this.ioPeek(addr) & 0xFF;
          return 0xFF;
        }
        break;
      case 0xE: case 0xF:
        if ((p & 2) !== 0) return this.kernal64[addr - 0xE000];
        break;
      default: break;
    }
    return this.ram[this.mmu.ramAddress(addr, this.mmu.ramBlock)];
  }

  /** A write in C64 mode: to I/O when it is in view, otherwise to the RAM under whatever is. */
  private c64Store(addr: number, v: number): void {
    if ((addr >> 12) === 0xD && this.c64Plane === C64_IO) { this.ioWrite(addr, v); return; }
    this.ram[this.mmu.ramAddress(addr, this.mmu.ramBlock)] = v;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.peekByte((addr + i) & 0xFFFF);
    return out;
  }

  /** A whole 64K view as the CPU sees it (I/O registers peeked). */
  snapshot(): Uint8Array { return this.readBlock(0, 0x10000); }

  get ramBankCount(): number { return 8; }

  /** One 16K quarter of the RAM, live: banks 0-3 are block 0, 4-7 block 1. */
  getRamBank(n: number): Uint8Array {
    const bank = ((n % 8) + 8) % 8;
    return this.ram.subarray(bank << 14, (bank + 1) << 14);
  }

  // ── The Z80's bus ────────────────────────────────────────────────────────

  /** The Z80's memory read. */
  z80Read(addr: number): number {
    addr &= 0xFFFF;
    const mmu = this.mmu;
    const cr = mmu.cr;
    if (addr < 0x1000 && (cr & 0xC0) === 0) return this.kernal[C128_Z80_BIOS_OFFSET + addr];
    if (addr < 0x1400 && addr >= 0x1000 && (cr & 0x01) === 0) return this.cpuColor[addr & 0x3FF];
    if (mmu.relocated) {
      const page = addr >> 8;
      if (page <= 1 || page === mmu.p0l || page === mmu.p1l) {
        const phys = mmu.relocate(addr);
        if (phys >= 0) return this.ram[phys];
      }
    }
    return this.mapped(addr, false);
  }

  /** The Z80's memory write. */
  z80Write(addr: number, value: number): void {
    addr &= 0xFFFF;
    const v = value & 0xFF;
    const mmu = this.mmu;
    const cr = mmu.cr;
    if (addr < 0x1000 && (cr & 0xC0) === 0) {
      // Under the BIOS the writes land in the RAM at $D000-$DFFF.
      this.ram[0xD000 | addr] = v;
      return;
    }
    if (addr >= 0x1000 && addr < 0x1400 && (cr & 0x01) === 0) { this.cpuColor[addr & 0x3FF] = v & 0x0F; return; }
    if (mmu.relocated) {
      const page = addr >> 8;
      if (page <= 1 || page === mmu.p0l || page === mmu.p1l) {
        const phys = mmu.relocate(addr);
        if (phys >= 0) { this.ram[phys] = v; return; }
      }
    }
    this.store(addr, v, false);
  }

  /** The Z80's IN: the high byte of the port address picks the I/O page. */
  z80In(port: number): number {
    const hi = (port >> 8) & 0xFF;
    if (hi < 0x10) return this.ram[0xD000 | (port & 0x0FFF)];
    if (hi >= 0xD0 && hi <= 0xDF && (this.mmu.cr & 0x01) === 0) return this.ioRead(port & 0xFFFF);
    return 0xFF;
  }

  /** The Z80's OUT. */
  z80Out(port: number, value: number): void {
    const hi = (port >> 8) & 0xFF;
    if (hi < 0x10) this.ram[0xD000 | (port & 0x0FFF)] = value & 0xFF;
    else if (hi >= 0xD0 && hi <= 0xDF && (this.mmu.cr & 0x01) === 0) this.ioWrite(port & 0xFFFF, value & 0xFF);
  }

  // ── The VIC-IIe's bus ────────────────────────────────────────────────────

  /** The colour RAM the VIC-IIe reads. */
  get colorRam(): Uint8Array { return this.vicColor; }

  /** A byte of the VIC-IIe's 16K view. */
  vicRead(addr14: number): number {
    const a = addr14 & 0x3FFF;
    if (this.mmu.c64Mode) {
      // The 64's rule: the character ROM (its 4K set) in banks 0 and 2.
      if ((a & 0x3000) === 0x1000 && (this.vicBase & 0x4000) === 0) return this.chargen[a & 0x0FFF];
    } else if (this.vicChargen && (a & 0x3000) === 0x1000) {
      return this.chargen[C128_CHARGEN_128_OFFSET + (a & 0x0FFF)];
    }
    return this.ram[(this.mmu.vicBlock << 16) | this.vicBase | a];
  }
}
