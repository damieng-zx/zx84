/**
 * MSX1 floppy disk interface — a memory-mapped WD2793 card.
 *
 * MSX1 machines had no disk controller on the motherboard; the drive came as a
 * cartridge (Philips VY-0010, Sony HBD-50, Toshiba HX-F101 …) holding a 16KB
 * Disk BASIC ROM at 0x4000–0x7FFF (mirrored at 0x8000–0xBFFF) and a Western
 * Digital WD2793 whose registers overlay the top bytes of that ROM. The common layout, shared by the Philips,
 * Sony and National-style cards, is:
 *
 *   7FF8  R status   W command
 *   7FF9  R/W track
 *   7FFA  R/W sector
 *   7FFB  R/W data
 *   7FFC  W   side select (bit 0)
 *   7FFD  W   drive select (bits 0-1, binary: 0 = A:, 1 = B:, 3 = none), in-use
 *             LED (bit 6), motor (bit 7)
 *   7FFF  R   INTRQ (bit 7) and DRQ (bit 6), both high when asserted
 *
 * A second family (the SVI-707-style "7FBx" cards) packs the same chip lower and
 * folds the three control latches into one write-only register:
 *
 *   7FB8-7FBB  status/command, track, sector, data
 *   7FBC  W   drive select (bits 0-1, one-hot: bit 0 = A:, bit 1 = B:), side
 *             (bit 2), motor (bit 3)
 *         R   INTRQ (bit 7, high when asserted), DRQ (bit 6, *low* when
 *             asserted — the driver only transfers a byte while bit 6 is clear)
 *
 * Which family a ROM expects is decided by the register addresses it loads, see
 * {@link detectLayout}; the standard layout is the default.
 *
 * The decode was written from the WD2793 datasheet and published MSX hardware
 * notes, then checked against real Disk BASIC ROMs from several vendors by
 * watching which values their drivers write (drive-select encodings differ
 * between the two families, see above).
 */

import { WD179x } from '@/cores/wd179x.ts';

/** Which register family the fitted ROM drives. */
export type MsxDiskLayout = 'standard' | 'compact';

/** Size of the Disk BASIC ROM, mapped in page 1. */
export const MSX_DISK_ROM_SIZE = 0x4000;

/** The card decodes A0-A13 only, so its 16KB image answers in page 1 *and*
 *  page 2 (0x4000-0x7FFF mirrored at 0x8000-0xBFFF). The MSX-DOS kernel relies
 *  on this: it runs the driver from page 2 and polls the controller at 0xBFF8. */
const ADDR_MASK = 0x3FFF;

const STANDARD_BASE = 0x7FF8;
const COMPACT_BASE = 0x7FB8;

// 7FFD (standard) / 7FBC (compact) control bits.
const STD_DRIVE_MASK = 0x03;
const STD_MOTOR = 0x80;
const CMP_SIDE = 0x04;
const CMP_MOTOR = 0x08;

// Status port bits.
const STATUS_DRQ = 0x40;
const STATUS_INTRQ = 0x80;

/**
 * Guess a ROM's register family from the 16-bit constants it loads. Z80 code
 * addresses a register as `LD rr,nnnn` / `LD A,(nnnn)` / `LD (nnnn),A`, so the
 * little-endian pair `B8 7F` (compact base) or `F8 7F` (standard base) turns up
 * wherever the driver touches the chip. Whichever appears more wins; ties and
 * ROMs showing neither use the standard layout.
 */
export function detectLayout(rom: Uint8Array): MsxDiskLayout {
  let standard = 0;
  let compact = 0;
  // Stop short of the register window itself: the ROM bytes shadowed by the
  // chip are never executed, and reading them would only add noise.
  const limit = Math.min(rom.length, 0x3FB0) - 1;
  for (let i = 0; i < limit; i++) {
    if (rom[i + 1] !== 0x7F) continue;
    const lo = rom[i];
    if (lo === 0xF8 || lo === 0xF9 || lo === 0xFA || lo === 0xFB || lo === 0xFC || lo === 0xFD || lo === 0xFF) standard++;
    else if (lo === 0xB8 || lo === 0xB9 || lo === 0xBA || lo === 0xBB || lo === 0xBC) compact++;
  }
  return compact > standard ? 'compact' : 'standard';
}

export class MsxDiskInterface {
  /** 3.5" 1DD/2DD drive behind the card. Status bit 7 is NOT READY (WD2793). */
  readonly fdc = new WD179x({
    statusBit7: 'not-ready',
    formatSectorsPerTrack: 9,
  });

  /** The 16KB Disk BASIC ROM, padded with 0xFF when the image is shorter. */
  private rom = new Uint8Array(MSX_DISK_ROM_SIZE).fill(0xFF);
  private _romLoaded = false;
  private _layout: MsxDiskLayout = 'standard';

  /** Register accesses since the machine last cleared it (activity LED). */
  accesses = 0;

  /** Raw value last written to the drive/side/motor latch. */
  private control = 0;
  private sideLatch = 0;
  /** INTRQ as the host sees it: set when a command completes, dropped by the
   *  next status read or command write. */
  private interrupt = false;

  get romLoaded(): boolean { return this._romLoaded; }
  get layout(): MsxDiskLayout { return this._layout; }
  get romSize(): number { return this._romLoaded ? this.rom.length : 0; }

  /** Install the Disk BASIC ROM. Only the first 16KB is used. */
  loadROM(data: Uint8Array): void {
    this.rom = new Uint8Array(MSX_DISK_ROM_SIZE).fill(0xFF);
    this.rom.set(data.subarray(0, MSX_DISK_ROM_SIZE));
    this._layout = detectLayout(this.rom);
    this._romLoaded = data.length > 0;
  }

  /** Force a register family (tests, and a manual override should a ROM's
   *  constants confuse {@link detectLayout}). */
  setLayout(layout: MsxDiskLayout): void { this._layout = layout; }

  /** Live ROM image (debug / memory viewer). */
  getRom(): Uint8Array { return this.rom; }

  reset(): void {
    this.fdc.reset();
    this.control = 0;
    this.sideLatch = 0;
    this.interrupt = false;
  }

  // ── Latch decode ─────────────────────────────────────────────────────────

  get motorOn(): boolean {
    return this._layout === 'standard'
      ? (this.control & STD_MOTOR) !== 0
      : (this.control & CMP_MOTOR) !== 0;
  }

  /** The controller unit the drive-select lines address. Only units 0 and 1 have
   *  drives; anything else (the standard family's "3", the compact family's
   *  "no bit set") selects nothing, so the chip sees a not-ready drive. */
  get selectedUnit(): number {
    if (this._layout === 'standard') return this.control & STD_DRIVE_MASK;
    if (this.control & 0x01) return 0;
    if (this.control & 0x02) return 1;
    return 3;
  }

  /** The drive (0 = A:, 1 = B:) for LEDs and sound; A: when none is selected. */
  get selectedDrive(): number {
    const unit = this.selectedUnit;
    return unit === 1 ? 1 : 0;
  }

  get selectedSide(): number {
    return this._layout === 'standard' ? this.sideLatch & 1 : (this.control & CMP_SIDE) >> 2;
  }

  // ── Register access ──────────────────────────────────────────────────────

  private get base(): number {
    return this._layout === 'standard' ? STANDARD_BASE : COMPACT_BASE;
  }

  /** Whether `addr` falls in the eight-byte register window rather than the ROM
   *  body. The standard window is the last eight bytes of the 16KB image; the
   *  compact one sits 0x40 lower. Both mirrors (page 1 and page 2) count. */
  isRegister(addr: number): boolean {
    const off = addr & ADDR_MASK;
    const first = this.base & ADDR_MASK;
    return off >= first && off < first + 8;
  }

  /** CPU read of 0x4000–0x7FFF: ROM, except where a register overlays it. */
  read(addr: number): number {
    addr &= 0xFFFF;
    if (this.isRegister(addr)) return this.readRegister((addr & ADDR_MASK) - (this.base & ADDR_MASK));
    return this.rom[addr & ADDR_MASK];
  }

  /** Read without side effects (memory viewer, disassembler, snapshots). */
  peek(addr: number): number {
    addr &= 0xFFFF;
    if (this.isRegister(addr)) return 0xFF;
    return this.rom[addr & ADDR_MASK];
  }

  /** CPU write to 0x4000–0x7FFF: only the register window listens. */
  write(addr: number, value: number): void {
    addr &= 0xFFFF;
    if (!this.isRegister(addr)) return;
    this.writeRegister((addr & ADDR_MASK) - (this.base & ADDR_MASK), value & 0xFF);
  }

  private readRegister(reg: number): number {
    this.accesses++;
    switch (reg) {
      case 0: {
        const status = this.fdc.readStatus();
        this.interrupt = false;
        return status;
      }
      case 1: return this.fdc.readTrack();
      case 2: return this.fdc.readSectorReg();
      case 3: {
        const value = this.fdc.readData();
        this.updateInterrupt();
        return value;
      }
      case 4:
        // Compact layout: the control latch's address doubles as the flag port.
        return this._layout === 'compact' ? this.flags() : 0xFF;
      case 7:
        return this._layout === 'standard' ? this.flags() : 0xFF;
      default:
        return 0xFF;
    }
  }

  private writeRegister(reg: number, value: number): void {
    this.accesses++;
    switch (reg) {
      case 0:
        this.interrupt = false;
        this.fdc.writeCommand(value);
        this.updateInterrupt();
        this.syncMotor();
        break;
      case 1: this.fdc.writeTrack(value); break;
      case 2: this.fdc.writeSectorReg(value); break;
      case 3:
        this.fdc.writeData(value);
        this.updateInterrupt();
        break;
      case 4:
        if (this._layout === 'standard') {
          this.sideLatch = value & 1;
          this.fdc.setSide(this.sideLatch);
        } else {
          this.control = value;
          this.applyControl();
        }
        break;
      case 5:
        if (this._layout === 'standard') {
          this.control = value;
          this.applyControl();
        }
        break;
    }
  }

  private applyControl(): void {
    this.fdc.selectDrive(this.selectedUnit);
    if (this._layout === 'compact') this.fdc.setSide(this.selectedSide);
    this.syncMotor();
  }

  /** The card holds the motor on from its latch; the controller's own
   *  spin-down timer must not turn it off underneath the driver. */
  private syncMotor(): void {
    this.fdc.motorOn = this.motorOn;
  }

  /** DRQ and INTRQ, each driving one bit of the flag port. The standard family
   *  reports both active high; the compact family inverts DRQ (bit 6 clear =
   *  a byte is waiting), as its drivers' transfer loops show. */
  private flags(): number {
    let v = 0x3F;
    if (this.interrupt) v |= STATUS_INTRQ;
    const drqBit = this._layout === 'standard' ? this.fdc.drq : !this.fdc.drq;
    if (drqBit) v |= STATUS_DRQ;
    return v;
  }

  /** INTRQ rises when a command finishes, i.e. the controller is idle with no
   *  byte pending. */
  private updateInterrupt(): void {
    if (this.fdc.intrq && !this.fdc.drq) this.interrupt = true;
  }

  /** Once per emulated frame: age the controller's activity latches. */
  tickFrame(): void {
    this.fdc.tickFrame();
    this.syncMotor();
  }
}
