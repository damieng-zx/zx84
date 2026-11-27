/**
 * Commodore Plus/4 motherboard (and, by omission, the Commodore 16).
 *
 * A MOS 7501 at 1.77 MHz (PAL) — a 6502 with an I/O port at `$00`/`$01` —
 * 64K of RAM (a C16 has 16K, mirrored), the KERNAL and BASIC 3.5 in two 16K
 * ROMs, the 7360 TED (`ted.ts`) which is both the video chip and the sound chip
 * and also the bus master, two 6529B PIOs (the user port and the keyboard
 * rows) and, on the Plus/4, a 6551A ACIA on the RS-232 socket.
 *
 * The frame loop runs instruction by instruction. On the first cycle of every
 * raster line the TED takes its fetches (and, on a bad line, holds the CPU off
 * the bus for 88 of the 114 cycles); the picture is drawn a line at a time.
 * Register accesses to the TED, the PIOs and the ACIA are made at the cycle of
 * the instruction they fall on, so timers and interrupt flags land where the
 * beam is.
 *
 * The 7501's port (`$01`) carries the serial bus (ATN bit 7, CLK bit 6, DATA
 * bit 5 out; CLK and DATA back in on the same two bits through the inverters)
 * and the Datasette (bit 4 the read line, bit 3 the motor, bit 1 the write
 * line). PIO 1 bit 2 reads the cassette's PLAY line.
 *
 * Two ROM banks the TED selects (`$FDD0-$FDDF`) supply `$8000-$BFFF` and
 * `$C000-$FFFF`: BASIC and the KERNAL, or the Plus/4's "3+1" function ROMs, or
 * a cartridge. `$FF3F` banks the ROMs out altogether, which is how BASIC gets
 * 60K of RAM.
 */

import { M6502 } from '@/cores/m6502.ts';
import { M6529B } from '@/cores/m6529b.ts';
import { Mc6551 } from '@/cores/mc6551.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { M6502MachineBase } from '@/machines/shared/m6502-machine-base.ts';
import { crc32, type StateReader, type StateWriter } from '@/machines/shared/state-io.ts';
import type { BeamInfo, BeamPos } from '@/debug/beam-log.ts';
import { accessTime } from '@/debug/m6502/bus-cycles.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';
import type { ChipSection } from '@/debug/chip-state.ts';
import type { C64Program } from '@/media/tape/t64.ts';
import { CbmDatasette } from '@/machines/shared/cbm/datasette.ts';
import type { TapeDeck } from '@/media/tape/tap.ts';
import type { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import {
  normalizeDriveModels, type CbmDriveModel, type CbmDriveUnit,
} from '@/machines/shared/cbm/drive/drive-unit.ts';
import { CbmSerialBus, IEC_ATN, IEC_CLK, IEC_DATA } from '@/machines/shared/cbm/serial-bus.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import { plus4RomChipSizes, plus4RomSize, type Plus4Model } from './models.ts';
import { Plus4Memory, type Plus4Expansion } from './memory.ts';
import { Plus4Keyboard } from './keyboard.ts';
import { Ted, type TedBus } from './ted.ts';
import { TedSound } from './ted-sound.ts';
import { plus4Descriptor } from './descriptor.ts';
import { plus4Chips } from './chip-dump.ts';
import { createPlus4Services, type Plus4Services } from './services/index.ts';
import { plus4ScreenText } from './screen-text.ts';
import { plus4OcrGrid } from '@/ocr/plus4.ts';
import type { C64OcrResult } from '@/ocr/c64.ts';
import { PLUS4_PALETTE } from './palette.ts';
import { saveCartridge, loadCartridge, type Plus4Cartridge } from './cartridge.ts';
import { plus4Screen, plus4Timing, type Plus4Timing } from './constants.ts';

/** Joystick directions as the TED's register bits (active high here). */
const JOY_BITS: Readonly<Record<string, number>> = {
  up: 0x01, down: 0x02, left: 0x04, right: 0x08, fire: 0x10,
};

/** BASIC's pointers, set when a program is loaded at the start of BASIC. */
const TXTTAB = 0x2B;
const VARTAB = 0x2D;
const ARYTAB = 0x2F;
const STREND = 0x31;
/** KERNAL's keyboard buffer (the same place as the 64's minus the length byte:
 *  BASIC 3.5 keeps its own). */
const KEYBUF = 0x0527;
const KEYBUF_COUNT = 0x00EF;

/** Where BASIC starts with no graphics area, and with one. */
const BASIC_START = 0x1001;
const BASIC_GRAPHICS_START = 0x4001;

/** Frames after a reset by which BASIC is ready whatever the ROM says. */
const BOOT_FRAMES = 250;
/** Serial bus writes in a frame that mean a file is moving. */
const IEC_BUSY_WRITES = 8;


export class Plus4Machine extends M6502MachineBase implements Machine {
  readonly kind: MachineKind = 'plus4';
  readonly model: Plus4Model;
  host: MachineHost | null = null;
  readonly services: Plus4Services;

  readonly cpu = new M6502();
  readonly memory: Plus4Memory;
  readonly timing: Plus4Timing;
  readonly ted: Ted;
  readonly sound: TedSound;
  /** The user port (Plus/4 only) and the keyboard rows. */
  readonly pio1 = new M6529B();
  readonly pio2 = new M6529B();
  /** The RS-232 interface (Plus/4 only; nothing answers on a C16). */
  readonly acia = new Mc6551();
  readonly keyboard = new Plus4Keyboard();

  /** The serial bus and the disk drives on it: the 7501's port bits. */
  readonly iec = new CbmSerialBus(() => this.serialOut);
  get drives(): readonly CbmDriveUnit[] { return this.iec.drives; }
  get drive(): CbmDriveUnit | null { return this.iec.drive; }
  get driveModels(): readonly CbmDriveModel[] { return this.iec.driveModels; }
  get driveModel(): CbmDriveModel { return this.iec.driveModel; }

  /** The Datasette's tape, played through the shared pulse deck. */
  get tape(): TapeDeck { return this.datasette.tape; }
  /** Edges of the cassette write line since the last reset (what SAVE wrote). */
  get tapeRecorder(): PulseRecorder { return this.datasette.recorder; }

  /** The shared Commodore Datasette: the deck and the whole transport state
   *  machine. This board supplies the cassette lines and the counters. */
  readonly datasette: CbmDatasette;

  readonly mixer: AudioMixer;
  readonly audio = new Audio();
  display: IScreenRenderer | null;
  private readonly _pixels: Uint8Array;
  protected get audioChip(): TedSound { return this.sound; }

  readonly activity = {
    kbdReads: 0, joyReads: 0, soundWrites: 0, tapeEdges: 0, irqReads: 0,
  };

  /** Joystick bits held (active high), port 1 and port 2. */
  private joy1 = 0;
  private joy2 = 0;

  // Tape transport: the shared Commodore Datasette (above) owns the deck and
  // the transport state machine; this board supplies the lines and counters.
  /** This frame's reads of the PLAY sense line and of the TED's IRQ flags,
   *  taken by the datasette at each frame's end (for auto-play and turbo). */
  private senseReads = 0;
  private irqReads = 0;
  /** Writes to the serial bus this frame: a drive sending or taking a file. */
  private iecWrites = 0;

  /** A program waiting for BASIC to be ready before it is put in memory. */
  private pendingProgram: { prog: C64Program; run: boolean } | null = null;
  private framesSinceReset = 0;

  /** A state without its disks (the browser-refresh copy) was restored. */
  refreshResumed = false;

  /** The cycle the chips have been run to. */
  private chipT = 0;

  // Frame-in-progress state (carried over a stop).
  /** Where the instruction last run started, for the bad-line hold. */
  private insnStart = 0;
  private insnOp = -1;
  /** Whether the instruction in progress runs on the halted clock ($FF13 bit 1). */
  private slowNow = false;

  /** The 256K expansion fitted, from the Hardware pane. */
  private expansion: Plus4Expansion = 'none';

  /** Fit (or remove) the 256K expansion; the pane rebuilds the machine. */
  setMemoryExpansion(type: Plus4Expansion): void {
    this.expansion = type;
    this.memory.setExpansion(type);
  }

  get memoryExpansion(): Plus4Expansion { return this.expansion; }

  get tapeTurboActive(): boolean { return this.datasette.turboActive; }

  constructor(model: Plus4Model, display: IScreenRenderer | null = null, ntsc = false) {
    super();
    this.model = model;
    this.display = display;
    this.timing = plus4Timing(ntsc);
    this.memory = new Plus4Memory(model);
    this.ted = new Ted(this.tedBus(), ntsc);
    this.sound = new TedSound(this.ted.regs, this.timing.clockHz);
    this.datasette = new CbmDatasette({
      motor: () => this.motorOn,
      cassetteWrite: () => this.cassetteWrite,
      read: (level) => {
        if (level === 0) this.activity.tapeEdges++;
      },
      takePolls: () => {
        const polls = this.senseReads;
        this.senseReads = 0;
        return polls;
      },
      takeFlagReads: () => {
        const reads = this.irqReads;
        this.irqReads = 0;
        return reads;
      },
      transportChanged: () => this.refreshTapePins(),
      releaseTurbo: () => { this.sound.flush(); this.mixer.reset(); },
      pressedPlay: () => this.setStatus('PLAY pressed on the Datasette'),
    }, this.timing.clockHz);
    this.mixer = new AudioMixer(this.timing.clockHz);
    this._pixels = new Uint8Array(this.ted.pixels.buffer);
    this.mixer.beeperGain = 1;
    this.mixer.psgGain = 1;

    this.cpu.onInterrupt = (vector) => this.noteInterrupt(this.cpu.pc, vector === 0xFFFA);
    this.cpu.read = (addr) => {
      const value = this.memory.readByte(addr);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, value, 'read');
      return value;
    };
    this.cpu.write = (addr, val) => {
      this.memory.writeByte(addr, val);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, val & 0xFF, 'write');
    };
    this.wireIo();
    this.services = createPlus4Services(this);
  }

  /** What the TED needs of this board. */
  private tedBus(): TedBus {
    return {
      read: (addr) => this.memory.readTedByte(addr),
      keyboardColumns: () => {
        // PIO 2's latch selects the lines the TED scans: a set bit is a line
        // being read, and a key down on it pulls its column's bit low.
        return this.keyboard.columnsForSelectedLines(this.pio2.latch);
      },
      joystickBits: () => ({ joy1: this.joy1, joy2: this.joy2 }),
    };
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  /** The cycle a register access of the instruction in progress lands on. */
  private accessT(addr: number, write: boolean): number {
    const t = accessTime(this.insnStart, this.insnOp, this.insnPc, addr, write, false);
    // In 1 MHz mode a CPU cycle is two TED cycles, so an access stamped in CPU
    // cycles lands twice as far from the instruction's start on the master
    // (TED) clock the chips count in.
    return this.slowNow ? this.insnStart + (t - this.insnStart) * 2 : t;
  }

  /** Bring the chips' clocks to cycle `t`. */
  private syncChips(t: number): void {
    if (t <= this.chipT) return;
    this.ted.advanceTo(t);
    this.sound.advanceTo(t);
    this.acia.tick(t);
    this.chipT = t;
  }

  /** The serial lines this machine pulls low, as bits (ATN 1, CLK 2, DATA 4). */
  get serialOut(): number {
    // The port's outputs go through inverters: an output held high pulls the
    // line low.
    const driven = (this.memory.portData & this.memory.portDir) | ~this.memory.portDir;
    return ((driven & 0x80) !== 0 ? IEC_ATN : 0)
      | ((driven & 0x40) !== 0 ? IEC_CLK : 0)
      | ((driven & 0x20) !== 0 ? IEC_DATA : 0);
  }

  /** The cassette write line: bit 1 of the 7501's port as driven. */
  get cassetteWrite(): boolean {
    const driven = (this.memory.portData & this.memory.portDir) | ~this.memory.portDir;
    return (driven & 0x02) !== 0;
  }

  /** The cassette motor: bit 3 of the 7501's port, low = on. */
  get motorOn(): boolean {
    const driven = (this.memory.portData & this.memory.portDir) | ~this.memory.portDir;
    return (driven & 0x08) === 0;
  }

  /** A button is down on the deck. A mounted tape has PLAY down until the user
   *  stops it; an empty deck stands for a blank cassette with RECORD and PLAY
   *  down, so SAVE goes straight to the recorder. This is PIO 1 bit 2 — not the
   *  7501 port's read bit, which carries the tape signal itself. */
  get tapeSense(): boolean { return !this.tape.loaded || this.tape.playing; }

  /** PIO 1's input pins, refreshed whenever the tape transport moves. */
  private refreshTapePins(): void {
    this.pio1.pins = this.tapeSense ? 0xFB : 0xFF;
  }

  private wireIo(): void {
    const { memory, ted, pio1, pio2, keyboard } = this;

    this.pio2.onWrite = () => {
      // A row line changed: the TED's keyboard register follows at once.
      ted.refreshKeyboard();
    };

    // The 7501's port: the serial bus and the cassette.
    memory.onPortRead = () => {
      // The port's input bits: CLK and DATA from the bus (low while anyone
      // pulls them), the cassette read line on bit 4.
      let input = 0xDF;
      if (!this.iec.clkLow) input |= 0x40;
      if (!this.iec.dataLow) input |= 0x80;
      // Bit 4 is the Datasette's read line — the tape's own signal, which the
      // KERNAL's reader waits on for its edges. The PLAY sense is a *steady*
      // deck-button level and lives on PIO 1 bit 2 (see updatePins): putting it
      // here instead left the read line stuck, so every LD-BYTES wait spun.
      // With the motor stopped (or no tape on the deck) there is no signal to
      // read and the port reads it low, as the hardware does.
      const signal = this.tape.playing && !this.tape.paused && this.tape.earBit;
      input = signal ? (input | 0x10) : (input & ~0x10);
      // A port read is what the KERNAL's tape loop spins on: count it.
      this.senseReads++;
      return ((input & ~memory.portDir) | (memory.portData & memory.portDir)) & 0xDF;
    };
    memory.onPortWrite = () => {
      if (this.iec.fitted) { this.syncDrives(this.cpu.tStates); this.iecWrites++; }
      this.cassettePortsChanged(this.cpu.tStates);
      if (this.iec.fitted) this.iec.update();
    };

    memory.ioRead = (addr) => {
      const t = this.accessT(addr, false);
      this.syncChips(t);
      if (addr >= 0xFF00) return ted.read(addr & 0x3F, t);
      switch (addr & 0xFFF0) {
        case 0xFD00: {
          // The 6551A, four registers, mirrored through the page.
          if ((addr & 0x0F) < 4 && this.aciaFitted) return this.acia.read(addr & 3);
          return 0xFF;
        }
        case 0xFD10:
          // A PIO 1 read is what a program polling the keyboard joystick or the
          // cassette's PLAY line does.
          this.senseReads++;
          this.activity.joyReads++;
          return pio1.read(0);
        case 0xFD30: {
          this.activity.kbdReads++;
          keyboard.reads++;
          if ((addr & 0x0F) === 0) this.senseReads++;
          return pio2.read(0);
        }
        case 0xFDD0:
          return 0xFF;      // the bank select is write only
        default:
          return 0xFF;
      }
    };

    memory.ioWrite = (addr, value) => {
      const t = this.accessT(addr, true);
      this.syncChips(t);
      if (addr >= 0xFF00) {
        const reg = addr & 0x3F;
        if (reg >= 0x0E && reg <= 0x12) this.activity.soundWrites++;
        ted.write(reg, value, t);
        if (reg === 0x3E) memory.setRomVisible(true);
        if (reg === 0x3F) memory.setRomVisible(false);
        return;
      }
      // A banked cartridge answers at its own register before the board's I/O.
      if (this._cart?.mapper.writeRegister(addr, value)) return;
      switch (addr & 0xFFF0) {
        case 0xFD00:
          if ((addr & 0x0F) < 4 && this.aciaFitted) this.acia.write(addr & 3, value);
          return;
        case 0xFD10: {
          const bus = this.iec.fitted;
          if (bus) { this.syncDrives(t); this.iecWrites++; }
          pio1.write(0, value);
          this.cassettePortsChanged(t);
          if (bus) this.iec.update();
          return;
        }
        case 0xFD30: {
          const bus = this.iec.fitted;
          if (bus) { this.syncDrives(t); this.iecWrites++; }
          pio2.write(0, value);
          ted.refreshKeyboard();
          if (bus) this.iec.update();
          return;
        }
        case 0xFDD0:
          memory.setBank(addr & 0x0F);
          return;
        default:
          return;
      }
    };

    memory.ioPeek = (addr) => {
      if (addr >= 0xFF00) return ted.peek(addr & 0x3F, this.cpu.tStates);
      switch (addr & 0xFFF0) {
        case 0xFD00: return (addr & 0x0F) < 4 && this.aciaFitted ? this.acia.peek(addr & 3) : 0xFF;
        case 0xFD10: return pio1.peek(0);
        case 0xFD30: return pio2.peek(0);
        default: return 0xFF;
      }
    };
  }

  /** Whether the ACIA answers (the Plus/4 has one, the C16 does not). */
  get aciaFitted(): boolean { return this.model !== 'c16'; }

  /** Set both PIOs' input pins to what the keyboard, joysticks and bus say. */
  private updatePins(_t: number): void {
    // PIO 1: inputs high except the cassette's PLAY line on bit 2.
    this.refreshTapePins();
    // PIO 2 drives the keyboard rows; its inputs float high.
    this.pio2.pins = 0xFF;
  }

  // ── Disk drives ─────────────────────────────────────────────────────────

  /** Bring the drives up to the machine's cycle `t`. */
  private syncDrives(t: number): void {
    if (this.iec.fitted) this.iec.syncTo(t, this.timing.clockHz);
  }

  // ── Datasette ───────────────────────────────────────────────────────────

  /** The 7501 port or a PIO was written at cycle `t`: follow the motor and the
   *  write line. */
  private cassettePortsChanged(t: number): void {
    this.datasette.portsChanged(t);
  }

  /** The tape was mounted, ejected, played or stopped: PLAY follows it, and the
   *  deck runs only while the motor is on. */
  tapeTransportChanged(): void {
    this.datasette.transportChanged(this.cpu.tStates);
  }

  /** Mounting a tape leaves PLAY up; it goes down by itself the first time
   *  software sits waiting for it (PRESS PLAY ON TAPE). */
  armAutoPlay(): void { this.datasette.armAutoPlay(); }

  /** Raise or drop the TED's interrupt line. */
  private updateInterrupts(t: number): void {
    this.syncChips(t);
    this.cpu.setIRQ(this.ted.irq);
  }

  /** Turbo while the KERNAL (or a loader) reads the tape with the motor on, or
   *  saves to the empty deck, or the drive's bus is busy. */
  private updateTapeTurbo(): void {
    // The drive is busy while its motor runs and bytes move under the head.
    let diskBusy = false;
    const busy = this.iecWrites >= IEC_BUSY_WRITES;
    this.iecWrites = 0;
    for (const d of this.drives) if ((d.takeActivity() > 0 || busy) && d.motorOn) diskBusy = true;
    this.datasette.updateTurbo(diskBusy);
  }

  // ── Machine SPI ──────────────────────────────────────────────────────────

  get descriptor(): MachineDescriptor { return plus4Descriptor(this.model, this.timing.ntsc ? 'us' : 'uk'); }
  get pixels(): Uint8Array { return this._pixels; }
  get frameWidth(): number { return this.ted.width; }
  get frameHeight(): number { return this.ted.height; }
  get tStatesPerFrame(): number { return this.timing.cyclesPerFrame; }
  get cpuClockHz(): number { return this.oneMhzMode ? this.timing.clockHz / 2 : this.timing.clockHz; }
  protected override get frameHz(): number { return this.timing.clockHz / this.timing.cyclesPerFrame; }

  /** The TED's $FF13 bit 1 halves the CPU clock; video keeps its own clock. */
  get oneMhzMode(): boolean { return (this.ted.regs[0x13] & 0x02) !== 0; }

  attachHost(host: MachineHost): void { this.host = host; }

  applySettings(view: SettingsView): void {
    this.audio.setVolume(view.get('volume', 70) / 100);
    this.datasette.tapeTurbo = view.get('tape-turbo-load', true);
    this.datasette.tapeSoundEnabled = view.get('tape-sound', true);
    const expansion = view.get<string>('plus4-expansion', 'none');
    this.setMemoryExpansion(expansion === 'hannes' || expansion === 'csory' ? expansion : 'none');
    this.drives.forEach((d, i) => { d.writeProtected = view.get('write-protect-' + 'abcd'[i], false); });
  }

  /** The border is fully rendered; the setting crops it: Normal shows it all,
   *  Small half, None just the display window. */
  setBorderSize(mode: BorderMode): void {
    const s = plus4Screen(this.timing);
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(s.borderLeft * (1 - frac));
    const cropY = Math.round(s.borderTop * (1 - frac));
    this.display?.setViewport(cropX, cropY, s.width - cropX * 2, s.height - cropY * 2);
  }

  /**
   * Install the system ROM: KERNAL, BASIC and (on the Plus/4) the two 3+1
   * function ROMs, in the order the ROM host serves them. An image of just the
   * KERNAL or just BASIC is taken by its size.
   */
  loadROM(data: Uint8Array): void {
    const sizes = plus4RomChipSizes(this.model);
    const whole = plus4RomSize(this.model);
    if (data.length === sizes[0] && sizes.length === 2) {
      // A C16's KERNAL on its own.
      this.memory.loadRoms(data, null, null, null);
    } else if (data.length === sizes[0]) {
      this.memory.loadRoms(data, null, null, null);
    } else {
      let at = 0;
      const part = (i: number): Uint8Array | null => {
        if (at + sizes[i] > data.length) return null;
        const out = data.subarray(at, at + sizes[i]);
        at += sizes[i];
        return out;
      };
      const kernal = part(0);
      const basic = part(1);
      const funcLow = part(2);
      const funcHigh = part(3);
      this.memory.loadRoms(kernal, basic, funcLow, funcHigh);
    }
    this.setStatus(`Plus/4 ROMs loaded (${data.length} of ${whole} bytes)`);
  }

  /** Fit the disk drives and (Plus/4) the ACIA the Hardware pane asks for, and
   *  list the DOS ROMs they need. */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.updatePins(this.cpu.tStates);
    const models = normalizeDriveModels(view.get<unknown>('drive-models:plus4', null));
    this.iec.driveModels = models;
    if (!view.get('plus4-drive', true)) {
      this.iec.unplug();
      return [];
    }
    this.iec.fitDrives(models);
    return this.iec.romRequests('c64-dos');
  }

  reset(): void {
    this.stop();
    this.resetHardware();
    this.resetFrameCount();
    this.setStatus('Reset');
  }

  private resetHardware(): void {
    this.memory.reset();
    this.ted.reset();
    this.sound.reset();
    this.pio1.reset();
    this.pio2.reset();
    // The board wires PIO 2's direction lines as outputs (its eight lines drive
    // the keyboard rows), so the chip is a plain latch there: what the KERNAL
    // writes is what the TED's scan sees. PIO 1's data lines are the user port's,
    // read as pins.
    this.pio2.ddr = 0xFF;
    this.acia.reset();
    this.keyboard.reset();
    this.joy1 = this.joy2 = 0;
    this.cpu.reset();
    this.iec.reset();
    this.midFrame = false;

    this.clearInterrupts();
    this.datasette.reset(this.cpu.tStates);
    this.framesSinceReset = 0;
    this.pendingProgram = null;
    this.refreshResumed = false;
    this.chipT = this.cpu.tStates;
    this.ted.syncClocks(this.cpu.tStates);
    this.sound.reset();
    this.datasette.syncClock(this.cpu.tStates);
    this.updatePins(this.cpu.tStates);
    this.mixer.reset();
    this.audio.reset();
    this.needsDisplay = true;
  }

  // ── Cartridge ────────────────────────────────────────────────────────────

  /** The cartridge on the expansion port, or null. */
  get cartridge(): Plus4Cartridge | null { return this._cart; }
  private _cart: Plus4Cartridge | null = null;
  /** The file the cartridge came from, for the ROM pane. */
  cartridgeFile = '';

  private swapCartridge(change: () => void): void {
    const wasActive = this.running || this.starting;
    this.stop();
    change();
    this.reset();
    if (wasActive) void this.start();
  }

  /** Fit a cartridge's banks, or take it out (null). */
  setCartridge(cart: Plus4Cartridge | null): void {
    this._cart = cart;
    cart?.mapper.reset();
    this.memory.setCartridgeMapper(cart?.mapper ?? null, cart?.low ?? null, cart?.high ?? null);
    if (cart === null) this.cartridgeFile = '';
  }

  mountCartridge(cart: Plus4Cartridge, file: string): void {
    this.swapCartridge(() => { this.setCartridge(cart); this.cartridgeFile = file; });
    this.setStatus(`Cartridge: ${file || cart.name}`);
  }

  ejectCartridge(): void {
    this.swapCartridge(() => this.setCartridge(null));
    this.setStatus('Cartridge ejected');
  }

  // ── Disk drive ───────────────────────────────────────────────────────────

  fitDrives(models: readonly CbmDriveModel[]): void { this.iec.fitDrives(models); }
  installDriveRom(model: CbmDriveModel, rom: Uint8Array): void { this.iec.installDriveRom(model, rom); }
  installDrive(rom: Uint8Array | null, model: CbmDriveModel = this.driveModel): void {
    this.iec.installDrive(rom, model);
  }

  // ── Programs (.prg / .t64) ───────────────────────────────────────────────

  /** Where BASIC starts: `$1001` with no graphics area, `$4001` with one. */
  get basicStart(): number {
    return this.memory.readByte(MEMSIZ_GRAPHICS) !== 0 ? BASIC_GRAPHICS_START : BASIC_START;
  }

  /** Start a program the way LOAD and RUN would on a freshly switched-on
   *  Plus/4: the machine is reset and the program goes into memory once BASIC
   *  is at READY. */
  injectProgram(prog: C64Program, run: boolean): void {
    this.resetHardware();
    this.pendingProgram = { prog, run };
  }

  private basicReady(): boolean {
    if (this.framesSinceReset >= BOOT_FRAMES) return true;
    return this.framesSinceReset >= 10 && /(^|\n)READY\./.test(plus4ScreenText(this.memory, this.ted));
  }

  private applyPendingProgram(): void {
    const pending = this.pendingProgram;
    if (!pending) return;
    this.pendingProgram = null;
    const { prog, run } = pending;
    const mem = this.memory;
    const end = Math.min(0x10000, prog.start + prog.data.length);
    for (let a = prog.start; a < end; a++) mem.ram[a & (mem.ramSize - 1)] = prog.data[a - prog.start];
    const ram = mem.ram;
    if (prog.start === (ram[TXTTAB] | (ram[TXTTAB + 1] << 8)) || prog.start === BASIC_START
        || prog.start === BASIC_GRAPHICS_START) {
      for (const ptr of [VARTAB, ARYTAB, STREND]) {
        ram[ptr] = end & 0xFF;
        ram[ptr + 1] = end >> 8;
      }
      if (run) {
        const keys = [0x52, 0x55, 0x4E, 0x0D];   // R U N <return>
        ram.set(keys, KEYBUF);
        ram[KEYBUF_COUNT] = keys.length;
      }
      this.setStatus(`Loaded "${prog.name}"${run ? ' — RUN' : ''}`);
    } else {
      this.setStatus(`Loaded "${prog.name}" at $${prog.start.toString(16).toUpperCase()} — start it with SYS`);
    }
  }

  // ── Input ────────────────────────────────────────────────────────────────

  /** A joystick direction or fire on control port 1 or 2. */
  joystickPress(dir: string, pressed: boolean, port: 1 | 2): void {
    const bit = JOY_BITS[dir];
    if (!bit) return;
    if (port === 1) this.joy1 = pressed ? this.joy1 | bit : this.joy1 & ~bit;
    else this.joy2 = pressed ? this.joy2 | bit : this.joy2 & ~bit;
    if (pressed) this.activity.joyReads++;
  }

  releaseJoysticks(): void { this.joy1 = this.joy2 = 0; }

  // ── Frame ────────────────────────────────────────────────────────────────

  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo || this.datasette.turboActive; }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1 || this.datasette.turboActive;
    this.sound.audible = !skipAudio;
    if (!this.openFrame(this.timing.cyclesPerFrame)) {
      this.activity.kbdReads = 0;
      this.activity.joyReads = 0;
      this.activity.soundWrites = 0;
      this.activity.tapeEdges = 0;
      this.activity.irqReads = 0;
      this.keyboard.reads = 0;
      this.ted.beginFrame(this.frameStartT);
    }
    this.memWatchHit = null;
    const cpu = this.cpu;
    const endT = this.frameEndT;

    while (cpu.tStates < endT) {
      // The chip catches up to the CPU: it fetches and draws the lines passed,
      // and a bad line holds the CPU off the bus for 88 of its 114 cycles.
      const free = this.ted.drawTo(cpu.tStates);
      if (free > cpu.tStates) cpu.tStates = free;
      if (this.checkStops(cpu.pc)) {
        this.midFrame = true;
        this.ted.drawTo(cpu.tStates);
        this.needsDisplay = true;
        return;
      }
      const before = cpu.tStates;
      const pc = cpu.pc;
      this.beforeInsn(pc);
      this.insnStart = before;
      this.insnOp = cpu.interruptPending() ? -1 : this.memory.peekByte(pc);
      this.slowNow = this.oneMhzMode;
      cpu.step();
      // The TED keeps the 1.77 MHz clock; with $FF13 bit 1 the CPU's cycles are
      // half as long, so charge each one twice on the master clock.
      if (this.slowNow) cpu.tStates = before + (cpu.tStates - before) * 2;
      const stopped = this.afterInsn();
      this.datasette.step(cpu.tStates);
      this.updateInterrupts(cpu.tStates);
      if (!skipAudio) {
        this.mixer.accumulateLevel(this.datasette.audioLevel(), cpu.tStates - before);
        this.mixer.generateSamples(this.audio, this.sound, true);
      }
      if (stopped) {
        this.midFrame = true;
        this.ted.drawTo(cpu.tStates);
        this.needsDisplay = true;
        return;
      }
    }

    this.ted.drawTo(endT);
    this.syncChips(cpu.tStates);
    this.syncDrives(cpu.tStates);
    this.framesSinceReset++;
    if (this.pendingProgram && this.basicReady()) this.applyPendingProgram();
    if (skipAudio) this.sound.advanceTo(cpu.tStates);
    this.datasette.checkAutoPlay(cpu.tStates);
    this.updateTapeTurbo();
    this.needsDisplay = true;
  }


  // ── Beam / debug ─────────────────────────────────────────────────────────

  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: this.timing.cyclesPerLine,
      linesPerFrame: this.timing.linesPerFrame,
      displayStart: 0,
      note: `line 0 is raster line 0 and cycle 0 of a line is the TED's cycle 1, where the raster counter moves on and the raster compare interrupt is raised; a bad line holds the CPU from cycle 4 to 92 (43 fetches + 3, doubled). The display window is 25 rows of 8 lines from raster line 4`,
    };
  }
  /** No opcode is fetched from I/O, where a read has side effects. */
  protected override peekOpcode(addr: number): number {
    if (addr >= 0xFF00 && addr < 0xFF40) return -1;
    if (addr >= 0xFD00 && addr < 0xFE00) return -1;
    return this.memory.peekByte(addr);
  }

  protected override tracer = new M6502Trace(this, { io: [[0xFD00, 0xFDFF], [0xFF00, 0xFF3F]], ioLabel: plus4IoLabel });

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: `${this.model}-ram-64k.bin` };
  }

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    switch (value) {
      case 'rom-bottom': return { data: this.memory.basic, baseAddr: 0x8000 };
      case 'rom-top': return { data: this.memory.kernal, baseAddr: 0xC000 };
      case 'rom-func-low': return { data: this.memory.funcLow, baseAddr: 0x8000 };
      case 'rom-func-high': return { data: this.memory.funcHigh, baseAddr: 0xC000 };
      case 'rom-cart-low': return this.memory.cartFitted ? { data: this.memory.cartLow, baseAddr: 0x8000 } : null;
      case 'rom-cart-high': return this.memory.cartFitted ? { data: this.memory.cartHigh, baseAddr: 0xC000 } : null;
      case 'colour-ram': return { data: this.memory.ram.subarray(this.ted.colourAddress, this.ted.colourAddress + 0x400), baseAddr: this.ted.colourAddress };
      default: return null;
    }
  }

  /** The chips, for the debugger's `chip_state`. */
  chips(): readonly ChipSection[] { return plus4Chips(this); }

  /** The text screen as the TED shows it. */
  ocrScreenForMcp(_mode?: string): string {
    return plus4ScreenText(this.memory, this.ted);
  }

  /** The 40×25 TEXT-overlay grid over the character screen. */
  ocrScreenStyled(): C64OcrResult {
    const mem = this.memory;
    return plus4OcrGrid({
      charAddress: this.ted.charAddress,
      screenAddress: this.ted.screenAddress,
      colourAddress: this.ted.colourAddress,
      bitmapAddress: this.ted.bitmapAddress,
      palette: PLUS4_PALETTE,
      mode: this.ted.videoMode,
      reverse: this.ted.reverseMode,
      background: this.ted.background,
      read: a => mem.readTedByte(a & 0xFFFF),
    });
  }

  /** Where the character screen sits in the frame buffer. */
  get textField(): { x: number; y: number; width: number; height: number } {
    return {
      x: this.ted.fieldX + (this.ted.narrow ? 7 : 0) + this.ted.xscroll,
      y: this.ted.fieldY,
      width: 40 * 8,
      height: 25 * 8,
    };
  }

  /** Paint the overlay's matched cells out of the frame, each in its `paper`. */
  blankCells(mask: readonly boolean[], paper: readonly number[]): void {
    const px = this.ted.pixels;
    const field = this.textField;
    for (let row = 0; row < 25; row++) {
      for (let col = 0; col < 40; col++) {
        const i = row * 40 + col;
        if (!mask[i]) continue;
        const colour = PLUS4_PALETTE[paper[i] & 0x7F];
        for (let y = 0; y < 8; y++) {
          const base = (field.y + row * 8 + y) * this.ted.width + field.x + col * 8;
          px.fill(colour, base, base + 8);
        }
      }
    }
  }

  // ── Snapshots (.plus4state) ──────────────────────────────────────────────

  /** CRC-32s of the KERNAL, BASIC and the 3+1 ROMs. */
  stateRomCrcs(): number[] {
    const out = [crc32(this.memory.kernal), crc32(this.memory.basic)];
    if (this.model !== 'c16') out.push(crc32(this.memory.funcLow), crc32(this.memory.funcHigh));
    return out;
  }

  /** The machine's state between frames. The tape is not part of it. */
  saveState(w: StateWriter, withMedia: boolean): void {
    this.completeFrame();
    w.section('TV  ', () => w.bool(this.timing.ntsc));
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameStartT); w.f64(this.frameEndT); w.f64(this.frameNumber);
    });
    w.section('CART', () => saveCartridge(w, this._cart));
    w.section('MEM ', () => this.memory.saveState(w));
    w.section('TED ', () => this.ted.saveState(w));
    w.section('SND ', () => this.sound.saveState(w));
    w.section('PIO1', () => this.pio1.saveState(w));
    w.section('PIO2', () => this.pio2.saveState(w));
    w.section('ACIA', () => this.acia.saveState(w));
    this.iec.saveState(w, withMedia);
  }

  loadState(r: StateReader): void {
    // States from before NTSC existed carry no TV section: they are PAL.
    const ntsc = r.section('TV  ').bool();
    if (ntsc !== this.timing.ntsc) {
      throw new Error(`This is a ${ntsc ? 'NTSC' : 'PAL'} snapshot: choose the ${ntsc ? 'NTSC' : 'PAL'} machine first`);
    }
    this.cpu.loadState(r.section('CPU '));
    {
      const s = r.section('MACH');
      this.frameStartT = s.f64(); this.frameEndT = s.f64(); this.frameNumber = s.f64();
    }
    if (r.peekSection('CART')) {
      const cart = loadCartridge(r.section('CART'));
      if (cart || this._cart) this.setCartridge(cart);
      this.cartridgeFile = '';
    }
    this.memory.loadState(r.section('MEM '));
    this.ted.loadState(r.section('TED '));
    this.sound.loadState(r.section('SND '));
    this.pio1.loadState(r.section('PIO1'));
    this.pio2.loadState(r.section('PIO2'));
    this.acia.loadState(r.section('ACIA'));
    const withMedia = this.iec.loadState(r);
    this.midFrame = false;

    this.clearInterrupts();
    this.keyboard.reset();
    this.joy1 = this.joy2 = 0;
    this.framesSinceReset = BOOT_FRAMES;
    this.datasette.resync(this.cpu.tStates);
    this.chipT = this.cpu.tStates;
    this.ted.syncClocks(this.cpu.tStates);
    this.sound.syncClocks(this.cpu.tStates);
    this.audio.reset();
    this.mixer.reset();
    this.refreshResumed = !withMedia;
    this.needsDisplay = true;
  }
}

/** BASIC's "graphics area reserved" flag: nonzero while a bitmap is set aside. */
const MEMSIZ_GRAPHICS = 0x0075;

/** Trace labels for the I/O pages. */
function plus4IoLabel(addr: number): string {
  if (addr >= 0xFF00) {
    if (addr < 0xFF0E) return 'TED';
    if (addr < 0xFF13) return 'TEDSND';
    if (addr < 0xFF40) return 'TED';
    return 'IO';
  }
  switch (addr & 0xFFF0) {
    case 0xFD00: return 'ACIA';
    case 0xFD10: return 'PIO1';
    case 0xFD30: return 'PIO2';
    default: return 'IO';
  }
}
