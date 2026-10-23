/**
 * Atari 8-bit memory map: the 400/800 and the XL line.
 *
 * 400/800:
 *
 *   0000-9FFF  RAM (40K on the 800; the 400 has 16K and reads $FF above it)
 *   A000-BFFF  RAM on a 48K machine, overlaid by an 8K cartridge at $A000
 *              or by a 16K cartridge starting at $8000 (cartridge.ts; the
 *              bank-switched OSS boards switch on reads/writes of $D5xx)
 *   C000-CFFF  unmapped
 *   D000-D7FF  hardware: GTIA, (unmapped), POKEY, PIA, ANTIC, (unmapped)
 *   D800-DFFF  floating-point ROM (2K)
 *   E000-FFFF  operating system ROM (8K)
 *
 * XL (600XL/800XL/1200XL): the same hardware window, but a 16K OS ROM and
 * up to 64K of RAM, with PIA port B (PORTB, $D301) as the memory control:
 *
 *   bit 0  1 = OS ROM at $C000-$CFFF and $D800-$FFFF, 0 = RAM there
 *   bit 1  0 = internal BASIC at $A000-$BFFF, 1 = RAM (600XL/800XL)
 *   bit 7  0 = self-test ROM at $5000-$57FF (only while the OS is enabled)
 *
 * Port B lines that the OS has left as inputs float high, so after reset the
 * OS is in, BASIC is out and self-test is out. A cartridge always wins over
 * internal BASIC. While a ROM covers RAM, writes to that range are lost.
 *
 * The 130XE adds four 16K banks of extended RAM that replace $4000-$7FFF:
 *
 *   bits 2-3  which of the four banks
 *   bit 4     0 = the CPU sees the bank
 *   bit 5     0 = ANTIC sees the bank
 *
 * The two enables are independent, so the CPU can build a screen in a bank
 * ANTIC displays while the main RAM at $4000 stays under the program, or the
 * reverse. The self-test ROM, when mapped, still covers its 2K of the window.
 *
 * Reads outside fitted RAM and ROM return $FF (open bus). The hardware window
 * is delegated to the machine through `ioRead`/`ioWrite`, which return -1 for
 * an address they do not claim.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import { ATARI_BASIC_ROM_SIZE, ATARI_OS_SIZE, ATARI_XL_OS_SIZE } from './models.ts';
import { AtariCartridge, parseCartridge } from './cartridge.ts';

const IO_BASE = 0xD000;
const IO_END = 0xD800;
/** The cartridge control area, CCTL: $D500-$D5FF. */
const CCTL_BASE = 0xD500;
const CCTL_END = 0xD600;
const CART_8K_BASE = 0xA000;
const CART_16K_BASE = 0x8000;
/** The 130XE's banked window and the size of one bank. */
const EXT_WINDOW_BASE = 0x4000;
const EXT_WINDOW_END = 0x8000;
const EXT_BANK_SIZE = 0x4000;
const SELF_TEST_BASE = 0x5000;
const SELF_TEST_END = 0x5800;
/** Offset of the self-test block inside the 16K XL OS image. */
const SELF_TEST_ROM_OFFSET = 0x1000;

export interface AtariMemoryConfig {
  /** Fitted RAM in bytes. */
  readonly ramSize: number;
  /** XL memory architecture. */
  readonly xl: boolean;
  /** 600XL/800XL/XE: BASIC ROM inside the machine. */
  readonly builtinBasic: boolean;
  /** 130XE: banked 16K extended RAM blocks (0 or 4). */
  readonly extBanks?: number;
}

export class AtariMemory implements IMachineMemory {
  /** Full 64K RAM array; only `ramSize` bytes are fitted. */
  readonly ram = new Uint8Array(0x10000);
  /** 130XE extended RAM: `extBanks` blocks of 16K, mapped at $4000-$7FFF. */
  readonly extRam: Uint8Array;
  readonly extBanks: number;
  /** OS image: 10K from $D800 (400/800) or 16K from $C000 (XL). */
  readonly osRom: Uint8Array;
  /** Internal BASIC ROM (600XL/800XL), else null. */
  readonly basicRom: Uint8Array | null;
  readonly xl: boolean;

  /** Fitted RAM size in bytes. */
  ramSize: number;
  /** The inserted cartridge, or null. */
  cart: AtariCartridge | null = null;
  /** Why the last insertCart() failed. */
  cartError = '';

  /** Hardware-window read hook; returns -1 for an address it does not claim. */
  ioRead: (addr: number) => number = () => -1;
  /** Hardware-window write hook. */
  ioWrite: (addr: number, val: number) => void = () => {};

  /** PORTB as the pins see it (XL memory control). */
  private portb = 0xFF;
  private osEnabled: boolean;
  private basicEnabled = false;
  private selfTestEnabled = false;
  /** Byte offset into `extRam` of the selected bank, less the window base. */
  private extOffset = -0x4000;
  private cpuExt = false;
  private anticExt = false;

  constructor(config: AtariMemoryConfig | number) {
    const c = typeof config === 'number'
      ? { ramSize: config, xl: false, builtinBasic: false, extBanks: 0 }
      : config;
    this.ramSize = c.ramSize;
    this.extBanks = c.xl ? (c.extBanks ?? 0) : 0;
    this.extRam = new Uint8Array(this.extBanks * EXT_BANK_SIZE);
    this.xl = c.xl;
    this.osRom = new Uint8Array(c.xl ? ATARI_XL_OS_SIZE : ATARI_OS_SIZE);
    this.basicRom = c.builtinBasic ? new Uint8Array(ATARI_BASIC_ROM_SIZE).fill(0xFF) : null;
    this.osEnabled = true;
    this.setPortB(0xFF);
  }

  /** The OS ROM image's own base address. */
  get osBase(): number { return this.xl ? 0xC000 : 0xD800; }

  /** Main RAM in 16K blocks, then the extended banks. */
  get ramBankCount(): number {
    return Math.max(1, this.ramSize >> 14) + this.extBanks;
  }

  getRamBank(n: number): Uint8Array {
    const count = this.ramBankCount;
    const bank = ((n % count) + count) % count;
    const main = Math.max(1, this.ramSize >> 14);
    if (bank >= main) {
      const ext = bank - main;
      return this.extRam.subarray(ext * EXT_BANK_SIZE, (ext + 1) * EXT_BANK_SIZE);
    }
    return this.ram.subarray(bank * 0x4000, (bank + 1) * 0x4000);
  }

  /** Total fitted RAM in bytes, extended banks included. */
  get totalRamSize(): number { return this.ramSize + this.extRam.length; }

  // ── XL memory control ────────────────────────────────────────────────────

  /** Apply PORTB as seen on the pins. No-op on the 400/800, where port B is
   *  joysticks 3 and 4. */
  setPortB(value: number): void {
    this.portb = value & 0xFF;
    if (!this.xl) return;
    this.osEnabled = (this.portb & 0x01) !== 0;
    this.basicEnabled = this.basicRom !== null && (this.portb & 0x02) === 0;
    this.selfTestEnabled = this.osEnabled && (this.portb & 0x80) === 0;
    if (this.extBanks > 0) {
      this.extOffset = ((this.portb >> 2) & 0x03) * EXT_BANK_SIZE - EXT_WINDOW_BASE;
      this.cpuExt = (this.portb & 0x10) === 0;
      this.anticExt = (this.portb & 0x20) === 0;
    }
  }

  get portB(): number { return this.portb; }
  get osRomEnabled(): boolean { return this.osEnabled; }
  get basicRomEnabled(): boolean { return this.basicEnabled; }
  get selfTestRomEnabled(): boolean { return this.selfTestEnabled; }
  /** 130XE: the extended bank (0-3) PORTB selects. */
  get extBank(): number { return (this.portb >> 2) & 0x03; }
  /** 130XE: the CPU / ANTIC currently see the selected bank at $4000-$7FFF. */
  get cpuExtEnabled(): boolean { return this.cpuExt; }
  get anticExtEnabled(): boolean { return this.anticExt; }

  // ── Bus ──────────────────────────────────────────────────────────────────

  /** Side-effect-free read as ANTIC sees the address space, for its DMA, the
   *  renderer and the OCR. Hardware registers read as $FF (ANTIC cannot fetch
   *  them), and a 130XE bank reaches ANTIC only when PORTB bit 5 selects it. */
  readRam(addr: number): number {
    addr &= 0xFFFF;
    if (addr >= IO_BASE && addr < IO_END) return 0xFF;
    return this.peek(addr, this.anticExt);
  }

  /** Called when a cartridge switches itself in or out of $A000-$BFFF (an OSS
   *  board's "off" banks), which the XL's TRIG3 line follows. */
  onCartEnable: (() => void) | null = null;

  /** A read or write of the cartridge control area $D500-$D5FF. */
  private cartControl(addr: number): void {
    const cart = this.cart;
    if (cart === null) return;
    const was = cart.enabled;
    cart.control(addr);
    if (cart.enabled !== was) this.onCartEnable?.();
  }

  readByte(addr: number): number {
    addr &= 0xFFFF;
    if (addr >= IO_BASE && addr < IO_END) {
      if (addr >= CCTL_BASE && addr < CCTL_END) this.cartControl(addr);
      const v = this.ioRead(addr);
      return v >= 0 ? v & 0xFF : 0xFF;
    }
    return this.peek(addr);
  }

  writeByte(addr: number, val: number): void {
    addr &= 0xFFFF;
    val &= 0xFF;
    if (addr >= IO_BASE && addr < IO_END) {
      if (addr >= CCTL_BASE && addr < CCTL_END) this.cartControl(addr);
      this.ioWrite(addr, val);
      return;
    }
    if (addr >= 0xC000) {
      // 400/800: OS ROM or nothing. XL: RAM only while the OS is switched out.
      if (!this.xl || this.osEnabled) return;
    } else if (addr >= CART_16K_BASE) {
      // A cartridge or internal BASIC is ROM; the RAM underneath is unreachable.
      if (this.cart !== null && this.cart.read(addr) >= 0) return;
      if (addr >= CART_8K_BASE && this.basicEnabled) return;
    } else if (this.selfTestEnabled && addr >= SELF_TEST_BASE && addr < SELF_TEST_END) {
      return;
    } else if (this.cpuExt && addr >= EXT_WINDOW_BASE && addr < EXT_WINDOW_END) {
      this.extRam[addr + this.extOffset] = val;
      return;
    }
    if (addr < this.ramSize) this.ram[addr] = val;
  }

  /** Everything but the hardware window; `ext` says whether this reader sees
   *  the selected extended bank in the $4000-$7FFF window. */
  private peek(addr: number, ext = this.cpuExt): number {
    if (addr >= 0xC000) {
      if (!this.xl) return addr >= IO_END ? this.osRom[addr - IO_END] : 0xFF;
      if (this.osEnabled) return this.osRom[addr - 0xC000];
    } else if (addr >= CART_16K_BASE) {
      if (this.cart !== null) {
        const v = this.cart.read(addr);
        if (v >= 0) return v;
      }
      if (addr >= CART_8K_BASE && this.basicEnabled) return this.basicRom![addr - CART_8K_BASE];
    } else if (this.selfTestEnabled && addr >= SELF_TEST_BASE && addr < SELF_TEST_END) {
      return this.osRom[SELF_TEST_ROM_OFFSET + addr - SELF_TEST_BASE];
    } else if (ext && addr >= EXT_WINDOW_BASE && addr < EXT_WINDOW_END) {
      return this.extRam[addr + this.extOffset];
    }
    return addr < this.ramSize ? this.ram[addr] : 0xFF;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  /** The 64K address space as the CPU currently sees it (I/O as $FF). */
  snapshot(): Uint8Array {
    const out = new Uint8Array(0x10000);
    for (let a = 0; a < 0x10000; a++) {
      out[a] = a >= IO_BASE && a < IO_END ? 0xFF : this.peek(a);
    }
    return out;
  }

  /**
   * Install the system ROM image: the 10K (400/800) or 16K (XL) OS, followed
   * on the 600XL/800XL by the 8K internal BASIC. Shorter OS images are
   * refused so a stray image for the other family cannot half-fill the ROM;
   * a missing BASIC leaves that ROM reading $FF.
   */
  loadRom(data: Uint8Array): boolean {
    const osSize = this.osRom.length;
    if (data.length < osSize) return false;
    this.osRom.set(data.subarray(0, osSize));
    if (this.basicRom && data.length >= osSize + ATARI_BASIC_ROM_SIZE) {
      this.basicRom.set(data.subarray(osSize, osSize + ATARI_BASIC_ROM_SIZE));
    }
    return true;
  }

  /**
   * Insert a cartridge: a raw 4K/8K/16K dump or a `.car` image. 8K sits at
   * $A000, 16K at $8000 unless it is a bank-switched OSS board (see
   * cartridge.ts); 4K sits at $B000, the half below it reading $FF. False (with
   * `cartError` saying why) for an image it cannot map.
   */
  insertCart(data: Uint8Array): boolean {
    const parsed = parseCartridge(data);
    if ('error' in parsed) {
      this.cartError = parsed.error;
      return false;
    }
    this.cart = new AtariCartridge(parsed.type, parsed.image);
    this.cartError = '';
    return true;
  }

  ejectCart(): void {
    this.cart = null;
  }

  reset(): void {
    // RAM contents survive a reset on real hardware; the decode resets, and
    // PORTB's lines float high until the OS drives them.
    this.cart?.reset();
    this.setPortB(0xFF);
  }
}
