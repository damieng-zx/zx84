/**
 * Beta Disk interface (TR-DOS).
 *
 * The Beta Disk was the dominant disk system for the plain 48K/128K Spectrum in
 * the ex-USSR scene. It pairs a WD1793 FDC with a 16KB TR-DOS ROM overlaid into
 * the bottom 16KB of the address space (slot 0). Unlike the +D's 8KB ROM + 8KB
 * RAM split, the whole 16KB is ROM.
 *
 * Paging — the "Beta 128" automatic model (verified against Fuse `beta.c`):
 *   • TR-DOS ROM maps IN on an M1 opcode fetch in 0x3D00-0x3DFF while the 48K
 *     BASIC ROM is active (the entry point is RANDOMIZE USR 15616 = 0x3D00).
 *   • it maps OUT on an M1 fetch at >= 0x4000. To return to BASIC, TR-DOS jumps
 *     through a trampoline in RAM (>= 0x4000); that fetch trips the page-out,
 *     then the trampoline jumps back into the now-restored BASIC ROM.
 *   • it is NOT paged in at reset (opposite of the +D) — it waits for the trap.
 *
 * I/O ports (full low-byte decode, high byte ignored; active only while paged
 * in — the port chip-select derives from the same DOS signal that maps the ROM,
 * so 0xFF never steals the keyboard (0xFE) or the 128K paging ports while
 * TR-DOS is out):
 *   0x1F  WD1793 status (read) / command (write)
 *   0x3F  WD1793 track register (r/w)
 *   0x5F  WD1793 sector register (r/w)
 *   0x7F  WD1793 data register (r/w)
 *   0xFF  system register (verified against Fuse beta.c):
 *           write: b0-1 drive select, b3 HLT, b4 side select (INVERTED — bit
 *                  set = side 0), b5 density (ignored — TR-DOS is always MFM).
 *                  No reset bit here.
 *           read:  b7 = INTRQ, b6 = DRQ
 *
 * The slot-0 overlay mechanism is shared with the Multiface / +D (setSlot0 /
 * restoreSlot0); `pagedIn` feeds spectrum.hasSlot0Overlay so 128K bank switches
 * leave slot 0 alone while TR-DOS is mapped.
 */

import type { SpectrumMemory } from '@/memory.ts';
import { WD1793 } from '@/cores/wd1793.ts';

// Low-byte port addresses.
const PORT_STATUS_CMD = 0x1F;
const PORT_TRACK      = 0x3F;
const PORT_SECTOR     = 0x5F;
const PORT_DATA       = 0x7F;
const PORT_SYSTEM     = 0xFF;

export class BetaDisk {
  enabled = false;
  pagedIn = false;
  romLoaded = false;

  /** 16KB TR-DOS ROM (0x0000-0x3FFF when paged in). */
  rom = new Uint8Array(16384);
  /** 16KB slot-0 overlay — a copy of the ROM (all ROM, no RAM half). */
  private overlay = new Uint8Array(16384);

  /** Last value written to the system register (port 0xFF). */
  systemReg = 0;

  readonly fdc = new WD1793();

  reset(): void {
    this.pagedIn = false;
    this.systemReg = 0;
    this.fdc.reset();
  }

  loadROM(data: Uint8Array): void {
    this.rom.fill(0);
    this.rom.set(data.subarray(0, 16384));
    this.romLoaded = true;
  }

  /**
   * Automatic paging trap. Called once per instruction from the frame loop with
   * the address about to be executed, BEFORE the fetch — so the 0x3Dxx
   * instruction is fetched from TR-DOS ROM once we page in. Pages OUT as soon as
   * execution leaves the bottom 16KB (>= 0x4000).
   */
  checkPage(pc: number, memory: SpectrumMemory): void {
    if (!this.romLoaded) return;
    if (!this.pagedIn) {
      // Enter TR-DOS: M1 fetch in 0x3D00-0x3DFF while the 48K BASIC ROM is live.
      if ((pc & 0xFF00) === 0x3D00 && memory.isBasicRomActive()) this.pageIn(memory);
    } else if (pc >= 0x4000) {
      // Left the bottom 16KB — hand back to BASIC.
      this.pageOut(memory);
    }
  }

  // ── Slot-0 paging (same mechanism as the Multiface / +D) ──────────────
  pageIn(memory: SpectrumMemory): void {
    if (this.pagedIn) return;
    this.overlay.set(this.rom, 0);
    memory.setSlot0(this.overlay);
    this.pagedIn = true;
  }

  pageOut(memory: SpectrumMemory): void {
    if (!this.pagedIn) return;
    // TR-DOS ROM is all ROM — no CPU writes to copy back.
    memory.restoreSlot0();
    this.pagedIn = false;
  }

  // ── Port decode (active only while paged in) ──────────────────────────
  matchPort(port: number): boolean {
    if (!this.pagedIn) return false;
    switch (port & 0xFF) {
      case PORT_STATUS_CMD: case PORT_TRACK: case PORT_SECTOR:
      case PORT_DATA: case PORT_SYSTEM:
        return true;
      default:
        return false;
    }
  }

  readPort(port: number): number {
    switch (port & 0xFF) {
      case PORT_STATUS_CMD: return this.fdc.readStatus();
      case PORT_TRACK:      return this.fdc.readTrack();
      case PORT_SECTOR:     return this.fdc.readSectorReg();
      case PORT_DATA:       return this.fdc.readData();
      case PORT_SYSTEM:
        return (this.fdc.intrq ? 0x80 : 0) | (this.fdc.drq ? 0x40 : 0) | 0x3F;
      default:              return 0xFF;
    }
  }

  writePort(port: number, val: number): void {
    switch (port & 0xFF) {
      case PORT_STATUS_CMD: this.fdc.writeCommand(val); break;
      case PORT_TRACK:      this.fdc.writeTrack(val); break;
      case PORT_SECTOR:     this.fdc.writeSectorReg(val); break;
      case PORT_DATA:       this.fdc.writeData(val); break;
      case PORT_SYSTEM:
        this.systemReg = val & 0xFF;
        // System-register bits (verified against Fuse beta.c wd_fdc / beta_sp_write):
        //   b0-1 drive select (2 drives — units 2/3 alias to 0/1)
        //   b3   HLT (head-load timing) — modelled implicitly
        //   b4   side select, INVERTED: bit set → side 0, clear → side 1
        //   b5   density (DDEN); TR-DOS is always MFM, so ignored
        // There is NO reset bit here (reset is via the machine reset line).
        this.fdc.selectDrive(val & 0x03);
        this.fdc.setSide((val & 0x10) ? 0 : 1);
        break;
    }
  }
}
