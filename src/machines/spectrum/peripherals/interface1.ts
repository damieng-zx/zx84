/**
 * ZX Interface 1 — Sinclair's official expansion: an 8KB shadow ROM that extends
 * BASIC (CAT/FORMAT/MOVE/OPEN#, microdrive LOAD/SAVE) plus up to eight
 * daisy-chained Microdrives. This build implements the microdrives; the RS-232
 * serial port and ZX Net are decoded but stubbed.
 *
 * Paging (verified against Fuse `z80_ops.c`):
 *   • the 8KB IF1 ROM maps into 0x0000-0x1FFF on an M1 opcode fetch at 0x0008
 *     (error restart) or 0x1708 (channel handler), and unmaps on a fetch at
 *     0x0700. Only the bottom 8KB is overlaid — 0x2000-0x3FFF stays the
 *     Spectrum ROM, so the overlay is [IF1 ROM | Spectrum ROM upper half]
 *     (same shape as the VTX-5000, unlike the +D whose upper half is RAM).
 *
 * I/O ports (low-byte decode, high byte ignored):
 *   0xE7  microdrive data register (serial byte to/from the loop)
 *   0xEF  control (write) / status (read)
 *           write bits: b0 COMMS DATA, b1 COMMS CLK, b2 R/W, b3 ERASE,
 *                       b4 CTS, b5 WAIT
 *           read  bits: b0 WRITE-PROT, b1 SYNC, b2 GAP, b3 DTR, b4 BUSY
 *   0xF7  RS-232 / ZX Net — stubbed (returns idle-line values)
 *
 * Drive select: a COMMS CLK falling edge shifts an 8-stage motor-on chain,
 * loading the inverted COMMS DATA bit into stage 0 (Fuse `if1.c` port_ctr_out).
 *
 * Note: the IF1 shares ports 0xE7/0xEF with the MGT +D. They are not used
 * together; io-ports.ts gates each on its own `enabled` flag.
 */

import type { SpectrumMemory } from '@/machines/spectrum/memory.ts';
import { Microdrive } from '@/machines/spectrum/peripherals/microdrive.ts';

// Low-byte port addresses.
const PORT_DATA    = 0xE7;
const PORT_CONTROL = 0xEF; // control (write) / status (read)
const PORT_RS232   = 0xF7;

export class Interface1 {
  enabled = false;
  pagedIn = false;
  romLoaded = false;

  /** 8KB shadow ROM (mapped to 0x0000-0x1FFF when paged in). */
  readonly rom = new Uint8Array(8192);
  /** 16KB slot-0 overlay: [IF1 ROM | snapshot of the Spectrum ROM upper half]. */
  private readonly overlay = new Uint8Array(16384);

  /** The eight daisy-chained microdrives (index 0 = drive 1). */
  readonly drives: Microdrive[] = Array.from({ length: 8 }, () => new Microdrive());

  /** Previous COMMS CLK latch state (for falling-edge detection). */
  private commsClk = false;

  /** Bumped on every microdrive byte transfer — drives the activity LED. */
  accesses = 0;

  reset(): void {
    this.pagedIn = false;
    this.commsClk = false;
    for (const d of this.drives) {
      d.motorOn = false;
      d.restart();
    }
  }

  loadROM(data: Uint8Array): void {
    this.rom.fill(0);
    this.rom.set(data.subarray(0, 8192));
    this.romLoaded = true;
  }

  // ── Shadow ROM paging ───────────────────────────────────────────────────
  /**
   * M1 opcode-fetch trap — page IN only. Called once per instruction from the
   * frame loop BEFORE the instruction executes, so the instruction at 0x0008 /
   * 0x1708 is fetched from the IF1 ROM. Page-OUT is handled separately AFTER the
   * instruction at 0x0700 executes (see pageOutAt below) — the byte at 0x0700 in
   * the IF1 ROM is a RET (the clean exit), so it must run from the IF1 ROM, not
   * be replaced by the underlying Spectrum ROM before it executes. (Paging out
   * too early was the cause of CAT silently failing.)
   */
  checkM1Page(pc: number, memory: SpectrumMemory): void {
    if (this.romLoaded && !this.pagedIn && (pc === 0x0008 || pc === 0x1708)) {
      this.pageIn(memory);
    }
  }

  /** True if the instruction about to run is the IF1 ROM's page-out exit (0x0700). */
  shouldPageOut(pc: number): boolean {
    return this.pagedIn && pc === 0x0700;
  }

  pageIn(memory: SpectrumMemory): void {
    if (this.pagedIn) return;
    // Preserve the Spectrum ROM's upper half (0x2000-0x3FFF); only the bottom
    // 8KB carries the IF1 ROM.
    const spectrumRom = memory.romPages[memory.currentROM];
    this.overlay.set(spectrumRom.subarray(0x2000, 0x4000), 0x2000);
    this.overlay.set(this.rom, 0);
    memory.setSlot0(this.overlay);
    this.pagedIn = true;
  }

  pageOut(memory: SpectrumMemory): void {
    if (!this.pagedIn) return;
    memory.restoreSlot0();
    this.pagedIn = false;
  }

  // ── Port decode ─────────────────────────────────────────────────────────
  matchPort(port: number): boolean {
    switch (port & 0xFF) {
      case PORT_DATA: case PORT_CONTROL: case PORT_RS232:
        return true;
      default:
        return false;
    }
  }

  readPort(port: number): number {
    switch (port & 0xFF) {
      case PORT_DATA:    return this.readData();
      case PORT_CONTROL: return this.readStatus();
      case PORT_RS232:   return 0xFF; // RS-232 / Net idle line — stubbed
      default:           return 0xFF;
    }
  }

  writePort(port: number, val: number): void {
    switch (port & 0xFF) {
      case PORT_DATA:    this.writeData(val); break;
      case PORT_CONTROL: this.writeControl(val); break;
      case PORT_RS232:   break; // stubbed
    }
  }

  // ── Microdrive data port (0xE7) ─────────────────────────────────────────
  /** Read one byte from the loop — the AND of every active drive's output. */
  readData(): number {
    let ret = 0xFF;
    for (const d of this.drives) ret &= d.dataIn();
    this.accesses++;
    return ret;
  }

  /** Write one byte to the loop (broadcast to every active drive). */
  writeData(val: number): void {
    for (const d of this.drives) d.dataOut(val & 0xFF);
    this.accesses++;
  }

  // ── Control / status port (0xEF) ────────────────────────────────────────
  /**
   * Status read: AND of every active drive's GAP/SYNC/WRITE-PROT contribution,
   * then re-align all heads (Fuse calls microdrives_restart at the end). The
   * RS-232 DTR/BUSY bits are left high (no serial line).
   */
  readStatus(): number {
    let ret = 0xFF;
    for (const d of this.drives) ret &= d.statusIn();
    for (const d of this.drives) d.restart();
    return ret;
  }

  /**
   * Control write: a COMMS CLK falling edge shifts the motor-on chain. Then
   * re-align all heads.
   */
  writeControl(val: number): void {
    const clk = (val & 0x02) !== 0;

    if (!clk && this.commsClk) {                 // ~~\__ falling edge
      for (let m = 7; m > 0; m--) {
        this.drives[m].motorOn = this.drives[m - 1].motorOn;
      }
      this.drives[0].motorOn = (val & 0x01) ? false : true; // inverted COMMS DATA
    }

    this.commsClk = clk;
    for (const d of this.drives) d.restart();
  }

  /** True while any drive's motor is selected (for the activity indicator). */
  get anyMotorOn(): boolean {
    return this.drives.some((d) => d.motorOn);
  }
}
