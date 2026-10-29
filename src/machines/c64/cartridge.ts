/**
 * Commodore 64 cartridges (`.crt`).
 *
 * A cartridge sits on the expansion port and can hold the bus in two ways: it
 * pulls the EXROM and GAME lines low, which tells the PLA to map its ROM into
 * the CPU's address space (ROML at $8000-$9FFF, ROMH at $A000-$BFFF or, in
 * Ultimax mode, $E000-$FFFF), and it answers in the two I/O areas, $DE00-$DEFF
 * (I/O 1) and $DF00-$DFFF (I/O 2), where the bank-switching boards put their
 * registers. `memory.ts` turns the two lines into a memory map; this file is
 * the cartridge itself.
 *
 * Lines are kept as levels, as the `.crt` header gives them: 0 is the line
 * pulled low (active), 1 is released.
 *
 *   EXROM 0, GAME 1   8K cartridge: ROML at $8000
 *   EXROM 0, GAME 0   16K cartridge: ROML at $8000, ROMH at $A000
 *   EXROM 1, GAME 0   Ultimax: ROML at $8000, ROMH at $E000, the rest open
 *   EXROM 1, GAME 1   cartridge out of the way
 *
 * Boards supported (the `.crt` hardware type): 0 normal, 4 Simons' BASIC,
 * 5 Ocean type 1, 7 Fun Play / Power Play, 8 Super Games, 10 Epyx FastLoad,
 * 15 System 3, 17 Dinamic, 18 Zaxxon, 19 Magic Desk and 32 EasyFlash (read
 * only: its flash chips cannot be programmed). Anything else is refused with
 * the type's number, since mapping it as a plain ROM would only crash.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

export type C64CartType =
  | 'normal' | 'simons' | 'ocean' | 'funplay' | 'supergames' | 'epyx'
  | 'system3' | 'dinamic' | 'zaxxon' | 'magicdesk' | 'easyflash';

const HW_TYPES: Readonly<Record<number, C64CartType>> = {
  0: 'normal', 4: 'simons', 5: 'ocean', 7: 'funplay', 8: 'supergames', 10: 'epyx',
  15: 'system3', 17: 'dinamic', 18: 'zaxxon', 19: 'magicdesk', 32: 'easyflash',
};

export const C64_CART_TYPE_NAMES: Readonly<Record<C64CartType, string>> = {
  normal: 'Normal', simons: "Simons' BASIC", ocean: 'Ocean', funplay: 'Fun Play',
  supergames: 'Super Games', epyx: 'Epyx FastLoad', system3: 'System 3', dinamic: 'Dinamic',
  zaxxon: 'Zaxxon', magicdesk: 'Magic Desk', easyflash: 'EasyFlash',
};

const SIGNATURE = 'C64 CARTRIDGE';
const BANK = 0x2000;
/** The Epyx FastLoad's capacitor holds the ROM in for this many cycles. */
const EPYX_HOLD = 512;

export type C64CartParse = { cart: C64Cartridge } | { error: string };

const be16 = (d: Uint8Array, o: number): number => (d[o] << 8) | d[o + 1];
const be32 = (d: Uint8Array, o: number): number => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

/** `data` looks like a `.crt` file. */
export function isCrt(data: Uint8Array): boolean {
  if (data.length < 0x40) return false;
  for (let i = 0; i < SIGNATURE.length; i++) if (data[i] !== SIGNATURE.charCodeAt(i)) return false;
  return true;
}

/** Banks of 8K, by bank number. A 4K chip is mirrored to fill its 8K. */
type Banks = (Uint8Array | undefined)[];

function bankFor(banks: Banks, n: number): Uint8Array {
  return banks[n] ?? (banks[n] = new Uint8Array(BANK).fill(0xFF));
}

/** Read a `.crt` file. */
export function parseCrt(data: Uint8Array): C64CartParse {
  if (!isCrt(data)) return { error: 'Not a C64 cartridge file (.crt)' };
  const headerLen = be32(data, 0x10);
  const hw = be16(data, 0x16);
  const type = HW_TYPES[hw];
  if (!type) return { error: `Cartridge hardware type ${hw} is not supported` };
  const exrom = data[0x18] ? 1 : 0;
  const game = data[0x19] ? 1 : 0;
  let name = '';
  for (let i = 0x20; i < 0x40 && data[i] !== 0; i++) name += String.fromCharCode(data[i]);

  const roml: Banks = [];
  const romh: Banks = [];
  let at = Math.max(headerLen, 0x40);
  while (at + 0x10 <= data.length) {
    if (String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]) !== 'CHIP') {
      return { error: `Cartridge file is damaged (no CHIP packet at ${at})` };
    }
    const total = be32(data, at + 4);
    const bank = be16(data, at + 10);
    const load = be16(data, at + 12);
    const size = be16(data, at + 14);
    if (total < 0x10 || at + 0x10 + size > data.length) return { error: 'Cartridge file is truncated' };
    const rom = data.subarray(at + 0x10, at + 0x10 + size);
    if (be16(data, at + 8) === 0 || be16(data, at + 8) === 2) {          // ROM or flash; RAM chips hold nothing
      if (load === 0x8000 && size === 0x4000) {
        bankFor(roml, bank).set(rom.subarray(0, BANK));
        bankFor(romh, bank).set(rom.subarray(BANK));
      } else if (load === 0x8000 || load === 0xA000 || load === 0xE000) {
        const target = bankFor(load === 0x8000 ? roml : romh, bank);
        if (size >= BANK) target.set(rom.subarray(0, BANK));
        else for (let i = 0; i < BANK; i += size) target.set(rom.subarray(0, Math.min(size, BANK - i)), i);
      } else {
        return { error: `Cartridge chip loads at $${load.toString(16).toUpperCase()}, which is not a cartridge address` };
      }
    }
    at += Math.max(total, 0x10);
  }
  if (roml.length === 0 && romh.length === 0) return { error: 'Cartridge file holds no ROM' };
  return { cart: new C64Cartridge(type, name, exrom, game, roml, romh, data) };
}

export class C64Cartridge {
  /** EXROM and GAME as levels (0 = pulled low). */
  exrom: number;
  game: number;
  /** Banks currently at ROML and ROMH. */
  private romlBank = 0;
  private romhBank = 0;
  private ctrl = 0;
  private locked = false;
  private epyxLast = 0;
  /** The 256 bytes of RAM on the EasyFlash, in I/O 2. */
  private readonly ram = new Uint8Array(256);
  /** Number of ROML banks and the first ROMH bank number, for boards that
   *  keep both in one numbering (Ocean). */
  private readonly romlCount: number;
  private readonly romhBase: number;

  /** The CPU's cycle count, for the Epyx FastLoad's capacitor. */
  clock: () => number = () => 0;
  /** The lines moved: the memory map must be worked out again. */
  onLines: (() => void) | null = null;

  constructor(
    readonly type: C64CartType,
    readonly name: string,
    private readonly headerExrom: number,
    private readonly headerGame: number,
    private readonly roml: Banks,
    private readonly romh: Banks,
    /** The file as given, for snapshots and ejecting back to it. */
    readonly image: Uint8Array,
  ) {
    this.exrom = headerExrom;
    this.game = headerGame;
    this.romlCount = Math.max(1, roml.reduce((n, b, i) => (b ? i + 1 : n), 0));
    this.romhBase = romh.findIndex(b => b !== undefined);
    this.reset();
  }

  /** Power-up: bank 0, and the lines the board starts with. */
  reset(): void {
    this.romlBank = 0;
    this.romhBank = 0;
    this.ctrl = 0;
    this.locked = false;
    this.ram.fill(0);
    this.exrom = this.headerExrom;
    this.game = this.headerGame;
    this.epyxLast = this.clock();
    if (this.type === 'zaxxon') { this.exrom = 0; this.game = 0; }
    if (this.type === 'supergames') { this.exrom = 0; this.game = 0; }
    if (this.type === 'easyflash') this.applyEasyFlash();
  }

  get dynamicLines(): boolean { return this.type === 'epyx'; }

  /** Epyx: the ROM is in only while the capacitor is held discharged. */
  private epyxIn(): boolean { return this.clock() - this.epyxLast < EPYX_HOLD; }

  /** The lines the PLA sees now. */
  get lines(): { exrom: number; game: number } {
    if (this.type === 'epyx') return { exrom: this.epyxIn() ? 0 : 1, game: 1 };
    return { exrom: this.exrom, game: this.game };
  }

  private setLines(exrom: number, game: number): void {
    if (exrom === this.exrom && game === this.game) return;
    this.exrom = exrom;
    this.game = game;
    this.onLines?.();
  }

  private applyEasyFlash(): void {
    const m = (this.ctrl & 4) !== 0;
    this.exrom = (this.ctrl & 2) !== 0 ? 0 : 1;
    this.game = m ? ((this.ctrl & 1) !== 0 ? 0 : 1) : 0;
  }

  // ── The ROM windows ──────────────────────────────────────────────────────

  /** A byte of the ROML window ($8000-$9FFF), offset 0-$1FFF. */
  readRoml(offset: number): number {
    if (this.type === 'epyx') this.epyxLast = this.clock();
    if (this.type === 'zaxxon') {
      const bank = offset >= 0x1000 ? 1 : 0;
      if (bank !== this.romhBank) this.romhBank = bank;
    }
    return (this.roml[this.type === 'zaxxon' ? 0 : this.romlBank]?.[offset]) ?? 0xFF;
  }

  /** The same byte, looked at without any effect on the board. */
  peekRoml(offset: number): number {
    return this.roml[this.type === 'zaxxon' ? 0 : this.romlBank]?.[offset] ?? 0xFF;
  }

  /** A byte of the ROMH window (at $A000 or $E000), offset 0-$1FFF. */
  readRomh(offset: number): number {
    let bank = this.romhBank;
    if (this.type === 'ocean' || this.type === 'magicdesk' || this.type === 'funplay') {
      // Boards that number ROMH banks above the ROML ones: the same register
      // picks the matching bank of each.
      bank = this.romh[this.romlBank] ? this.romlBank : this.romhBase + (this.romlBank % this.romlCount);
    } else if (this.type === 'easyflash' || this.type === 'supergames') {
      bank = this.romlBank;
    } else if (this.type === 'normal' || this.type === 'simons') {
      bank = 0;
    }
    return this.romh[bank]?.[offset] ?? 0xFF;
  }

  // ── I/O 1 ($DE00) and I/O 2 ($DF00) ──────────────────────────────────────

  io1Read(addr: number): number {
    switch (this.type) {
      case 'epyx': this.epyxLast = this.clock(); return 0xFF;
      case 'simons': this.setLines(0, 0); return 0;
      case 'system3': this.romlBank = addr & 0x3F; return 0xFF;
      case 'dinamic': this.romlBank = addr & 0x0F; return 0xFF;
      case 'easyflash': return addr === 0xDE00 ? this.romlBank : (addr === 0xDE02 ? this.ctrl : 0xFF);
      default: return 0xFF;
    }
  }

  io1Write(addr: number, value: number): void {
    const v = value & 0xFF;
    switch (this.type) {
      case 'simons': if (v === 1) this.setLines(0, 1); break;
      case 'ocean': this.romlBank = v & 0x3F; break;
      case 'funplay':
        if (v === 0x86) this.setLines(1, 1);            // the loader's "switch off" write
        else {
          this.romlBank = ((v >> 3) & 7) | ((v & 1) << 3);
          this.setLines(this.headerExrom, this.headerGame);
        }
        break;
      case 'system3': this.romlBank = addr & 0x3F; break;
      case 'magicdesk':
        if (v & 0x80) this.setLines(1, 1);
        else { this.romlBank = v & 0x3F; this.setLines(this.headerExrom, this.headerGame); }
        break;
      case 'easyflash':
        if (addr === 0xDE00) this.romlBank = v & 0x3F;
        else if (addr === 0xDE02) { this.ctrl = v; this.applyEasyFlash(); this.onLines?.(); }
        break;
      default: break;
    }
  }

  io2Read(addr: number): number {
    switch (this.type) {
      case 'epyx': return this.roml[0]?.[BANK - 0x100 + (addr & 0xFF)] ?? 0xFF;   // the last page of the ROM
      case 'easyflash': return this.ram[addr & 0xFF];
      default: return 0xFF;
    }
  }

  io2Write(addr: number, value: number): void {
    const v = value & 0xFF;
    switch (this.type) {
      case 'easyflash': this.ram[addr & 0xFF] = v; break;
      case 'supergames':
        if (this.locked) break;
        this.romlBank = v & 3;
        if (v & 8) this.locked = true;
        this.setLines(v & 4 ? 1 : 0, v & 4 ? 1 : 0);
        break;
      default: break;
    }
  }

  /** Lines of text for the debugger: the board's own state. */
  describe(): string[] {
    const hx = (v: number, w = 2): string => v.toString(16).toUpperCase().padStart(w, '0');
    const out = [`ROML bank ${this.romlBank} (of ${this.romlCount})  ROMH bank ${this.romhBank}`];
    if (this.type === 'easyflash') out.push(`$DE02 control ${hx(this.ctrl)}  (mode bit ${this.ctrl & 4 ? 1 : 0}, EXROM bit ${this.ctrl & 2 ? 1 : 0}, GAME bit ${this.ctrl & 1 ? 1 : 0})`);
    if (this.type === 'supergames') out.push(`bank latch ${this.locked ? 'locked' : 'free'}`);
    if (this.type === 'epyx') out.push(`capacitor: ROM ${this.epyxIn() ? 'held in' : 'let go'} (last discharge at cycle ${this.epyxLast})`);
    return out;
  }

  // ── State ────────────────────────────────────────────────────────────────

  saveState(w: StateWriter): void {
    w.u16(this.romlBank); w.u16(this.romhBank);
    w.u8(this.exrom); w.u8(this.game); w.u8(this.ctrl); w.bool(this.locked);
    w.f64(this.epyxLast);
    w.raw(this.ram);
  }

  loadState(r: StateReader): void {
    this.romlBank = r.u16(); this.romhBank = r.u16();
    this.exrom = r.u8(); this.game = r.u8(); this.ctrl = r.u8(); this.locked = r.bool();
    this.epyxLast = r.f64();
    r.rawInto(this.ram);
  }
}
