/**
 * MGT +D disk interface.
 *
 * The +D was the popular third-party disk system for the plain 48K/128K/+2
 * Spectrum. It pairs a WD1772 FDC with an 8KB shadow ROM (G+DOS) and 8KB of
 * RAM, overlaid into the bottom 16KB of the address space (slot 0).
 *
 * Paging (verified against Fuse `z80_ops.c` + `plusd.c`):
 *   • at reset the +D is paged IN, so its ROM boots at 0x0000, sets up, then
 *     pages itself out with OUT 0xE7 and hands off to the normal ROM.
 *   • thereafter it pages IN via an M1 opcode-fetch TRAP: when the CPU fetches
 *     an instruction at 0x0008 (RST 8 / error), 0x003a, 0x0066 (NMI) or 0x028e
 *     (KEY-INPUT) the +D ROM maps itself in so it can intercept G+DOS commands
 *     and the snapshot button. This is the crux — without it BASIC never sees
 *     the +D and commands like `CAT 1` give a syntax error.
 *   • OUT 0xE7 pages OUT; IN 0xE7 also pages IN (rarely used by the ROM).
 *
 * I/O ports (full low-byte decode, high byte ignored):
 *   0xE3  WD1772 status (read) / command (write)
 *   0xEB  WD1772 track register (r/w)
 *   0xF3  WD1772 sector register (r/w)
 *   0xFB  WD1772 data register (r/w)
 *   0xE7  read = page in, write = page out
 *   0xEF  control register (write): drive = (b & 3)==2 ? 1 : 0, side = b>>7
 *   0xF7  printer port (decoded, not implemented in this build)
 *
 * The slot-0 overlay mechanism is shared with the Multiface (setSlot0 /
 * restoreSlot0); `pagedIn` feeds spectrum.hasSlot0Overlay so 128K bank
 * switches leave slot 0 alone while the +D is mapped.
 */

import type { SpectrumMemory } from '@/machines/spectrum/memory.ts';
import { WD179x } from '@/cores/wd179x.ts';

// Low-byte port addresses.
const PORT_STATUS_CMD = 0xE3;
const PORT_TRACK      = 0xEB;
const PORT_SECTOR     = 0xF3;
const PORT_DATA       = 0xFB;
const PORT_PAGE       = 0xE7;
const PORT_CONTROL    = 0xEF;
const PORT_PRINTER    = 0xF7;

export class MgtPlusD {
  enabled = false;
  pagedIn = false;
  romLoaded = false;

  /** 8KB G+DOS shadow ROM (0x0000-0x1FFF when paged in). */
  rom = new Uint8Array(8192);
  /** 8KB +D RAM (0x2000-0x3FFF when paged in). */
  ram = new Uint8Array(8192);
  /** 16KB slot-0 overlay: [ROM | RAM]. */
  private overlay = new Uint8Array(16384);

  /** Last value written to the control register (port 0xEF). */
  controlReg = 0;

  readonly fdc = new WD179x({
    statusBit7: 'motor-on',
    formatSectorsPerTrack: 10,
  });

  reset(): void {
    this.pagedIn = false;
    this.ram.fill(0);
    this.controlReg = 0;
    this.fdc.reset();
  }

  loadROM(data: Uint8Array): void {
    this.rom.fill(0);
    this.rom.set(data.subarray(0, 8192));
    this.romLoaded = true;
  }

  /**
   * M1 opcode-fetch trap. The +D pages its ROM in when the CPU fetches an
   * instruction from one of these entry points. Called once per instruction
   * from the frame loop (cheap: a guard + four compares). Mirrors Fuse
   * `z80_ops.c`: PC == 0x0008 || 0x003a || 0x0066 || 0x028e → plusd_page().
   */
  checkM1Page(pc: number, memory: SpectrumMemory): void {
    if (this.pagedIn) return;
    if (pc === 0x0008 || pc === 0x003a || pc === 0x0066 || pc === 0x028e) {
      this.pageIn(memory);
    }
  }

  // ── Slot-0 paging (same mechanism as the Multiface) ───────────────────
  pageIn(memory: SpectrumMemory): void {
    if (this.pagedIn) return;
    this.overlay.set(this.rom, 0);
    this.overlay.set(this.ram, 0x2000);
    memory.setSlot0(this.overlay);
    this.pagedIn = true;
  }

  pageOut(memory: SpectrumMemory): void {
    if (!this.pagedIn) return;
    // CPU writes during the overlay went into the live slot-0 RAM half; copy
    // them back so they persist across page-outs.
    this.ram.set(memory.getSlot(0).subarray(0x2000, 0x4000));
    memory.restoreSlot0();
    this.pagedIn = false;
  }

  // ── Port decode ───────────────────────────────────────────────────────
  /** True if the low byte is one of the +D's ports. */
  matchPort(port: number): boolean {
    switch (port & 0xFF) {
      case PORT_STATUS_CMD: case PORT_TRACK: case PORT_SECTOR: case PORT_DATA:
      case PORT_PAGE: case PORT_CONTROL: case PORT_PRINTER:
        return true;
      default:
        return false;
    }
  }

  readPort(port: number, memory: SpectrumMemory): number {
    switch (port & 0xFF) {
      case PORT_STATUS_CMD: return this.fdc.readStatus();
      case PORT_TRACK:      return this.fdc.readTrack();
      case PORT_SECTOR:     return this.fdc.readSectorReg();
      case PORT_DATA:       return this.fdc.readData();
      case PORT_PAGE:       this.pageIn(memory); return 0; // Fuse plusd_patch_read returns 0
      case PORT_PRINTER:    return 0xFF; // printer BUSY not implemented
      default:              return 0xFF;
    }
  }

  writePort(port: number, val: number, memory: SpectrumMemory): void {
    switch (port & 0xFF) {
      case PORT_STATUS_CMD: this.fdc.writeCommand(val); break;
      case PORT_TRACK:      this.fdc.writeTrack(val); break;
      case PORT_SECTOR:     this.fdc.writeSectorReg(val); break;
      case PORT_DATA:       this.fdc.writeData(val); break;
      case PORT_PAGE:       this.pageOut(memory); break;
      case PORT_CONTROL:
        this.controlReg = val & 0xFF;
        this.fdc.selectDrive((val & 0x03) === 2 ? 1 : 0);
        this.fdc.setSide((val & 0x80) ? 1 : 0);
        break;
      case PORT_PRINTER:    break; // printer not implemented
    }
  }
}
