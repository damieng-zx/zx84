/**
 * Atari 400/800/XL frame probe: status LEDs, drive indicators, the Memory
 * layout pane (which follows the XL's PORTB banking live) and the BASIC
 * listing and variables panes.
 *
 * `sample()` runs every rAF and must not allocate; it copies the machine's
 * frame-scoped counters and the drives' last-access state. `frameTick()` then
 * clears the drives' momentary motor/activity flags. The memory map is
 * pull-on-demand (only while the Banks pane is open) and may allocate freely.
 */

import type {
  FrameIndicators, FramePaneProvider, FrameProbe, MemoryMapSnapshot,
  MemoryMapSlot, TranscribeDriver,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import {
  isAtariBasicRom, parseAtariBasic, parseAtariBasicVariables,
} from '@/basic/atari-basic-parser.ts';
import type { AtariMachine } from '../atari-machine.ts';

function hex(v: number, width: number): string {
  return v.toString(16).toUpperCase().padStart(width, '0');
}

/** The 400/800 shipped with 5.25" drives; the floppy-sound synth profile is 2. */
const DRIVE_PROFILE_5_25 = 2;

/** TEXT overlay: OCR the standard text grid, then blank what it read. */
class AtariTranscribeDriver implements TranscribeDriver {
  constructor(private readonly m: AtariMachine) {}
  get active(): boolean { return this.m.transcribing; }
  activate(): void { this.m.transcribing = true; }
  deactivate(): void { this.m.transcribing = false; }
  run(): { text: string; html: string; grid: OcrGridName } {
    const m = this.m;
    const result = m.ocrScreenStyled();
    if (result.mask.some(Boolean)) {
      m.blankCells(result.mask, result.cols, result.rows);
      if (m.display) m.display.updateTexture(m.pixels);
    }
    return result;
  }
}

export class AtariFrameProbe implements FrameProbe {
  readonly panes: FramePaneProvider;
  readonly transcribe: AtariTranscribeDriver;

  constructor(private readonly m: AtariMachine) {
    this.transcribe = new AtariTranscribeDriver(m);
    this.panes = {
      memoryMap: () => this.memoryMap(),
      basicListing: () => (this.basicResident() ? parseAtariBasic(m.memory.ram) : []),
      basicVars: () => (this.basicResident() ? parseAtariBasicVariables(m.memory.ram) : []),
    };
  }

  /**
   * Whether Atari BASIC is the ROM in the $A000 window, and so owns the
   * zero-page pointers the parsers read: the left cartridge on the 400/800
   * and 1200XL (or an XL with the internal BASIC switched off), or the
   * 600XL/800XL's built-in BASIC while PORTB bit 1 has it enabled. Another
   * cartridge, or none, means no listing.
   */
  private basicResident(): boolean {
    const mem = this.m.memory;
    const cart = mem.cart;
    if (cart !== null && cart.enabled) return cart.type === 'std8' && isAtariBasicRom(cart.image);
    return mem.basicRomEnabled && mem.basicRom !== null && isAtariBasicRom(mem.basicRom);
  }

  sample(out: FrameIndicators): void {
    out.keyboard = this.m.activity.keyPresses;
    out.psg = this.m.activity.psgWrites;
    // Activity, not level: the OS leaves CONSOL bit 3 high at rest, so only
    // a frame in which the speaker moved (a key click, a beep) lights BEEP.
    out.beeper = this.m.activity.speakerToggles > 0 ? 1 : 0;

    // The program recorder has no transport buttons of its own: the computer
    // starts and stops it through the motor line, as with PLAY held down. So
    // the pane shows it playing while a load is under way and never paused,
    // and highlights the file SIO is reading.
    const casReads = this.m.activity.casReads;
    const loading = this.m.tapeLoadingActive;
    out.tapeIn = 0;
    out.tapeLoad = casReads;
    out.tapeTurbo = this.m.tapeTurbo && loading;
    out.tapeLoaded = this.m.cassette.loaded;
    out.tapePlaying = loading;
    out.tapePaused = false;
    out.tapeFinished = this.m.cassette.loaded && this.m.cassette.finished;
    out.tapePosition = 0;
    out.casBlock = casReads > 0 ? this.m.cassette.currentFile() : -1;
    out.tracingActive = this.m.traceActive;

    const drives = this.m.services.disks.states;
    // The pane has four slots; the ones with no drive fitted read as absent.
    for (let slot = drives.length; slot < out.driveLed.length; slot++) {
      out.driveLed[slot] = -1;
      out.driveSector[slot] = -1;
      out.driveTrack[slot] = 0;
      out.driveDirty[slot] = 0;
    }
    let activeSlot = -1;
    for (let slot = 0; slot < drives.length; slot++) {
      const d = drives[slot];
      out.driveLed[slot] = d.disk ? (d.activity !== 0 ? d.activity : 1) : -1;
      out.driveTrack[slot] = d.track;
      out.driveSector[slot] = d.disk ? d.sector : -1;
      out.driveDirty[slot] = d.dirty ? 1 : 0;
      if (d.motorOn) activeSlot = slot;
    }
    out.disk = activeSlot >= 0 ? 1 : 0;
    if (activeSlot >= 0) {
      const d = drives[activeSlot];
      out.floppySlot = activeSlot;
      out.floppyMotor = true;
      out.floppyTrack = d.track;
      out.floppyProfile = DRIVE_PROFILE_5_25;
    } else {
      out.floppySlot = -1;
      out.floppyMotor = false;
      out.floppyProfile = -1;
    }
  }

  frameTick(_out: FrameIndicators): void {
    this.m.services.disks.clearActivity();
  }

  diskImageForSlot(slot: number): DskImage | null {
    return this.m.services.disks.diskImageForSlot(slot);
  }

  private memoryMap(): MemoryMapSnapshot {
    const mem = this.m.memory;
    const cart = mem.cart;
    const slots: MemoryMapSlot[] = [];
    /** RAM if fitted at `top` (exclusive end of the range), else unmapped. */
    const ram = (top: number) => (mem.ramSize >= top ? 'RAM' : 'Unmapped');
    /** A ROM over RAM: reads the ROM, writes are lost (XL with 64K). */
    const overRam = (range: string, rom: string, top: number): MemoryMapSlot =>
      (mem.ramSize >= top ? { range, read: rom, write: 'Ignored (RAM hidden)' } : { range, read: rom });

    const osIn = mem.osRomEnabled;
    if (!mem.xl || osIn) {
      slots.push(overRam('E000-FFFF', 'OS ROM', 0x10000));
      slots.push(overRam('D800-DFFF', 'Floating-point ROM', 0x10000));
    } else {
      slots.push({ range: 'D800-FFFF', read: ram(0x10000) });
    }
    slots.push({ range: 'D500-D7FF', read: 'Unmapped' });
    slots.push({ range: 'D400-D4FF', read: 'ANTIC' });
    slots.push({ range: 'D300-D3FF', read: 'PIA' });
    slots.push({ range: 'D200-D2FF', read: 'POKEY' });
    slots.push({ range: 'D100-D1FF', read: 'Unmapped' });
    slots.push({ range: 'D000-D0FF', read: 'GTIA' });
    if (!mem.xl) slots.push({ range: 'C000-CFFF', read: 'Unmapped' });
    else if (osIn) slots.push(overRam('C000-CFFF', 'OS ROM', 0xD000));
    else slots.push({ range: 'C000-CFFF', read: ram(0xD000) });

    if (cart !== null && cart.base === 0x8000) {
      slots.push({ range: '8000-BFFF', read: 'Cartridge (16K)' });
    } else {
      const a000 = cart?.enabled ? (cart.bankSwitched ? `Cartridge (${cart.type.toUpperCase()})` : 'Cartridge')
        : mem.basicRomEnabled ? 'BASIC ROM' : null;
      slots.push(a000 ? overRam('A000-BFFF', a000, 0xC000) : { range: 'A000-BFFF', read: ram(0xC000) });
      slots.push({ range: '8000-9FFF', read: ram(0xA000) });
    }
    // The 130XE's banked window: the CPU and ANTIC each see the extended
    // bank only when PORTB says so, so the two views can differ.
    const window = mem.cpuExtEnabled || mem.anticExtEnabled
      ? `${mem.cpuExtEnabled ? `Extended RAM bank ${mem.extBank}` : 'RAM'}`
        + `${mem.anticExtEnabled !== mem.cpuExtEnabled
          ? `, ANTIC sees ${mem.anticExtEnabled ? `bank ${mem.extBank}` : 'main RAM'}` : ''}`
      : ram(0x8000);
    if (mem.selfTestRomEnabled) {
      slots.push({ range: '5800-7FFF', read: window });
      slots.push(overRam('5000-57FF', 'Self-test ROM', 0x5800));
      slots.push({ range: '4000-4FFF', read: window });
    } else {
      slots.push({ range: '4000-7FFF', read: window });
    }
    slots.push({ range: '0000-3FFF', read: 'RAM' });

    return {
      slots,
      registers: [
        { name: 'DMACTL', value: hex(this.m.antic.dmactl, 2) },
        { name: 'DLIST', value: hex(this.m.antic.dlist, 4) },
        { name: 'COLBK', value: hex(this.m.gtia.colbk, 2) },
        { name: 'PRIOR', value: hex(this.m.gtia.prior, 2) },
        { name: 'SKCTL', value: hex(this.m.pokey.skctl, 2) },
        ...(mem.xl ? [{ name: 'PORTB', value: hex(mem.portB, 2) }] : []),
      ],
    };
  }
}
