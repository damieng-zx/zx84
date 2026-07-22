import type { IMachineMemory } from '@/machines/machine.ts';
import type { Zx8xModel } from './models.ts';

const ADDRESS_SPACE = 0x10000;
const RAM_BASE = 0x4000;
const HIRES_RAM_BASE = 0x2000;
const HIRES_RAM_SIZE = 0x2000;
const UDG_RAM_BASE = 0x3000;

/**
 * ZX80/ZX81 memory decoding. A15 is not decoded, so the lower 32K is echoed in
 * the upper 32K. The internal 1K RAM repeats through the RAM window; fitting a
 * 16K pack replaces those mirrors with a contiguous 0x4000-0x7fff region.
 */
export class Zx8xMemory implements IMachineMemory {
  private rom: Uint8Array;
  private ram: Uint8Array;
  private readonly hiresRam = new Uint8Array(HIRES_RAM_SIZE);
  private expanded = false;
  private udgRam = false;
  private wrxRam = false;

  constructor(readonly model: Zx8xModel) {
    this.rom = new Uint8Array(model === 'zx80' ? 0x1000 : 0x2000);
    this.ram = new Uint8Array(0x400);
  }

  get has16kExpansion(): boolean { return this.expanded; }
  get hasUdgRam(): boolean { return this.udgRam; }
  get hasWrxRam(): boolean { return this.wrxRam; }
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
    if (enabled) this.wrxRam = false;
  }

  /** WRX refresh-readable static RAM decoded at $2000-$3FFF. */
  setWrxRam(enabled: boolean): void {
    this.wrxRam = enabled;
    if (enabled) this.udgRam = false;
  }

  isUdgPatternAddress(addr: number): boolean {
    const decoded = (addr & 0xffff) & 0x7fff;
    return this.udgRam && decoded >= UDG_RAM_BASE && decoded < RAM_BASE;
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

  /** Load a cassette-program memory image without applying ROM protection. */
  loadRamImage(data: Uint8Array, address: number): void {
    for (let i = 0; i < data.length; i++) this.writeByte(address + i, data[i]);
  }

  readByte(addr: number): number {
    const decoded = (addr & 0xffff) & 0x7fff;
    if (this.wrxRam && decoded >= HIRES_RAM_BASE && decoded < RAM_BASE) {
      return this.hiresRam[decoded - HIRES_RAM_BASE];
    }
    if (this.udgRam && decoded >= UDG_RAM_BASE && decoded < RAM_BASE) {
      return this.hiresRam[decoded - HIRES_RAM_BASE];
    }
    if (decoded < RAM_BASE) return this.rom[decoded % this.rom.length];
    return this.ram[(decoded - RAM_BASE) % this.ram.length];
  }

  writeByte(addr: number, val: number): void {
    const decoded = (addr & 0xffff) & 0x7fff;
    if (this.wrxRam && decoded >= HIRES_RAM_BASE && decoded < RAM_BASE) {
      this.hiresRam[decoded - HIRES_RAM_BASE] = val & 0xff;
      return;
    }
    if (this.udgRam && decoded >= UDG_RAM_BASE && decoded < RAM_BASE) {
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

  ramSnapshot(): Uint8Array { return this.ram.slice(); }

  reset(): void {
    this.ram.fill(0);
    this.hiresRam.fill(0);
  }
}
