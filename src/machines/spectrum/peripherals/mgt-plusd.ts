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
 *   0xEF  control register (write): drive = (b & 3)==2 ? 1 : 0, side = b>>7,
 *         b6 = printer STROBE (data is latched into the output on a rising edge)
 *   0xF7  printer: write = data latch, read b7 = BUSY. The virtual printer is
 *         always ready (BUSY clear) and collects what it is sent in `printed`.
 *
 * The slot-0 overlay mechanism is shared with the Multiface (setSlot0 /
 * restoreSlot0); `pagedIn` feeds spectrum.hasSlot0Overlay so 128K bank
 * switches leave slot 0 alone while the +D is mapped.
 *
 * Booting (read from the G+DOS ROM). The 8KB ROM holds only part of G+DOS; the
 * rest is the system file, which RUN loads from disk into the +D's own RAM:
 *   • RUN with no program ends "0 OK". The ROM catches that error and, if the
 *     typed line starts with RUN and no system is loaded, boots (ROM 0x037B).
 *   • It searches the disk for a CODE file matching `+SYS*` (ROM 0x039D), loads
 *     it to 0x2000 (6.5KB), then writes 'D' at 0x3DE4 (the "system loaded"
 *     marker) and a checksum of 0x2080-0x39FE into 0x39FF.
 *   • The system then loads and runs a BASIC file matching `AUTO*`.
 *   • With a system already loaded, RUN does not boot again.
 * The RAM is static and survives the Spectrum's reset button: the ROM's reset
 * code finds the 'D' marker and warm-starts with the system it already has
 * (ROM 0x02A2). Only power (a new machine, or fitting the +D) clears it.
 *
 * Many disks (snapshot collections, magazines) carry no system file, so on real
 * hardware you boot a system disk first and then swap. When a booted disk has
 * no `+SYS*` file and a system file has been supplied (`systemFile`), zx84 loads
 * that one instead at the point the ROM's search fails, then lets the ROM carry
 * on: it sets the marker and checksum and goes on to load the disk's `AUTO*`.
 * The disk itself is never touched, so CAT and SAVE see it as it is.
 */

import type { SpectrumMemory } from '@/machines/spectrum/memory.ts';
import type { Z80 } from '@/cores/z80.ts';
import { WD179x } from '@/cores/wd179x.ts';

// Low-byte port addresses.
const PORT_STATUS_CMD = 0xE3;
const PORT_TRACK      = 0xEB;
const PORT_SECTOR     = 0xF3;
const PORT_DATA       = 0xFB;
const PORT_PAGE       = 0xE7;
const PORT_CONTROL    = 0xEF;
const PORT_PRINTER    = 0xF7;
const MAX_PRINTED     = 1 << 20;

// ── G+DOS ROM boot addresses (see the header) ─────────────────────────────
/** `JP NZ,1652`: the `+SYS*` directory search has just failed. */
const SYS_NOT_FOUND_PC = 0x03A2;
/** `LD A,'D'`: the system is in RAM; set the marker, checksum, load AUTO*. */
const SYS_LOADED_PC    = 0x03C7;
/** Where the system file loads, and its expected length. */
const SYS_LOAD_ADDR    = 0x2000;
/** The 9-byte file header the ROM copies to 0x3E29 after reading it. */
const SYS_HEADER_ADDR  = 0x3E29;
/** IX+0D (IX = 0x3AC3): the ROM sets it to 9 before loading the body. */
const SYS_IX_0D_ADDR   = 0x3AD0;
/** The most the system may occupy: the ROM sums 0x2080-0x39FE and keeps the
 *  checksum at 0x39FF, the system file's last byte; 0x3A00 up is workspace. */
const SYS_MAX_LEN      = 0x3A00 - SYS_LOAD_ADDR;
/** The ROM bytes the fallback relies on, so a different G+DOS ROM revision is
 *  left to behave as it does on hardware rather than being patched blindly:
 *  0x039D  LD A,08 / CALL 09A5 / JP NZ,1652   (search for the +SYS* template)
 *  0x03C7  LD A,'D' / LD (3DE4),A             (mark the system loaded) */
const ROM_SIGNATURE: ReadonlyArray<readonly [number, readonly number[]]> = [
  [0x039D, [0x3E, 0x08, 0xCD, 0xA5, 0x09, 0xC2, 0x52, 0x16]],
  [0x03C7, [0x3E, 0x44, 0x32, 0xE4, 0x3D]],
];
const FLAG_Z = 0x40;

export class MgtPlusD {
  enabled = false;
  pagedIn = false;
  romLoaded = false;

  /** G+DOS system file body (the `+SYS` CODE file, loaded at 0x2000), used
   *  when a disk that is booted has none of its own. Null = boot as hardware
   *  does, with "file not found" on such disks. */
  systemFile: Uint8Array | null = null;
  /** Whether the loaded ROM is the revision the system-file fallback knows. */
  private romKnown = false;
  /** Whether the +D was fitted at the last reset. Its RAM is kept across resets
   *  only while it stays fitted: fitting it is a power-on. */
  private wasFitted = false;

  /** 8KB G+DOS shadow ROM (0x0000-0x1FFF when paged in). */
  rom = new Uint8Array(8192);
  /** 8KB +D RAM (0x2000-0x3FFF when paged in). */
  ram = new Uint8Array(8192);
  /** 16KB slot-0 overlay: [ROM | RAM]. */
  private overlay = new Uint8Array(16384);

  /** Last value written to the control register (port 0xEF). */
  controlReg = 0;
  /** Printer data latch (port 0xF7 write). */
  private printerData = 0;
  /** Bytes strobed to the virtual printer, capped so a runaway listing can't
   *  grow without bound. */
  readonly printed: number[] = [];

  readonly fdc = new WD179x({
    statusBit7: 'motor-on',
    formatSectorsPerTrack: 10,
  });

  /**
   * The Spectrum's reset line. The +D's RAM is static and keeps the G+DOS
   * system across it (the ROM warm-starts from the 'D' marker), so it is only
   * cleared when the +D has just been fitted. Callers must page the +D out
   * first if it is mapped, so the live slot-0 RAM is copied back to `ram`.
   */
  reset(): void {
    const fitted = this.enabled && this.romLoaded;
    if (fitted && !this.wasFitted) this.ram.fill(0);
    this.wasFitted = fitted;
    this.pagedIn = false;
    this.controlReg = 0;
    this.printerData = 0;
    this.fdc.reset();
  }

  /** Power the +D off and on: its RAM (and any loaded G+DOS system) is lost.
   *  Safe while paged in: the live slot-0 RAM is cleared as well. */
  clearRam(memory: SpectrumMemory): void {
    this.ram.fill(0);
    if (this.pagedIn) memory.getSlot(0).fill(0, 0x2000, 0x4000);
  }

  loadROM(data: Uint8Array): void {
    this.rom.fill(0);
    this.rom.set(data.subarray(0, 8192));
    this.romLoaded = true;
    this.romKnown = ROM_SIGNATURE.every(([at, bytes]) => bytes.every((b, i) => this.rom[at + i] === b));
  }

  /** Supply the G+DOS system file for disks that lack one. The body only (no
   *  9-byte header), as it loads at 0x2000. Rejects an empty or oversized one. */
  loadSystemFile(data: Uint8Array): boolean {
    if (data.length === 0 || data.length > SYS_MAX_LEN) return false;
    this.systemFile = data.slice();
    return true;
  }

  /** Whether a disk without a system file will still boot (a system file is
   *  supplied and the ROM is the revision the fallback was written against). */
  get canSupplySystem(): boolean {
    return this.systemFile !== null && this.romKnown;
  }

  /**
   * M1 opcode-fetch trap. The +D pages its ROM in when the CPU fetches an
   * instruction from one of these entry points. Called once per instruction
   * from the frame loop (cheap: a guard + four compares). Mirrors Fuse
   * `z80_ops.c`: PC == 0x0008 || 0x003a || 0x0066 || 0x028e → plusd_page().
   * While paged in it also watches for the boot's failed `+SYS*` search.
   */
  checkM1Page(cpu: Z80, memory: SpectrumMemory): void {
    const pc = cpu.pc;
    if (this.pagedIn) {
      if (pc === SYS_NOT_FOUND_PC && (cpu.f & FLAG_Z) === 0) this.supplySystem(cpu, memory);
      return;
    }
    if (pc === 0x0008 || pc === 0x003a || pc === 0x0066 || pc === 0x028e) {
      this.pageIn(memory);
    }
  }

  /**
   * The disk being booted has no `+SYS*` file: load the supplied one where the
   * ROM would have put it and continue at the instruction after its own load,
   * as if the search had succeeded. Leaves the CPU alone (so the ROM reports
   * "file not found" as it would on hardware) when there is no system file or
   * the ROM is an unknown revision.
   */
  private supplySystem(cpu: Z80, memory: SpectrumMemory): void {
    const sys = this.systemFile;
    if (sys === null || !this.romKnown) return;
    const live = memory.getSlot(0);
    live.set(sys, SYS_LOAD_ADDR);
    // The header a CODE file carries, as the ROM would have read and copied it:
    // type 3 (CODE), length, start, then 0xFFFF / 0x0000 (no autorun).
    live.set([
      0x03, sys.length & 0xFF, sys.length >> 8, SYS_LOAD_ADDR & 0xFF, SYS_LOAD_ADDR >> 8,
      0xFF, 0xFF, 0x00, 0x00,
    ], SYS_HEADER_ADDR);
    live[SYS_IX_0D_ADDR] = 0x09;
    cpu.pc = SYS_LOADED_PC;
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
      case PORT_PRINTER:    return 0x7F; // b7 = BUSY: the virtual printer is always ready
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
        // STROBE (b6) rising edge: the latched byte goes to the printer.
        if ((val & 0x40) && !(this.controlReg & 0x40) && this.printed.length < MAX_PRINTED) {
          this.printed.push(this.printerData);
        }
        this.controlReg = val & 0xFF;
        this.fdc.selectDrive((val & 0x03) === 2 ? 1 : 0);
        this.fdc.setSide((val & 0x80) ? 1 : 0);
        break;
      case PORT_PRINTER:    this.printerData = val & 0xFF; break;
    }
  }
}
