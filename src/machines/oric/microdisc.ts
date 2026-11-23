/**
 * The Oric Microdisc: a WD1793 floppy controller with its own boot EPROM.
 *
 * The card answers at four addresses in page 3, above the VIA's mirror:
 *
 *   $0310  WD1793 status (read) / command (write)
 *   $0311  track
 *   $0312  sector
 *   $0313  data
 *   $0314  control latch (write) / INTRQ (read, bit 7, inverted)
 *   $0318  DRQ (read, bit 7, inverted: 0 = the FDC wants a byte)
 *
 * The latch is what makes the card a *boot* device rather than just a disk
 * controller. Writing it selects the drive and side, sets the density, and
 * flips two memory maps at once: `ROMDIS` clear puts the overlay RAM at `$C000`
 * in place of the BASIC ROM, and EPROM-select clear puts the card's 8 KB boot
 * ROM at `$E000`. That is how a Sedoric disk boots — the EPROM reads track 0,
 * loads the DOS into the overlay, and switches back.
 *
 * Because reading the WD1793's status clears its INTRQ, the ROM polls `$0314`
 * instead; that read is therefore part of the latch's contract, not a
 * convenience.
 */

import { WD179x } from '@/cores/wd179x.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/** Register selectors within the card's page-3 block. */
export const MD_STATUS = 0x10;
export const MD_TRACK = 0x11;
export const MD_SECTOR = 0x12;
export const MD_DATA = 0x13;
export const MD_CONTROL = 0x14;
export const MD_DRQ = 0x18;

/** Control-latch bits. */
const CTL_INTRQ_ENABLE = 0x01;
const CTL_ROMDIS = 0x02;
const CTL_SIDE = 0x10;
const CTL_DRIVE_SHIFT = 5;
const CTL_DRIVE_MASK = 0x60;
const CTL_EPROM = 0x80;

/** The addresses the card decodes, as a half-open range. */
export const MD_BLOCK_START = 0x0310;
export const MD_BLOCK_END = 0x031C;

export class OricMicrodisc {
  /**
   * The controller. The Microdisc's READY line is not wired to the drive on this
   * board, and its `README` reports NOT READY when no disk is in the drive, so
   * `not-ready` is the status bit 7 the ROM expects to poll.
   */
  readonly fdc = new WD179x({ statusBit7: 'not-ready', formatSectorsPerTrack: 17 });

  /** The control latch as last written. */
  control = 0;
  /** The INTRQ latch, asserted by the controller and cleared by the ROM. */
  private interrupt = false;
  /** The last DRQ level, so a read can report it without polling twice. */
  private dataRequest = false;

  /** Selected drive (0-3) and side (0/1), from the latch. */
  get drive(): number { return (this.control & CTL_DRIVE_MASK) >> CTL_DRIVE_SHIFT; }
  get side(): number { return (this.control & CTL_SIDE) !== 0 ? 1 : 0; }
  /**
   * Density: the card clears bit 3 for **single** density. The WD1793's own pin
   * is inverted against the ROM's naming, which is why Sedoric writes `$18` for
   * double density.
   */
  get singleDensity(): boolean { return (this.control & 0x08) !== 0; }
  /** Overlay RAM is mapped in at `$C000` when ROMDIS is clear. */
  get romDisabled(): boolean { return (this.control & CTL_ROMDIS) === 0; }
  /** The boot EPROM is mapped at `$E000` when its select bit is clear. */
  get epromSelected(): boolean { return (this.control & CTL_EPROM) === 0; }
  get interruptEnabled(): boolean { return (this.control & CTL_INTRQ_ENABLE) !== 0; }

  reset(): void {
    this.fdc.reset();
    this.control = 0;
    this.interrupt = false;
    this.dataRequest = false;
    // Re-derive the controller's view of the latch. A real reset leaves the
    // card's latch where it was, and the FDC's drive/side/density follow it —
    // skipping this left the controller pointing at no drive while the latch
    // said otherwise, which is what made a Sedoric boot report "insert system
    // disc" with the disk in place.
    this.applyLatch();
  }

  /** Push the latch's drive, side and density into the controller. */
  private applyLatch(): void {
    this.fdc.selectDrive(this.drive);
    this.fdc.setSide(this.side);
    this.fdc.setDensity(this.singleDensity);
  }

  /** True while the card decodes `addr` in page 3. */
  static decodes(addr: number): boolean {
    return addr >= MD_BLOCK_START && addr < MD_BLOCK_END;
  }

  /** A read from one of the card's registers. */
  read(addr: number): number {
    const reg = addr & 0xFF;
    switch (reg) {
      case MD_STATUS: {
        const value = this.fdc.readStatus();
        this.updateInterrupt();
        return value;
      }
      case MD_TRACK: return this.fdc.readTrack();
      case MD_SECTOR: return this.fdc.readSectorReg();
      case MD_DATA: {
        const value = this.fdc.readData();
        this.updateInterrupt();
        return value;
      }
      case MD_CONTROL:
        // Bit 7 is INTRQ in negative logic: 0 while the controller wants
        // attention. Only meaningful once the ROM has enabled it.
        return this.interruptEnabled && this.interrupt ? 0x7F : 0xFF;
      case MD_DRQ:
        // Bit 7 is DRQ in negative logic: 0 while the controller wants a byte.
        this.dataRequest = this.fdc.drq;
        return this.dataRequest ? 0x7F : 0xFF;
      default:
        return 0xFF;
    }
  }

  /** A write to one of the card's registers. */
  write(addr: number, value: number): void {
    const reg = addr & 0xFF;
    const val = value & 0xFF;
    switch (reg) {
      case MD_STATUS:
        this.interrupt = false;
        this.fdc.writeCommand(val);
        this.updateInterrupt();
        return;
      case MD_TRACK: this.fdc.writeTrack(val); return;
      case MD_SECTOR: this.fdc.writeSectorReg(val); return;
      case MD_DATA:
        this.fdc.writeData(val);
        this.updateInterrupt();
        return;
      case MD_CONTROL:
        this.control = val;
        this.applyLatch();
        this.updateInterrupt();
        return;
      case MD_DRQ:
        this.dataRequest = (val & 0x80) !== 0;
        return;
      default:
        return;
    }
  }

  /** Advance the controller's frame bookkeeping. */
  tickFrame(): void {
    this.fdc.tickFrame();
    this.updateInterrupt();
  }

  /** The CPU's IRQ line is asserted by this card. */
  get irq(): boolean {
    return this.interruptEnabled && this.interrupt;
  }

  private updateInterrupt(): void {
    // The controller raises INTRQ when a command completes; the latch holds it
    // until the ROM reads the status or the latch.
    if (this.fdc.intrq && !this.fdc.drq) this.interrupt = true;
  }

  saveState(w: StateWriter): void {
    w.u8(this.control);
    w.bool(this.interrupt);
    w.bool(this.dataRequest);
    this.fdc.saveState(w);
  }

  loadState(r: StateReader): void {
    this.control = r.u8();
    this.interrupt = r.bool();
    this.dataRequest = r.bool();
    this.fdc.loadState(r);
  }
}
