import type { IMachineMemory } from '@/machines/machine.ts';
import type { Zx8xModel } from './models.ts';

const ADDRESS_SPACE = 0x10000;
const RAM_BASE = 0x4000;
const HIRES_RAM_BASE = 0x2000;
const HIRES_RAM_SIZE = 0x2000;
const UDG_RAM_BASE = 0x3000;
const MEMOTECH_ROM_BASE = 0x2000;
const MEMOTECH_ROM_SIZE = 0x0800;
const QUICKSILVA_ROM_BASE = 0x2800;
const QUICKSILVA_ROM_SIZE = 0x0800;
const QUICKSILVA_RAM_BASE = 0xa000;
const QUICKSILVA_RAM_SIZE = 0x1800;

/**
 * ZX80/ZX81 memory decoding. A15 is not decoded, so the lower 32K is echoed in
 * the upper 32K. The internal 1K RAM repeats through the RAM window; fitting a
 * 16K pack replaces those mirrors with a contiguous 0x4000-0x7fff region.
 */
export class Zx8xMemory implements IMachineMemory {
  private rom: Uint8Array;
  private ram: Uint8Array;
  private readonly hiresRam = new Uint8Array(HIRES_RAM_SIZE);
  private readonly memotechRam = new Uint8Array(0x400);
  private readonly quickSilvaRam = new Uint8Array(QUICKSILVA_RAM_SIZE);
  private hrgRom = new Uint8Array(0);
  private expanded = false;
  private udgRam = false;
  private udg128Ram = false;
  private wrxRam = false;
  private memotechHrg = false;
  private quickSilvaHrg = false;

  constructor(readonly model: Zx8xModel) {
    this.rom = new Uint8Array(model === 'zx80' ? 0x1000 : 0x2000);
    this.ram = new Uint8Array(0x400);
  }

  get has16kExpansion(): boolean { return this.expanded; }
  get hasUdgRam(): boolean { return this.udgRam; }
  get hasUdg128Ram(): boolean { return this.udg128Ram; }
  get hasWrxRam(): boolean { return this.wrxRam; }
  get hasMemotechHrg(): boolean { return this.memotechHrg; }
  get hasQuickSilvaHrg(): boolean { return this.quickSilvaHrg; }
  get ramSize(): number { return this.ram.length; }

  set16kExpansion(enabled: boolean): void {
    if (enabled === this.expanded) return;
    const next = new Uint8Array(enabled ? 0x4000 : 0x400);
    next.set(this.ram.subarray(0, Math.min(next.length, this.ram.length)));
    this.ram = next;
    this.expanded = enabled;
  }

  /** Character-generator RAM board decoded at $3000-$3FFF. */
  setUdgRam(enabled: boolean): void {
    this.udgRam = enabled;
    if (enabled) this.disableOtherHrg('udg');
  }

  /** 128-character UDG board using bit 7 as character-address bit 6. */
  setUdg128Ram(enabled: boolean): void {
    this.udg128Ram = enabled;
    if (enabled) this.disableOtherHrg('udg128');
  }

  /** WRX refresh-readable static RAM decoded at $2000-$3FFF. */
  setWrxRam(enabled: boolean): void {
    this.wrxRam = enabled;
    if (enabled) this.disableOtherHrg('wrx');
  }

  setMemotechHrg(enabled: boolean): void {
    this.memotechHrg = enabled;
    if (enabled) this.disableOtherHrg('memotech');
  }

  setQuickSilvaHrg(enabled: boolean): void {
    this.quickSilvaHrg = enabled;
    if (enabled) this.disableOtherHrg('quicksilva');
  }

  private disableOtherHrg(keep: 'udg' | 'udg128' | 'wrx' | 'memotech' | 'quicksilva'): void {
    if (keep !== 'udg') this.udgRam = false;
    if (keep !== 'udg128') this.udg128Ram = false;
    if (keep !== 'wrx') this.wrxRam = false;
    if (keep !== 'memotech') this.memotechHrg = false;
    if (keep !== 'quicksilva') this.quickSilvaHrg = false;
  }

  isUdgPatternAddress(addr: number): boolean {
    const decoded = (addr & 0xffff) & 0x7fff;
    return (this.udgRam || this.udg128Ram) && decoded >= UDG_RAM_BASE && decoded < RAM_BASE;
  }

  isUdg128PatternAddress(addr: number): boolean {
    const decoded = (addr & 0xffff) & 0x7fff;
    return this.udg128Ram && decoded >= UDG_RAM_BASE && decoded < RAM_BASE;
  }

  isWrxBitmapAddress(addr: number): boolean {
    const decoded = (addr & 0xffff) & 0x7fff;
    // WRX16 commonly stores HFILE in the added static RAM at $2000-$3FFF;
    // WRX1K deliberately uses the ZX81's stock RAM at $4000 and its mirrors.
    return this.wrxRam && decoded >= HIRES_RAM_BASE;
  }

  loadROM(data: Uint8Array): void {
    const size = this.model === 'zx80' ? 0x1000 : 0x2000;
    this.rom = new Uint8Array(size).fill(0xff);
    this.rom.set(data.subarray(0, size));
  }

  getRom(): Uint8Array { return this.rom; }

  loadHrgROM(data: Uint8Array): void {
    this.hrgRom = new Uint8Array(0x800).fill(0xff);
    this.hrgRom.set(data.subarray(0, this.hrgRom.length));
  }

  readMemotechOverlay(addr: number): number {
    return this.memotechRam[addr & 0x3ff];
  }

  /** Load a cassette-program memory image without applying ROM protection. */
  loadRamImage(data: Uint8Array, address: number): void {
    for (let i = 0; i < data.length; i++) this.writeByte(address + i, data[i]);
  }

  readByte(addr: number): number {
    const physical = addr & 0xffff;
    if (this.quickSilvaHrg && physical >= QUICKSILVA_RAM_BASE
        && physical < QUICKSILVA_RAM_BASE + QUICKSILVA_RAM_SIZE) {
      return this.quickSilvaRam[physical - QUICKSILVA_RAM_BASE];
    }
    const decoded = (addr & 0xffff) & 0x7fff;
    if (this.memotechHrg && decoded >= MEMOTECH_ROM_BASE
        && decoded < MEMOTECH_ROM_BASE + MEMOTECH_ROM_SIZE && this.hrgRom.length) {
      return this.hrgRom[decoded - MEMOTECH_ROM_BASE];
    }
    if (this.quickSilvaHrg && decoded >= QUICKSILVA_ROM_BASE
        && decoded < QUICKSILVA_ROM_BASE + QUICKSILVA_ROM_SIZE && this.hrgRom.length) {
      return this.hrgRom[decoded - QUICKSILVA_ROM_BASE];
    }
    if (this.wrxRam && decoded >= HIRES_RAM_BASE && decoded < RAM_BASE) {
      return this.hiresRam[decoded - HIRES_RAM_BASE];
    }
    if ((this.udgRam || this.udg128Ram) && decoded >= UDG_RAM_BASE && decoded < RAM_BASE) {
      return this.hiresRam[decoded - HIRES_RAM_BASE];
    }
    if (decoded < RAM_BASE) return this.rom[decoded % this.rom.length];
    return this.ram[(decoded - RAM_BASE) % this.ram.length];
  }

  writeByte(addr: number, val: number): void {
    const physical = addr & 0xffff;
    if (this.quickSilvaHrg && physical >= QUICKSILVA_RAM_BASE
        && physical < QUICKSILVA_RAM_BASE + QUICKSILVA_RAM_SIZE) {
      this.quickSilvaRam[physical - QUICKSILVA_RAM_BASE] = val & 0xff;
      return;
    }
    const decoded = (addr & 0xffff) & 0x7fff;
    if (this.memotechHrg && decoded < 0x400) {
      this.memotechRam[decoded] = val & 0xff;
      return;
    }
    if (this.wrxRam && decoded >= HIRES_RAM_BASE && decoded < RAM_BASE) {
      this.hiresRam[decoded - HIRES_RAM_BASE] = val & 0xff;
      return;
    }
    if ((this.udgRam || this.udg128Ram) && decoded >= UDG_RAM_BASE && decoded < RAM_BASE) {
      this.hiresRam[decoded - HIRES_RAM_BASE] = val & 0xff;
      return;
    }
    if (decoded < RAM_BASE) return;
    this.ram[(decoded - RAM_BASE) % this.ram.length] = val & 0xff;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte(addr + i);
    return out;
  }

  snapshot(): Uint8Array {
    const out = new Uint8Array(ADDRESS_SPACE);
    for (let i = 0; i < ADDRESS_SPACE; i++) out[i] = this.readByte(i);
    return out;
  }

  getRamBank(n: number): Uint8Array {
    if (n !== 0) return new Uint8Array(0);
    return this.ram.length === 0x4000 ? this.ram : this.ram.slice();
  }

  /** One bank: the ZX80/81 has a single unpaged block of RAM. */
  readonly ramBankCount = 1;

  ramSnapshot(): Uint8Array { return this.ram.slice(); }

  reset(): void {
    this.ram.fill(0);
    this.hiresRam.fill(0);
    this.memotechRam.fill(0);
    this.quickSilvaRam.fill(0);
  }
}
