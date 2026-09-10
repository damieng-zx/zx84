/**
 * LynxMachine — the Camputers Lynx motherboard.
 *
 * A Z80A at 4MHz, a Motorola 6845 sequencing the raster over three one-bit
 * colour planes, a ten-line keyboard read through the address bus, an 8-bit
 * sound DAC on port 0x84 and, on the 96K/128K, an FD1793 floppy controller —
 * which is a WD1793, so the existing WD179x core covers it.
 *
 * Hardware behaviour follows MAME's `camputers/camplynx.cpp`, the only
 * detailed public description of this machine.
 */

import { Z80 } from '@/cores/z80.ts';
import { Crtc6845 } from '@/cores/crtc-6845.ts';
import { WD179x } from '@/cores/wd179x.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, MachineTraceMode,
  SettingsView,
} from '@/machines/machine.ts';
import { LYNX_CPU_CLOCK, LYNX_PAGE_SIZE, LYNX_T_PER_FRAME } from './constants.ts';
import { lynxHasDisk, type LynxModel } from './models.ts';
import { LynxMemory } from './lynx-memory.ts';
import { LynxKeyboard } from './lynx-keyboard.ts';
import { LynxVideo } from './lynx-video.ts';
import { wireLynxPortIO } from './lynx-io.ts';
import { lynxDescriptor } from './descriptor.ts';
import { createLynxServices, type LynxServices } from './services/index.ts';

/** The Lynx's only audio is a DAC on the mixer's beeper channel, so there is
 *  no PSG to keep in step with the sample rate. */
const NO_PSG = { setSampleRate(_rate: number): void { /* no PSG fitted */ } };

export class LynxMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'lynx';
  readonly model: LynxModel;

  readonly services: LynxServices;

  readonly cpu = new Z80();
  readonly crtc = new Crtc6845(0);
  readonly memory: LynxMemory;
  readonly keyboard = new LynxKeyboard();
  readonly video: LynxVideo;
  /** FD1793 — a WD1793, so status bit 7 is NOT READY rather than MOTOR ON. */
  readonly fdc = new WD179x({ statusBit7: 'not-ready', formatSectorsPerTrack: 10 });
  /** The disk interface is fitted on the 96K and 128K only. */
  readonly hasDisk: boolean;

  /** The cassette deck. The Lynx has a real motor bit, so playback is gated on
   *  the motor rather than on read cadence the way the CPC's has to be. */
  readonly tape = new TapeDeck(LYNX_CPU_CLOCK);

  readonly mixer = new AudioMixer(LYNX_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  readonly activity = { kbdReads: 0, fdcAccesses: 0, casReads: 0 };

  /** Port 0x84's DAC value while the cassette motor is off. */
  dacLevel = 0;
  /** Port 0x80 as last written. */
  private port80 = 0;
  /** CPU time the deck was last advanced to. */
  private tapeLastAdvanceT = 0;
  /** The motor relay, as port 0x80 last set it. */
  private tapeMotorRunning = false;

  private host: MachineHost | null = null;
  private readonly _pixels32: Uint32Array;
  private readonly _pixels: Uint8Array;

  constructor(model: LynxModel, display: IScreenRenderer | null = null) {
    super();
    this.model = model;
    this.hasDisk = lynxHasDisk(model);
    this.display = display;
    this.memory = new LynxMemory(model);
    this.video = new LynxVideo(this.memory, this.crtc);
    this._pixels32 = this.video.pixels;
    this._pixels = new Uint8Array(this._pixels32.buffer);

    this.tape.pulseScale = LYNX_CPU_CLOCK / TAPE_REF_HZ;
    this.cpu.read8 = (addr: number): number => this.memory.readByte(addr);
    this.cpu.write8 = (addr: number, v: number): void => this.memory.writeByte(addr, v);
    wireLynxPortIO(this);

    this.services = createLynxServices(this, () => this.host);
  }

  // ── Machine SPI ────────────────────────────────────────────────────────

  get descriptor(): MachineDescriptor { return lynxDescriptor(this.model); }
  get pixels(): Uint8Array { return this._pixels; }
  get frameWidth(): number { return this.video.geometry.width; }
  get frameHeight(): number { return this.video.geometry.height; }
  get tStatesPerFrame(): number { return LYNX_T_PER_FRAME; }
  get cpuClockHz(): number { return LYNX_CPU_CLOCK; }

  attachHost(host: MachineHost): void { this.host = host; }
  applySettings(_view: SettingsView): void { /* nothing settings-driven yet */ }
  setBorderSize(_mode: BorderMode): void { /* the Lynx border is not croppable */ }

  /**
   * Install the system ROM: the 8K images end to end, as romSources fetches
   * them. Two on the 48K; on the 96K and 128K three, then the DOS ROM, which
   * lives at the top of bank 0 rather than following the others.
   */
  loadROM(data: Uint8Array): void {
    const count = this.hasDisk ? 3 : 2;
    const images: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const at = i * LYNX_PAGE_SIZE;
      if (at + LYNX_PAGE_SIZE > data.length) break;
      images.push(data.subarray(at, at + LYNX_PAGE_SIZE));
    }
    const dosAt = count * LYNX_PAGE_SIZE;
    const dos = this.hasDisk && dosAt + LYNX_PAGE_SIZE <= data.length
      ? data.subarray(dosAt, dosAt + LYNX_PAGE_SIZE)
      : null;
    this.memory.loadRoms(images, dos);
  }

  reset(): void {
    this.cpu.reset();
    this.memory.reset();
    this.keyboard.reset();
    this.video.reset();
    this.crtc.reset();
    this.fdc.reset();
    this.port80 = 0;
    this.dacLevel = 0;
    this.tapeMotorRunning = false;
    this.tapeLastAdvanceT = 0;
    this.tape.paused = true;
  }

  // ── Port 0x80 and the cassette ─────────────────────────────────────────

  /** Port 0x80: bank decode, the alternate green plane, the cassette motor. */
  setPort80(value: number): void {
    this.port80 = value & 0xff;
    this.memory.setPort80(this.port80);
    this.video.altGreen = (this.port80 & 0x10) !== 0;
    this.setTapeMotor(this.tapeMotorOn);
  }

  /** The motor bit is bit 1 on the 48K/96K and bit 3 on the 128K. */
  get tapeMotorOn(): boolean {
    return (this.port80 & (this.memory.is128k ? 0x08 : 0x02)) !== 0;
  }

  /**
   * Tape input, sampled by the ROM's bit-timing loop.
   *
   * The deck is advanced here rather than once a frame because the ROM measures
   * the gap between edges: it has to see the level the tape is at *now*, at the
   * T-state of this read, not where the tape was at the last frame boundary.
   */
  cassetteInput(): boolean {
    if (!this.tape.playing || this.tape.paused) return false;
    const now = this.cpu.tStates;
    const gap = now - this.tapeLastAdvanceT;
    this.tapeLastAdvanceT = now;
    if (gap > 0) this.tape.advance(gap);
    return this.tape.earBit !== 0;
  }

  /** Tape output. Saving to a wav is not something this emulator does, so the
   *  bit is dropped — but it must not reach the DAC or the speaker screams
   *  through every SAVE. */
  cassetteOutput(_high: boolean): void { /* nothing records */ }

  /** Start or stop the deck with the motor relay. */
  private setTapeMotor(on: boolean): void {
    if (on === this.tapeMotorRunning) return;
    this.tapeMotorRunning = on;
    if (!this.tape.loaded) return;
    if (on) {
      this.tapeLastAdvanceT = this.cpu.tStates;
      if (!this.tape.playing) this.tape.startPlayback();
      this.tape.paused = false;
    } else {
      this.tape.paused = true;
    }
  }

  // ── Debug SPI ──────────────────────────────────────────────────────────

  /** Execution tracing is not wired up yet; the MCP tool degrades rather than
   *  failing. */
  startTrace(_mode: MachineTraceMode = 'full'): void { /* not yet */ }
  stopTrace(): string { return ''; }

  /** The Lynx screen is a bitmap with no character grid behind it, so OCR
   *  needs a font match against the ROM's character set — a later increment. */
  ocrScreenForMcp(): string {
    return 'OCR is not available on the Camputers Lynx yet';
  }

  /** Raw RAM dump for the `.bin` save: the whole physical store. */
  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ramSnapshot(), filename: `ram-${this.model}.bin` };
  }

  // ── Frame ──────────────────────────────────────────────────────────────

  protected get audioChip() { return NO_PSG; }
  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    this.activity.kbdReads = 0;
    this.activity.fdcAccesses = 0;
    this.activity.casReads = 0;

    this.video.beginFrame();

    // The 6845 owns the line count; the 50Hz frame is divided among however
    // many lines it has been programmed for, so an unusual R4/R9 stretches or
    // squeezes the raster rather than losing lines off the bottom.
    const lines = this.crtc.linesPerFrame();
    const tPerLine = LYNX_T_PER_FRAME / lines;
    let lineEnd = this.cpu.tStates;
    let lastAudioT = this.cpu.tStates;
    let broke = false;
    let interrupted = false;

    for (let line = 0; line < lines; line++) {
      lineEnd += tPerLine;

      while (this.cpu.tStates < lineEnd) {
        if (this.breakpoints.has(this.cpu.pc)) { this.breakpointHit = this.cpu.pc; broke = true; break; }
        if (this.onTrap !== null && this.onTrap(this.cpu.pc)) { broke = true; break; }
        this.cpu.step();

        if (!skipAudio) {
          const elapsed = this.cpu.tStates - lastAudioT;
          if (elapsed > 0) {
            // The DAC is an 8-bit level and the mixer's beeper channel is one
            // bit, so only the top bit carries for now.
            this.mixer.accumulate(this.dacLevel >> 7, elapsed);
            this.mixer.generateSamples(this.audio, null, false);
            lastAudioT = this.cpu.tStates;
          }
        }
      }
      if (broke) break;

      this.video.renderScanline();

      // VSYNC is wired straight to /INT.
      if (this.crtc.vsyncStart) { this.cpu.interrupt(); interrupted = true; }
    }

    // Until the ROM has programmed R7 there is no VSYNC to interrupt from, and
    // the machine would never leave its initialisation loop.
    if (!broke && !interrupted) this.cpu.interrupt();

    if (this.display) this.display.updateTexture(this._pixels);
  }
}
