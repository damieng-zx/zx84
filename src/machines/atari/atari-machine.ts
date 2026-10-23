/**
 * Atari 400 / 800 / XL motherboard.
 *
 * A 1.79 MHz (NTSC) or 1.77 MHz (PAL) 6502 with the Atari chip set: ANTIC
 * (display list + DMA), GTIA (colour, players/missiles, collisions, console
 * keys, the internal speaker), POKEY (four sound channels, timers, keyboard,
 * serial) and a 6821 PIA. Port A is joysticks 1-2; port B is joysticks 3-4 on
 * the 400/800 and the memory-control register on the XL machines. The PIA's
 * CA2/CB2 control lines drive the cassette motor and the SIO command line.
 *
 * The XL machines also repurpose GTIA's TRIG3 input as the cartridge-present
 * sense: the XL OS reads it at boot and re-checks it every vertical blank.
 *
 * The frame loop is scanline-based: ANTIC is stepped at the start of each of
 * the 262/312 lines, its DMA steals are charged against the 114 cycles the
 * CPU gets per line, the CPU runs to the line boundary (WSYNC ends it early),
 * and the line is drawn. NMI/DLI/VBI are raised from ANTIC's own flags, and
 * POKEY's IRQ is sampled after every instruction.
 */

import { M6502 } from '@/cores/m6502.ts';
import { M6821 } from '@/cores/m6821.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { soundDeviceGains } from '@/machines/machine.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, HostKeyEvent, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import {
  BEAM_DL, BEAM_DMA, BEAM_EFF, BEAM_IO, DL_FETCH, DL_VISIBLE, IRQ_CRITIC, IRQ_I_SET, type BeamInfo, type BeamPos,
} from '@/debug/beam-log.ts';
import { ANTIC_BASE, REG_HSCROL } from './line-writes.ts';
import type { StopKind } from '@/debug/stop-reason.ts';
import type { ChipSection } from '@/debug/chip-state.ts';
import { accessCycle } from '@/debug/m6502/bus-cycles.ts';
import { Antic, ANTIC_FIRST_LINE, ANTIC_LAST_LINE, ANTIC_MODES } from './antic.ts';
import { AtariCartridge, type AtariCartType } from './cartridge.ts';
import { AtariMemory } from './memory.ts';
import { AtariVideo } from './atari-video.ts';
import { ANTIC_VBI_LINE, type AnticLine } from './antic.ts';
import {
  buildAtariPalette, resolveAtariPalette, type AtariPaletteId, type AtariVideoBoard,
} from './palette.ts';
import { Gtia } from './gtia.ts';
import { LineWrites } from './line-writes.ts';
import { Pokey } from './pokey.ts';
import { atariDescriptor } from './descriptor.ts';
import { createAtariServices, type AtariServices } from './services/index.ts';
import { AtariSio, SIO_ENTRY } from './sio.ts';
import { SioBus } from './sio-bus.ts';
import { SioDisks } from './sio-disk.ts';
import {
  atariInfo, atariIs400, atariModelName, atariTimingFor,
  type AtariModel, type AtariRegion,
} from './models.ts';
import {
  ATARI_BORDER_LEFT, ATARI_BORDER_TOP, ATARI_SCREEN_HEIGHT, ATARI_SCREEN_WIDTH,
  type AtariTiming,
} from './constants.ts';
import { CONSOLE_KEYS, mapAtariKey, isModifierKey } from './keyboard.ts';
import { atariOcrGrid, atariOcrText, type AtariOcrInput } from '@/ocr/atari.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import { AtariCassette } from './cassette.ts';
import { XEX_TRAP, XexLoader, type XexHost, type XexSegment } from './xex.ts';
import { normalizeDriveModels } from './drive-models.ts';
import {
  AtariAutostart, compileAutostart, opsNeedBasic, type AutostartHost, type AutostartOp,
} from './autostart.ts';

/** The cartridge boards a snapshot may name. */
const CART_TYPES: ReadonlySet<string> = new Set<AtariCartType>([
  'std8', 'std16', 'oss-m091', 'oss-034m', 'oss-043m', 'oss8',
]);

/** Cycle of the line at which ANTIC posts NMIST and raises a VBI/DLI NMI. */
const NMI_CYCLE = 7;
/** How long after a tape read the tape still counts as loading (see
 *  `AtariMachine.tapeLoadingActive`): longer than a BASIC loader takes to
 *  poke the bytes of one record. */
const TAPE_IDLE_SECONDS = 3;
/** The XL's CONSOL speaker level, in units of POKEY's full scale. The manual
 *  gives no figure; this keeps the step the mixer gave it (0.8 x 0.5). */
const XL_SPEAKER_LEVEL = 0.4;
/** The 400/800's internal speaker against POKEY at full scale. */
const SPEAKER_GAIN = 0.5;
/** An instruction starting this many cycles before NMI_CYCLE still does its
 *  read (on its last cycle) after the status went up. */
const NMIST_READ_LEAD = 3;
/** The part of the line over which ANTIC's DMA takes its cycles (refresh
 *  and playfield fetches), so the CPU's own cycles spread across the line as
 *  they do on hardware: none before STEAL_START, all by STEAL_END. */
const STEAL_START = 16;
const STEAL_END = 106;
/** The point of the line where ANTIC samples DMACTL's playfield width and
 *  fetches the mode line's screen bytes (it reads them over the cycles from
 *  about here to STEAL_END): a store the CPU made before it counts for this
 *  line, one made after it for the next. */
const FETCH_SAMPLE_CYCLE = STEAL_START;
/** Cycles from the start of an instruction to its data read (an absolute load). */
const VCOUNT_READ_LEAD = 3;
const STEAL_SPAN = STEAL_END - STEAL_START;

/** The POKEY interrupt sources an IRQST value (active low) shows as pending. */
function atariPendingIrq(irqst: number): string {
  const names: [number, string][] = [
    [0x80, 'BREAK'], [0x40, 'KEY'], [0x20, 'SERIN'], [0x10, 'SEROUT'], [0x08, 'SERDONE'],
    [0x04, 'TIMER4'], [0x02, 'TIMER2'], [0x01, 'TIMER1'],
  ];
  return names.filter(([bit]) => ((~irqst) & bit) !== 0).map(([, n]) => n).join(' ');
}

/** Flag on a queued access (see `accessLog`): this one is a display-list
 *  pointer write and goes in the log as a BEAM_DL entry. */
const ACCESS_DL = 4;

/** What `runAtariLine` did: the line finished, a stop left it part-way, or it
 *  finished and a stop is wanted after it. */
const LINE_DONE = 0;
const LINE_PARKED = 1;
const LINE_STOPPED = 2;

/** The line in progress: everything the instruction loop needs that a stop
 *  in the middle of the line must keep for the next call. */
interface AtariLineState {
  al: AnticLine;
  line: number;
  start: number;
  end: number;
  visible: boolean;
  vbi: boolean;
  dli: boolean;
  rnmi: boolean;
  nmiAt: number;
  statusDue: boolean;
  nmiDue: boolean;
  steal: number;
  stolen: number;
  sampled: boolean;
}

/**
 * True when a 6821 control register drives its C2 pin low. The pin is an
 * output only with bit 5 set, and follows bit 3 only in manual mode (bit 4
 * also set): $34 is low, $3C high. As an input (bit 5 clear) nothing drives
 * it and it reads high, so the line is off; the handshake/pulse modes (bits
 * 5-4 = 10) only dip it around port accesses, also taken as off.
 */
function c2DrivenLow(cr: number): boolean {
  return (cr & 0x38) === 0x30;
}

/** Joystick direction to PIA PORTA bit. */
const JOY_BITS: Readonly<Record<string, number>> = {
  up: 0x01, down: 0x02, left: 0x04, right: 0x08,
};

export class AtariMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'atari';
  readonly model: AtariModel;
  /** TV standard: clock, scanlines, frame rate, palette and GTIA's PAL bit. */
  readonly region: AtariRegion;
  host: MachineHost | null = null;
  readonly services: AtariServices;
  /** SIO fast path (see `sio.ts`). */
  readonly sio: AtariSio;
  /** The device end of the serial bus, for programs that drive POKEY's
   *  serial port themselves (see `sio-bus.ts`). */
  readonly sioBus: SioBus;

  readonly cpu = new M6502();
  readonly memory: AtariMemory;
  readonly antic = new Antic();
  readonly gtia = new Gtia();
  readonly pokey: Pokey;
  readonly pia = new M6821();
  readonly video: AtariVideo;
  /** The picture-affecting register writes of the line being run, with the
   *  cycle each landed on, so the line can be drawn with them mid-line. */
  readonly lineWrites = new LineWrites();
  /** POKEY writes made during the CPU step being run, as (address, value,
   *  cycles before the step's end) triples, applied on their own cycle. */
  private readonly pokeyWrites: number[] = [];
  /** True while `cpu.step()` runs, so POKEY writes wait for their cycle. */
  private inStep = false;
  /** The POKEY address read during this step (-1 for none), and its value. */
  private pokeyReadAddr = -1;
  private pokeyReadValue = 0;
  readonly mixer: AudioMixer;
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  /** Per-frame activity counters read by the frame probe. */
  readonly activity = { keyPresses: 0, psgWrites: 0, casReads: 0, speakerToggles: 0 };
  /** The 410/1010 program recorder: its tape runs while the motor line is
   *  on and drives POKEY's serial input; SIO reads take whole records. */
  readonly cassette: AtariCassette;
  /** A DOS executable armed to load on the next boot (see xex.ts). */
  xex: XexLoader | null = null;
  /** OPTION is being held for an XEX boot, to keep XL BASIC out of $A000. */
  private xexHoldsOption = false;
  /** The auto-start script running after a Load (see autostart.ts), if any.
   *  An explicit reset or cartridge change cancels it. */
  autostart: AtariAutostart | null = null;
  /** The BASIC cartridge image the shell inserts under an empty name on the
   *  400/800/1200XL, kept so auto-start can put BASIC back after taking it
   *  out for a game. */
  hiddenBasic: Uint8Array | null = null;
  /** A user's BASIC image from the ROM pane. Where BASIC is a cartridge it
   *  stands in for the default one the shell mounts under an empty name. */
  basicOverride: Uint8Array | null = null;
  /** The auto-start script is doing the reset (so reset() must not cancel it). */
  private autostartResetting = false;

  /** Logical joystick direction bits for both ports (1 = pressed). */
  readonly joyDir = new Uint8Array(2);
  /** Cartridge name shown by the ROM pane. */
  cartridgeName = '';
  /** Cassette motor (PACTL CA2) and SIO command (PBCTL CB2) lines, both
   *  active low (see `c2DrivenLow`). */
  cassetteMotor = false;
  /** "Turbo while loading": run flat out while the recorder is playing. */
  tapeTurbo = true;
  /** Frames left in the window after a tape read in which the tape still
   *  counts as loading (see `tapeLoadingActive`). */
  private tapeIdleFrames = 0;
  sioCommand = false;

  private readonly timing: AtariTiming;
  private wsyncRequested = false;
  /** SYSTEM RESET was pressed on a 400/800: ANTIC raises RNMI at the next vertical blank. */
  private rnmiPending = false;
  /** CPU cycle the current line began at, for reads that depend on where in the line they land. */
  private lineStartT = 0;
  /** A frame is in progress (started, not finished); `fLine` is the next line
   *  to run in it, and `lineLive` says the line `ls` describes is part-way. */
  private frameLive = false;
  private lineLive = false;
  private fLine = 0;
  private fSkipAudio = false;
  private readonly ls: AtariLineState = {
    al: null as unknown as AnticLine, line: 0, start: 0, end: 0, visible: false, vbi: false, dli: false,
    rnmi: false, nmiAt: 0, statusDue: false, nmiDue: false, steal: 0, stolen: 0, sampled: false,
  };
  /** The lowest and highest address any memory watchpoint covers (lo above hi
   *  when there are none), so the CPU's bus closures pay one range compare and
   *  nothing more for an access outside every watchpoint. Refreshed when a
   *  frame (or the rest of one) starts running: watchpoints change between runs. */
  private watchLo = 0x10000;
  private watchHi = -1;
  private refreshWatchBounds(): void {
    let lo = 0x10000, hi = -1;
    for (const wp of this.memWatchpoints) {
      if (wp.start < lo) lo = wp.start;
      if (wp.end > hi) hi = wp.end;
    }
    this.watchLo = lo;
    this.watchHi = hi;
  }
  /** Instructions left before a single-step request stops the run; -1 = none. */
  private stepsLeft = -1;
  /** Set while the rest of a frame is run for a snapshot: nothing may stop it. */
  private ignoreStops = false;
  /** A WSYNC store ended past its line's end: the next line is spent halted. */
  private wsyncCarried = false;
  private lastAudioT = 0;
  /** CPU cycle count at which the current frame began. Frames sit on a fixed
   *  grid of `tStatesPerFrame`, so an instruction that overruns a frame's
   *  last line does not stretch every later frame. */
  private frameBase = 0;
  /** CPU cycle the frame in progress began at: `frameBase` as it was before
   *  `runFrame` moved it on to the next frame. `beam()` measures from it. */
  private beamFrameStart = 0;
  private keysDown = 0;
  /** The mixer's weight on the CONSOL speaker (1 at the centre). */
  private speakerWeight = 1;
  /** The palette the video is drawing with (see palette.ts). */
  private paletteId: AtariPaletteId = 'tv';

  constructor(model: AtariModel, display?: IScreenRenderer | null, region: AtariRegion = 'pal') {
    super();
    this.model = model;
    this.region = region;
    this.timing = atariTimingFor(region);
    this.display = display ?? null;

    const info = atariInfo(model);
    this.memory = new AtariMemory({
      ramSize: info.ramKb * 1024, xl: info.xl, builtinBasic: info.builtinBasic,
      extBanks: info.extBanks,
    });
    this.pokey = new Pokey(this.timing.clockHz);
    this.cassette = new AtariCassette(this.timing.clockHz);
    this.sioBus = new SioBus(new SioDisks(this), this.timing.clockHz);
    // The bus's PROCEED and INTERRUPT lines are the PIA's CA1 and CB1; a device
    // pulling one low is a high-to-low edge, the transition the OS selects.
    this.sioBus.onProceed = asserted => this.pia.setC1(0, !asserted);
    this.sioBus.onInterrupt = asserted => this.pia.setC1(1, !asserted);
    // The SIO data-in line is a wired AND of whatever is driving it: the
    // recorder while its motor runs, and the disk drives answering a command
    // frame POKEY sent. Both idle at mark (1).
    this.pokey.serialIn = () => (this.cassetteMotor ? this.cassette.level() : 1) & this.sioBus.level();
    this.pokey.onSerialOut = (byte, cyclesLeft) => this.sioBus.receive(byte, cyclesLeft);
    this.gtia.pal = this.timing.pal;
    this.video = new AtariVideo(this.timing.pal);
    this.video.setPalette(buildAtariPalette(this.timing.pal, this.paletteId, this.videoBoard));
    this.audio = new Audio();
    this.mixer = new AudioMixer(this.timing.clockHz);
    // Both a POKEY and the GTIA speaker feed the mixer, at the hardware's
    // balance until applySettings() weighs them.
    this.mixer.beeperGain = SPEAKER_GAIN;
    this.mixer.psgGain = 1;

    // Watchpoints hook the CPU's own bus access here, not AtariMemory: the SIO
    // fast path and the XEX loader reach memory through AtariMemory, and those
    // are not accesses the program made.
    this.antic.onDlFetch = (address, instr, operand) => this.logDlFetch(address, instr, operand);
    this.cpu.onInterrupt = (vector) => {
      const nmi = vector === 0xFFFA;
      // The OS skips a VBI's deferred stage when CRITIC is set or the
      // interrupted code had the I flag set (the P the CPU just pushed).
      let why = 0;
      if (nmi && (this.antic.nmist & 0x40) !== 0 && this.interruptLogging) {
        if (this.memory.readRam(0x42) !== 0) why |= IRQ_CRITIC;
        if ((this.memory.readRam(0x100 | ((this.cpu.sp + 1) & 0xFF)) & 0x04) !== 0) why |= IRQ_I_SET;
      }
      this.noteInterrupt(this.cpu.pc, nmi, nmi ? this.antic.nmist : this.pokey.readReg(0xD20E), why);
    };
    this.cpu.read = (addr) => {
      const v = this.memory.readByte(addr);
      if (addr >= this.watchLo && addr <= this.watchHi) this.recordMemWatch(addr, v, 'read');
      return v;
    };
    this.cpu.write = (addr, val) => {
      this.memory.writeByte(addr, val);
      if (addr >= this.watchLo && addr <= this.watchHi) this.recordMemWatch(addr, val & 0xFF, 'write');
    };
    this.antic.read = (addr) => this.memory.readRam(addr);
    this.antic.onWsyc = () => { this.wsyncRequested = true; };
    this.memory.onCartEnable = () => this.senseCartridge();
    this.memory.ioRead = (addr) => this.readHardware(addr);
    this.memory.ioPeek = (addr) => this.peekHardware(addr);
    this.memory.ioWrite = (addr, val) => this.writeHardware(addr, val);
    this.pia.inputB = 0xFF;

    this.services = createAtariServices(this);
    this.sio = new AtariSio(this);
  }

  protected override get audioChip(): Pokey { return this.pokey; }
  protected override get frameHz(): number { return this.timing.pal ? 50 : 60; }

  get descriptor(): MachineDescriptor {
    return atariDescriptor(this.model, this.region === 'ntsc' ? 'us' : 'uk');
  }
  get pixels(): Uint8Array { return this.video.pixels; }
  get frameWidth(): number { return ATARI_SCREEN_WIDTH; }
  get frameHeight(): number { return ATARI_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number { return this.timing.tStatesPerFrame; }
  get cpuClockHz(): number { return this.timing.clockHz; }
  get ramSize(): number { return this.memory.totalRamSize; }

  attachHost(host: MachineHost): void { this.host = host; }

  applySettings(view: SettingsView): void {
    const paletteId = resolveAtariPalette(this.timing.pal, view.get<string>('atari-color-map', 'tv'));
    if (paletteId !== this.paletteId) {
      this.paletteId = paletteId;
      this.video.setPalette(buildAtariPalette(this.timing.pal, paletteId, this.videoBoard));
    }
    this.audio.setVolume(view.get('volume', 70) / 100);
    this.tapeTurbo = view.get('tape-turbo-load', true);
    // Each source has its own volume, declared by the descriptor's soundDevices.
    const gains = soundDeviceGains(this.descriptor.ui.soundDevices, view);
    this.speakerWeight = Math.min(1, gains.beeper);
    const pokeyWeight = Math.min(1, gains.psg);
    this.mixer.beeperGain = SPEAKER_GAIN * this.speakerWeight;
    if (this.memory.xl) {
      // The XL's speaker is inside POKEY's output, so weigh the two there.
      this.pokey.setChannelGain(pokeyWeight);
      this.pokey.setExternal(this.xlSpeakerLevel());
    } else {
      this.mixer.psgGain = pokeyWeight;
    }
    this.fitDrives(view);
  }

  /** Fit the drives the Drives pane has set up, each with its own model. A
   *  disk stays in a drive that is still there; this changes nothing when the
   *  drives already match. */
  private fitDrives(view: SettingsView): void {
    this.services.disks.configure(normalizeDriveModels(view.get<unknown>('drive-models:atari', null)));
  }

  /** The drives are fitted before the machine boots, so the shell can put
   *  carried and restored disks into the right ones. */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.fitDrives(view);
    return [];
  }

  /** The XL's CONSOL level into POKEY's output, weighted by the mixer: the
   *  speaker joins POKEY there, so the mixer's own gains never see it. */
  private xlSpeakerLevel(): number {
    return this.gtia.speaker ? XL_SPEAKER_LEVEL * this.speakerWeight : 0;
  }

  /**
   * Crop the border for display (None / Small / Normal), as the other
   * machines do. The renderer always draws the full 336x240 frame with the
   * GRAPHICS 0 area at (8, 24); cropping is a viewport change only, and it
   * is what the TEXT overlay's placement assumes.
   */
  setBorderSize(mode: BorderMode): void {
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(ATARI_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(ATARI_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY,
      ATARI_SCREEN_WIDTH - cropX * 2,
      ATARI_SCREEN_HEIGHT - cropY * 2,
    );
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  reset(warm = false): void {
    if (!this.autostartResetting) this.cancelAutostart();
    this.antic.reset(warm);
    this.rnmiPending = false;
    this.gtia.reset();
    this.senseCartridge();
    if (this.xex) {
      // Reboot the executable, as a reset reboots DOS. With built-in BASIC
      // (600XL/800XL) hold OPTION through the OS's boot so BASIC stays out of
      // $A000-$BFFF; the trap lets go once loading starts.
      this.xex.rearm();
      if (this.memory.basicRom && (this.gtia.consol & 0x04) !== 0) {
        this.gtia.consol &= ~0x04;
        this.xexHoldsOption = true;
      }
    }
    this.pokey.reset();
    this.pia.reset();
    this.memory.reset();
    this.cassette.reset();
    this.joyDir.fill(0);
    this.keysDown = 0;
    this.cassetteMotor = false;
    this.tapeIdleFrames = 0;
    this.sioCommand = false;
    this.sioBus.reset();
    this.wsyncRequested = false;
    this.wsyncCarried = false;
    this.lastAudioT = 0;
    this.audio.reset();
    this.mixer.reset();
    this.cpu.reset();
    this.frameBase = this.cpu.tStates;
    this.beamFrameStart = this.frameBase;
    this.resumeSkipPc = -1;
    this.dropFrameInProgress();
    // A warm reset keeps counting so a log that spans it stays in order.
    if (!warm) this.resetFrameCount();
    this.needsDisplay = true;
    this.setStatus(`Atari ${atariModelName(this.model)} (${this.region.toUpperCase()}) reset`);
  }

  // ── Beam seam ────────────────────────────────────────────────────────────

  /** The frame in progress and the cycles since it started: `line * 114` plus
   *  the cycle in the line, since a frame is a whole number of lines. Between
   *  frames it is the next frame, a few cycles in. (A frame a breakpoint
   *  stopped part-way is not resumable yet, so right after one the next
   *  frame's start is ahead of the CPU and `t` is negative.) */
  beam(): BeamPos {
    const start = this.frameOpen ? this.beamFrameStart : this.frameBase;
    return { frame: this.frameNumber, t: this.cpu.tStates - start };
  }

  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: this.timing.cyclesPerLine,
      linesPerFrame: this.timing.linesPerFrame,
      displayStart: ANTIC_FIRST_LINE * this.timing.cyclesPerLine,
    };
  }

  // ── Chip state ───────────────────────────────────────────────────────────

  /** The custom chips, for the debugger's `chip_state`. Every dump reads the
   *  chips' own state, never the bus, so it clears no flag and trips no
   *  watchpoint. */
  chips(): readonly ChipSection[] {
    return [
      { name: 'antic', description: 'ANTIC: display-list processor (DMACTL, display list, scroll, NMI)', dump: () => this.dumpAntic() },
      { name: 'gtia', description: 'GTIA: colours, players/missiles, priority, console', dump: () => this.dumpGtia() },
      { name: 'pokey', description: 'POKEY: audio, timers, keyboard, serial, IRQ', dump: () => this.dumpPokey() },
      { name: 'pia', description: 'PIA 6520: joystick ports and the XL memory-control lines', dump: () => this.dumpPia() },
    ];
  }

  private dumpAntic(): string {
    const a = this.antic;
    const h = (v: number, w = 2) => v.toString(16).toUpperCase().padStart(w, '0');
    const dmactl = a.dmactl;
    const width = ['none', 'narrow', 'normal', 'wide'][dmactl & 3];
    const lines = [
      `DMACTL  D400 = ${h(dmactl)}  playfield ${width}, missile DMA ${dmactl & 4 ? 'on' : 'off'}, player DMA ${dmactl & 8 ? 'on' : 'off'}, ` +
      `${dmactl & 16 ? 'single' : 'double'}-line PM, display-list DMA ${dmactl & 32 ? 'on' : 'off'}`,
      `CHACTL  D401 = ${h(a.chactl)}`,
      `DLISTL/H D402/3 = ${h(a.dlistStart, 4)}  (counter now ${h(a.dlistCounter, 4)})`,
      `HSCROL  D404 = ${h(a.hscrol)}   VSCROL D405 = ${h(a.vscrol)}`,
      `PMBASE  D407 = ${h(a.pmbase)}   CHBASE D409 = ${h(a.chbase)}`,
      `VCOUNT  D40B = ${h((a.line >> 1) & 0xFF)}  (line ${a.line})`,
      `NMIEN   D40E = ${h(a.nmien)}  ${a.nmien & 0x80 ? 'DLI ' : ''}${a.nmien & 0x40 ? 'VBI' : ''}`.trimEnd(),
      `NMIST   D40F = ${h(a.nmist | 0x1F)}  ${a.nmist & 0x80 ? 'DLI ' : ''}${a.nmist & 0x40 ? 'VBI ' : ''}${a.nmist & 0x20 ? 'RESET' : ''}`.trimEnd(),
      '',
      `Display list from ${h(a.dlistStart, 4)}:`,
    ];
    // Decode it the way ANTIC reads it: scanlines count from the first
    // display line, and a JVB ends the list.
    let pc = a.dlistStart;
    let line = ANTIC_FIRST_LINE;
    for (let n = 0; n < 64; n++) {
      const instr = a.read(pc) & 0xFF;
      const mode = instr & 0x0F;
      const flags = `${instr & 0x80 ? ' DLI' : ''}`;
      if (mode === 0) {
        const count = ((instr >> 4) & 7) + 1;
        lines.push(`  ${h(pc, 4)}  ${h(instr)}           blank ${count}${flags}   lines ${line}-${line + count - 1}`);
        line += count; pc = (pc + 1) & 0xFFFF;
        continue;
      }
      if (mode === 1) {
        const target = a.read(pc + 1) | (a.read(pc + 2) << 8);
        lines.push(`  ${h(pc, 4)}  ${h(instr)} ${h(target & 0xFF)} ${h(target >> 8)}     ${instr & 0x40 ? 'JVB' : 'JMP'} ${h(target, 4)}${flags}`);
        if (instr & 0x40) break;
        pc = target;
        continue;
      }
      const info = ANTIC_MODES[mode];
      const lms = (instr & 0x40) !== 0;
      const operand = lms ? a.read(pc + 1) | (a.read(pc + 2) << 8) : 0;
      const count = info ? info.lines : 1;
      lines.push(`  ${h(pc, 4)}  ${h(instr)}${lms ? ` ${h(operand & 0xFF)} ${h(operand >> 8)}` : '      '}     mode ${mode.toString(16).toUpperCase()}` +
        `${lms ? ` LMS ${h(operand, 4)}` : ''}${flags}${instr & 0x20 ? ' VSCROL' : ''}${instr & 0x10 ? ' HSCROL' : ''}   lines ${line}-${line + count - 1}`);
      line += count; pc = (pc + (lms ? 3 : 1)) & 0xFFFF;
    }
    return lines.join('\n');
  }

  private dumpGtia(): string {
    const g = this.gtia;
    const h = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
    const names = [
      'HPOSP0', 'HPOSP1', 'HPOSP2', 'HPOSP3', 'HPOSM0', 'HPOSM1', 'HPOSM2', 'HPOSM3',
      'SIZEP0', 'SIZEP1', 'SIZEP2', 'SIZEP3', 'SIZEM', 'GRAFP0', 'GRAFP1', 'GRAFP2', 'GRAFP3', 'GRAFM',
      'COLPM0', 'COLPM1', 'COLPM2', 'COLPM3', 'COLPF0', 'COLPF1', 'COLPF2', 'COLPF3', 'COLBK',
      'PRIOR', 'VDELAY', 'GRACTL',
    ];
    const rows = names.map((n, i) => `${n.padEnd(7)} D0${h(i)} = ${h(g.regValue(i))}`);
    const prior = g.prior;
    rows.push('', `PRIOR: priority ${prior & 0x0F}${prior & 0x10 ? ', 5th player' : ''}${prior & 0x20 ? ', multicolour players' : ''}, ` +
      `mode ${['normal', '9 (16 luminances)', '10 (9 colours)', '11 (16 colours)'][prior >> 6]}`);
    rows.push(`CONSOL  D01F = ${h(g.consol)}  (active low: START ${g.consol & 1 ? 'up' : 'down'}, SELECT ${g.consol & 2 ? 'up' : 'down'}, OPTION ${g.consol & 4 ? 'up' : 'down'})`);
    rows.push('(The write-only registers above are the chip\'s own values, not the OS shadows.)');
    return rows.join('\n');
  }

  private dumpPokey(): string {
    const p = this.pokey;
    const h = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
    const rows: string[] = [];
    for (let i = 0; i < 4; i++) rows.push(`AUDF${i + 1}  D20${i * 2} = ${h(p.audf[i])}   AUDC${i + 1} D20${i * 2 + 1} = ${h(p.audc[i])}`);
    rows.push(
      `AUDCTL  D208 = ${h(p.audctl)}`,
      `IRQEN   D20E = ${h(p.irqen)}  ${[[0x80, 'BREAK'], [0x40, 'KEY'], [0x20, 'SERIN'], [0x10, 'SEROUT'], [0x08, 'SERDONE'], [0x04, 'TIMER4'], [0x02, 'TIMER2'], [0x01, 'TIMER1']]
        .filter(([bit]) => (p.irqen & (bit as number)) !== 0).map(([, n]) => n).join(' ')}`,
      `IRQST   D20E = ${h(p.readReg(0xD20E))}  (active low; pending: ${atariPendingIrq(p.readReg(0xD20E)) || 'none'})`,
      `SKCTL   D20F = ${h(p.skctl)}   SKSTAT D20F = ${h(p.readReg(0xD20F))}`,
      `KBCODE  D209 = ${h(p.kbcode)}   SERIN D20D = ${h(p.serin)}`,
    );
    for (let i = 0; i < 4; i++) {
      const t = p.timerInfo(i);
      const clock = t.clock === 'fast' ? '1.79 MHz' : t.clock === 'linked' ? 'linked into a 16-bit pair' : t.base15k ? '15 kHz' : '64 kHz';
      rows.push(`Timer ${i + 1}: AUDF ${h(p.audf[i])}, clock ${clock}, ${Number.isFinite(t.underflowIn)
        ? `next underflow in ${t.underflowIn} CPU cycles` : 'not counting'}`);
    }
    return rows.join('\n');
  }

  private dumpPia(): string {
    const p = this.pia;
    const h = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
    const s = p.exportState();
    const rows: string[] = [];
    for (let i = 0; i < 2; i++) {
      const port = i === 0 ? 'PORTA' : 'PORTB';
      rows.push(
        `${port}  D30${i} = ${h(p.portValue(i))}  (pins, with the direction register applied)   DDR ${h(p.ddr[i])}  output latch ${h(p.out[i])}`,
        `PACTL/PBCTL D30${i + 2} = ${h(p.cr[i])}  data register ${p.cr[i] & 4 ? 'selected' : 'DDR selected'}, C1 flag ${s[6 + i * 2] ? 'set' : 'clear'}, C2 flag ${s[7 + i * 2] ? 'set' : 'clear'}`,
      );
    }
    rows.push(`IRQ line: ${p.irq ? 'asserted' : 'clear'}`);
    return rows.join('\n');
  }

  /** Forget a frame that was stopped part-way (a reset or a loaded snapshot
   *  starts the machine over, so there is nothing to resume). */
  private dropFrameInProgress(): void {
    this.frameLive = false;
    this.lineLive = false;
    this.fLine = 0;
    this.midFrame = false;
    this.stepsLeft = -1;
    this.accessLog.length = 0;
    this.clearInterrupts();
  }

  /** Run the rest of a frame that was stopped part-way, with every stop
   *  ignored, so the machine is between frames (a snapshot needs that). */
  private completeFrame(): void {
    if (!this.midFrame) return;
    this.ignoreStops = true;
    try {
      this.stepFrame();
    } finally {
      this.ignoreStops = false;
    }
  }

  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  /** The 6502 pushes PCH, PCL, P: the return address is at SP+2 (low), SP+3 (high). */
  protected override interruptedPc(): number {
    const sp = this.cpu.sp;
    return this.memory.readRam(0x100 | ((sp + 2) & 0xFF)) | (this.memory.readRam(0x100 | ((sp + 3) & 0xFF)) << 8);
  }

  /** Execute exactly one instruction, inside the frame loop: the chips are
   *  clocked, DMA is stolen and a WSYNC halts, as in a run. The first
   *  instruction does not stop on a breakpoint or trap at its own pc. */
  stepInstruction(): void {
    this.breakpointHit = -1;
    this.portWatchHit = null;
    this.memWatchHit = null;
    this.stopReason = null;
    this.resumeSkipPc = this.cpu.pc;
    this.resumeSkipKind = 'breakpoint';
    this.stepsLeft = 1;
    try {
      this.stepFrame();
    } finally {
      this.stepsLeft = -1;
    }
  }

  /** The CPU cycle the instruction in progress started at, and whether its step
   *  is an interrupt entry (which runs no instruction at pc). */
  private insnStartT = 0;
  private stepEntersInterrupt = false;

  /** Watched accesses made by the instruction in progress, waiting for its last
   *  cycle: addr, value, flags, pc per access. The 6502 core counts an
   *  instruction's cycles after its bus accesses, so inside the callback
   *  `cpu.tStates` is still the instruction's start. */
  private readonly accessLog: number[] = [];

  protected override logAccess(addr: number, value: number, write: boolean, port: boolean, values?: number[]): void {
    const log = this.beamLog;
    if (log === null || !log.acceptsFrame(this.frameNumber)) return;
    if (values !== undefined && !values.includes(value)) return;
    if (!this.inStep) {
      super.logAccess(addr, value, write, port, values);
      return;
    }
    this.accessLog.push(addr, value, (write ? 1 : 0) | (port ? 2 : 0), this.insnPc);
  }

  /** Stamp the queued accesses with the instruction's last cycle: a store's
   *  bus write is its last cycle, and for the common loads it is too. (A
   *  read-modify-write's read comes earlier; the stamp is approximate there.) */
  private stampAccesses(): void {
    const log = this.beamLog;
    const q = this.accessLog;
    if (log !== null) {
      const cpl = this.timing.cyclesPerLine;
      const startT = this.insnStartT - this.beamFrameStart;
      const cycles = this.cpu.tStates - this.insnStartT;
      // The opcode, to place each access on its own cycle (see bus-cycles.ts).
      // An interrupt-entry step runs no instruction: its accesses take the last cycle.
      const opcode = this.stepEntersInterrupt || q.length === 0 ? -1 : this.memory.readByte(q[3]);
      for (let i = 0; i < q.length; i += 4) {
        let flags = q[i + 2];
        const cycle = opcode < 0 ? cycles : accessCycle(opcode, q[i + 3], q[i], (flags & 1) !== 0, cycles);
        const t = startT + cycle - 1;
        let kind = BEAM_IO;
        if ((flags & ACCESS_DL) !== 0) {
          // A display-list pointer write: note whether ANTIC is drawing the
          // picture (a write then restarts the display list mid-frame).
          kind = BEAM_DL;
          const line = Math.floor(t / cpl);
          if (line >= ANTIC_FIRST_LINE && line < ANTIC_LAST_LINE) flags |= DL_VISIBLE;
        }
        log.push(kind, this.frameNumber, t, q[i + 3], q[i], q[i + 1], flags);
      }
    }
    q.length = 0;
  }

  /** Log the Atari's display-list events (every DLISTL/DLISTH write, with a
   *  flag for one that lands in the visible area, and every display-list
   *  instruction ANTIC fetches). */
  dlLogging = false;
  /** Log how many cycles DMA steals on each line, and from what. */
  dmaLogging = false;
  /** Log what the renderer decided for the registers that depend on where in
   *  the line they are written: HSCROL on each scrolling line (the value used,
   *  the write that supplied it, any that came too late), each change of a
   *  playfield or background colour (with the pixel it starts at), and the
   *  playfield width DMACTL gave a line (when it changes, or a write came too
   *  late for it). */
  private effOn = false;
  get effLogging(): boolean { return this.effOn; }
  set effLogging(on: boolean) {
    this.effOn = on;
    this.dmactlLogged = -1;
    this.video.onHscrol = on
      ? (y, value, source, cutoff, lateCount, lateValue, lateCycle) =>
        this.logHscrol(y, value, source, cutoff, lateCount, lateValue, lateCycle)
      : null;
    this.video.onColour = on
      ? (y, reg, value, old, cutX, cycle) => this.logColour(y, reg, value, old, cutX, cycle)
      : null;
  }

  private logHscrol(
    y: number, value: number, source: number, cutoff: number,
    lateCount: number, lateValue: number, lateCycle: number,
  ): void {
    const log = this.beamLog;
    if (log === null) return;
    // flags: bit 0 = a write supplied the value; bits 8+ = how many came too late.
    // regLo: the supplying write's cycle (low 16) and the cutoff (high 16);
    // regHi: the last late write's value (low 8) and cycle (next 8).
    log.push(BEAM_EFF, this.frameNumber, (y + ANTIC_FIRST_LINE) * this.timing.cyclesPerLine,
      0, REG_HSCROL, value, (source >= 0 ? 1 : 0) | (lateCount << 8),
      (source & 0xFFFF) | (cutoff << 16), lateValue | (lateCycle << 8));
  }

  /** A colour register changed during a line. addr = the GTIA offset; value =
   *  what was written; regHi = what it replaced; regLo = the buffer x the
   *  renderer starts drawing with it; flags >> 8 = the cycle of the write. */
  private logColour(y: number, reg: number, value: number, old: number, cutX: number, cycle: number): void {
    const log = this.beamLog;
    if (log === null) return;
    log.push(BEAM_EFF, this.frameNumber, (y + ANTIC_FIRST_LINE) * this.timing.cyclesPerLine + cycle,
      0, reg, value, cycle << 8, cutX, old);
  }

  /** DMACTL as ANTIC sampled it for the line in progress, and the last value
   *  logged (-1 = none yet). */
  private sampledDmactl = 0;
  private dmactlLogged = -1;

  /** The playfield width DMACTL gave this line: logged when it changes, and
   *  when the register held a different value by the line's end (a write that
   *  came after ANTIC sampled it). addr = ANTIC_BASE (DMACTL); value = the one
   *  used; regLo = the register at the end of the line; regHi = the last
   *  value logged; flags bit 0 = late. */
  private logDmactl(line: number): void {
    const log = this.beamLog;
    const used = this.sampledDmactl;
    const now = this.antic.dmactl;
    const late = now !== used;
    if (log === null || (used === this.dmactlLogged && !late)) return;
    log.push(BEAM_EFF, this.frameNumber, line * this.timing.cyclesPerLine + FETCH_SAMPLE_CYCLE,
      0, ANTIC_BASE, used, late ? 1 : 0, now, this.dmactlLogged < 0 ? used : this.dmactlLogged);
    this.dmactlLogged = used;
  }

  /** ANTIC fetched a display-list instruction at the top of the current line.
   *  These chip-side events are stamped from the loop's own line counter, not
   *  `cpu.tStates`, which may already be past the line start. */
  private logDlFetch(address: number, instr: number, operand: number): void {
    const log = this.beamLog;
    if (!this.dlLogging || log === null) return;
    log.push(BEAM_DL, this.frameNumber, this.fLine * this.timing.cyclesPerLine, address, operand, instr, DL_FETCH);
  }

  /** Log the line's DMA steal. */
  private logDma(line: number, steal: number): void {
    const log = this.beamLog;
    if (!this.dmaLogging || log === null) return;
    const b = this.antic.stealBreakdown();
    log.push(BEAM_DMA, this.frameNumber, line * this.timing.cyclesPerLine, 0, 0, steal, 0,
      b.dl | (b.screen << 8) | (b.glyph << 16) | (b.pm << 24), b.refresh);
  }

  /**
   * Change the cartridge with the machine held, then cold-start it. A running
   * (or still-starting) machine is restarted afterwards; a paused one stays
   * paused. The shell hidden-mounts BASIC while the new machine's start() is
   * still awaiting audio, so "starting" must count as running here or the
   * machine would come up stopped.
   */
  swapCartridge(change: () => void): void {
    const wasActive = this.running || this.starting;
    this.stop();
    change();
    this.reset();
    if (wasActive) void this.start();
  }

  // ── Snapshots (see snapshots/atari-state.ts for the file container) ───────

  /**
   * Write the machine's state. Taken between frames (the frame loop is not
   * running), when ANTIC's per-line state, the line-write log and the queued
   * POKEY writes are all empty by construction, so none of that is saved.
   * `withMedia` adds the disks, tape and recorded output; the refresh-resume
   * path leaves them out, since the shell remounts its persisted media.
   * Host input (held keys, the joystick) is live state, not machine state.
   */
  saveState(w: StateWriter, withMedia: boolean): void {
    // A frame stopped part-way holds loop state this snapshot does not carry;
    // run the rest of it first, as step_frame would.
    this.completeFrame();
    const cpu = this.cpu;
    const mem = this.memory;
    w.section('CPU ', () => {
      w.u8(cpu.a); w.u8(cpu.x); w.u8(cpu.y); w.u8(cpu.sp); w.u16(cpu.pc); w.u8(cpu.p);
      w.f64(cpu.tStates);
      w.bool(cpu.irqLine); w.bool(cpu.nmiLatched);
    });
    w.section('MACH', () => {
      w.f64(this.frameBase);
      w.bool(this.cassetteMotor); w.bool(this.sioCommand);
      w.u32(this.tapeIdleFrames);
      w.bool(this.xexHoldsOption);
    });
    w.section('MEM ', () => {
      w.u8(mem.portB);
      w.u32(mem.ramSize);
      w.raw(mem.ram.subarray(0, mem.ramSize));
      w.u32(mem.extRam.length);
      w.raw(mem.extRam);
      const cart = mem.cart;
      w.bool(cart !== null);
      if (cart) {
        w.str(cart.type);
        w.bytes(cart.image);
        w.i32(cart.bankState);
        w.str(this.cartridgeName);
      }
    });
    w.section('ANTC', () => this.antic.saveState(w));
    w.section('GTIA', () => this.gtia.saveState(w));
    w.section('POKY', () => this.pokey.saveState(w));
    w.section('PIA ', () => w.raw(this.pia.exportState()));
    w.section('SIO ', () => this.sioBus.saveState(w));
    w.section('XEX ', () => {
      const xex = this.xex;
      w.bool(xex !== null);
      if (!xex) return;
      w.str(xex.name);
      w.str(xex.phase);
      w.u32(xex.progress);
      w.u32(xex.segments.length);
      for (const seg of xex.segments) { w.u16(seg.start); w.u16(seg.end); w.bytes(seg.data); }
    });
    w.section('MEDA', () => {
      w.bool(withMedia);
      if (!withMedia) return;
      this.services.disks.saveState(w);
      this.cassette.saveState(w);
    });
  }

  /**
   * Restore a state written by `saveState` into this machine, which must be the
   * same model and region (the caller checks). The frame loop must be stopped.
   * Anything the snapshot does not carry stays as it is: the OS ROM, settings,
   * the audio device and, for a media-less snapshot, the drives and tape.
   */
  loadState(r: StateReader): void {
    const cpu = this.cpu;
    const mem = this.memory;
    this.dropFrameInProgress();
    {
      const s = r.section('CPU ');
      cpu.a = s.u8(); cpu.x = s.u8(); cpu.y = s.u8(); cpu.sp = s.u8(); cpu.pc = s.u16(); cpu.p = s.u8();
      cpu.tStates = s.f64();
      cpu.irqLine = s.bool(); cpu.nmiLatched = s.bool();
    }
    {
      const s = r.section('MACH');
      this.frameBase = s.f64();
      this.cassetteMotor = s.bool(); this.sioCommand = s.bool();
      this.tapeIdleFrames = s.u32();
      this.xexHoldsOption = s.bool();
    }
    {
      const s = r.section('MEM ');
      const portB = s.u8();
      if (s.u32() !== mem.ramSize) throw new Error('Snapshot RAM size does not match this machine');
      s.rawInto(mem.ram.subarray(0, mem.ramSize));
      if (s.u32() !== mem.extRam.length) throw new Error('Snapshot extended RAM does not match this machine');
      s.rawInto(mem.extRam);
      mem.setPortB(portB);
      if (s.bool()) {
        const type = s.str();
        if (!CART_TYPES.has(type)) throw new Error(`Snapshot cartridge type ${type} is not supported`);
        const image = s.bytes();
        const bank = s.i32();
        const name = s.str();
        const cart = new AtariCartridge(type as AtariCartType, image);
        cart.bankState = bank;
        mem.cart = cart;
        this.cartridgeName = name;
        if (name === '') this.hiddenBasic = image;
      } else {
        mem.ejectCart();
        this.cartridgeName = '';
      }
    }
    this.antic.loadState(r.section('ANTC'));
    this.gtia.loadState(r.section('GTIA'));
    this.pokey.loadState(r.section('POKY'));
    {
      const s = r.section('PIA ');
      const regs = new Uint8Array(14);
      s.rawInto(regs);
      this.pia.importState(regs);
    }
    this.sioBus.loadState(r.section('SIO '));
    {
      const s = r.section('XEX ');
      if (s.bool()) {
        const name = s.str();
        const phase = s.str();
        const next = s.u32();
        const segments: XexSegment[] = [];
        for (let n = s.u32(); n > 0; n--) segments.push({ start: s.u16(), end: s.u16(), data: s.bytes() });
        const xex = new XexLoader(name, segments);
        xex.restore(phase === 'loading' || phase === 'running' ? phase : 'boot', next);
        this.xex = xex;
      } else {
        this.xex = null;
      }
    }
    {
      const s = r.section('MEDA');
      if (s.bool()) {
        this.services.disks.loadState(s);
        this.cassette.loadState(s);
      }
    }

    // What the snapshot cannot hold: the host's keys and stick are whatever
    // they are now, a script that was typing is over, and nothing is half-way
    // through a line.
    this.cancelAutostart();
    this.releaseAllKeys();
    if (this.xexHoldsOption) this.gtia.consol &= ~0x04;
    this.pokey.keysDown = 0;
    this.joyDir.fill(0);
    this.gtia.trig.fill(1);
    this.senseCartridge();
    this.lineWrites.clear();
    this.pokeyWrites.length = 0;
    this.inStep = false;
    this.pokeyReadAddr = -1;
    this.wsyncRequested = false;
    this.activity.keyPresses = 0;
    this.activity.psgWrites = 0;
    this.activity.casReads = 0;
    this.activity.speakerToggles = 0;
    this.pia.inputB = 0xFF;
    if (mem.xl) this.pokey.setExternal(this.xlSpeakerLevel());
    this.lastAudioT = cpu.tStates;
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
  }

  // ── Bus ──────────────────────────────────────────────────────────────────

  private readHardware(addr: number): number {
    if (addr < 0xD100) return this.gtia.readReg(addr);
    if (addr < 0xD200) return 0xFF;
    if (addr < 0xD300) {
      const v = this.pokey.readReg(addr);
      if (this.inStep) { this.pokeyReadAddr = addr; this.pokeyReadValue = v; }
      return v;
    }
    if (addr < 0xD400) {
      this.pia.inputA = this.joystickPortA();
      this.pia.inputB = 0xFF;
      switch (addr & 0x03) {
        case 0: return this.pia.readData(0);
        case 1: return this.pia.readData(1);
        case 2: return this.pia.readControl(0);
        default: return this.pia.readControl(1);
      }
    }
    if (addr < 0xD500) {
      // VCOUNT moves on a few cycles before the next line, so it depends on
      // where in the line the read lands: the instruction's access comes
      // about three cycles after it starts.
      if ((addr & 0x0F) === 0x0B && this.inStep) {
        return this.antic.vcountAt(this.cpu.tStates - this.lineStartT + VCOUNT_READ_LEAD, this.timing.linesPerFrame);
      }
      return this.antic.readReg(addr);
    }
    return 0xFF;
  }

  /** The hardware window as a debugger sees it: the registers a read would
   *  return, without what a read does. The PIA's data registers are read
   *  without clearing their interrupt flags; the cartridge control area is
   *  never touched (a real read there switches a bank); the VCOUNT shown is
   *  the line now. GTIA, POKEY and ANTIC registers are pure to read. */
  private peekHardware(addr: number): number {
    if (addr < 0xD100) return this.gtia.readReg(addr);
    if (addr < 0xD200) return 0xFF;
    if (addr < 0xD300) return this.pokey.readReg(addr);
    if (addr < 0xD400) {
      const port = addr & 0x01;
      switch (addr & 0x03) {
        case 0: case 1: {
          if ((this.pia.cr[port] & 0x04) === 0) return this.pia.ddr[port];
          this.pia.inputA = this.joystickPortA();
          this.pia.inputB = 0xFF;
          return this.pia.portValue(port);
        }
        default: return this.pia.readControl(port);
      }
    }
    if (addr < 0xD500) return this.antic.readReg(addr);
    return 0xFF;
  }

  private writeHardware(addr: number, value: number): void {
    if (addr < 0xD100) {
      const a = addr & 0x1F;
      if (a <= 0x1E) this.lineWrites.addGtia(a, value & 0xFF, this.gtia.regValue(a));
      this.gtia.writeReg(addr, value);
      // The XL has no internal speaker: CONSOL's goes to the TV sound,
      // joining POKEY's between the amplifier stages.
      if (a === 0x1F && this.memory.xl) this.pokey.setExternal(this.xlSpeakerLevel());
      return;
    }
    if (addr < 0xD200) return;
    if (addr < 0xD300) {
      if (addr < 0xD208) this.activity.psgWrites++;
      if (!this.inStep) {
        this.pokey.writeReg(addr, value);
        return;
      }
      // A store writes on its instruction's last cycle. A read-modify-write
      // of the same address writes the value it read one cycle before that
      // (the 6502's dummy write), which the core does not make itself.
      if (addr === this.pokeyReadAddr) this.pokeyWrites.push(addr, this.pokeyReadValue, 2);
      this.pokeyWrites.push(addr, value, 1);
      return;
    }
    if (addr < 0xD400) {
      switch (addr & 0x03) {
        case 0: this.pia.writeData(0, value); break;
        case 1: this.pia.writeData(1, value); break;
        case 2: this.pia.writeControl(0, value); break;
        default: this.pia.writeControl(1, value); break;
      }
      this.cassetteMotor = c2DrivenLow(this.pia.cr[0]);
      const command = c2DrivenLow(this.pia.cr[1]);
      if (command !== this.sioCommand) {
        this.sioCommand = command;
        this.sioBus.setCommand(command);
      }
      // Port B lines left as inputs float high; the pins drive the XL MMU.
      if ((addr & 0x01) !== 0) this.memory.setPortB(this.pia.portValue(1));
      return;
    }
    if (addr < 0xD500) {
      const a = addr & 0x0F;
      if (a === 0x01 || a === 0x04 || a === 0x09) {
        this.lineWrites.addAntic(a, value & 0xFF, this.antic.regValue(a));
      }
      // A write to the display-list pointer, for the display-list log (the
      // flag in the entry says whether it landed while ANTIC was drawing).
      if ((a === 0x02 || a === 0x03) && this.dlLogging && this.beamLog !== null && this.inStep) {
        this.accessLog.push(addr, value & 0xFF, ACCESS_DL | 1, this.insnPc);
      }
      this.antic.writeReg(addr, value);
    }
  }

  /**
   * Arm a DOS executable and reboot into it. A cartridge (the hidden BASIC
   * included) is pulled first, since it would cover RAM at $A000 and take
   * the boot; built-in BASIC is kept out by the OPTION hold in reset().
   */
  mountXex(segments: readonly XexSegment[], name: string): void {
    this.swapCartridge(() => {
      if (this.memory.cart) {
        this.memory.ejectCart();
        this.cartridgeName = '';
      }
      this.xex = new XexLoader(name, segments);
      // Power-cycle: an XL's OS does a warm start (no disk boot) over RAM
      // that still holds the last session's start-up flags.
      this.memory.ram.fill(0);
    });
  }

  /** Forget an armed executable (another boot medium was chosen). */
  clearXex(): void {
    this.xex = null;
    if (this.xexHoldsOption) { this.gtia.consol |= 0x04; this.xexHoldsOption = false; }
  }

  // ── Auto-start (see autostart.ts) ────────────────────────────────────────

  private readonly autostartHost: AutostartHost = {
    keyDown: (e) => { this.keyDown(e); },
    keyUp: (e) => { this.keyUp(e); },
    coldStart: (basic) => this.autostartColdStart(basic),
    speakerToggles: () => this.activity.speakerToggles,
    screenText: () => this.ocrScreenForMcp(),
    notify: (message) => this.setStatus(message),
  };

  /** Whether a script that needs BASIC can get it: the built-in ROM, or the
   *  shell's hidden BASIC cartridge (a cartridge the user chose stays put,
   *  and covers BASIC). */
  canAutostartBasic(): boolean {
    if (this.memory.basicRom) return this.memory.cart === null;
    return this.memory.cart !== null ? this.cartridgeName === '' : this.hiddenBasic !== null;
  }

  /**
   * Run an auto-start script: the machine is cold-started (BASIC on or off)
   * and the script then types and waits as a person would. Returns false,
   * doing nothing, when the script needs BASIC and none can be had.
   */
  startAutostart(ops: readonly AutostartOp[]): boolean {
    if (opsNeedBasic(ops) && !this.canAutostartBasic()) return false;
    const steps = compileAutostart(ops, { builtinBasic: this.memory.basicRom !== null });
    if (steps === null) return false;
    this.cancelAutostart();
    const script = new AtariAutostart(this.autostartHost, steps);
    this.autostart = script;
    script.start();
    if (script.finished) this.autostart = null;
    return true;
  }

  cancelAutostart(): void {
    const script = this.autostart;
    this.autostart = null;
    script?.cancel();
  }

  /**
   * The script's reset: a power cycle. On the 400/800/1200XL BASIC is the
   * cartridge, so BASIC off pulls the shell's hidden one (never a cartridge
   * the user inserted, which keeps booting) and BASIC on puts it back; the
   * 600XL/800XL's built-in BASIC is kept out by the OPTION key the script
   * holds. Runs inside the frame loop, so no stop()/start() as
   * swapCartridge() does.
   */
  private autostartColdStart(basic: boolean): void {
    const mem = this.memory;
    if (!mem.basicRom) {
      if (basic && mem.cart === null && this.hiddenBasic !== null) {
        mem.insertCart(this.hiddenBasic);
      } else if (!basic && mem.cart !== null && this.cartridgeName === '') {
        mem.ejectCart();
      }
    }
    mem.ram.fill(0); // a power cycle: no warm-start state survives
    this.autostartResetting = true;
    try { this.reset(); } finally { this.autostartResetting = false; }
  }

  private xexTrap(): void {
    if (this.xexHoldsOption) {
      this.gtia.consol |= 0x04;
      this.xexHoldsOption = false;
    }
    const cpu = this.cpu;
    const mem = this.memory;
    const host: XexHost = {
      read: (a) => mem.readByte(a & 0xffff),
      write: (a, v) => mem.writeByte(a & 0xffff, v),
      pushReturn: (addr) => {
        const ret = (addr - 1) & 0xffff;
        mem.writeByte(0x0100 | cpu.sp, ret >> 8);
        cpu.sp = (cpu.sp - 1) & 0xff;
        mem.writeByte(0x0100 | cpu.sp, ret & 0xff);
        cpu.sp = (cpu.sp - 1) & 0xff;
      },
      jump: (addr) => { cpu.pc = addr & 0xffff; },
    };
    this.xex!.trap(host);
    cpu.tStates += 6;
  }

  /** XL: TRIG3 reads 1 while a cartridge is answering in $A000-$BFFF, as the
   *  cartridge port's RD5 line says. A cartridge swap always resets, which
   *  sets it; a bank-switched board that switches itself out (an OSS "off"
   *  bank) drops it, and back up when it returns. On the 400/800 TRIG3 is a
   *  fourth joystick trigger. */
  private senseCartridge(): void {
    if (this.memory.xl) this.gtia.trig[3] = this.memory.cart?.enabled ? 1 : 0;
  }

  private joystickPortA(): number {
    // PORTA directions are active low; joystick 1 in bits 0-3, joystick 2 in
    // bits 4-7. Bits the OS has made outputs are ignored by the PIA itself.
    let v = 0xFF;
    v &= ~(this.joyDir[0] & 0x0F);
    v &= ~((this.joyDir[1] & 0x0F) << 4);
    return v;
  }

  // ── Frame loop ───────────────────────────────────────────────────────────

  /**
   * Run the frame in progress, or start the next one. A frame is a loop over
   * lines, and a line is a loop over instructions; a stop (a breakpoint, a
   * trap, a watchpoint, a beam target or a single step) returns from the
   * middle of either, and the next call carries on from where it stopped, so
   * stopping and continuing changes nothing about the frame (docs/
   * beam-debug-mcp-spec.md P3). Everything live between two instructions is in
   * fields: `fLine`, `ls` (the line in progress) and the machine's own state.
   */
  protected runFrame(): void {
    const timing = this.timing;
    this.refreshWatchBounds();
    if (!this.frameLive) this.beginAtariFrame();
    while (this.fLine < timing.linesPerFrame) {
      if (!this.lineLive) this.beginAtariLine(this.fLine);
      const result = this.runAtariLine();
      if (result === LINE_PARKED) {
        this.midFrame = true;
        this.needsDisplay = true;
        return;
      }
      this.fLine++;
      // A stop at the end of the line leaves the frame open, unless that was
      // its last line: then it is finished like any other frame.
      if (result === LINE_STOPPED && this.fLine < timing.linesPerFrame) {
        this.midFrame = true;
        this.needsDisplay = true;
        return;
      }
    }
    this.finishAtariFrame();
  }

  /** Frame header: runs once, when a frame starts. */
  private beginAtariFrame(): void {
    const cpu = this.cpu;
    const timing = this.timing;
    // Re-anchor if the CPU has run well past the grid (a debugger step, a
    // breakpoint resumed mid-frame) rather than racing through stale lines.
    if (cpu.tStates - this.frameBase > timing.tStatesPerFrame) this.frameBase = cpu.tStates;
    this.beamFrameStart = this.frameBase;
    this.frameBase += timing.tStatesPerFrame;
    this.fSkipAudio = this.speedMultiplier !== 1 || (this.tapeTurbo && this.tapeLoadingActive);
    this.activity.keyPresses = 0;
    this.activity.psgWrites = 0;
    this.activity.casReads = 0;
    if (this.tapeIdleFrames > 0) this.tapeIdleFrames--;
    this.antic.beginFrame();
    this.lastAudioT = cpu.tStates;
    this.fLine = 0;
    this.frameLive = true;
    this.lineLive = false;
  }

  /** Frame trailer: runs once, when the last line is done. */
  private finishAtariFrame(): void {
    this.frameLive = false;
    this.midFrame = false;
    this.fLine = 0;
    this.activity.speakerToggles = this.gtia.speakerToggles;
    this.gtia.speakerToggles = 0;
    this.needsDisplay = true;
    const script = this.autostart;
    if (script !== null) {
      script.frame();
      if (script.finished) this.autostart = null;
    }
  }

  /** Line header: runs once, when a line starts. Leaves the line in `ls`. */
  private beginAtariLine(line: number): void {
    const cpu = this.cpu;
    const timing = this.timing;
    const ls = this.ls;
    const al = this.antic.beginLine(line);
    const lineStart = this.beamFrameStart + line * timing.cyclesPerLine;
    const lineEnd = lineStart + timing.cyclesPerLine;
    const visible = line >= ANTIC_FIRST_LINE && line < ANTIC_LAST_LINE;
    // Player/missile DMA reads its bytes in the first cycles of the line,
    // before the CPU gets to run.
    if (visible) this.video.capturePm(line, al, this.antic, this.memory);

    // ANTIC posts NMIST and raises the NMI a few cycles into the line, and
    // the 6502 only takes it at the end of the instruction in progress. A
    // poll of NMIST whose read lands at or after that point sees the bit
    // before the OS handler clears it (games spin on exactly that), so the
    // status goes up for an instruction that *ends* past NMI_CYCLE, and
    // the NMI itself before the next one.
    const vbi = this.antic.takeVbi();
    const dli = al.dli;
    const rnmi = line === ANTIC_VBI_LINE && this.rnmiPending;
    if (rnmi) this.rnmiPending = false;
    this.lineStartT = lineStart;
    ls.al = al;
    ls.line = line;
    ls.start = lineStart;
    ls.end = lineEnd;
    ls.visible = visible;
    ls.vbi = vbi;
    ls.dli = dli;
    ls.rnmi = rnmi;
    ls.statusDue = vbi || dli || rnmi;
    // Whether the NMI is enabled is decided when it is raised, not at the
    // top of the line: a store to NMIEN just after a WSYNC (cycle 0-6 of
    // the line) is in time for it.
    ls.nmiDue = ls.statusDue;
    ls.nmiAt = lineStart + NMI_CYCLE;
    // ANTIC's DMA halts the CPU: the line is still 114 cycles long, but the
    // CPU only gets what DMA leaves it, and POKEY keeps counting meanwhile.
    // The stolen cycles are charged once the line is past the NMI point,
    // where the refresh and playfield fetches really fall.
    ls.steal = this.antic.stealCycles();
    ls.stolen = 0;
    ls.sampled = false;

    this.wsyncRequested = false;
    this.lineWrites.clear();
    if (this.wsyncCarried) {
      // The WSYNC store ended past the line it started in, after the point
      // where ANTIC releases the CPU: it waits for the next release, which
      // is this whole line.
      this.wsyncCarried = false;
      if (cpu.tStates < lineEnd) {
        this.clockChips(lineEnd - cpu.tStates);
        cpu.tStates = lineEnd;
      }
      this.wsyncRequested = true;
    }
    this.lineLive = true;
  }

  /** Save the loop's locals into the line in progress so a later call can
   *  carry on from here. */
  private parkLine(
    statusDue: boolean, nmiDue: boolean, steal: number, stolen: number, sampled: boolean, skipPc: number,
  ): void {
    const ls = this.ls;
    ls.statusDue = statusDue;
    ls.nmiDue = nmiDue;
    ls.steal = steal;
    ls.stolen = stolen;
    ls.sampled = sampled;
    // A skip that was not used up is still owed to the first instruction run.
    if (skipPc >= 0) this.resumeSkipPc = skipPc;
  }

  /**
   * Run the rest of the line in progress: its instructions, then its trailer.
   * Returns LINE_DONE when the line finished, LINE_PARKED when a stop left it
   * part-way (it carries on from there next call), or LINE_STOPPED when the
   * line finished and a stop is wanted after it (the instruction that ends a
   * line by WSYNC leaves the instruction loop early).
   */
  private runAtariLine(): number {
    const cpu = this.cpu;
    const ls = this.ls;
    const al = ls.al;
    const lineStart = ls.start;
    const lineEnd = ls.end;
    const visible = ls.visible;
    const vbi = ls.vbi;
    const dli = ls.dli;
    const rnmi = ls.rnmi;
    const nmiAt = ls.nmiAt;
    let statusDue = ls.statusDue;
    let nmiDue = ls.nmiDue;
    let steal = ls.steal;
    let stolen = ls.stolen;
    let sampled = ls.sampled;
    const writes = this.lineWrites;
    // The pc a stop at the last pause must step over, taken once per call: it
    // applies to the first instruction run, and is gone after that whether or
    // not the pc matched.
    let skipPc = this.resumeSkipPc;
    const skipKind = this.resumeSkipKind;
    this.resumeSkipPc = -1;
    // Completing a frame for a snapshot must not stop anywhere.
    const ignore = this.ignoreStops;
    let stopAfter: StopKind | null = null;

    while (cpu.tStates < lineEnd) {
      // A beam target: stop at the first instruction boundary at or after it.
      const target = this.beamTarget;
      if (target !== null && !ignore &&
          (this.frameNumber > target.frame ||
            (this.frameNumber === target.frame && cpu.tStates - this.beamFrameStart >= target.t))) {
        this.beamTarget = null;
        this.markStop('beam', cpu.pc);
        this.parkLine(statusDue, nmiDue, steal, stolen, sampled, skipPc);
        return LINE_PARKED;
      }
      if (!sampled && cpu.tStates - lineStart >= FETCH_SAMPLE_CYCLE) {
        sampled = true;
        steal = this.sampleLineFetch(al, visible);
      }
      if (statusDue && cpu.tStates + NMIST_READ_LEAD >= nmiAt) {
        this.antic.postNmiStatus(vbi, dli, rnmi);
        statusDue = false;
      }
      if (nmiDue && cpu.tStates >= nmiAt) {
        if (rnmi || this.nmiEnabled(vbi, dli)) cpu.nmi(); // RNMI ignores NMIEN
        nmiDue = false;
      }
      if (stolen < steal) {
        const t = cpu.tStates - lineStart;
        if (t > STEAL_START) {
          const due = t >= STEAL_END ? steal : ((steal * (t - STEAL_START)) / STEAL_SPAN) | 0;
          if (due > stolen) {
            cpu.tStates += due - stolen;
            this.clockChips(due - stolen);
            stolen = due;
            if (cpu.tStates >= lineEnd) break;
          }
        }
      }
      cpu.setIRQ(this.pokey.irq || this.pia.irq);
      // The first instruction after a breakpoint or trap stopped the run at
      // this pc must not stop there again, or a resume makes no progress.
      let skipBreakpoint = false;
      let trapResume = false;
      if (skipPc >= 0) {
        if (cpu.pc === skipPc) {
          skipBreakpoint = true;
          trapResume = skipKind === 'trap';
        }
        skipPc = -1;
      }
      if (!skipBreakpoint && !ignore && this.breakpoints.has(cpu.pc)) {
        this.markStop('breakpoint', cpu.pc);
        this.parkLine(statusDue, nmiDue, steal, stolen, sampled, -1);
        return LINE_PARKED;
      }
      // The next step may enter an interrupt instead of running the
      // instruction at pc; a trap there would report one that does not run.
      if (this.onTrap !== null && !cpu.interruptPending() && this.onTrap(cpu.pc, trapResume) && !ignore) {
        this.markStop('trap', cpu.pc);
        this.parkLine(statusDue, nmiDue, steal, stolen, sampled, -1);
        return LINE_PARKED;
      }
      // Service an SIO call natively instead of letting the OS bit-bang it.
      // Only while the OS ROM is mapped: an XL program that switches it out
      // (Turbo-BASIC XL) keeps its own code in the RAM at $E459.
      if (cpu.pc === SIO_ENTRY && this.memory.osRomEnabled && this.sio.claims()) {
        this.sio.handle();
        continue;
      }
      if (cpu.pc === XEX_TRAP && this.xex) {
        this.xexTrap();
        continue;
      }
      const before = cpu.tStates;
      this.inStep = true;
      this.pokeyReadAddr = -1;
      this.insnPc = cpu.pc;
      this.insnStartT = before;
      // (Only worked out when a watchpoint could log something this step.)
      this.stepEntersInterrupt = this.watchHi >= 0 && cpu.interruptPending();
      cpu.step();
      this.inStep = false;
      if (this.intOpen > 0) this.closeInterrupts();
      // A store's bus write is its last cycle (the core counts the
      // instruction's cycles after its access).
      if (writes.pending) writes.stamp(cpu.tStates - 1 - lineStart);
      if (this.accessLog.length > 0) this.stampAccesses();
      if (!ignore) {
        if (this.memWatchHit !== null) stopAfter = 'watch';
        else if (this.stepsLeft > 0 && --this.stepsLeft === 0) stopAfter = 'step';
      }
      if (this.pokeyWrites.length > 0) this.clockWithPokeyWrites(cpu.tStates - before);
      else this.clockChips(cpu.tStates - before);
      if (this.wsyncRequested) {
        // WSYNC holds the CPU (RDY low) until the line ends.
        if (cpu.tStates < lineEnd) {
          this.clockChips(lineEnd - cpu.tStates);
          cpu.tStates = lineEnd;
        } else {
          this.wsyncCarried = true;
        }
        break;
      }
      // A watchpoint fired, or a single step was asked for, during this
      // instruction: stop with the chips clocked up to the end of it.
      if (stopAfter !== null) {
        this.markStop(stopAfter, cpu.pc);
        this.parkLine(statusDue, nmiDue, steal, stolen, sampled, skipPc);
        return LINE_PARKED;
      }
    }

    if (!sampled) steal = this.sampleLineFetch(al, visible);

    // A CPU held by WSYNC (or past the line already) still gets the
    // line's interrupt, as it comes out of the halt.
    // DMA the CPU ran past without paying for (an instruction that crossed
    // the end of the line) is still owed; a WSYNC halt already covered it.
    if (stolen < steal && !this.wsyncRequested) {
      cpu.tStates += steal - stolen;
      this.clockChips(steal - stolen);
    }
    if (statusDue) this.antic.postNmiStatus(vbi, dli, rnmi);
    if (nmiDue && (rnmi || this.nmiEnabled(vbi, dli))) cpu.nmi();

    const now = cpu.tStates;
    if (!this.fSkipAudio) {
      const audioElapsed = now - this.lastAudioT;
      if (audioElapsed > 0) {
        // The 400/800's internal speaker; the XL's goes through POKEY.
        this.mixer.accumulate(this.gtia.speaker && !this.memory.xl ? 1 : 0, audioElapsed);
        this.mixer.generateSamples(this.audio, this.pokey, true);
        this.lastAudioT = now;
      }
    }

    if (writes.pending) writes.stamp(now - lineStart);
    if (visible) {
      this.video.renderLine(ls.line - ANTIC_FIRST_LINE, al, this.antic, this.gtia, this.memory, writes);
    }
    if (this.dmaLogging) this.logDma(ls.line, steal);
    if (this.effOn && visible) this.logDmactl(ls.line);
    this.lineLive = false;
    // The instruction that ended the line by WSYNC left the instruction loop
    // early, so a stop it asked for happens here, with the line done.
    if (stopAfter !== null) {
      this.markStop(stopAfter, cpu.pc);
      if (skipPc >= 0) this.resumeSkipPc = skipPc;
      return LINE_STOPPED;
    }
    if (skipPc >= 0) this.resumeSkipPc = skipPc;
    return LINE_DONE;
  }

  /** ANTIC samples DMACTL's width and fetches the mode line's screen bytes:
   *  settle the line on them and return the DMA cycles it now costs. */
  private sampleLineFetch(al: AnticLine, visible: boolean): number {
    this.antic.sampleFetch();
    this.sampledDmactl = this.antic.dmactl;
    if (visible && al.fetch !== false) this.video.fetchScreen(al, this.memory);
    return this.antic.stealCycles();
  }

  /** NMIEN lets the VBI and/or DLI this line raised through. */
  private nmiEnabled(vbi: boolean, dli: boolean): boolean {
    const nmien = this.antic.nmien;
    return (vbi && (nmien & 0x40) !== 0) || (dli && (nmien & 0x80) !== 0);
  }

  /** Run the chips through a CPU step of `cycles`, applying the step's
   *  queued POKEY writes on the cycles they land on. */
  private clockWithPokeyWrites(cycles: number): void {
    const queued = this.pokeyWrites;
    let done = 0;
    for (let i = 0; i < queued.length; i += 3) {
      const at = Math.max(done, cycles - queued[i + 2]);
      this.clockChips(at - done);
      done = at;
      this.pokey.writeReg(queued[i], queued[i + 1]);
    }
    queued.length = 0;
    this.clockChips(cycles - done);
  }

  /** Run POKEY, the tape and the drives for `cycles` CPU cycles. They move
   *  first, so POKEY samples the data-in line where they now are. */
  private clockChips(cycles: number): void {
    const bus = this.sioBus;
    // POKEY reads the data-in line once a step, so a long step (a DMA steal,
    // a WSYNC wait) would let it see a stretch of a drive's reply or of the
    // tape at one level: walk it in bit-safe pieces while either is playing.
    if (cycles > 8 && (bus.busy || this.cassetteMotor)) {
      while (cycles > 0) {
        const n = cycles > 8 ? 8 : cycles;
        if (this.cassetteMotor) this.cassette.advance(n);
        bus.advance(n);
        this.pokey.advance(n);
        cycles -= n;
      }
      return;
    }
    if (this.cassetteMotor) this.cassette.advance(cycles);
    bus.advance(cycles);
    this.pokey.advance(cycles);
  }

  protected framePixels(): Uint8Array { return this.video.pixels; }
  /** A program has just read a record from the tape (the SIO fast path). */
  noteTapeRead(): void {
    this.tapeIdleFrames = Math.round(TAPE_IDLE_SECONDS * this.frameHz);
  }

  /**
   * A tape with more to play is being loaded. The motor line is the loader's
   * own say-so, unlike machines that must infer loading from how often the
   * program polls the tape. Programs that read the tape at signal level
   * (custom and turbo loaders, the leader tones) take real time with the motor
   * running, so they get the same flat-out run as a manual turbo.
   *
   * The OS runs the motor only while it reads a record, though, and a BASIC
   * loader spends most of its time between records poking the bytes it was
   * given. So a read within the last few seconds counts too, which keeps the
   * whole load fast and lets go soon after the last record.
   */
  get tapeLoadingActive(): boolean {
    return this.cassette.loaded && !this.cassette.finished
      && (this.cassetteMotor || this.tapeIdleFrames > 0);
  }

  /** Turbo engaged for UI fast-forward, or while a cassette is loading. */
  protected inTurbo(): boolean { return this.turbo || (this.tapeTurbo && this.tapeLoadingActive); }

  // ── Input helpers (called by the InputService) ───────────────────────────

  keyDown(e: HostKeyEvent): boolean {
    const consoleBit = CONSOLE_KEYS[e.code];
    if (consoleBit !== undefined) {
      this.gtia.consol &= ~consoleBit;
      return true;
    }
    if (isModifierKey(e.code)) {
      if (e.code.startsWith('Shift')) this.pokey.shiftDown = true;
      return true;
    }
    if (e.code === 'Pause' || e.code === 'Break') {
      this.pokey.breakKey();
      return true;
    }
    const mapped = mapAtariKey(e);
    if (!mapped) return false;
    this.pokey.pressKey(mapped.code, mapped.shift, mapped.control);
    this.keysDown++;
    this.activity.keyPresses++;
    return true;
  }

  keyUp(e: HostKeyEvent): boolean {
    const consoleBit = CONSOLE_KEYS[e.code];
    if (consoleBit !== undefined) {
      this.gtia.consol |= consoleBit;
      return true;
    }
    if (isModifierKey(e.code)) {
      if (e.code.startsWith('Shift') && !e.shift) this.pokey.shiftDown = false;
      return true;
    }
    const mapped = e.code === 'Pause' || e.code === 'Break' ? true : mapAtariKey(e) !== null;
    if (!mapped) return false;
    this.keysDown = Math.max(0, this.keysDown - 1);
    this.pokey.anyKeyDown = this.keysDown > 0;
    if (this.keysDown === 0) this.pokey.shiftDown = e.shift;
    return true;
  }

  releaseAllKeys(): void {
    this.gtia.consol = 0x07;
    this.keysDown = 0;
    this.pokey.anyKeyDown = false;
    this.pokey.shiftDown = false;
  }

  pressJoystick(dir: string, pressed: boolean, player: number): void {
    const port = player === 1 ? 1 : 0;
    if (dir === 'fire') {
      this.gtia.setTrigger(port, pressed);
      return;
    }
    const bit = JOY_BITS[dir];
    if (bit === undefined) return;
    if (pressed) this.joyDir[port] |= bit;
    else this.joyDir[port] &= ~bit;
  }

  // ── On-screen keyboard (ui/keyboard) ─────────────────────────────────────
  // The face presses keys by POKEY scan code rather than through host events,
  // so it reaches the keys a PC keyboard has no clean equivalent for.

  /** Press a key on POKEY's matrix, with SHIFT and CONTROL as latched on the
   *  face. Each press must be paired with `releaseScanKey()`. */
  pressScanKey(code: number, shift: boolean, control: boolean): void {
    this.pokey.pressKey(code, shift, control);
    this.keysDown++;
    this.activity.keyPresses++;
  }

  releaseScanKey(): void {
    this.keysDown = Math.max(0, this.keysDown - 1);
    this.pokey.anyKeyDown = this.keysDown > 0;
    if (this.keysDown === 0) this.pokey.shiftDown = false;
  }

  /** SHIFT held on its own, which programs read through SKSTAT bit 3. */
  holdShift(down: boolean): void {
    if (this.keysDown === 0) this.pokey.shiftDown = down;
  }

  /** Hold or release a console key: CONSOL bit 1 START, 2 SELECT, 4 OPTION. */
  setConsoleKey(bit: number, down: boolean): void {
    if (down) this.gtia.consol &= ~bit;
    else this.gtia.consol |= bit;
  }

  pressBreak(): void { this.pokey.breakKey(); }

  /**
   * SYSTEM RESET. On the 400/800 it is ANTIC's RNMI: NMIST bit 5 and an NMI
   * the OS answers with a warm start, which NMIEN cannot mask. The XL wires
   * the key to the CPU's reset line instead; its OS then warm-starts too.
   */
  pressSystemReset(): void {
    if (this.memory.xl) {
      this.reset(true);
      return;
    }
    // ANTIC raises it at the vertical blank, at the same point as the VBI.
    this.rnmiPending = true;
  }

  /** The key POKEY is reporting held (KBCODE with SHIFT/CONTROL), or -1. */
  get heldKeyCode(): number { return this.pokey.anyKeyDown ? this.pokey.kbcode : -1; }
  get shiftHeld(): boolean { return this.pokey.shiftDown; }
  /** CONSOL's key bits, active low. */
  get consoleKeys(): number { return this.gtia.consol & 0x07; }

  // ── Debug surface ────────────────────────────────────────────────────────

  startTrace(_mode = 'full'): void { /* no trace engine yet */ }
  stopTrace(): string { return ''; }

  /** True while the TEXT overlay is showing (gates the per-frame OCR). */
  transcribing = false;

  /** Every text line on screen, wherever the display list puts it. */
  ocrScreenForMcp(_mode?: string): string { return atariOcrText(this.ocrInput()); }

  /** The 40x24 TEXT-overlay grid over the standard GRAPHICS 0 area. */
  ocrScreenStyled(): OcrResult { return atariOcrGrid(this.ocrInput()); }

  /** Paint the overlay's matched cells out of the frame. */
  blankCells(mask: readonly boolean[], cols: number, rows: number): void {
    this.video.blankCells(mask, cols, rows, 8, 24, 8, 8);
  }

  private ocrInput(): AtariOcrInput {
    return {
      dlist: this.antic.dlist,
      dmactl: this.antic.dmactl,
      chbase: this.antic.chbase,
      chactl: this.antic.chactl,
      colpf: this.gtia.colpf,
      colbk: this.gtia.colbk,
      palette: this.video.paletteTable,
      read: (addr) => this.memory.readRam(addr),
    };
  }

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    const mem = this.memory;
    // Offsets of $D800 and $E000 inside the OS image, whose own base is
    // $D800 (400/800) or $C000 (XL).
    const fp = 0xD800 - mem.osBase;
    switch (value) {
      case 'rom-os': return { data: mem.osRom.subarray(fp + 0x800), baseAddr: 0xE000 };
      case 'rom-fp': return { data: mem.osRom.subarray(fp, fp + 0x800), baseAddr: 0xD800 };
      case 'rom-os-c000':
        return mem.xl ? { data: mem.osRom.subarray(0, 0x1000), baseAddr: 0xC000 } : null;
      case 'rom-self-test':
        return mem.xl ? { data: mem.osRom.subarray(0x1000, 0x1800), baseAddr: 0x5000 } : null;
      case 'rom-basic':
        return mem.basicRom ? { data: mem.basicRom, baseAddr: 0xA000 } : null;
      default: return null;
    }
  }

  screenExportBytes(): Uint8Array | null { return null; }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    const mem = this.memory;
    const data = new Uint8Array(mem.totalRamSize);
    data.set(mem.ram.subarray(0, mem.ramSize));
    data.set(mem.extRam, mem.ramSize);
    return {
      data,
      filename: `atari${atariModelName(this.model).toLowerCase()}-ram-${data.length >> 10}k.bin`,
    };
  }

  /** Whose measured video levels the palette uses. */
  private get videoBoard(): AtariVideoBoard {
    if (this.memory.xl) return 'xl';
    return this.model === 'atari400' ? '400' : '800';
  }

  /** The 400's membrane keyboard has no Help/Inv/F keys. */
  get is400(): boolean { return atariIs400(this.model); }
}
