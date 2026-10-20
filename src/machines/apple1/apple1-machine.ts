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
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import { ocrApple1Text } from '@/ocr/apple1.ts';
import { apple1ModelInfo, type Apple1Model } from './models.ts';
import {
  APPLE1_ACTIVE_HEIGHT, APPLE1_ACTIVE_WIDTH, APPLE1_BORDER_LEFT, APPLE1_BORDER_TOP, APPLE1_CHAR_CYCLES, APPLE1_CPU_CLOCK, APPLE1_FRAME_HZ,
  APPLE1_SCREEN_HEIGHT, APPLE1_SCREEN_WIDTH, APPLE1_TSTATES_PER_FRAME,
} from './constants.ts';
import { Apple1Memory } from './apple1-memory.ts';
import { Apple1Terminal } from './apple1-terminal.ts';
import { Apple1Keyboard } from './apple1-keyboard.ts';
import { APPLE1_DEFAULT_OPTIONS, readApple1Options, type Apple1Options } from './options.ts';
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

  readonly charset = new Apple1Charset();
  readonly video = new Apple1Video();
  private cursorFrame = 0;

  /** CPU cycle count at which the terminal will accept its next character. */
  private busyUntil = 0;

  /** Per-frame activity for the frame probe. `kbdReads` counts reads of the
   *  keyboard's PIA registers, which is what the KEY indicator shows. */
  readonly activity = { kbdReads: 0 };

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

  /** Fit the RAM the settings ask for, then list the ROMs the machine needs besides
   *  the Monitor: the video character generator. */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.fit(readApple1Options(view));
    return [{
      cacheKey: 'apple1-chargen',
      source: apple1ModelInfo(this.model).charsetSource,
      fetchingMsg: 'Fetching Apple I character generator ROM…',
      loadedMsg: (bytes) => `Character generator loaded (${bytes} bytes)`,
      failMsg: 'Failed to load the Apple I character generator ROM',
      failId: 'apple1-chargen',
      apply: (data) => { this.charset.load(data); this.needsDisplay = true; },
      awaitLoad: true,
    }];
  }

  private fit(options: Apple1Options): void {
    this.options = options;
    this.memory.setRamKb(options.ramKb);
    this.memory.setBasicRam(options.basicRam);
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
    this.setStatus('Reset');
  }

  /** The keyboard's RESET key: the 6502's RESET line and the PIA's, not a power
   *  cycle. RAM and the screen survive; the Monitor's reset handler runs again. */
  pressResetKey(): boolean {
    this.cpu.reset();
    this.pia.reset();
    this.keyboard.reset();
    this.busyUntil = 0;
    return true;
  }

  /** The CLEAR SCREEN key blanks the terminal without involving the CPU. */
  pressClearScreenKey(): void {
    this.terminal.clear();
    this.needsDisplay = true;
  }

  private resetHardware(): void {
    this.memory.reset();
    this.cpu.reset();
    this.pia.reset();
    this.keyboard.reset();
    this.terminal.clear();
    this.busyUntil = 0;
    this.activity.kbdReads = 0;
    this.cursorFrame = 0;
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

  protected runFrame(): void {
    const endT = this.cpu.tStates + APPLE1_TSTATES_PER_FRAME;
    const skipAudio = this.speedMultiplier !== 1;
    const watchActive = this.memWatchpoints.length > 0;
    this.activity.kbdReads = 0;

    while (this.cpu.tStates < endT) {
      if (this.breakpoints.has(this.cpu.pc)) {
        this.breakpointHit = this.cpu.pc;
        this.drawFrame();
        return;
      }
      if (this.onTrap !== null && this.onTrap(this.cpu.pc)) {
        this.drawFrame();
        return;
      }
      const before = this.cpu.tStates;
      this.cpu.step();
      if (!skipAudio) {
        // Silence still has to be fed: the frame loop paces itself on the audio buffer.
        this.mixer.accumulate(0, this.cpu.tStates - before);
        this.mixer.generateSamples(this.audio, null, false);
      }
      // Stop on the instruction that tripped a memory watchpoint.
      if (watchActive && this.memWatchHit !== null) {
        this.drawFrame();
        return;
      }
    }
    this.cursorFrame = (this.cursorFrame + 1) % (CURSOR_FRAMES * 2);
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

  startTrace(_mode = 'full'): void {}
  stopTrace(): string { return ''; }
}
