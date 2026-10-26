/**
 * Apple I motherboard.
 *
 * A 1.0227 MHz 6502 with 8K of RAM, the 256-byte Woz Monitor PROM and a 6820 PIA
 * that joins an ASCII keyboard to a video terminal. There are no interrupts and
 * no sound: the frame loop runs the CPU for a frame's worth of cycles and
 * charges the terminal's 60-characters-a-second pace through PIA port B bit 7,
 * which the Monitor polls before every character it prints.
 */

import { M6502 } from '@/cores/m6502.ts';
import { M6820 } from '@/cores/m6820.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { m6502ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import { ocrApple1Text } from '@/ocr/apple1.ts';
import { apple1ModelInfo, type Apple1Model } from './models.ts';
import {
  APPLE1_ACTIVE_HEIGHT, APPLE1_ACTIVE_WIDTH, APPLE1_BORDER_LEFT, APPLE1_BORDER_TOP, APPLE1_CHAR_CYCLES, APPLE1_CPU_CLOCK,
  APPLE1_CYCLES_PER_LINE, APPLE1_FRAME_HZ, APPLE1_LINES_PER_FRAME, APPLE1_SCREEN_HEIGHT, APPLE1_SCREEN_WIDTH,
  APPLE1_TSTATES_PER_FRAME,
} from './constants.ts';
import { Apple1Memory } from './apple1-memory.ts';
import { Apple1Terminal } from './apple1-terminal.ts';
import { Apple1Keyboard, apple1PasteBytes } from './apple1-keyboard.ts';
import { APPLE1_DEFAULT_OPTIONS, readApple1Options, type Apple1Options } from './options.ts';
import { Apple1Cassette } from './apple1-cassette.ts';
import { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import { accessTime } from '@/debug/m6502/bus-cycles.ts';
import { Apple1Charset } from './apple1-charset.ts';
import { Apple1Video } from './apple1-video.ts';
import { apple1Descriptor } from './descriptor.ts';
import { createApple1Services, type Apple1Services } from './services/index.ts';

/** Frames the cursor spends on, then off (about 1.9 blinks a second). */
const CURSOR_FRAMES = 16;

/** PIA port B bit 7 is the terminal's "busy" line; the other seven bits carry the character. */
const DISPLAY_BUSY = 0x80;

/** The Apple I makes no sound; this only gives the frame loop a chip to size. */
class NoSound {
  setSampleRate(_rate: number): void {}
}

export class Apple1Machine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'apple1';
  readonly model: Apple1Model;
  host: MachineHost | null = null;
  readonly services: Apple1Services;
  /** Fitted memory; the defaults until `prepare()` reads the settings. */
  options: Apple1Options = APPLE1_DEFAULT_OPTIONS;

  readonly cpu = new M6502();
  readonly memory = new Apple1Memory();
  readonly pia = new M6820();
  readonly terminal = new Apple1Terminal();
  readonly keyboard = new Apple1Keyboard(this.pia);
  readonly mixer = new AudioMixer(APPLE1_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  readonly cassette = new Apple1Cassette();
  /** Times the ACI's output toggles — what a write to tape puts on it — for
   *  the Save menu's recording (services/tape.ts). */
  readonly tapeRecorder = new PulseRecorder();
  /** Cycles run before the last RESET-key press: the key resets the 6502's
   *  cycle count but not the tape, so the recorder's clock carries on from here. */
  private tapeClockBase = 0;
  readonly charset = new Apple1Charset();
  readonly video = new Apple1Video();
  private cursorFrame = 0;

  /** Key presses queued by `typeText`, and how many have been typed. */
  private paste: Uint8Array = new Uint8Array(0);
  private pasteAt = 0;

  /** CPU cycle count at which the terminal will accept its next character. */
  private busyUntil = 0;

  /** Per-frame activity for the frame probe. `kbdReads` counts reads of the
   *  keyboard's PIA registers, which is what the KEY indicator shows. */
  readonly activity = { kbdReads: 0, cassetteToggles: 0 };

  protected readonly audioChip = new NoSound();
  protected override get frameHz(): number { return APPLE1_FRAME_HZ; }

  get descriptor(): MachineDescriptor { return apple1Descriptor(this.model); }
  get pixels(): Uint8Array { return this.video.pixels; }
  get frameWidth(): number { return APPLE1_SCREEN_WIDTH; }
  get frameHeight(): number { return APPLE1_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number { return APPLE1_TSTATES_PER_FRAME; }
  get cpuClockHz(): number { return APPLE1_CPU_CLOCK; }

  /** The terminal is still working on the last character it was given. */
  get displayBusy(): boolean { return this.cpu.tStates < this.busyUntil; }

  constructor(model: Apple1Model, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.display = display ?? null;
    this.fit(APPLE1_DEFAULT_OPTIONS);
    // Nothing on the board drives IRQ or NMI; the hook is there for the
    // interrupt log all the same.
    this.cpu.onInterrupt = (vector) => this.noteInterrupt(this.cpu.pc, vector === 0xFFFA);
    // The 6502 core makes its bus accesses before it counts the cycles.
    this.deferAccessStamps = true;
    this.cpu.read = (addr) => {
      const value = this.memory.readByte(addr);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, value, 'read');
      return value;
    };
    this.cpu.write = (addr, val) => {
      this.memory.writeByte(addr, val);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, val & 0xFF, 'write');
    };
    this.wirePia();
    this.wireAci();
    this.mixer.beeperGain = 0;
    this.mixer.psgGain = 0;
    this.services = createApple1Services(this);
  }

  /** KBD/KBDCR/DSP/DSPCR: port A is the keyboard, port B the display. */
  private wirePia(): void {
    const { pia, memory } = this;
    memory.ioRead = (reg) => {
      if (reg < 2) this.activity.kbdReads++;
      // The terminal's busy line is a pin, so it is read live rather than latched.
      if (reg === 2) pia.portBInput = this.displayBusy ? DISPLAY_BUSY : 0;
      return pia.read(reg);
    };
    memory.ioWrite = (reg, val) => pia.write(reg, val);
    memory.ioPeek = (reg) => {
      if (reg === 2) pia.portBInput = this.displayBusy ? DISPLAY_BUSY : 0;
      return pia.peek(reg);
    };
    pia.onPortBWrite = (value, ddr) => {
      // Only the output bits reach the terminal; bit 7 is its status input.
      this.terminal.put(value & ddr & 0x7F);
      this.busyUntil = this.cpu.tStates + APPLE1_CHAR_CYCLES;
    };
  }

  /**
   * The Apple Cassette Interface's I/O page. The interface decodes only the
   * page: any access to `$C000`-`$C0FF` toggles the tape output, and a read finds
   * the tape input in bit 7. The ROM relies on both — its leader sweeps
   * `LDY $C000,X` with X from `$FF` down to 0 and needs every access to toggle to
   * make an unbroken tone, and it reads the input at `$C081`.
   */
  private wireAci(): void {
    const { memory } = this;
    memory.aciRead = (offset) => {
      this.pulseCassetteOutput(offset, false);
      return this.cassetteInputBit ? 0x80 : 0x00;
    };
    memory.aciWrite = (offset) => this.pulseCassetteOutput(offset, true);
    memory.aciPeek = () => (this.cassetteInputBit ? 0x80 : 0x00);
  }

  /** The tape input level, with the tape brought up to the CPU's present time. */
  get cassetteInputBit(): boolean {
    this.cassette.advanceTo(this.cpu.tStates / APPLE1_CPU_CLOCK);
    return this.cassette.inputBit === 1;
  }

  /** A toggle of the tape output, by an access to `$C0xx` (`offset` = xx).
   *  The edge is timed on the access's own cycle of the instruction (the 6502
   *  core runs the bus before counting cycles) and recorded for the Save
   *  menu, and counted for the activity readout. */
  pulseCassetteOutput(offset: number, write: boolean): void {
    this.activity.cassetteToggles++;
    const t = this.insnActive
      ? accessTime(this.cpu.tStates, this.peekOpcode(this.insnPc), this.insnPc, 0xC000 | offset, write, false)
      : this.cpu.tStates;
    this.tapeRecorder.toggle(this.tapeClockBase + t);
  }

  /** The recorder's clock now: cycles since the machine was last reset. */
  get tapeClock(): number { return this.tapeClockBase + this.cpu.tStates; }

  /** Fit the RAM and interface the settings ask for, then list the ROMs the machine
   *  needs besides the Monitor: the video character generator and the interface's ROM. */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.fit(readApple1Options(view));
    const requests: AuxRomRequest[] = [];
    if (this.options.aci) {
      requests.push({
        cacheKey: 'apple1-aci-rom',
        source: apple1ModelInfo(this.model).aciRomSource,
        fetchingMsg: 'Fetching Apple Cassette Interface ROM…',
        loadedMsg: (bytes) => `Cassette Interface ROM loaded (${bytes} bytes)`,
        failMsg: 'Failed to load the Apple Cassette Interface ROM — tape loading unavailable',
        failId: 'apple1-aci-rom',
        apply: (data) => this.memory.loadAciRom(data),
        awaitLoad: true,
      });
    }
    requests.push({
      cacheKey: 'apple1-chargen',
      source: apple1ModelInfo(this.model).charsetSource,
      fetchingMsg: 'Fetching Apple I character generator ROM…',
      loadedMsg: (bytes) => `Character generator loaded (${bytes} bytes)`,
      failMsg: 'Failed to load the Apple I character generator ROM',
      failId: 'apple1-chargen',
      apply: (data) => { this.charset.load(data); this.needsDisplay = true; },
      awaitLoad: true,
    });
    return requests;
  }

  private fit(options: Apple1Options): void {
    this.options = options;
    this.memory.setRamKb(options.ramKb);
    this.memory.setBasicRam(options.basicRam);
    this.memory.aciFitted = options.aci;
  }

  attachHost(host: MachineHost): void { this.host = host; }

  loadROM(data: Uint8Array): void {
    this.memory.loadRom(data);
    this.setStatus(`${apple1ModelInfo(this.model).label} ROM loaded (${data.length} bytes)`);
  }

  applySettings(_view: SettingsView): void {}

  setBorderSize(mode: BorderMode): void {
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(APPLE1_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(APPLE1_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY, APPLE1_SCREEN_WIDTH - cropX * 2, APPLE1_SCREEN_HEIGHT - cropY * 2,
    );
  }

  reset(): void {
    this.stop();
    this.resetHardware();
    this.resetFrameCount();
    this.setStatus('Reset');
  }

  /** The keyboard's RESET key: the 6502's RESET line and the PIA's, not a power
   *  cycle. RAM and the screen survive; the Monitor's reset handler runs again. */
  pressResetKey(): boolean {
    this.cancelPaste();
    this.tapeClockBase += this.cpu.tStates;
    this.cpu.reset();
    this.dropFrameInProgress();
    this.pia.reset();
    this.keyboard.reset();
    this.busyUntil = 0;
    return true;
  }

  /**
   * Type `text` at the keyboard, as a person keying in a listing would. One key
   * goes in each time the program has taken the last (KBDCR bit 7 clear), so the
   * Monitor or BASIC sees exactly what a keyboard would give it, at the pace the
   * program reads it; nothing is injected while it is not looking for keys.
   * Returns how many key presses were queued.
   */
  typeText(text: string): number {
    const keys = apple1PasteBytes(text);
    this.paste = keys;
    this.pasteAt = 0;
    return keys.length;
  }

  /** Key presses still waiting to be typed. */
  get pasteRemaining(): number { return this.paste.length - this.pasteAt; }

  cancelPaste(): void {
    this.paste = new Uint8Array(0);
    this.pasteAt = 0;
  }

  /** Hand the program the next queued key if it has finished with the last one. */
  private feedPaste(): void {
    if (this.pasteAt >= this.paste.length) return;
    if ((this.pia.cra & 0x80) !== 0) return;
    this.keyboard.press(this.paste[this.pasteAt++]);
  }

  /** The CLEAR SCREEN key blanks the terminal without involving the CPU. */
  pressClearScreenKey(): void {
    this.terminal.clear();
    this.needsDisplay = true;
  }

  private resetHardware(): void {
    this.cancelPaste();
    this.memory.reset();
    this.cpu.reset();
    this.tapeRecorder.reset();
    this.tapeClockBase = 0;
    this.pia.reset();
    this.keyboard.reset();
    this.terminal.clear();
    this.busyUntil = 0;
    this.activity.kbdReads = 0;
    this.cursorFrame = 0;
    this.cassette.rewind();
    this.activity.cassetteToggles = 0;
    this.video.invalidate();
    this.mixer.reset();
    this.needsDisplay = true;
  }

  protected framePixels(): Uint8Array { return this.video.pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  /** Draw the terminal into the frame buffer, with the cursor in its blink phase. */
  private drawFrame(): void {
    this.video.render(this.terminal, this.charset, this.cursorFrame < CURSOR_FRAMES);
    this.needsDisplay = true;
  }

  // ── Beam ───────────────────────────────────────────────────────────────

  /** The terminal is not a raster the CPU can see or time itself against, so
   *  the beam is only a position in the nominal NTSC field the frame loop
   *  runs (65 cycles by 262 lines), with `t` the cycle in it. */
  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: APPLE1_CYCLES_PER_LINE,
      linesPerFrame: APPLE1_LINES_PER_FRAME,
      displayStart: 0,
      note: 'nominal: the frame is a 60 Hz NTSC field of 262 lines of 65 cycles, the slice of time the frame loop runs, but the terminal keeps its own timing that the CPU cannot see (it only polls the busy bit), so a line here is not tied to the picture; the terminal is drawn whole at the end of each frame',
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return m6502ReturnAddress(this.cpu.sp, a => this.memory.peekByte(a)); }
  protected override peekOpcode(addr: number): number { return this.memory.peekByte(addr); }

  /** Forget a frame a stop left open: a reset restarts the CPU's clock, so
   *  there is nothing to carry on. The frame count keeps going. */
  private dropFrameInProgress(): void {
    this.midFrame = false;
    this.clearInterrupts();
  }

  protected override interruptEntryPending(): boolean { return this.cpu.interruptPending(); }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    if (!this.openFrame(APPLE1_TSTATES_PER_FRAME)) {
      this.activity.kbdReads = 0;
      this.feedPaste();
    }
    this.memWatchHit = null;
    const endT = this.frameEndT;

    while (this.cpu.tStates < endT) {
      if (this.checkStops(this.cpu.pc)) {
        // The frame stays open; the next call carries on from here.
        this.midFrame = true;
        this.drawFrame();
        return;
      }
      const before = this.cpu.tStates;
      this.beforeInsn(this.cpu.pc);
      this.cpu.step();
      const stopped = this.afterInsn();
      if (!skipAudio) {
        // Silence still has to be fed: the frame loop paces itself on the audio buffer.
        this.mixer.accumulate(0, this.cpu.tStates - before);
        this.mixer.generateSamples(this.audio, null, false);
      }
      // Stop on the instruction that tripped a memory watchpoint, with the
      // frame open.
      if (stopped) {
        this.midFrame = true;
        this.drawFrame();
        return;
      }
    }
    this.cursorFrame = (this.cursorFrame + 1) % (CURSOR_FRAMES * 2);
    this.cassette.advanceTo(this.cpu.tStates / APPLE1_CPU_CLOCK);
    this.drawFrame();
  }

  // ── Debug / OCR surface ────────────────────────────────────────────────

  /** The terminal is already text, so there is nothing to recognise. */
  ocrScreenForMcp(_mode?: string): string {
    const rows = this.terminal.lines();
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  /** The terminal is text already, so the overlay just reads its buffer. */
  ocrScreenStyled(): OcrResult {
    return ocrApple1Text(this.terminal.cells);
  }

  /** Where the TEXT overlay's grid sits in the frame. */
  get textField(): { x: number; y: number; width: number; height: number } {
    return {
      x: APPLE1_BORDER_LEFT, y: APPLE1_BORDER_TOP,
      width: APPLE1_ACTIVE_WIDTH, height: APPLE1_ACTIVE_HEIGHT,
    };
  }

  /** Blank the matched cells so the crisp overlay replaces them. */
  blankCells(mask: boolean[]): void { this.video.blankCells(mask); }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    const kb = this.memory.ramKb;
    return { data: this.memory.ram.slice(0, kb * 1024), filename: `${this.model}-ram-${kb}k.bin` };
  }

  /** Execution trace: BaseMachine's startTrace/stopTrace drive it and
   *  beforeInsn feeds it (debug/m6502/trace.ts). */
  protected override tracer = new M6502Trace(this, { io: [[0xC000, 0xC0FF], [0xD000, 0xDFFF]], ioLabel: apple1IoLabel });
}

/** Portio-trace names for the Apple I's I/O: the PIA (repeated through $Dxxx,
 *  address bit 4 set) and the cassette interface's page. */
function apple1IoLabel(addr: number): string {
  if ((addr & 0xF010) === 0xD010) return ['KBD', 'KBDCR', 'DSP', 'DSPCR'][addr & 3];
  return (addr & 0xFF00) === 0xC000 ? 'ACI' : '';
}
