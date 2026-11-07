/**
 * Commodore VIC-20 motherboard.
 *
 * A 6502 at 1.108 MHz (PAL) or 1.023 MHz (NTSC), 5K of RAM, BASIC V2, the
 * KERNAL and the character ROM (see `memory.ts`), the 6561/6560 VIC
 * (`vic.ts`) and two 6522 VIAs:
 *
 *   VIA 1 ($9110), its interrupt on NMI
 *     port A  PA0 serial CLK in, PA1 serial DATA in, PA2-PA4 joystick up,
 *             down and left, PA5 fire, PA6 cassette sense, PA7 serial ATN out
 *     port B  the user port
 *     CA1     the RESTORE key; CA2 the cassette motor
 *   VIA 2 ($9120), its interrupt on IRQ (the KERNAL's 60 Hz jiffy from timer 1)
 *     port A  keyboard rows (in)
 *     port B  keyboard columns (out); PB3 cassette write; PB7 joystick right
 *     CA1     cassette read; CA2 serial CLK out; CB1 serial SRQ in;
 *             CB2 serial DATA out
 *
 * The serial outputs go through inverters, so ATN, CLK or DATA is pulled low
 * while its output is high. The inputs read the lines as they are: low while
 * the VIC-20 or any drive pulls them. The drives (the shared 1541, 1571 and
 * 1581, `shared/cbm/`) are brought up to the VIC-20's clock at every access
 * to the VIAs' serial pins and at frame end.
 *
 * The Datasette: a mounted tape counts as PLAY pressed (PA6 low), the motor
 * runs while VIA 1 holds CA2 low and moves the tape, the read line's level
 * goes to VIA 2's CA1 (the KERNAL picks the edge), and SAVE drives PB3.
 *
 * The frame loop runs instruction by instruction. The VIAs are brought up to
 * the cycle of each register access (`accessTime`) and to the end of each
 * instruction, and the VIC draws the picture up to each of its register
 * writes and to the end of the frame. The VIC never holds the CPU.
 */

import { M6502 } from '@/cores/m6502.ts';
import { M6522 } from '@/cores/m6522.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { crc32, type StateReader, type StateWriter } from '@/machines/shared/state-io.ts';
import { withStopsDisarmed } from '@/machines/shared/native-state.ts';
import { m6502ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { accessTime } from '@/debug/m6502/bus-cycles.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';
import type { ChipSection } from '@/debug/chip-state.ts';
import type { C64Program } from '@/media/tape/t64.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import { normalizeDriveModels, type CbmDriveUnit } from '@/machines/shared/cbm/drive/drive-unit.ts';
import { CbmSerialBus } from '@/machines/shared/cbm/serial-bus.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import { readVic20Expansion, vic20BasicStart } from './options.ts';
import type { Vic20Model } from './models.ts';
import { Vic20Memory, type Vic20RamExpansion } from './memory.ts';
import { Vic20Keyboard } from './keyboard.ts';
import { Vic } from './vic.ts';
import { VicSound } from './vic-sound.ts';
import { vic20Descriptor } from './descriptor.ts';
import { vic20Chips } from './chip-dump.ts';
import { createVic20Services, type Vic20Services } from './services/index.ts';
import { vic20ScreenText } from './screen-text.ts';
import { vic20OcrGrid } from '@/ocr/vic20.ts';
import type { C64OcrResult } from '@/ocr/c64.ts';
import { VIC20_PALETTE } from './palette.ts';
import { loadCartridge, saveCartridge, type Vic20Cartridge } from './cartridge.ts';
import {
  VIC20_BASIC_SIZE, VIC20_CHARGEN_SIZE, VIC20_KERNAL_SIZE, VIC20_PIXEL_DOUBLE, vic20Screen,
  vic20Timing, type Vic20Timing,
} from './constants.ts';

/** Joystick directions as port bits (active low on the pins): up, down, left
 *  and fire on VIA 1 port A, right on VIA 2 port B. */
const JOY_VIA1: Readonly<Record<string, number>> = { up: 0x04, down: 0x08, left: 0x10, fire: 0x20 };
const JOY_RIGHT = 0x80;

/** BASIC's pointers, set when a program is loaded at the start of BASIC, and
 *  the KERNAL's keyboard buffer (the same places as on the C64). */
const TXTTAB = 0x2B;
const VARTAB = 0x2D;
const ARYTAB = 0x2F;
const STREND = 0x31;
const KEYBUF = 0x0277;
const KEYBUF_COUNT = 0xC6;
/** Frames after a reset by which BASIC is ready whatever the ROMs (the real
 *  KERNAL gets there in under two seconds). */
const BOOT_FRAMES = 300;
/** Frames of quiet before tape turbo lets go. */
const TAPE_TURBO_COOLDOWN = 25;
/** Reads of the PLAY sense line (VIA 1 port A) in a frame that mean a program
 *  is waiting for PLAY (the KERNAL's IRQ and the joystick read it a few times
 *  a frame; PRESS PLAY ON TAPE reads it in a tight loop). */
const AUTO_PLAY_POLLS = 100;
/** Reads of VIA 2's interrupt flags in a frame that mean the tape is being
 *  read: every pulse is an interrupt, where the jiffy alone reads it once. */
const TURBO_IFR_READS = 10;

/** The VIA's CA2/CB2 is an output held high (PCR mode 7) — through the
 *  inverter, its serial line is pulled low. */
function ca2High(via: M6522): boolean { return ((via.pcr >> 1) & 7) === 7; }
function cb2High(via: M6522): boolean { return ((via.pcr >> 5) & 7) === 7; }

/** A port's pins as the chip drives them: outputs as latched, inputs high. */
function drivenA(via: M6522): number { return ((via.ora & via.ddra) | (~via.ddra & 0xFF)) & 0xFF; }
function drivenB(via: M6522): number { return ((via.orb & via.ddrb) | (~via.ddrb & 0xFF)) & 0xFF; }

export class Vic20Machine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'vic20';
  readonly model: Vic20Model;
  host: MachineHost | null = null;
  readonly services: Vic20Services;

  readonly cpu = new M6502();
  readonly memory = new Vic20Memory();
  readonly timing: Vic20Timing;
  readonly vic: Vic;
  /** The VIC's voices, run from its registers. */
  readonly sound: VicSound;
  readonly via1 = new M6522();
  readonly via2 = new M6522();
  readonly keyboard = new Vic20Keyboard();
  /** The serial bus and the disk drives on it; the VIC-20's side of it is
   *  `serialOut` (bits ATN 1, CLK 2, DATA 4, as the bus counts them). */
  readonly iec = new CbmSerialBus(() => this.serialOut);
  /** The disk drives on the serial bus, device 8 first; none while unplugged. */
  get drives(): readonly CbmDriveUnit[] { return this.iec.drives; }
  /** A state without its disks (the browser-refresh copy) was restored: the
   *  shell then puts the persisted disk back, which must not look like a disk
   *  change to the drive. Cleared by any reset. */
  refreshResumed = false;
  /** The Datasette's tape, played through the shared pulse deck. */
  readonly tape: TapeDeck;
  /** Edges of the cassette write line since the last reset (what SAVE wrote). */
  readonly tapeRecorder = new PulseRecorder();

  readonly mixer: AudioMixer;
  readonly audio = new Audio();
  display: IScreenRenderer | null;
  private readonly _pixels: Uint8Array;
  protected get audioChip(): VicSound { return this.sound; }

  readonly activity = { kbdReads: 0, joyReads: 0, soundWrites: 0, tapeEdges: 0 };

  // Tape transport.
  tapeTurbo = true;
  private _tapeTurboActive = false;
  private tapeTurboCooldown = 0;
  private tapeLastT = 0;
  private prevEar = 0;
  private motorWasOn = false;
  private autoPlayArmed = false;
  /** This frame's reads of the PLAY sense line and of VIA 2's flags, and the
   *  recorder's length at the last frame's end (for auto-play and turbo). */
  private senseReads = 0;
  private ifrReads = 0;
  private recordedAtFrame = 0;

  get tapeTurboActive(): boolean { return this._tapeTurboActive; }

  /** Joystick directions held: `up`/`down`/`left`/`fire` bits for VIA 1 and
   *  the right bit for VIA 2, active high here. */
  private joyVia1 = 0;
  private joyRight = false;
  /** Paddles in the control port (the host mouse turning them), and their
   *  fire buttons: X's on the joystick-left line, Y's on joystick-right. */
  private paddles = false;
  private paddleButtons = 0;

  /** NMI is edge-triggered: VIA 1's interrupt output, last seen. */
  private nmiLevel = false;
  /** The cycle the VIAs have been brought up to. */
  private viaT = 0;

  /** A program waiting for BASIC to be ready before it is put in memory. */
  private pendingProgram: { prog: C64Program; run: boolean } | null = null;
  private framesSinceReset = 0;

  // The instruction in progress, for timing its register accesses.
  private insnStart = 0;
  private insnOp = -1;

  constructor(model: Vic20Model, display: IScreenRenderer | null = null, ntsc = false) {
    super();
    this.model = model;
    this.display = display;
    this.timing = vic20Timing(ntsc);
    this.mixer = new AudioMixer(this.timing.clockHz);
    this.mixer.beeperGain = 0;
    this.mixer.psgGain = 1;
    this.vic = new Vic(this.memory, this.timing);
    this.sound = new VicSound(this.vic.regs, this.timing.clockHz);
    this.tape = new TapeDeck(this.timing.clockHz);
    this.tape.pulseScale = this.timing.clockHz / TAPE_REF_HZ;
    this._pixels = new Uint8Array(this.vic.pixels.buffer);
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
    this.services = createVic20Services(this);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  /** The cycle a register access of the instruction in progress lands on. */
  private accessT(addr: number, write: boolean): number {
    return this.insnActive ? accessTime(this.insnStart, this.insnOp, this.insnPc, addr, write, false) : this.cpu.tStates;
  }

  /** Bring both VIAs' timers up to cycle `t`. */
  private syncVias(t: number): void {
    const n = t - this.viaT;
    if (n <= 0) return;
    this.via1.addCycles(n);
    this.via2.addCycles(n);
    this.viaT = t;
  }

  /** The serial lines the VIC-20 pulls low itself, as bits (ATN 1, CLK 2, DATA 4). */
  get serialOut(): number {
    return ((drivenA(this.via1) & 0x80) !== 0 ? 1 : 0) | (ca2High(this.via2) ? 2 : 0) | (cb2High(this.via2) ? 4 : 0);
  }

  /** Set the VIA port inputs to what the keyboard, joystick and serial bus
   *  put on the pins now. */
  private updatePins(): void {
    const { via1, via2, keyboard } = this;
    // VIA 1 port A: serial CLK/DATA in (high unless pulled), joystick, PLAY
    // sense (low while a button is down), ATN out reads as driven.
    const out = this.serialOut;
    let a1 = this.tapeSense ? 0xBF : 0xFF;
    if ((out & 2) !== 0 || this.iec.clkLow) a1 &= ~0x01;
    if ((out & 4) !== 0 || this.iec.dataLow) a1 &= ~0x02;
    a1 &= ~(this.joyVia1 | ((this.paddleButtons & 1) !== 0 ? JOY_VIA1.left : 0));
    via1.portAInput = a1;
    via1.portBInput = 0xFF;
    // VIA 2: the matrix between port B (columns) and port A (rows). The
    // joystick's right switch pulls PB7 low, which the keyboard sees as
    // column 7 driven.
    const right = this.joyRight || (this.paddleButtons & 2) !== 0 ? JOY_RIGHT : 0;
    const columns = drivenB(via2) & ~right;
    via2.portAInput = keyboard.rowsFor(columns);
    via2.portBInput = keyboard.columnsFor(drivenA(via2)) & ~right;
  }

  private wireIo(): void {
    const { memory, vic, via1, via2 } = this;

    memory.openBus = () => {
      vic.drawTo(this.accessT(0, false));
      return vic.busValue;
    };

    memory.ioRead = (addr) => {
      const t = this.accessT(addr, false);
      if ((addr & 0x0300) === 0) return vic.read(addr, t);
      const sel1 = (addr & 0x10) !== 0, sel2 = (addr & 0x20) !== 0;
      if (!sel1 && !sel2) { vic.drawTo(t); return vic.busValue; }
      this.syncVias(t);
      const reg = addr & 0x0F;
      // VIA 1's port A reads the serial bus: the drives first catch up.
      if (sel1 && (reg === 1 || reg === 15)) this.syncDrives(t);
      this.updatePins();
      let v = 0xFF;
      if (sel1) {
        if (reg === 1 || reg === 15) { this.activity.joyReads++; this.senseReads++; }
        v &= via1.read(reg);
      }
      if (sel2) {
        if (reg === 1 || reg === 15) { this.activity.kbdReads++; this.keyboard.reads++; }
        if (reg === 13) this.ifrReads++;
        v &= via2.read(reg);
      }
      this.updateInterrupts();
      return v;
    };

    memory.ioWrite = (addr, value) => {
      const t = this.accessT(addr, true);
      if ((addr & 0x0300) === 0) {
        const reg = addr & 0x0F;
        if (reg >= 10 && reg <= 14) {
          this.sound.advanceTo(t);
          this.activity.soundWrites++;
        }
        vic.write(addr, value, t);
        return;
      }
      this.syncVias(t);
      const reg = addr & 0x0F;
      // ATN is VIA 1's PA7 (ORA, DDRA); CLK and DATA out VIA 2's CA2 and CB2 (PCR).
      const bus = this.iec.fitted && ((addr & 0x10) !== 0 && (reg === 1 || reg === 3 || reg === 15)
        || (addr & 0x20) !== 0 && reg === 12);
      if (bus) this.syncDrives(t);
      if (addr & 0x10) via1.write(reg, value);
      if (addr & 0x20) via2.write(reg, value);
      if (bus) this.iec.update();
      this.cassettePortsChanged(t);
      this.updateInterrupts();
    };

    memory.ioPeek = (addr) => {
      if ((addr & 0x0300) === 0) return vic.peek(addr, this.cpu.tStates);
      const reg = addr & 0x0F;
      let v = 0xFF;
      if (addr & 0x10) v &= peekVia(via1, reg);
      if (addr & 0x20) v &= peekVia(via2, reg);
      return v;
    };
  }

  // ── Disk drives ──────────────────────────────────────────────────────────

  /** Bring the drives up to the VIC-20's cycle `t`. */
  private syncDrives(t: number): void {
    if (this.iec.fitted) this.iec.syncTo(t, this.timing.clockHz);
  }

  // ── Datasette ────────────────────────────────────────────────────────────

  /** The motor runs while VIA 1 holds CA2 low (PCR mode 6). */
  get motorOn(): boolean { return ((this.via1.pcr >> 1) & 7) === 6; }
  /** The cassette write line: VIA 2 PB3 as driven. */
  get cassetteWrite(): boolean { return (drivenB(this.via2) & 0x08) !== 0; }

  /** A button is down on the deck. A mounted tape has PLAY down until the
   *  user stops it; an empty deck stands for a blank cassette with RECORD and
   *  PLAY down, so SAVE goes straight to the recorder. */
  get tapeSense(): boolean { return !this.tape.loaded || this.tape.playing; }

  /** A VIA was written at cycle `t`: follow the motor and the write line. */
  private cassettePortsChanged(t: number): void {
    const motor = this.motorOn;
    if (motor !== this.motorWasOn) {
      this.motorWasOn = motor;
      if (this.tape.loaded && this.tape.playing) {
        if (motor) this.tapeLastT = this.cpu.tStates;
        this.tape.paused = !motor;
      }
    }
    if (motor) this.tapeRecorder.observe(this.cassetteWrite ? 1 : 0, t);
  }

  /** The tape was mounted, ejected, played or stopped: PLAY follows it, and
   *  the deck runs only while the motor is on. */
  tapeTransportChanged(): void {
    this.motorWasOn = this.motorOn;
    this.tapeLastT = this.cpu.tStates;
    this.prevEar = this.tape.earBit;
    if (this.tape.loaded && this.tape.playing) this.tape.paused = !this.motorWasOn;
  }

  /** Mounting a tape leaves PLAY up; it goes down by itself the first time
   *  software sits waiting for it (PRESS PLAY ON TAPE). */
  armAutoPlay(): void { this.autoPlayArmed = true; }

  private checkAutoPlay(): void {
    const polls = this.senseReads;
    this.senseReads = 0;
    if (!this.autoPlayArmed || !this.tape.loaded || this.tape.playing) return;
    if (polls < AUTO_PLAY_POLLS) return;
    this.autoPlayArmed = false;
    this.tape.startPlayback();
    this.tapeTransportChanged();
    this.setStatus('PLAY pressed on the Datasette');
  }

  /** Move the tape to now, and give its read line's level to VIA 2's CA1. */
  private stepTape(): void {
    const tape = this.tape;
    if (!tape.playing || tape.paused) return;
    const now = this.cpu.tStates;
    const gap = now - this.tapeLastT;
    this.tapeLastT = now;
    if (gap > 0) tape.advance(gap);
    const ear = tape.earBit;
    if (ear !== this.prevEar) {
      this.prevEar = ear;
      this.via2.setCA1(ear !== 0);
      if (ear === 0) this.activity.tapeEdges++;
    }
  }

  /** Turbo while the KERNAL (or a loader) reads the tape with the motor on,
   *  or saves to the empty deck. */
  private updateTapeTurbo(): void {
    const reading = this.tape.playing && !this.tape.paused && this.ifrReads >= TURBO_IFR_READS;
    const writing = this.tapeRecorder.count !== this.recordedAtFrame;
    this.ifrReads = 0;
    this.recordedAtFrame = this.tapeRecorder.count;
    if (this.motorOn && (reading || writing)) {
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
    this.sound.flush();
    this.mixer.reset();
  }

  /** Raise or drop the interrupt lines from the VIAs. */
  private updateInterrupts(): void {
    this.via1.setCA1(!this.keyboard.restore);
    this.cpu.setIRQ(this.via2.irq);
    const nmi = this.via1.irq;
    if (nmi && !this.nmiLevel) this.cpu.nmi();
    this.nmiLevel = nmi;
  }

  // ── Machine SPI ──────────────────────────────────────────────────────────

  get descriptor(): MachineDescriptor { return vic20Descriptor(this.model, this.timing.ntsc ? 'us' : 'uk'); }
  get pixels(): Uint8Array { return this._pixels; }
  get frameWidth(): number { return this.vic.width; }
  get frameHeight(): number { return this.vic.height; }
  get tStatesPerFrame(): number { return this.timing.cyclesPerFrame; }
  get cpuClockHz(): number { return this.timing.clockHz; }
  protected override get frameHz(): number { return this.timing.clockHz / this.timing.cyclesPerFrame; }

  attachHost(host: MachineHost): void { this.host = host; }

  applySettings(view: SettingsView): void {
    this.audio.setVolume(view.get('volume', 70) / 100);
    this.tapeTurbo = view.get('tape-turbo-load', true);
    this.drives.forEach((d, i) => { d.writeProtected = view.get('write-protect-' + 'abcd'[i], false); });
  }

  /** The border is fully rendered; the setting crops it: Normal shows it
   *  all, Small half, None just the KERNAL's text area. */
  setBorderSize(mode: BorderMode): void {
    const s = vic20Screen(this.timing);
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(s.borderLeft * (1 - frac) / VIC20_PIXEL_DOUBLE) * VIC20_PIXEL_DOUBLE;
    const cropY = Math.round(s.borderTop * (1 - frac));
    const right = s.width - s.borderLeft - s.activeWidth;
    const bottom = s.height - s.borderTop - s.activeHeight;
    const cropR = Math.round(right * (1 - frac) / VIC20_PIXEL_DOUBLE) * VIC20_PIXEL_DOUBLE;
    const cropB = Math.round(bottom * (1 - frac));
    this.display?.setViewport(cropX, cropY, s.width - cropX - cropR, s.height - cropY - cropB);
  }

  /**
   * Install the system ROM: BASIC, KERNAL and the character ROM at an 8K
   * stride, as the ROM host serves them (20K). An 8K image on its own
   * replaces just the KERNAL, and 16K is BASIC and KERNAL.
   */
  loadROM(data: Uint8Array): void {
    if (data.length === VIC20_KERNAL_SIZE) {
      this.memory.loadRoms(null, data, null);
    } else {
      const kernalAt = VIC20_BASIC_SIZE;
      const charAt = kernalAt + VIC20_KERNAL_SIZE;
      this.memory.loadRoms(
        data.subarray(0, VIC20_BASIC_SIZE),
        data.length >= charAt ? data.subarray(kernalAt, charAt) : null,
        data.length >= charAt + VIC20_CHARGEN_SIZE ? data.subarray(charAt, charAt + VIC20_CHARGEN_SIZE) : null,
      );
    }
    this.setStatus(`VIC-20 ROMs loaded (${data.length} bytes)`);
  }

  /** Fit expansion RAM. Done with the power off: the next reset starts the
   *  KERNAL over, and it sizes the RAM afresh. */
  setRamExpansion(exp: Vic20RamExpansion): void {
    this.memory.setExpansion(exp);
  }

  // ── Cartridge ────────────────────────────────────────────────────────────

  /** The cartridge on the expansion port, or null. */
  get cartridge(): Vic20Cartridge | null { return this.memory.cart; }
  /** The file the cartridge came from, for the ROM pane ('' when it came
   *  with a snapshot). */
  cartridgeFile = '';

  /** Change what is on the expansion port the way a person must: with the
   *  power off, so the machine starts over with it (and the KERNAL finds a
   *  cartridge's autostart signature). */
  private swapCartridge(change: () => void): void {
    const wasActive = this.running || this.starting;
    this.stop();
    change();
    this.reset();
    if (wasActive) void this.start();
  }

  /** Plug a cartridge in and start over with it. */
  mountCartridge(cart: Vic20Cartridge, file: string): void {
    this.swapCartridge(() => { this.memory.setCartridge(cart); this.cartridgeFile = file; });
    this.setStatus(`Cartridge: ${file || cart.name}`);
  }

  /** Take the cartridge out and start over without it. */
  ejectCartridge(): void {
    this.swapCartridge(() => { this.memory.setCartridge(null); this.cartridgeFile = ''; });
    this.setStatus('Cartridge ejected');
  }

  /** Fit the expansion RAM and the disk drives the Hardware pane and the
   *  Drives pane ask for, and list the DOS ROMs the drives need (the same
   *  files, and the same cache, as the C64's). */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.setRamExpansion(readVic20Expansion(view));
    const models = normalizeDriveModels(view.get<unknown>('drive-models:vic20', null));
    this.iec.driveModels = models;
    if (!view.get('vic20-drive', true)) {
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
    this.vic.reset();
    this.via1.reset();
    this.via2.reset();
    this.keyboard.reset();
    this.joyVia1 = 0;
    this.joyRight = false;
    this.cpu.reset();
    this.sound.reset();
    this.sound.now = this.cpu.tStates;
    this.viaT = this.cpu.tStates;
    this.nmiLevel = false;
    this.midFrame = false;
    this.framesSinceReset = 0;
    this.pendingProgram = null;
    this.tapeRecorder.reset();
    this.recordedAtFrame = 0;
    this.motorWasOn = false;
    if (this.tape.loaded) this.tape.paused = true;
    this._tapeTurboActive = false;
    this.tapeTurboCooldown = 0;
    this.tapeLastT = this.cpu.tStates;
    this.senseReads = this.ifrReads = 0;
    this.iec.reset();
    this.refreshResumed = false;
    this.clearInterrupts();
    this.updatePins();
    this.mixer.reset();
    this.audio.reset();
    this.needsDisplay = true;
  }

  // ── Programs (.prg / .t64) ───────────────────────────────────────────────

  /** Where BASIC starts with the RAM fitted: $1201 with BLK1 (the screen
   *  moves to $1000 and the 3K, if fitted, is left out), $0401 with the 3K
   *  alone, else $1001. */
  get basicStart(): number { return vic20BasicStart(this.memory.expansion); }

  /**
   * Start a program the way LOAD and RUN would on a freshly switched-on
   * VIC-20: the machine is reset and the program goes into memory once BASIC
   * is at READY. A program at the start of BASIC gets BASIC's pointers set
   * and, with `run`, RUN typed for it. Bytes that fall where no RAM is fitted
   * are dropped, as the bus would drop them. Safe while running: it only
   * touches the hardware between frames.
   */
  injectProgram(prog: C64Program, run: boolean): void {
    this.resetHardware();
    this.pendingProgram = { prog, run };
  }

  private basicReady(): boolean {
    if (this.framesSinceReset >= BOOT_FRAMES) return true;
    return this.framesSinceReset >= 10 && /(^|\n)READY\./.test(vic20ScreenText(this.memory, this.vic));
  }

  private applyPendingProgram(): void {
    const pending = this.pendingProgram;
    if (!pending) return;
    this.pendingProgram = null;
    const { prog, run } = pending;
    const mem = this.memory;
    const end = Math.min(0x10000, prog.start + prog.data.length);
    for (let a = prog.start; a < end; a++) {
      if (mem.isRam(a)) mem.ram[a] = prog.data[a - prog.start];
    }
    const ram = mem.ram;
    if (prog.start === (ram[TXTTAB] | (ram[TXTTAB + 1] << 8))) {
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

  /** A joystick direction or fire on the control port. */
  joystickPress(dir: string, pressed: boolean): void {
    if (dir === 'right') { this.joyRight = pressed; return; }
    const bit = JOY_VIA1[dir];
    if (!bit) return;
    this.joyVia1 = pressed ? this.joyVia1 | bit : this.joyVia1 & ~bit;
  }

  releaseJoysticks(): void { this.joyVia1 = 0; this.joyRight = false; }

  // ── Paddles ──────────────────────────────────────────────────────────────

  /** Plug a pair of paddles into the control port, or take them out. With
   *  none, the VIC's POT inputs float up and read $FF. */
  setPaddles(on: boolean): void {
    this.paddles = on;
    this.paddleButtons = 0;
    this.vic.potX = this.vic.potY = on ? 0x80 : 0xFF;
  }

  /** Turn the paddles: X with the mouse's left-right, Y with its up-down. A
   *  paddle turned clockwise (the mouse moved right or down) reads lower, as
   *  its resistance falls and the VIC's count with it. */
  turnPaddles(dx: number, dy: number): void {
    if (!this.paddles) return;
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    this.vic.potX = clamp(this.vic.potX - dx);
    this.vic.potY = clamp(this.vic.potY - dy);
  }

  /** A paddle's fire button: 0 for X's, 1 for Y's. */
  setPaddleButton(index: 0 | 1, pressed: boolean): void {
    if (!this.paddles) return;
    const bit = 1 << index;
    this.paddleButtons = pressed ? this.paddleButtons | bit : this.paddleButtons & ~bit;
  }

  // ── Frame ────────────────────────────────────────────────────────────────

  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo || this._tapeTurboActive; }
  protected override interruptEntryPending(): boolean { return this.cpu.interruptPending(); }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1 || this._tapeTurboActive;
    if (this.sound.audible === skipAudio) {
      // Turbo on or off: what was queued no longer lines up with the mixer.
      this.sound.audible = !skipAudio;
      this.sound.flush();
    }
    if (!this.openFrame(this.timing.cyclesPerFrame)) {
      this.activity.kbdReads = 0;
      this.activity.joyReads = 0;
      this.activity.soundWrites = 0;
      this.activity.tapeEdges = 0;
      this.keyboard.reads = 0;
      this.vic.beginFrame(this.frameStartT);
    }
    this.memWatchHit = null;
    const cpu = this.cpu;
    const endT = this.frameEndT;
    while (cpu.tStates < endT) {
      if (this.checkStops(cpu.pc)) {
        this.midFrame = true;
        this.vic.drawTo(cpu.tStates);
        this.needsDisplay = true;
        return;
      }
      const before = cpu.tStates;
      const pc = cpu.pc;
      this.beforeInsn(pc);
      this.insnStart = before;
      this.insnOp = cpu.interruptPending() ? -1 : this.memory.peekByte(pc);
      cpu.step();
      const stopped = this.afterInsn();
      this.syncVias(cpu.tStates);
      this.stepTape();
      this.updateInterrupts();
      this.sound.advanceTo(cpu.tStates);
      if (!skipAudio) {
        this.mixer.accumulate(0, cpu.tStates - before);
        this.mixer.generateSamples(this.audio, this.sound, true);
      }
      if (stopped) {
        this.midFrame = true;
        this.vic.drawTo(cpu.tStates);
        this.needsDisplay = true;
        return;
      }
    }
    this.vic.drawTo(endT);
    this.syncDrives(cpu.tStates);
    this.framesSinceReset++;
    if (this.pendingProgram && this.basicReady()) this.applyPendingProgram();
    this.checkAutoPlay();
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
      note: `line 0 is raster line 0 and cycle 0 of a line is where the ${this.timing.ntsc ? '6560' : '6561'}'s raster counter moves on; the text area starts at the vertical origin ($9001, in pairs of lines) and the horizontal origin ($9000, in cycles). The picture is drawn as the beam goes, caught up before every VIC write`,
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
    return (addr & 0xFC00) === 0x9000 ? -1 : this.memory.peekByte(addr);
  }

  protected override tracer = new M6502Trace(this, { io: [[0x9000, 0x93FF]], ioLabel: vic20IoLabel });

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: `${this.model}-ram-64k.bin` };
  }

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    switch (value) {
      case 'rom-basic': return { data: this.memory.basic, baseAddr: 0xC000 };
      case 'rom-kernal': return { data: this.memory.kernal, baseAddr: 0xE000 };
      case 'rom-chargen': return { data: this.memory.chargen, baseAddr: 0x8000 };
      case 'color-ram': return { data: this.memory.colorRam, baseAddr: 0x9400 };
      default: return null;
    }
  }

  /** The VIC and the VIAs, for the debugger's `chip_state`. */
  chips(): readonly ChipSection[] { return vic20Chips(this); }

  /** The text screen as the VIC shows it. */
  ocrScreenForMcp(_mode?: string): string {
    return vic20ScreenText(this.memory, this.vic);
  }

  /** The TEXT-overlay grid over the VIC's text area. */
  ocrScreenStyled(): C64OcrResult {
    const mem = this.memory;
    return vic20OcrGrid({
      regs: this.vic.regs,
      chargen: mem.chargen,
      palette: VIC20_PALETTE,
      vicRead: a => mem.vicRead(a),
      colour: a => mem.vicColour(a),
    });
  }

  /** Where the text area sits in the frame buffer: from the origins, in
   *  doubled pixels across. */
  get textField(): { x: number; y: number; width: number; height: number } {
    const r = this.vic.regs;
    const t = this.timing;
    return {
      x: ((r[0] & 0x7F) * 4 - t.firstPixel) * VIC20_PIXEL_DOUBLE,
      y: r[1] * 2 - t.firstLine,
      width: (r[2] & 0x7F) * 8 * VIC20_PIXEL_DOUBLE,
      height: ((r[3] >> 1) & 0x3F) * ((r[3] & 1) !== 0 ? 16 : 8),
    };
  }

  /** Paint the overlay's matched cells out of the frame, each in its `paper`. */
  blankCells(mask: readonly boolean[], paper: readonly number[]): void {
    const px = this.vic.pixels;
    const w = this.vic.width, h = this.vic.height;
    const field = this.textField;
    const cols = this.vic.regs[2] & 0x7F;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const left = field.x + (i % cols) * 8 * VIC20_PIXEL_DOUBLE;
      const top = field.y + Math.floor(i / cols) * 8;
      const colour = VIC20_PALETTE[paper[i] & 0x0F];
      for (let y = Math.max(0, top); y < Math.min(h, top + 8); y++) {
        const x0 = Math.max(0, left), x1 = Math.min(w, left + 8 * VIC20_PIXEL_DOUBLE);
        if (x1 > x0) px.fill(colour, y * w + x0, y * w + x1);
      }
    }
  }

  // ── Snapshots (.vic20state) ──────────────────────────────────────────────

  /** CRC-32s of BASIC, the KERNAL and the character ROM. */
  stateRomCrcs(): number[] {
    return [crc32(this.memory.basic), crc32(this.memory.kernal), crc32(this.memory.chargen)];
  }

  private completeFrame(): void {
    if (this.midFrame) withStopsDisarmed(this, () => this.stepFrame());
  }

  /** The fitted expansion, as text for a refusal. */
  private static expansionName(e: Vic20RamExpansion): string {
    const parts = [e.ram123 && '3K', e.blk1 && 'BLK1', e.blk2 && 'BLK2', e.blk3 && 'BLK3', e.blk5 && 'BLK5']
      .filter(Boolean);
    return parts.length > 0 ? `expansion RAM in ${parts.join(', ')}` : 'no expansion RAM';
  }

  /** The machine's state between frames. */
  saveState(w: StateWriter, withMedia: boolean): void {
    this.completeFrame();
    const e = this.memory.expansion;
    // The fitted memory first, so a restore can refuse a mismatch before it
    // changes anything.
    w.section('CONF', () => {
      w.bool(this.timing.ntsc);
      w.bool(e.ram123); w.bool(e.blk1); w.bool(e.blk2); w.bool(e.blk3); w.bool(e.blk5);
    });
    w.section('CART', () => saveCartridge(w, this.memory.cart));
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameStartT); w.f64(this.frameEndT); w.f64(this.frameNumber);
      w.bool(this.nmiLevel);
    });
    w.section('MEM ', () => this.memory.saveState(w));
    w.section('VIC ', () => this.vic.saveState(w));
    w.section('SND ', () => this.sound.saveState(w));
    w.section('VIA1', () => this.via1.saveState(w));
    w.section('VIA2', () => this.via2.saveState(w));
    this.iec.saveState(w, withMedia);
  }

  loadState(r: StateReader): void {
    {
      const s = r.section('CONF');
      const ntsc = s.bool();
      const exp: Vic20RamExpansion = {
        ram123: s.bool(), blk1: s.bool(), blk2: s.bool(), blk3: s.bool(), blk5: s.bool(),
      };
      if (ntsc !== this.timing.ntsc) {
        throw new Error(`This is a ${ntsc ? 'NTSC' : 'PAL'} snapshot: choose the ${ntsc ? 'NTSC' : 'PAL'} VIC-20 first`);
      }
      const have = this.memory.expansion;
      const same = exp.ram123 === have.ram123 && exp.blk1 === have.blk1 && exp.blk2 === have.blk2
        && exp.blk3 === have.blk3 && exp.blk5 === have.blk5;
      if (!same) {
        throw new Error(`This snapshot was saved with ${Vic20Machine.expansionName(exp)} and this VIC-20 has ${Vic20Machine.expansionName(have)}`);
      }
    }
    {
      const cart = loadCartridge(r.section('CART'));
      if (cart || this.memory.cart) {
        this.memory.setCartridge(cart);
        this.cartridgeFile = '';
      }
    }
    this.cpu.loadState(r.section('CPU '));
    {
      const s = r.section('MACH');
      this.frameStartT = s.f64(); this.frameEndT = s.f64(); this.frameNumber = s.f64();
      this.nmiLevel = s.bool();
    }
    this.memory.loadState(r.section('MEM '));
    this.vic.loadState(r.section('VIC '));
    this.sound.loadState(r.section('SND '));
    this.via1.loadState(r.section('VIA1'));
    this.via2.loadState(r.section('VIA2'));
    // One DRVM, DRV and MEDA section for each drive, device 8 first.
    const withMedia = this.iec.loadState(r);
    this.viaT = this.cpu.tStates;
    this.midFrame = false;
    this.pendingProgram = null;
    this.framesSinceReset = BOOT_FRAMES;
    this.refreshResumed = !withMedia;
    this.motorWasOn = this.motorOn;
    this.tapeLastT = this.cpu.tStates;
    this._tapeTurboActive = false;
    this.tapeTurboCooldown = 0;
    this.clearInterrupts();
    this.keyboard.reset();
    this.joyVia1 = 0;
    this.joyRight = false;
    // The VIAs' pin inputs come back with their state; the next access
    // recomputes them. The VIC starts drawing at the next frame.
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
  }
}

/** A VIA register without the side effects of reading it (the interrupt flags
 *  a read of a port or a timer clears stay as they were). */
function peekVia(via: M6522, reg: number): number {
  const ifr = via.ifr;
  const v = via.read(reg);
  via.ifr = ifr;
  return v;
}

/** Trace labels for the I/O block. */
function vic20IoLabel(addr: number): string {
  if ((addr & 0xFC00) !== 0x9000) return 'IO';
  if ((addr & 0x0300) === 0) return 'VIC';
  const parts = [(addr & 0x10) !== 0 && 'VIA1', (addr & 0x20) !== 0 && 'VIA2'].filter(Boolean);
  return parts.length > 0 ? parts.join('+') : 'IO';
}
