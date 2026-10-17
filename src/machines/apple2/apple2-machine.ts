/**
 * Apple II / II Plus motherboard.
 *
 * A 1.0227 MHz 6502 with 48K RAM, a 12K system ROM (Applesoft + Monitor), the
 * $C0xx soft switches, NTSC video (text / lores / hires), a 1-bit speaker, a
 * cassette port, and a Disk II controller card in slot 6. There are no on-board
 * interrupts: the frame loop just runs the CPU for a frame's worth of cycles and
 * advances the disk bit clock off the cycle count.
 */

import { M6502 } from '@/cores/m6502.ts';
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
import { APPLE2_ROM_SIZE } from './models.ts';
import {
  APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP, APPLE2_CPU_CLOCK, APPLE2_SCREEN_HEIGHT,
  APPLE2_SCREEN_WIDTH, APPLE2_TSTATES_PER_FRAME, APPLE2_VBL_LINE, APPLE2_CYCLES_PER_LINE,
} from './constants.ts';
import { Apple2Memory } from './apple2-memory.ts';
import { Apple2Keyboard } from './apple2-keyboard.ts';
import { Apple2Charset } from './apple2-charset.ts';
import { Apple2Video, type Apple2VideoState } from './apple2-video.ts';
import { Apple2Cassette } from './apple2-cassette.ts';
import { Disk2 } from './peripherals/disk2.ts';
import { apple2Descriptor } from './descriptor.ts';
import { wireApple2Io } from './apple2-io.ts';
import { createApple2Services, type Apple2Services } from './services/index.ts';

/** Frames between flash-phase flips (the text-mode "flashing" attribute). */
const FLASH_FRAMES = 16;

class Apple2Speaker {
  level = 0;
  setSampleRate(_rate: number): void {}
  toggle(): void { this.level ^= 1; }
}

export class Apple2Machine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'apple2';
  readonly model: Apple2Model;
  host: MachineHost | null = null;
  readonly services: Apple2Services;

  readonly cpu = new M6502();
  readonly memory = new Apple2Memory();
  readonly keyboard = new Apple2Keyboard();
  readonly charset = new Apple2Charset();
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

  /** Text-mode flash attribute phase. */
  flashPhase = false;
  private flashFrame = 0;

  /** Per-frame activity for the frame probe. */
  readonly activity = { beeperToggled: false, cassetteToggles: 0 };

  protected get audioChip(): Apple2Speaker { return this.speaker; }

  get descriptor(): MachineDescriptor { return apple2Descriptor(this.model); }
  get pixels(): Uint8Array { return this.video.pixels; }
  get frameWidth(): number { return APPLE2_SCREEN_WIDTH; }
  get frameHeight(): number { return APPLE2_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number { return APPLE2_TSTATES_PER_FRAME; }
  get cpuClockHz(): number { return APPLE2_CPU_CLOCK; }

  private readonly videoState: Apple2VideoState = {
    ram: this.memory.ram,
    textMode: true, mixed: false, page2: false, hires: false,
    charset: this.charset, flashPhase: false,
  };

  constructor(model: Apple2Model, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.display = display ?? null;
    this.cpu.read = (addr) => this.memory.readByte(addr);
    this.cpu.write = (addr, val) => this.memory.writeByte(addr, val);
    this.mixer.beeperGain = 1;
    this.mixer.psgGain = 0;
    wireApple2Io(this);
    this.services = createApple2Services(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  loadROM(data: Uint8Array): void {
    this.memory.loadRom(data);
    this.setStatus(`Apple II ROM loaded (${Math.min(data.length, APPLE2_ROM_SIZE)} bytes)`);
  }

  /** ROMs the machine needs beyond the system ROM: the Disk II controller card
   *  ROM (slot 6) and the video character generator. */
  prepare(_view: SettingsView): AuxRomRequest[] {
    return [
      {
        cacheKey: 'apple2-disk2-rom',
        source: 'apple2/disk2.rom',
        fetchingMsg: 'Fetching Disk II controller ROM…',
        loadedMsg: (bytes) => `Disk II ROM loaded (${bytes} bytes)`,
        failMsg: 'Failed to load the Disk II ROM — floppy boot unavailable',
        failId: 'apple2-disk2',
        apply: (data) => this.memory.loadSlotRom(6, data),
        awaitLoad: true,
      },
      {
        cacheKey: 'apple2-chargen',
        source: 'apple2/chargen.rom',
        fetchingMsg: 'Fetching Apple II character generator ROM…',
        loadedMsg: (bytes) => `Character generator loaded (${bytes} bytes)`,
        failMsg: 'Failed to load the Apple II character generator ROM',
        failId: 'apple2-chargen',
        apply: (data) => this.charset.load(data),
        awaitLoad: true,
      },
    ];
  }

  applySettings(view: SettingsView): void {
    this.audio.setVolume(view.get('volume', 70) / 100);
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

  /** Boot the disk in drive 1: the Monitor ROM's reset scans the slots and
   *  jumps into the Disk II card's boot ROM, so a fresh reset with a disk in
   *  place is exactly how a real machine starts DOS. */
  bootDisc(): void {
    this.resetHardware();
    this.setStatus('Boot: drive 1');
  }

  /** Library one-click play: the shell has already reset the machine. */
  armBootTrap(kind: 'menu' | 'rom48k' | 'disk'): void {
    if (kind === 'disk') this.resetHardware();
  }

  private resetHardware(): void {
    this.cpu.reset();
    this.memory.reset();
    // Power-on reset, not the ROM's Ctrl-Reset warm start: after booting, the
    // autostart ROM caches a warm-start vector at $03F2-$03F4, which a real
    // Ctrl-Reset follows straight into Applesoft — no banner and no disc scan.
    // Clearing it makes Reset re-run the slot scan, so a mounted disc boots as
    // it would on power-up (what a Reset button is expected to do).
    this.memory.ram[0x3F2] = 0;
    this.memory.ram[0x3F3] = 0;
    this.memory.ram[0x3F4] = 0;
    this.keyboard.reset();
    this.disk2.reset();
    this.cassette.rewind();
    this.textMode = true;
    this.mixed = false;
    this.page2 = false;
    this.hires = false;
    this.flashPhase = false;
    this.flashFrame = 0;
    this.speaker.level = 0;
    this.activity.beeperToggled = false;
    this.activity.cassetteToggles = 0;
    this.mixer.reset();
    this.video.reset();
    this.needsDisplay = true;
  }

  protected framePixels(): Uint8Array { return this.video.pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  protected runFrame(): void {
    const endT = this.cpu.tStates + APPLE2_TSTATES_PER_FRAME;
    const skipAudio = this.speedMultiplier !== 1;
    this.activity.beeperToggled = false;

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
      if (!skipAudio) {
        this.mixer.accumulateLevel(this.speaker.level, this.cpu.tStates - before);
        this.mixer.generateSamples(this.audio, null, false);
      }
    }

    this.flashFrame = (this.flashFrame + 1) % (FLASH_FRAMES * 2);
    this.flashPhase = this.flashFrame < FLASH_FRAMES;

    this.videoState.textMode = this.textMode;
    this.videoState.mixed = this.mixed;
    this.videoState.page2 = this.page2;
    this.videoState.hires = this.hires;
    this.videoState.flashPhase = this.flashPhase;
    this.video.render(this.videoState);

    this.cassette.advanceTo(this.cpu.tStates / APPLE2_CPU_CLOCK);
    this.disk2.tickFrame();
    this.needsDisplay = true;
  }

  // ── Debug / OCR surface ────────────────────────────────────────────────

  private ocrTextRows(): { first: number; last: number } | null {
    if (this.textMode) return { first: 0, last: 23 };
    if (this.mixed) return { first: 20, last: 23 };
    return null;
  }

  ocrScreenForMcp(_mode?: string): string {
    const result = ocrApple2Text({
      ram: this.memory.ram, page2: this.page2, textRows: this.ocrTextRows(),
    });
    const rows = result.text.split('\n').map(r => r.replace(/\s+$/, ''));
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  ocrScreenStyled(): OcrResult {
    return ocrApple2Text({
      ram: this.memory.ram, page2: this.page2, textRows: this.ocrTextRows(),
    });
  }

  /** Blank matched 40×24 cells to black so the crisp overlay replaces them. */
  blankCells(mask: boolean[], cols: number, rows: number, _paper?: number[]): void {
    const px = new Uint32Array(this.video.pixels.buffer);
    const w = APPLE2_SCREEN_WIDTH;
    const cellW = 7;
    const cellH = 8;
    for (let row = 0; row < rows; row++) {
      const y0 = APPLE2_BORDER_TOP + row * cellH;
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
