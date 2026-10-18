/**
 * Apple II / II Plus / //e motherboard.
 *
 * A 1.0227 MHz 6502 (a 65C02 on the Enhanced //e) with 48K RAM, a 12K system ROM (Applesoft + Monitor), the
 * $C0xx soft switches, NTSC video (text / lores / hires), a 1-bit speaker, a
 * cassette port, and a Disk II controller card in slot 6. There are no on-board
 * interrupts: the frame loop just runs the CPU for a frame's worth of cycles and
 * advances the disk bit clock off the cycle count.
 */

import { M6502 } from '@/cores/m6502.ts';
import { M65C02 } from '@/cores/m65c02.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import { ocrApple2Text } from '@/ocr/apple2.ts';
import type { Apple2Model } from './models.ts';
import { APPLE2_ROM_SIZE, apple2ModelInfo, type Apple2ModelInfo } from './models.ts';
import { APPLE2_DEFAULT_OPTIONS, readApple2Options, type Apple2Options } from './options.ts';
import {
  APPLE2_ACTIVE_HEIGHT, APPLE2_ACTIVE_WIDTH, APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP, APPLE2_CPU_CLOCK, APPLE2_SCREEN_HEIGHT,
  APPLE2_SCREEN_WIDTH, APPLE2_TSTATES_PER_FRAME, APPLE2_VBL_LINE, APPLE2_CYCLES_PER_LINE,
} from './constants.ts';
import { Apple2Memory } from './apple2-memory.ts';
import { Apple2eMemory } from './apple2e-memory.ts';
import { Apple2Keyboard } from './apple2-keyboard.ts';
import { Apple2Paddles } from './apple2-paddles.ts';
import { Apple2Charset, Apple2eCharset, type Apple2Font } from './apple2-charset.ts';
import { Apple2Video, type Apple2VideoMode, type Apple2VideoState } from './apple2-video.ts';
import { Apple2Cassette } from './apple2-cassette.ts';
import { Disk2 } from './peripherals/disk2.ts';
import { Mockingboard } from './peripherals/mockingboard.ts';
import { Videx, VIDEX_SLOT } from './peripherals/videx.ts';
import { apple2Descriptor } from './descriptor.ts';
import { wireApple2Io } from './apple2-io.ts';
import { wireApple2eIo } from './apple2e-io.ts';
import { createApple2Services, type Apple2Services } from './services/index.ts';

/** Frames between flash-phase flips (the text-mode "flashing" attribute). */
const FLASH_FRAMES = 16;

/** The slot a Mockingboard is conventionally fitted in. */
const MOCKINGBOARD_SLOT = 4;

class Apple2Speaker {
  level = 0;
  /** The sound card's chips also need to know the audio sample rate. */
  onSampleRate: (rate: number) => void = () => {};
  setSampleRate(rate: number): void { this.onSampleRate(rate); }
  toggle(): void { this.level ^= 1; }
}

export class Apple2Machine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'apple2';
  readonly model: Apple2Model;
  private readonly modelInfo: Apple2ModelInfo;
  /** Fitted expansions; the defaults until `prepare()` reads the settings. */
  options: Apple2Options = APPLE2_DEFAULT_OPTIONS;
  host: MachineHost | null = null;
  readonly services: Apple2Services;

  /** An NMOS 6502, or on the Enhanced //e a CMOS 65C02. */
  readonly cpu: M6502;
  readonly memory: Apple2Memory;
  readonly keyboard: Apple2Keyboard;
  readonly paddles = new Apple2Paddles();
  /** The Mockingboard, when fitted (slot 4). */
  mockingboard: Mockingboard | null = null;
  /** The Videx Videoterm 80-column card (][ and ][+ only), when fitted (slot 3). */
  videx: Videx | null = null;
  readonly charset: Apple2Font;
  readonly video = new Apple2Video();
  readonly cassette = new Apple2Cassette();
  readonly disk2 = new Disk2(() => this.cpu.tStates);
  readonly speaker = new Apple2Speaker();
  readonly mixer = new AudioMixer(APPLE2_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  /** Display switches ($C050-$C057). */
  textMode = true;
  mixed = false;
  page2 = false;
  hires = false;

  /** //e only: 80-column text, alternate character set, double hi-res. */
  col80 = false;
  altCharset = false;
  dhires = false;

  /** Text-mode flash attribute phase. */
  flashPhase = false;
  private flashFrame = 0;

  /** Per-frame activity for the frame probe. `kbdReads` counts polls of the
   *  keyboard data port ($C000), which is what the KEY indicator shows. */
  readonly activity = { beeperToggled: false, cassetteToggles: 0, kbdReads: 0 };

  protected get audioChip(): Apple2Speaker { return this.speaker; }

  get descriptor(): MachineDescriptor { return apple2Descriptor(this.model); }
  get pixels(): Uint8Array { return this.video.pixels; }
  get frameWidth(): number { return APPLE2_SCREEN_WIDTH; }
  get frameHeight(): number { return APPLE2_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number { return APPLE2_TSTATES_PER_FRAME; }
  get cpuClockHz(): number { return APPLE2_CPU_CLOCK; }

  private readonly videoState: Apple2VideoState;

  /** The //e's memory (MMU switches, auxiliary RAM); only valid on that model. */
  get mmu(): Apple2eMemory { return this.memory as Apple2eMemory; }
  get isIie(): boolean { return this.modelInfo.iie; }

  constructor(model: Apple2Model, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.modelInfo = apple2ModelInfo(model);
    this.cpu = this.modelInfo.cmos ? new M65C02() : new M6502();
    this.display = display ?? null;
    this.memory = this.modelInfo.iie ? new Apple2eMemory() : new Apple2Memory();
    this.keyboard = new Apple2Keyboard(this.modelInfo.iie);
    this.charset = this.modelInfo.iie ? new Apple2eCharset() : new Apple2Charset();
    this.videoState = {
      ram: this.memory.ram,
      textMode: true, mixed: false, page2: false, hires: false,
      charset: this.charset, flashPhase: false, mode: 'ntsc',
    };
    this.cpu.read = (addr) => this.memory.readByte(addr);
    this.cpu.write = (addr, val) => this.memory.writeByte(addr, val);
    this.mixer.beeperGain = 1;
    this.mixer.psgGain = 0;
    if (this.modelInfo.iie) wireApple2eIo(this);
    else wireApple2Io(this);
    this.services = createApple2Services(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  loadROM(data: Uint8Array): void {
    this.memory.loadRom(data);
    this.setStatus(`${this.modelInfo.label} ROM loaded (${Math.min(data.length, APPLE2_ROM_SIZE)} bytes)`);
  }

  /** Fit the expansions the settings ask for, then list the ROMs they need: the
   *  Disk II controller card ROM (slot 6, when fitted) and the video character
   *  generator. */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.options = readApple2Options(view, this.model);
    this.memory.languageCard = this.options.languageCard;
    this.paddles.fitted = this.options.joystick;
    if (this.options.eightyColumn && !this.modelInfo.iie) {
      const card = new Videx();
      this.memory.cards[VIDEX_SLOT] = card;
      this.videx = card;
    }
    if (this.options.mockingboard) {
      const board = new Mockingboard(MOCKINGBOARD_SLOT, APPLE2_CPU_CLOCK, this.audio.sampleRate);
      this.speaker.onSampleRate = (rate) => board.setSampleRate(rate);
      this.memory.cards[MOCKINGBOARD_SLOT] = board;
      this.mockingboard = board;
      this.mixer.psgGain = 1;
    }
    if (this.modelInfo.iie) {
      this.mmu.auxFitted = this.options.eightyColumn;
      this.mmu.slotless = this.modelInfo.iic;
      this.mmu.intcxrom = this.modelInfo.iic;
    }
    const requests: AuxRomRequest[] = [];
    // The //c has its own disk firmware inside the system ROM.
    if (this.options.disk2 && !this.modelInfo.iic) {
      requests.push({
        cacheKey: 'apple2-disk2-rom',
        source: 'apple2/disk2.rom',
        fetchingMsg: 'Fetching Disk II controller ROM…',
        loadedMsg: (bytes) => `Disk II ROM loaded (${bytes} bytes)`,
        failMsg: 'Failed to load the Disk II ROM — floppy boot unavailable',
        failId: 'apple2-disk2',
        apply: (data) => this.memory.loadSlotRom(6, data),
        awaitLoad: true,
      });
    }
    const videx = this.videx;
    if (videx) {
      requests.push({
        cacheKey: 'apple2-videx-rom',
        source: 'apple2/videx-videoterm.rom',
        fetchingMsg: 'Fetching Videx Videoterm firmware ROM…',
        loadedMsg: (bytes) => `Videx Videoterm ROM loaded (${bytes} bytes)`,
        failMsg: 'Failed to load the Videx Videoterm ROM — 80-column card unavailable',
        failId: 'apple2-videx-rom',
        apply: (data) => videx.loadRom(data),
        awaitLoad: true,
      }, {
        cacheKey: 'apple2-videx-chargen',
        source: 'apple2/videx-chargen.rom',
        fetchingMsg: 'Fetching Videx Videoterm character ROM…',
        loadedMsg: (bytes) => `Videx character ROM loaded (${bytes} bytes)`,
        failMsg: 'Failed to load the Videx Videoterm character ROM',
        failId: 'apple2-videx-chargen',
        apply: (data) => videx.loadFont(data),
        awaitLoad: true,
      });
    }
    requests.push({
      cacheKey: 'apple2-chargen',
      source: this.modelInfo.charsetSource,
      fetchingMsg: 'Fetching Apple II character generator ROM…',
      loadedMsg: (bytes) => `Character generator loaded (${bytes} bytes)`,
      failMsg: 'Failed to load the Apple II character generator ROM',
      failId: 'apple2-chargen',
      apply: (data) => this.charset.load(data),
      awaitLoad: true,
    });
    return requests;
  }

  applySettings(view: SettingsView): void {
    this.audio.setVolume(view.get('volume', 70) / 100);
    const mode = view.get<Apple2VideoMode>('apple2-video', 'ntsc');
    if (mode !== this.videoState.mode) {
      this.videoState.mode = mode;
      // A frame may be paused; repaint so the change shows immediately.
      this.video.render(this.videoState);
      this.needsDisplay = true;
    }
  }

  // ── Frame probe / status inputs ────────────────────────────────────────

  get vblActive(): boolean {
    const line = (this.cpu.tStates % APPLE2_TSTATES_PER_FRAME) / APPLE2_CYCLES_PER_LINE;
    return line >= APPLE2_VBL_LINE;
  }

  get cassetteInputBit(): boolean {
    this.cassette.advanceTo(this.cpu.tStates / APPLE2_CPU_CLOCK);
    return this.cassette.inputBit === 1;
  }

  toggleSpeaker(): void {
    this.speaker.toggle();
    this.activity.beeperToggled = true;
  }

  /** $C020: cassette output. Counted for the activity readout; the Apple II
   *  has no cassette-in feedback, so nothing else depends on it. */
  pulseCassetteOutput(): void { this.activity.cassetteToggles++; }

  setBorderSize(mode: BorderMode): void {
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(APPLE2_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(APPLE2_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY, APPLE2_SCREEN_WIDTH - cropX * 2, APPLE2_SCREEN_HEIGHT - cropY * 2,
    );
  }

  reset(): void {
    this.stop();
    this.resetHardware();
    this.setStatus('Reset');
  }

  /** Boot the disk in drive 1. On an Autostart Monitor (the ][+) a fresh reset
   *  with a disk in place is exactly how a real machine starts DOS: the ROM
   *  scans the slots and jumps into the Disk II card's boot ROM. The original
   *  ][ has no Autostart — its Reset drops into the Monitor — so the boot is
   *  what the user would have typed, `C600G`. */
  bootDisc(): void {
    this.resetHardware();
    if (!this.modelInfo.autostart && this.options.disk2) this.cpu.pc = 0xC600;
    this.setStatus('Boot: drive 1');
  }

  /** Library one-click play: the shell has already reset the machine. */
  armBootTrap(kind: 'menu' | 'rom48k' | 'disk'): void {
    if (kind === 'disk') this.bootDisc();
  }

  private resetHardware(): void {
    this.cpu.reset();
    this.memory.reset();
    if (this.modelInfo.autostart) {
      // Power-on reset, not the ROM's Ctrl-Reset warm start: after booting, the
      // autostart ROM caches a warm-start vector at $03F2-$03F4, which a real
      // Ctrl-Reset follows straight into Applesoft — no banner and no disc scan.
      // Clearing it makes Reset re-run the slot scan, so a mounted disc boots as
      // it would on power-up (what a Reset button is expected to do).
      this.memory.ram[0x3F2] = 0;
      this.memory.ram[0x3F3] = 0;
      this.memory.ram[0x3F4] = 0;
    }
    this.keyboard.reset();
    this.paddles.reset();
    this.cpu.setIRQ(false);
    this.disk2.reset();
    this.cassette.rewind();
    this.textMode = true;
    this.mixed = false;
    this.page2 = false;
    this.hires = false;
    this.col80 = false;
    this.altCharset = false;
    this.dhires = false;
    this.flashPhase = false;
    this.flashFrame = 0;
    this.speaker.level = 0;
    this.activity.beeperToggled = false;
    this.activity.cassetteToggles = 0;
    this.activity.kbdReads = 0;
    this.mixer.reset();
    this.video.reset();
    this.needsDisplay = true;
  }

  protected framePixels(): Uint8Array { return this.video.pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  protected runFrame(): void {
    const endT = this.cpu.tStates + APPLE2_TSTATES_PER_FRAME;
    const skipAudio = this.speedMultiplier !== 1;
    const board = this.mockingboard;
    this.activity.beeperToggled = false;
    this.activity.kbdReads = 0;

    while (this.cpu.tStates < endT) {
      if (this.breakpoints.has(this.cpu.pc)) {
        this.breakpointHit = this.cpu.pc;
        this.needsDisplay = true;
        return;
      }
      if (this.onTrap !== null && this.onTrap(this.cpu.pc)) {
        this.needsDisplay = true;
        return;
      }
      const before = this.cpu.tStates;
      this.cpu.step();
      const elapsed = this.cpu.tStates - before;
      if (board) {
        board.tick(elapsed);
        this.cpu.setIRQ(board.irq);
      }
      if (!skipAudio) {
        this.mixer.accumulateLevel(this.speaker.level, elapsed);
        this.mixer.generateSamples(this.audio, board, board !== null);
      }
    }

    this.flashFrame = (this.flashFrame + 1) % (FLASH_FRAMES * 2);
    this.flashPhase = this.flashFrame < FLASH_FRAMES;

    this.syncVideoState();
    this.video.render(this.videoState);

    this.cassette.advanceTo(this.cpu.tStates / APPLE2_CPU_CLOCK);
    this.disk2.tickFrame();
    this.needsDisplay = true;
  }

  /** Copy the display switches into the renderer's state. */
  private syncVideoState(): void {
    const v = this.videoState;
    v.textMode = this.textMode;
    v.mixed = this.mixed;
    v.hires = this.hires;
    v.flashPhase = this.flashPhase;
    v.videx = this.videx ? this.videx.view : null;
    if (this.modelInfo.iie) {
      const mmu = this.mmu;
      // With 80STORE, PAGE2 switches which RAM the CPU sees rather than which page
      // is shown, so the display stays on page 1.
      v.page2 = this.page2 && !mmu.store80;
      v.aux = mmu.auxFitted ? mmu.aux : null;
      v.col80 = this.col80;
      v.dhires = this.dhires;
      v.altCharset = this.altCharset;
    } else {
      v.page2 = this.page2;
    }
  }

  // ── Debug / OCR surface ────────────────────────────────────────────────

  private ocrTextRows(): { first: number; last: number } | null {
    if (this.textMode) return { first: 0, last: 23 };
    if (this.mixed) return { first: 20, last: 23 };
    return null;
  }

  ocrScreenForMcp(_mode?: string): string {
    const result = ocrApple2Text(this.ocrInput());
    const rows = result.text.split('\n').map(r => r.replace(/\s+$/, ''));
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  ocrScreenStyled(): OcrResult {
    return ocrApple2Text(this.ocrInput());
  }

  private ocrInput(): Parameters<typeof ocrApple2Text>[0] {
    const videx = this.videx?.view;
    const ink = this.videoState.mode === 'green' ? '#33ff66' : '#ffffff';
    if (videx?.active) {
      return {
        ram: videx.ram, page2: false, textRows: { first: 0, last: 23 },
        videx: { start: videx.start }, ink,
      };
    }
    if (!this.modelInfo.iie) {
      return { ram: this.memory.ram, page2: this.page2, textRows: this.ocrTextRows(), ink };
    }
    const mmu = this.mmu;
    return {
      ink,
      ram: mmu.ram, aux: mmu.auxFitted ? mmu.aux : null,
      page2: this.page2 && !mmu.store80, textRows: this.ocrTextRows(),
      col80: this.col80, altCharset: this.altCharset, iie: true, mouseText: this.modelInfo.cmos,
    };
  }

  /** Blank matched 40×24 (or 80×24) cells to black so the crisp overlay replaces them. */
  /** Where the TEXT overlay's grid sits in the frame: the Videx card's 216-line
   *  display is centred, the Apple's own text fills the 192-line active area. */
  get textField(): { x: number; y: number; width: number; height: number } {
    if (this.videx?.view.active) {
      const height = 24 * 9;
      return { x: APPLE2_BORDER_LEFT, y: (APPLE2_SCREEN_HEIGHT - height) >> 1, width: APPLE2_ACTIVE_WIDTH, height };
    }
    return {
      x: APPLE2_BORDER_LEFT, y: APPLE2_BORDER_TOP,
      width: APPLE2_ACTIVE_WIDTH, height: APPLE2_ACTIVE_HEIGHT,
    };
  }

  blankCells(mask: boolean[], cols: number, rows: number, _paper?: number[]): void {
    const px = new Uint32Array(this.video.pixels.buffer);
    const w = APPLE2_SCREEN_WIDTH;
    const cellW = APPLE2_ACTIVE_WIDTH / cols;
    // The Videx card's output is 24 rows of nine scan lines, centred in the frame.
    const videxOut = this.videx?.view.active === true;
    const cellH = videxOut ? 9 : 8;
    const top = videxOut ? (APPLE2_SCREEN_HEIGHT - 24 * 9) >> 1 : APPLE2_BORDER_TOP;
    for (let row = 0; row < rows; row++) {
      const y0 = top + row * cellH;
      for (let col = 0; col < cols; col++) {
        if (!mask[row * cols + col]) continue;
        const x0 = APPLE2_BORDER_LEFT + col * cellW;
        for (let y = 0; y < cellH; y++) {
          const base = (y0 + y) * w + x0;
          px.fill(0xFF000000, base, base + cellW);
        }
      }
    }
  }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: `${this.model}-ram-48k.bin` };
  }

  startTrace(_mode = 'full'): void {}
  stopTrace(): string { return ''; }
}
