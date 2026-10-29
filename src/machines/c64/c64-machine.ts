/**
 * Commodore 64 motherboard (PAL).
 *
 * A 6510 (a 6502 with an I/O port at $00/$01) at 985 kHz, 64K of RAM, the
 * BASIC, KERNAL and character ROMs, the PLA that banks them (see
 * `memory.ts`), the 6569 VIC-II (`vic-ii.ts`), the 6581 SID, and two 6526
 * CIAs: CIA 1 scans the keyboard and joysticks, reads the cassette (its FLAG
 * input) and interrupts the CPU on IRQ; CIA 2 picks the VIC-II's bank, talks
 * to the serial bus and interrupts on NMI, wired-OR with the RESTORE key.
 *
 * The frame loop runs line by line, stopping at the cycles where the VIC-II
 * does its per-line work (`EV_*` in vic-ii.ts). Before each instruction the
 * CPU waits out any cycles the VIC-II holds the bus for (bad lines, sprite
 * DMA); an instruction overtaken by a hold part-way is stretched by it.
 * Register accesses to the VIC-II, SID and CIAs are made at the cycle of the
 * instruction they fall on (`accessTime`), so timers read and the picture
 * changes where the beam is.
 *
 * The Datasette: the port's bit 5 drives the motor (low = on), bit 4 senses
 * PLAY and bit 3 is the write line. A mounted tape counts as PLAY pressed;
 * the motor moves it. Its read line's falling edges set CIA 1's FLAG.
 */

import { M6502 } from '@/cores/m6502.ts';
import { Mos6526 } from '@/cores/mos6526.ts';
import { Mos6581 } from '@/cores/mos6581.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { crc32, type StateReader, type StateWriter } from '@/machines/shared/state-io.ts';
import { withStopsDisarmed } from '@/machines/shared/native-state.ts';
import { m6502ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { accessTime, isReadModifyWrite } from '@/debug/m6502/bus-cycles.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import type { C64Program } from '@/media/tape/t64.ts';
import type { ChipSection } from '@/debug/chip-state.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import { C64_DRIVE_ROM_SOURCES, type C64Model } from './models.ts';
import { C64Memory } from './memory.ts';
import { C64Keyboard } from './keyboard.ts';
import {
  EV_SPRITE_DMA, EV_SPRITE_MCB, EV_VC, VicII,
} from './vic-ii.ts';
import { c64Descriptor } from './descriptor.ts';
import { c64Chips } from './chip-dump.ts';
import { parseCrt, type C64Cartridge } from './cartridge.ts';
import { createC64Services, type C64Services } from './services/index.ts';
import { c64ScreenText } from './screen-text.ts';
import { c64OcrGrid, type C64OcrResult } from '@/ocr/c64.ts';
import { Drive1541 } from './drive/drive-1541.ts';
import { Drive1581 } from './drive/drive-1581.ts';
import {
  C64_MAX_DRIVES, isC64DriveModel, normalizeDriveModels, type C64DriveModel, type C64DriveUnit,
} from './drive/drive-unit.ts';
import { C64_PALETTE } from './palette.ts';
import {
  C64_ACTIVE_HEIGHT, C64_ACTIVE_WIDTH, C64_BASIC_SIZE, C64_BORDER_LEFT, C64_CHARGEN_SIZE,
  C64_KERNAL_SIZE, C64_SCREEN_WIDTH, c64Timing, type C64Timing,
} from './constants.ts';

/** Indices into the line's events (see `lineEvents`), in the order they fall. */
const EVT_VC = 0;
const EVT_SPRITE_MCB = 1;
const EVT_SPRITE_DMA = 2;
const EVT_LINE_END = 3;

/** Joystick directions as CIA port bits (active low on the port). */
const JOY_BITS: Readonly<Record<string, number>> = {
  up: 0x01, down: 0x02, left: 0x04, right: 0x08, fire: 0x10,
};

/** The KERNAL's wait for a key in BASIC's direct mode (901227-02 and -03):
 *  reaching it means the machine has finished starting and is at READY. */
const KERNAL_KEY_WAIT_START = 0xE5CD;
const KERNAL_KEY_WAIT_END = 0xE5D5;
/** Frames after a reset by which BASIC is ready whatever the KERNAL. */
const BOOT_FRAMES = 200;
/** Serial bus writes in a frame that mean a file is moving (a byte is dozens). */
const IEC_BUSY_WRITES = 8;
/** Frames of quiet before tape turbo lets go. */
const TAPE_TURBO_COOLDOWN = 25;
/** Reads of the 6510 port in a frame that mean a program is polling the
 *  cassette sense line (the KERNAL's IRQ reads it about once a frame). */
const AUTO_PLAY_POLLS = 100;
/** Reads of CIA 1's interrupt flags in a frame that mean the tape is being
 *  read: every pulse is an interrupt (or a poll), where the KERNAL's jiffy
 *  IRQ alone reads it about once a frame. */
const TURBO_ICR_READS = 10;

/** BASIC's pointers set when a program is loaded at the start of BASIC. */
const TXTTAB = 0x2B;
const VARTAB = 0x2D;
const ARYTAB = 0x2F;
const STREND = 0x31;
const KEYBUF = 0x0277;
const KEYBUF_COUNT = 0xC6;
const BASIC_START = 0x0801;

export class C64Machine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'c64';
  readonly model: C64Model;
  host: MachineHost | null = null;
  readonly services: C64Services;

  readonly cpu = new M6502();
  readonly memory = new C64Memory();
  readonly vic: VicII;
  /** PAL or NTSC: the clock, the line and frame, the visible lines. */
  readonly timing: C64Timing;
  readonly sid: Mos6581;
  readonly cia1 = new Mos6526();
  readonly cia2 = new Mos6526();
  readonly keyboard = new C64Keyboard();
  /** The disk drives on the serial bus, device 8 first; none while unplugged. */
  drives: C64DriveUnit[] = [];
  /** The first drive (device 8), or null when none is fitted. */
  get drive(): C64DriveUnit | null { return this.drives[0] ?? null; }
  /** The drives the Drives pane has set up, one model each: what the next build fits. */
  driveModels: C64DriveModel[] = ['1541'];
  /** The model of the first drive in that setup. */
  get driveModel(): C64DriveModel { return this.driveModels[0] ?? '1541'; }
  /** The Datasette's tape, played through the shared pulse deck. */
  readonly tape: TapeDeck;
  /** Edges of the cassette write line since the last reset (what SAVE wrote). */
  readonly tapeRecorder = new PulseRecorder();

  readonly mixer: AudioMixer;
  readonly audio = new Audio();
  display: IScreenRenderer | null;
  private readonly _pixels: Uint8Array;

  readonly activity = { kbdReads: 0, sidWrites: 0, tapeEdges: 0, joyReads: 0 };

  /** Joystick bits held (active high here), port 1 and port 2. */
  private joy1 = 0;
  private joy2 = 0;

  /** The 1351 mouse: the control port it is plugged into (0 = none), its two
   *  6-bit position counters (what the SID's POT lines read) and its buttons
   *  (bit 0 left, bit 1 right). */
  private mousePort: 0 | 1 | 2 = 0;
  private mouseX = 0;
  private mouseY = 0;
  private mouseButtons = 0;

  // Tape transport.
  tapeTurbo = true;
  private _tapeTurboActive = false;
  private tapeTurboCooldown = 0;
  private tapeLastT = 0;
  private prevEar = 0;
  private motorWasOn = false;
  private autoPlayArmed = false;
  /** CIA 1 interrupt-flag reads this frame, and the recorder's length at
   *  the last frame's end (for the turbo). */
  private icrReads = 0;
  /** Writes to the serial bus this frame: a drive sending or taking a file. */
  private iecWrites = 0;
  private recordedAtFrame = 0;

  // NMI is edge-triggered from the wired-OR of CIA 2 and RESTORE.
  private nmiLevel = false;

  // Frame-in-progress state (carried over a stop).
  private fLine = 0;
  private fEvent = 0;
  private lineLive = false;
  /** Where the instruction last run started, for stretching it over a hold
   *  registered at an event it had already overrun. */
  private lastInsnStart = 0;
  private insnStart = 0;
  private insnOp = -1;
  /** The instruction in progress is a read-modify-write, and the I/O
   *  address it read (-1 for none) with the value it got. */
  private insnRmw = false;
  private rmwAddr = -1;
  private rmwValue = 0;
  private audioLastT = 0;

  /** A program waiting for BASIC to be ready before it is put in memory. */
  private pendingProgram: { prog: C64Program; run: boolean } | null = null;
  private framesSinceReset = 0;

  /** A state without its disks (the browser-refresh copy) was restored: the
   *  shell then puts the persisted disk back, which must not look like a disk
   *  change to the drive. Cleared by any reset. */
  refreshResumed = false;

  get tapeTurboActive(): boolean { return this._tapeTurboActive; }

  /** The line cycles at which the frame loop hands over to the VIC-II, in order. */
  private readonly lineEvents: readonly number[];

  constructor(model: C64Model, display: IScreenRenderer | null = null, ntsc = false) {
    super();
    this.model = model;
    this.display = display;
    this.timing = c64Timing(ntsc);
    this.sid = new Mos6581(this.timing.clockHz);
    this.tape = new TapeDeck(this.timing.clockHz);
    this.mixer = new AudioMixer(this.timing.clockHz);
    this.lineEvents = [EV_VC, EV_SPRITE_MCB, EV_SPRITE_DMA, this.timing.lineEndCycle, this.timing.cyclesPerLine];
    this.vic = new VicII(this.memory, this.timing);
    this._pixels = new Uint8Array(this.vic.pixels.buffer);
    this.tape.pulseScale = this.timing.clockHz / TAPE_REF_HZ;
    this.mixer.beeperGain = 0;
    this.mixer.psgGain = 1;
    this.deferAccessStamps = true;

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
    this.services = createC64Services(this);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  /** The cycle a register access of the instruction in progress lands on. */
  private accessT(addr: number, write: boolean): number {
    return accessTime(this.insnStart, this.insnOp, this.insnPc, addr, write, false);
  }

  private wireIo(): void {
    const { memory, vic, sid, cia1, cia2, keyboard } = this;

    cia1.portAIn = (driven) => {
      const joy = this.joyBits(2);
      if (joy !== 0) this.activity.joyReads++;
      return driven & ~joy & keyboard.columnsFor(cia1.drivenB & ~this.joyBits(1));
    };
    cia1.portBIn = (driven) => {
      this.activity.kbdReads++;
      return driven & ~this.joyBits(1) & keyboard.rowsFor(cia1.drivenA & ~this.joyBits(2));
    };
    // The paddle lines of the control port CIA 1 port A bits 6-7 select
    // (bit 6 port 1, bit 7 port 2) go to the SID; a 1351 answers on its own.
    sid.potRead = (axis) => {
      const sel = cia1.drivenA & 0xC0;
      const selected = sel === 0x40 ? 1 : sel === 0x80 ? 2 : 0;
      if (this.mousePort === 0 || selected !== this.mousePort) return 0xFF;
      return ((axis === 0 ? this.mouseX : this.mouseY) & 0x3F) << 1;
    };
    // CIA 2 port A: VIC bank (bits 0-1), serial bus outputs through
    // inverters (ATN 3, CLK 4, DATA 5) and inputs (CLK 6, DATA 7). A line is
    // low while the 64 or any drive pulls it.
    cia2.portAIn = (driven) => {
      const clkLow = (driven & 0x10) !== 0 || this.drives.some(d => d.clkAsserted);
      const dataLow = (driven & 0x20) !== 0 || this.drives.some(d => d.dataAsserted);
      return (driven & 0x3F) | (clkLow ? 0 : 0x40) | (dataLow ? 0 : 0x80);
    };
    cia2.onPortWrite = (port) => {
      if (port !== 0) return;
      const bank = (~cia2.drivenA) & 3;
      if ((bank << 14) !== memory.vicBase) {
        vic.drawTo(this.cpu.tStates);
        memory.setVicBank(bank);
      }
    };
    memory.setVicBank((~cia2.drivenA) & 3);

    const ioRead = (addr: number): number => {
      switch ((addr >> 8) & 0x0F) {
        case 0x0: case 0x1: case 0x2: case 0x3: {
          const r = addr & 0x3F;
          if (r === 0x1E || r === 0x1F) vic.drawTo(this.accessT(addr, false));
          return vic.read(addr);
        }
        case 0x4: case 0x5: case 0x6: case 0x7:
          sid.advanceTo(this.accessT(addr, false));
          return sid.read(addr);
        case 0x8: case 0x9: case 0xA: case 0xB:
          return (memory.colorRam[addr & 0x3FF] & 0x0F) | (vic.read(0x12) & 0xF0);
        case 0xC:
          cia1.advanceTo(this.accessT(addr, false));
          if ((addr & 0x0F) === 0x0D) this.icrReads++;
          return cia1.read(addr);
        case 0xD: {
          const t = this.accessT(addr, false);
          cia2.advanceTo(t);
          if (this.drives.length > 0 && (addr & 0x0F) === 0) this.syncDrive(t);
          return cia2.read(addr);
        }
        case 0xE: return memory.cart ? memory.cart.io1Read(addr) : 0xFF;
        default: return memory.cart ? memory.cart.io2Read(addr) : 0xFF;
      }
    };
    memory.ioRead = (addr) => {
      const value = ioRead(addr);
      if (this.insnRmw) { this.rmwAddr = addr; this.rmwValue = value; }
      return value;
    };
    memory.ioPeek = (addr) => {
      switch ((addr >> 8) & 0x0F) {
        case 0x0: case 0x1: case 0x2: case 0x3: return vic.peek(addr);
        case 0x4: case 0x5: case 0x6: case 0x7: return sid.peek(addr);
        case 0x8: case 0x9: case 0xA: case 0xB: return memory.colorRam[addr & 0x3FF] & 0x0F;
        case 0xC: return cia1.peek(addr);
        case 0xD: return cia2.peek(addr);
        default: return 0xFF;      // the cartridge's registers are not looked at
      }
    };
    const ioWrite = (addr: number, value: number, t: number): void => {
      switch ((addr >> 8) & 0x0F) {
        case 0x0: case 0x1: case 0x2: case 0x3:
          vic.write(addr, value, t);
          break;
        case 0x4: case 0x5: case 0x6: case 0x7:
          sid.advanceTo(t);
          sid.write(addr, value);
          this.activity.sidWrites++;
          break;
        case 0x8: case 0x9: case 0xA: case 0xB:
          memory.colorRam[addr & 0x3FF] = value & 0x0F;
          break;
        case 0xC:
          cia1.advanceTo(t);
          cia1.write(addr, value);
          break;
        case 0xD: {
          cia2.advanceTo(t);
          const bus = this.drives.length > 0 && ((addr & 0x0F) === 0 || (addr & 0x0F) === 2);
          if (bus) { this.syncDrive(t); this.iecWrites++; }
          cia2.write(addr, value);
          if (bus) this.updateIecLines();
          break;
        }
        case 0xE: memory.cart?.io1Write(addr, value); break;
        default: memory.cart?.io2Write(addr, value); break;
      }
    };
    memory.ioWrite = (addr, value) => {
      const t = this.accessT(addr, true);
      // An NMOS read-modify-write writes the byte it read straight back, a
      // cycle before the new one. Programs lean on it: INC/ASL $D019 clears
      // the VIC-II's interrupt flags with that first write, not the second.
      if (this.insnRmw && addr === this.rmwAddr) ioWrite(addr, this.rmwValue, t - 1);
      ioWrite(addr, value, t);
    };
    memory.onPortChange = () => this.portChanged();
  }

  /** The 6510 port changed: follow the motor and the write line. */
  private portChanged(): void {
    const motor = this.memory.motorOn;
    if (motor !== this.motorWasOn) {
      this.motorWasOn = motor;
      if (this.tape.loaded && this.tape.playing) {
        if (motor) this.tapeLastT = this.cpu.tStates;
        this.tape.paused = !motor;
      }
    }
    if (motor) this.tapeRecorder.observe(this.memory.cassetteWrite ? 1 : 0, this.cpu.tStates);
  }

  // ── Machine SPI ──────────────────────────────────────────────────────────

  get descriptor(): MachineDescriptor { return c64Descriptor(this.model, this.timing.ntsc ? 'us' : 'uk'); }
  get pixels(): Uint8Array { return this._pixels; }
  get frameWidth(): number { return C64_SCREEN_WIDTH; }
  get frameHeight(): number { return this.timing.screenHeight; }
  get tStatesPerFrame(): number { return this.timing.cyclesPerFrame; }
  get cpuClockHz(): number { return this.timing.clockHz; }
  protected override get frameHz(): number { return this.timing.clockHz / this.timing.cyclesPerFrame; }

  attachHost(host: MachineHost): void { this.host = host; }

  applySettings(view: SettingsView): void {
    this.audio.setVolume(view.get('volume', 70) / 100);
    this.tapeTurbo = view.get('tape-turbo-load', true);
    this.sid.setModel(view.get<string>('c64-sid', '6581') === '8580' ? '8580' : '6581');
    this.drives.forEach((d, i) => { d.writeProtected = view.get('write-protect-' + 'abcd'[i], false); });
  }

  /** The border is fully rendered; the setting crops it: Normal shows it
   *  all, Small half, None just the display window. */
  setBorderSize(mode: BorderMode): void {
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(C64_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(this.timing.borderTop * (1 - frac));
    this.display?.setViewport(cropX, cropY, C64_SCREEN_WIDTH - cropX * 2, this.timing.screenHeight - cropY * 2);
  }

  /**
   * Install the system ROM: BASIC, KERNAL and the character ROM end to end,
   * as the ROM host serves them. An 8K image on its own replaces just the
   * KERNAL (JiffyDOS and the like), and 16K is BASIC and KERNAL.
   */
  loadROM(data: Uint8Array): void {
    if (data.length === C64_KERNAL_SIZE) {
      this.memory.loadRoms(null, data, null);
    } else {
      const kernalAt = C64_BASIC_SIZE;
      const charAt = kernalAt + C64_KERNAL_SIZE;
      this.memory.loadRoms(
        data.subarray(0, C64_BASIC_SIZE),
        data.length >= charAt ? data.subarray(kernalAt, charAt) : null,
        data.length >= charAt + C64_CHARGEN_SIZE ? data.subarray(charAt, charAt + C64_CHARGEN_SIZE) : null,
      );
    }
    this.setStatus(`C64 ROMs loaded (${data.length} bytes)`);
  }

  reset(): void {
    this.stop();
    this.resetHardware(true);
    this.resetFrameCount();
    this.setStatus('Reset');
  }

  private resetHardware(power: boolean): void {
    if (power) this.memory.reset();
    this.memory.cassetteSense = this.tapeSense;
    this.vic.reset();
    this.sid.reset();
    this.cia1.reset();
    this.cia2.reset();
    this.memory.setVicBank((~this.cia2.drivenA) & 3);
    this.keyboard.reset();
    this.joy1 = this.joy2 = 0;
    this.cpu.reset();
    // The cartridge starts over with the clock it keeps time by.
    if (power) this.memory.resetCartridge();
    if (this.drives.length > 0) { for (const d of this.drives) d.reset(); this.updateIecLines(); }
    this.nmiLevel = false;
    this.midFrame = false;
    this.fLine = 0;
    this.fEvent = 0;
    this.lineLive = false;
    this.clearInterrupts();
    this.tapeRecorder.reset();
    this.recordedAtFrame = 0;
    this.motorWasOn = false;
    if (this.tape.loaded) this.tape.paused = true;
    this._tapeTurboActive = false;
    this.tapeTurboCooldown = 0;
    this.framesSinceReset = 0;
    this.pendingProgram = null;
    this.refreshResumed = false;
    this.syncChipClocks();
    this.mixer.reset();
    this.audio.reset();
    this.needsDisplay = true;
  }

  // ── Cartridge ────────────────────────────────────────────────────────────

  /** The cartridge on the expansion port, or null. */
  get cartridge(): C64Cartridge | null { return this.memory.cart; }

  /** Change what is on the expansion port the way a person must: with the
   *  power off, so the machine starts over with it. */
  swapCartridge(change: () => void): void {
    const wasActive = this.running || this.starting;
    this.stop();
    change();
    this.reset();
    if (wasActive) void this.start();
  }

  /** Fit a cartridge (null takes it off). */
  setCartridge(cart: C64Cartridge | null): void {
    this.memory.setCartridge(cart, () => this.cpu.tStates);
    if (cart === null) this.cartridgeFile = '';
  }

  /** The file the cartridge came from, for the ROM pane ('' when it came
   *  with a snapshot). */
  cartridgeFile = '';

  /** Plug a cartridge in and start over with it. */
  mountCartridge(cart: C64Cartridge, file: string): void {
    this.swapCartridge(() => { this.setCartridge(cart); this.cartridgeFile = file; });
    this.setStatus(`Cartridge: ${file || cart.name}`);
  }

  /** Take the cartridge out and start over without it. */
  ejectCartridge(): void {
    this.swapCartridge(() => this.setCartridge(null));
    this.setStatus('Cartridge ejected');
  }

  // ── Disk drive ───────────────────────────────────────────────────────────

  private makeDrive(model: C64DriveModel): C64DriveUnit {
    return model === '1581' ? new Drive1581() : new Drive1541();
  }

  /** Give each drive the device number its place dictates. A drive that moved
   *  starts over (the DOS reads its jumpers at power-on); write protect belongs
   *  to the place, as the pane's switch does, not to the drive that sits there. */
  private renumberDrives(protect: readonly boolean[]): void {
    this.drives.forEach((d, i) => {
      const moved = d.unit !== i;
      d.unit = i;
      const want = protect[i] ?? false;
      if (d.writeProtected !== want) d.setWriteProtect(want);
      if (moved && d.hasRom) d.reset();
    });
    this.driveModels = this.drives.map(d => d.model);
    this.updateIecLines();
  }

  /** Fit these drives, device 8 first. A drive already in its place keeps its
   *  disk if the model is the same; the others are new and empty. */
  fitDrives(models: readonly C64DriveModel[]): void {
    const old = this.drives;
    this.drives = models.map((model, i) => {
      const drive = old[i]?.model === model ? old[i] : this.makeDrive(model);
      drive.unit = i;
      return drive;
    });
    if (models.length > 0) this.driveModels = [...models];
    this.updateIecLines();
  }

  /** Put the DOS ROM in every drive of that model. */
  installDriveRom(model: C64DriveModel, rom: Uint8Array): void {
    for (const d of this.drives) if (d.model === model) d.loadRom(rom);
    this.updateIecLines();
  }

  /** Fit a drive running the DOS in `rom` (the 16K image of a 1541, the 32K
   *  of a 1581), or take every drive off the bus (null). With no drive of that
   *  model fitted yet, it becomes the one drive. */
  installDrive(rom: Uint8Array | null, model: C64DriveModel = this.driveModel): void {
    if (rom === null) { this.drives = []; return; }
    if (!this.drives.some(d => d.model === model)) this.fitDrives([model]);
    this.installDriveRom(model, rom);
  }

  /** Put an empty drive of `model` at place `at`, the drives from there moving
   *  down a device number. Needs a drive of that model fitted already, whose
   *  ROM it copies; false when there is no room. */
  insertDriveAt(at: number, model: C64DriveModel): boolean {
    if (this.drives.length >= C64_MAX_DRIVES) return false;
    const rom = this.drives.find(d => d.model === model && d.hasRom)?.rom;
    if (!rom) return false;
    const protect = this.drives.map(d => d.writeProtected);
    const drive = this.makeDrive(model);
    drive.loadRom(rom);
    this.drives.splice(Math.max(0, Math.min(at, this.drives.length)), 0, drive);
    this.renumberDrives(protect);
    return true;
  }

  /** Take a drive out with its disk, the drives under it moving up. */
  removeDriveAt(index: number): boolean {
    if (this.drives.length <= 1 || index < 0 || index >= this.drives.length) return false;
    const protect = this.drives.map(d => d.writeProtected);
    this.drives.splice(index, 1);
    this.renumberDrives(protect);
    return true;
  }

  /** Swap one drive for another model, with its ROM from a drive of that model
   *  already fitted; false when there is none (the machine must be rebuilt). */
  replaceDriveAt(index: number, model: C64DriveModel): boolean {
    const rom = this.drives.find(d => d.model === model && d.hasRom)?.rom;
    if (!rom || index < 0 || index >= this.drives.length) return false;
    const protect = this.drives.map(d => d.writeProtected);
    const drive = this.makeDrive(model);
    drive.loadRom(rom);
    this.drives[index] = drive;
    this.renumberDrives(protect);
    return true;
  }

  /** Fit or remove the drives the Hardware pane and the Drives pane ask for,
   *  and list the DOS ROMs they need (fetched before the machine starts). */
  prepare(view: SettingsView): AuxRomRequest[] {
    const models = normalizeDriveModels(view.get<unknown>('drive-models:c64', null));
    this.driveModels = models;
    if (!view.get('c64-drive', true)) {
      this.drives = [];
      return [];
    }
    this.fitDrives(models);
    return [...new Set(models)].map((model): AuxRomRequest => ({
      cacheKey: `c64-dos${model}-rom`,
      source: C64_DRIVE_ROM_SOURCES[model],
      fetchingMsg: `Fetching ${model} DOS ROM...`,
      loadedMsg: (bytes) => `${model} DOS ROM loaded (${bytes} bytes)`,
      failMsg: `Failed to load the ${model} DOS ROM: disk drive unavailable`,
      failId: 'c64-dos' + model,
      apply: (data) => this.installDriveRom(model, data),
      awaitLoad: true,
    }));
  }

  /** Bring the drives up to the 64's cycle `t`. */
  private syncDrive(t: number): void {
    for (const d of this.drives) d.runTo(Math.floor(t * d.clockHz / this.timing.clockHz));
  }

  /** Tell the drives which bus lines the 64 pulls low (ATN, CLK, DATA). */
  private updateIecLines(): void {
    const driven = this.cia2.drivenA;
    const atn = (driven & 0x08) !== 0, clk = (driven & 0x10) !== 0, data = (driven & 0x20) !== 0;
    for (const d of this.drives) d.setC64Lines(atn, clk, data);
  }

  /** The chips' own clocks follow the CPU's (it restarts at 0 on reset). */
  private syncChipClocks(): void {
    const t = this.cpu.tStates;
    this.cia1.now = t;
    this.cia2.now = t;
    this.sid.now = t;
    this.sid.flush();
    this.tapeLastT = t;
    this.audioLastT = t;
  }

  /** A button is down on the deck. A mounted tape has PLAY down until the
   *  user stops it; an empty deck stands for a blank cassette with RECORD and
   *  PLAY down, so SAVE goes straight to the recorder (and LOAD searches, as
   *  it would on a blank tape). */
  private get tapeSense(): boolean { return !this.tape.loaded || this.tape.playing; }

  /** The tape was mounted, ejected, played or stopped: PLAY follows it, and
   *  the deck runs only while the motor is on. */
  tapeTransportChanged(): void {
    this.memory.cassetteSense = this.tapeSense;
    this.motorWasOn = this.memory.motorOn;
    this.tapeLastT = this.cpu.tStates;
    this.prevEar = this.tape.earBit;
    if (this.tape.loaded && this.tape.playing) this.tape.paused = !this.motorWasOn;
  }

  /** Mounting a tape leaves PLAY up (with it down the KERNAL would run the
   *  motor at the READY prompt and wind the tape on); PLAY goes down by
   *  itself the first time software sits waiting for it. */
  armAutoPlay(): void { this.autoPlayArmed = true; }

  /** PLAY, pressed for a program polling the sense line (the KERNAL's PRESS
   *  PLAY ON TAPE loop, or a loader's own). */
  private checkAutoPlay(): void {
    const polls = this.memory.portReads;
    this.memory.portReads = 0;
    if (!this.autoPlayArmed || !this.tape.loaded || this.tape.playing) return;
    if (polls < AUTO_PLAY_POLLS) return;
    this.autoPlayArmed = false;
    this.tape.startPlayback();
    this.tapeTransportChanged();
    this.setStatus('PLAY pressed on the Datasette');
  }

  // ── Input ────────────────────────────────────────────────────────────────

  /** A joystick direction or fire on control port 1 or 2. */
  joystickPress(dir: string, pressed: boolean, port: 1 | 2): void {
    const bit = JOY_BITS[dir];
    if (!bit) return;
    if (port === 1) this.joy1 = pressed ? this.joy1 | bit : this.joy1 & ~bit;
    else this.joy2 = pressed ? this.joy2 | bit : this.joy2 & ~bit;
  }

  releaseJoysticks(): void { this.joy1 = this.joy2 = 0; }

  /** The bits a port reads as held: its joystick, and a mouse's buttons (the
   *  left is the fire button, the right reads as up). */
  private joyBits(port: 1 | 2): number {
    const joy = port === 1 ? this.joy1 : this.joy2;
    if (this.mousePort !== port || this.mouseButtons === 0) return joy;
    return joy | ((this.mouseButtons & 1) !== 0 ? 0x10 : 0) | ((this.mouseButtons & 2) !== 0 ? 0x01 : 0);
  }

  // ── 1351 mouse ───────────────────────────────────────────────────────────

  /** Plug the mouse into a control port, or take it out (0). */
  setMousePort(port: 0 | 1 | 2): void {
    this.mousePort = port;
    if (port === 0) this.mouseButtons = 0;
  }

  /** Move the mouse: the counters the POT lines read count the motion, 6 bits
   *  wrapping, and the driver works out the difference between two reads.
   *  `dy` is screen-down, as the host reports it; the 1351 counts up. */
  moveMouse(dx: number, dy: number): void {
    // A driver reads about once a frame and cannot tell more than half a turn
    // of the counter from a move the other way: a flick is cut to that.
    const cut = (v: number) => Math.max(-31, Math.min(31, Math.round(v)));
    this.mouseX = (this.mouseX + cut(dx)) & 0x3F;
    this.mouseY = (this.mouseY - cut(dy)) & 0x3F;
  }

  setMouseButton(index: number, pressed: boolean): void {
    const bit = index === 0 ? 1 : index === 2 ? 2 : 0;
    if (bit === 0) return;
    this.mouseButtons = pressed ? this.mouseButtons | bit : this.mouseButtons & ~bit;
  }

  // ── Programs (.prg / .t64) ───────────────────────────────────────────────

  /**
   * Start a program the way LOAD and RUN would on a freshly switched-on 64:
   * the machine is reset (so whatever was running cannot be overwritten
   * under it) and the program goes into memory once BASIC is at READY. A
   * program at the start of BASIC gets BASIC's pointers set and, with `run`,
   * RUN typed for it. Safe while running: it only touches the hardware
   * between frames.
   */
  injectProgram(prog: C64Program, run: boolean): void {
    this.resetHardware(true);
    this.pendingProgram = { prog, run };
  }

  private basicReady(): boolean {
    const pc = this.cpu.pc;
    return (pc >= KERNAL_KEY_WAIT_START && pc < KERNAL_KEY_WAIT_END) || this.framesSinceReset >= BOOT_FRAMES;
  }

  private applyPendingProgram(): void {
    const pending = this.pendingProgram;
    if (!pending) return;
    this.pendingProgram = null;
    const { prog, run } = pending;
    const ram = this.memory.ram;
    const end = Math.min(0x10000, prog.start + prog.data.length);
    ram.set(prog.data.subarray(0, end - prog.start), prog.start);
    const isBasic = prog.start === (ram[TXTTAB] | (ram[TXTTAB + 1] << 8)) || prog.start === BASIC_START;
    if (isBasic) {
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

  // ── Frame ────────────────────────────────────────────────────────────────

  protected get audioChip(): Mos6581 { return this.sid; }
  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo || this._tapeTurboActive; }
  protected override interruptEntryPending(): boolean { return this.cpu.interruptPending(); }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1 || this._tapeTurboActive;
    this.sid.audible = !skipAudio;
    if (!this.openFrame(this.timing.cyclesPerFrame)) {
      this.activity.kbdReads = 0;
      this.activity.sidWrites = 0;
      this.activity.tapeEdges = 0;
      this.activity.joyReads = 0;
      this.fLine = 0;
      this.fEvent = 0;
      this.lineLive = false;
    }
    this.memWatchHit = null;
    const vic = this.vic;

    const events = this.lineEvents;
    for (; this.fLine < this.timing.linesPerFrame; this.fLine++) {
      const lineStart = this.frameStartT + this.fLine * this.timing.cyclesPerLine;
      if (!this.lineLive) {
        this.lineLive = true;
        this.fEvent = 0;
        vic.startLine(this.fLine, lineStart);
        this.updateInterrupts();
      }
      for (; this.fEvent < events.length; this.fEvent++) {
        const at = events[this.fEvent];
        if (!this.runCpuTo(lineStart + at)) {
          this.midFrame = true;
          this.needsDisplay = true;
          return;
        }
        switch (this.fEvent) {
          case EVT_VC: vic.loadCounters(); break;
          case EVT_SPRITE_MCB: vic.spriteRowAdvance(); break;
          case EVT_SPRITE_DMA:
            vic.spriteDmaCheck();
            // An instruction that ran past the start of the new sprite holds
            // pays them (the bad line's was charged as it ran).
            this.cpu.tStates += vic.stretch(this.lastInsnStart, this.cpu.tStates, false);
            break;
          case EVT_LINE_END: vic.endOfLineFetches(); break;
          default: vic.endLine(); break;
        }
        this.updateInterrupts();
      }
      this.lineLive = false;
      if (!skipAudio) this.pumpAudio();
    }

    this.syncDrive(this.cpu.tStates);
    this.cia1.todTick();
    this.cia2.todTick();
    this.framesSinceReset++;
    if (this.pendingProgram && this.basicReady()) this.applyPendingProgram();
    if (skipAudio) { this.audioLastT = this.cpu.tStates; this.sid.advanceTo(this.cpu.tStates); }
    this.checkAutoPlay();
    this.updateTapeTurbo();
    this.needsDisplay = true;
  }

  /** Feed the SID's samples to the mixer up to now. */
  private pumpAudio(): void {
    const now = this.cpu.tStates;
    this.sid.advanceTo(now);
    const elapsed = now - this.audioLastT;
    this.audioLastT = now;
    if (elapsed <= 0) return;
    this.mixer.accumulate(0, elapsed);
    this.mixer.generateSamples(this.audio, this.sid, true);
  }

  /** Run the CPU to cycle `target`. False when a stop left it part-way. */
  private runCpuTo(target: number): boolean {
    const cpu = this.cpu;
    const vic = this.vic;
    while (cpu.tStates < target) {
      // Wait out a hold the VIC-II has on the bus.
      const free = vic.stealEnd(cpu.tStates);
      if (free !== cpu.tStates) { cpu.tStates = free; continue; }
      if (this.checkStops(cpu.pc)) return false;
      const start = cpu.tStates;
      const pc = cpu.pc;
      this.beforeInsn(pc);
      this.insnStart = start;
      this.insnOp = cpu.interruptPending() ? -1 : this.memory.peekByte(pc);
      this.insnRmw = this.insnOp >= 0 && isReadModifyWrite(this.insnOp);
      this.rmwAddr = -1;
      cpu.step();
      cpu.tStates += vic.stretch(start, cpu.tStates);
      this.lastInsnStart = start;
      const stopped = this.afterInsn();
      this.afterStep();
      if (stopped) return false;
    }
    return true;
  }

  /** After each instruction: the tape, the CIAs and the interrupt lines. */
  private afterStep(): void {
    const now = this.cpu.tStates;
    const tape = this.tape;
    if (tape.playing && !tape.paused) {
      const gap = now - this.tapeLastT;
      this.tapeLastT = now;
      if (gap > 0) tape.advance(gap);
      const ear = tape.earBit;
      if (ear !== this.prevEar) {
        this.prevEar = ear;
        if (ear === 0) { this.cia1.flag(); this.activity.tapeEdges++; }
      }
    }
    this.cia1.advanceTo(now);
    this.cia2.advanceTo(now);
    this.updateInterrupts();
  }

  private updateInterrupts(): void {
    this.cpu.setIRQ(this.cia1.irq || this.vic.irq);
    const nmi = this.cia2.irq || this.keyboard.restore;
    if (nmi && !this.nmiLevel) this.cpu.nmi();
    this.nmiLevel = nmi;
  }

  /** Turbo while the KERNAL (or a loader) is reading the tape — the motor
   *  is on and the deck is moving — or saving to the empty deck. */
  private updateTapeTurbo(): void {
    const reading = this.tape.playing && !this.tape.paused && this.icrReads >= TURBO_ICR_READS;
    const writing = this.tapeRecorder.count !== this.recordedAtFrame;
    this.icrReads = 0;
    this.recordedAtFrame = this.tapeRecorder.count;
    // The drive is busy while its motor runs and bytes move under the head.
    // A disk is busy while a motor runs and either the controller moves bytes
    // or the serial bus is carrying them (a 1581 reads a sector in a blink and
    // then spends the best part of a second sending it).
    let diskBusy = false;
    const busy = this.iecWrites >= IEC_BUSY_WRITES;
    this.iecWrites = 0;
    for (const d of this.drives) if ((d.takeActivity() > 0 || busy) && d.motorOn) diskBusy = true;
    const loading = (this.memory.motorOn && (reading || writing)) || diskBusy;
    if (loading) {
      this._tapeTurboActive = this.tapeTurbo;
      this.tapeTurboCooldown = TAPE_TURBO_COOLDOWN;
    } else if (this.tapeTurboCooldown > 0) {
      if (--this.tapeTurboCooldown === 0) this.releaseTapeTurbo();
    } else if (this._tapeTurboActive) {
      this.releaseTapeTurbo();
    }
  }

  private releaseTapeTurbo(): void {
    if (!this._tapeTurboActive) return;
    this._tapeTurboActive = false;
    this.sid.flush();
    this.mixer.reset();
  }

  // ── Beam / debug ─────────────────────────────────────────────────────────

  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: this.timing.cyclesPerLine,
      linesPerFrame: this.timing.linesPerFrame,
      displayStart: 0,
      note: `line 0 is raster line 0 and cycle 0 of a line is the ${this.timing.ntsc ? '6567' : '6569'}'s cycle 1, where the raster counter moves on and the raster interrupt is raised; bad lines hold the CPU from cycle 11 to 54 and sprite DMA from cycle 54 on. The display window is lines 51-250. The picture is drawn as the beam goes, caught up before every VIC-II and CIA 2 write`,
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return m6502ReturnAddress(this.cpu.sp, a => this.memory.peekByte(a)); }
  /** No opcode is fetched from I/O, where a read has side effects. */
  protected override peekOpcode(addr: number): number {
    return (addr >> 12) === 0xD && this.memory.ioIn ? -1 : this.memory.peekByte(addr);
  }

  protected override tracer = new M6502Trace(this, { io: [[0xD000, 0xDFFF]], ioLabel: c64IoLabel });

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: `${this.model}-ram-64k.bin` };
  }

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    switch (value) {
      case 'rom-basic': return { data: this.memory.basic, baseAddr: 0xA000 };
      case 'rom-kernal': return { data: this.memory.kernal, baseAddr: 0xE000 };
      case 'rom-chargen': return { data: this.memory.chargen, baseAddr: 0xD000 };
      case 'color-ram': return { data: this.memory.colorRam, baseAddr: 0xD800 };
      default: return null;
    }
  }

  // ── Chip state ───────────────────────────────────────────────────────────

  /** The custom chips (and the drive), for the debugger's `chip_state`. */
  chips(): readonly ChipSection[] { return c64Chips(this); }

  // ── Screen text ──────────────────────────────────────────────────────────

  /** The text screen as the VIC-II shows it (text modes only). */
  ocrScreenForMcp(_mode?: string): string {
    return c64ScreenText(this.memory, this.vic.regs);
  }

  /** The 40x25 TEXT-overlay grid over the character screen. */
  ocrScreenStyled(): C64OcrResult {
    const mem = this.memory;
    return c64OcrGrid({
      regs: this.vic.regs,
      chargen: mem.chargen,
      palette: C64_PALETTE,
      vicRead: a => mem.vicRead(a),
      colour: i => mem.colorRam[i],
    });
  }

  /**
   * Where the character screen sits in the frame buffer: the 320x200 window,
   * moved by the scroll registers (the first text row starts YSCROLL lines
   * below raster line 48, the first column XSCROLL pixels in).
   */
  get textField(): { x: number; y: number; width: number; height: number } {
    const regs = this.vic.regs;
    return {
      x: C64_BORDER_LEFT + (regs[0x16] & 7),
      y: this.timing.borderTop - 3 + (regs[0x11] & 7),
      width: C64_ACTIVE_WIDTH,
      height: C64_ACTIVE_HEIGHT,
    };
  }

  /** Paint the overlay's matched cells out of the frame, each in its `paper`. */
  blankCells(mask: readonly boolean[], paper: readonly number[]): void {
    const px = this.vic.pixels;
    const field = this.textField;
    for (let row = 0; row < 25; row++) {
      const top = field.y + row * 8;
      if (top + 8 > this.timing.screenHeight) break;
      for (let col = 0; col < 40; col++) {
        if (!mask[row * 40 + col]) continue;
        const left = field.x + col * 8;
        if (left + 8 > C64_SCREEN_WIDTH) continue;
        const colour = C64_PALETTE[paper[row * 40 + col] & 0x0F];
        for (let y = 0; y < 8; y++) {
          const base = (top + y) * C64_SCREEN_WIDTH + left;
          px.fill(colour, base, base + 8);
        }
      }
    }
  }

  // ── Snapshots (.c64state) ────────────────────────────────────────────────

  /** CRC-32s of BASIC, the KERNAL and the character ROM. */
  stateRomCrcs(): number[] {
    return [crc32(this.memory.basic), crc32(this.memory.kernal), crc32(this.memory.chargen)];
  }

  private completeFrame(): void {
    if (this.midFrame) withStopsDisarmed(this, () => this.stepFrame());
  }

  /** The machine's state between frames. The tape is not part of it. */
  saveState(w: StateWriter, withMedia: boolean): void {
    this.completeFrame();
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameStartT); w.f64(this.frameEndT); w.f64(this.frameNumber);
      w.bool(this.nmiLevel);
    });
    w.section('TV  ', () => w.bool(this.timing.ntsc));
    w.section('CART', () => {
      const cart = this.memory.cart;
      w.bool(cart !== null);
      if (cart) { w.bytes(cart.image); cart.saveState(w); }
    });
    w.section('MEM ', () => this.memory.saveState(w));
    w.section('VIC ', () => this.vic.saveState(w));
    w.section('SID ', () => this.sid.saveState(w));
    w.section('CIA1', () => this.cia1.saveState(w));
    w.section('CIA2', () => this.cia2.saveState(w));
    for (const drive of this.drives) {
      if (!drive.hasRom) continue;
      w.section('DRVM', () => w.str(drive.model));
      w.section('DRV ', () => drive.saveState(w));
      w.section('MEDA', () => {
        w.bool(withMedia);
        if (withMedia) drive.saveDisk(w);
      });
    }
  }

  loadState(r: StateReader): void {
    this.cpu.loadState(r.section('CPU '));
    {
      const s = r.section('MACH');
      this.frameStartT = s.f64(); this.frameEndT = s.f64(); this.frameNumber = s.f64();
      this.nmiLevel = s.bool();
    }
    // States from before NTSC existed carry no TV section: they are PAL.
    const ntsc = r.peekSection('TV  ') ? r.section('TV  ').bool() : false;
    if (ntsc !== this.timing.ntsc) {
      throw new Error(`This is a ${ntsc ? 'NTSC' : 'PAL'} snapshot: choose the ${ntsc ? 'NTSC' : 'PAL'} Commodore 64 first`);
    }
    // States from before cartridges carry no CART section: nothing was fitted.
    if (r.peekSection('CART')) {
      const c = r.section('CART');
      if (c.bool()) {
        const parsed = parseCrt(c.bytes());
        if ('error' in parsed) throw new Error(`The snapshot's cartridge: ${parsed.error}`);
        this.setCartridge(parsed.cart);
        this.cartridgeFile = '';
        parsed.cart.loadState(c);
      } else if (this.memory.cart) {
        this.setCartridge(null);
      }
    } else if (this.memory.cart) {
      this.setCartridge(null);
    }
    this.memory.loadState(r.section('MEM '));
    this.vic.loadState(r.section('VIC '));
    this.sid.loadState(r.section('SID '));
    this.cia1.loadState(r.section('CIA1'));
    this.cia2.loadState(r.section('CIA2'));
    let withMedia = true;
    // One DRVM (the model; absent before the 1581 existed: a 1541), DRV and
    // MEDA section for each drive, device 8 first.
    let n = 0;
    while (r.peekSection('DRVM') || r.peekSection('DRV ')) {
      let model: C64DriveModel = '1541';
      if (r.peekSection('DRVM')) {
        const named = r.section('DRVM').str();
        if (isC64DriveModel(named)) model = named;
      }
      const state = r.section('DRV ');
      const media = r.section('MEDA');
      withMedia = media.bool();
      if (this.drives.length > 0) {
        const drive = this.drives[n];
        if (!drive) {
          throw new Error(`This snapshot has more drives than are set up: add drives in the Drives pane first (it has ${n + 1} or more)`);
        }
        if (drive.model !== model) {
          throw new Error(`This snapshot has a ${model} drive as device ${8 + n}: set that drive to a ${model} in the Drives pane first`);
        }
        if (drive.hasRom) {
          drive.loadState(state);
          if (withMedia) drive.loadDisk(media);
        }
      }
      n++;
    }
    // Drives the snapshot did not have start over.
    for (let i = n; i < this.drives.length; i++) if (this.drives[i].hasRom) this.drives[i].reset();
    this.updateIecLines();
    this.memory.cassetteSense = this.tapeSense;
    this.motorWasOn = this.memory.motorOn;
    this.midFrame = false;
    this.fLine = 0;
    this.fEvent = 0;
    this.lineLive = false;
    this.clearInterrupts();
    this.keyboard.reset();
    this.joy1 = this.joy2 = 0;
    this._tapeTurboActive = false;
    this.tapeTurboCooldown = 0;
    this.framesSinceReset = BOOT_FRAMES;
    this.tapeLastT = this.cpu.tStates;
    this.audioLastT = this.cpu.tStates;
    this.audio.reset();
    this.mixer.reset();
    this.refreshResumed = !withMedia;
    this.needsDisplay = true;
  }
}

/** Trace labels for the I/O page. */
function c64IoLabel(addr: number): string {
  switch ((addr >> 8) & 0x0F) {
    case 0x0: case 0x1: case 0x2: case 0x3: return 'VIC';
    case 0x4: case 0x5: case 0x6: case 0x7: return 'SID';
    case 0x8: case 0x9: case 0xA: case 0xB: return 'COLOR';
    case 0xC: return 'CIA1';
    case 0xD: return 'CIA2';
    default: return 'IO';
  }
}
