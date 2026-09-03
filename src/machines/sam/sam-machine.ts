/**
 * SamMachine — MGT SAM Coupé orchestrator.
 *
 * The SAM's counterpart to `Spectrum` / `CpcMachine` / `MsxMachine`: it owns the
 * Z80B, the paged memory and the MGT ASIC, and drives its own PAL field loop.
 * Implements the shared `Machine` SPI so the shell, UI and MCP server treat it
 * like any other machine.
 *
 * The CPU, memory paging, all four screen modes and both interrupt sources are
 * live, as are the keyboard, the Kempston port, the SAA1099 and the two WD1772
 * drives and the cassette deck. Still to come: snapshots.
 */

import { Z80 } from '@/cores/z80.ts';
import { SAA1099 } from '@/cores/saa1099.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { disasmOne, type DisasmLine } from '@/debug/z80/disasm.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind,
  MachineTraceMode, SettingsView,
} from '@/machines/machine.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { SamMemory } from './sam-memory.ts';
import { SamAsic } from './asic.ts';
import { SamKeyboard } from './sam-keyboard.ts';
import { SamJoystick } from './sam-joystick.ts';
import { SamContention } from './contention.ts';
import { SamDiskInterface } from './peripherals/sam-disk.ts';
import { createSamConfig, type SamConfig } from './config.ts';
import type { SamModel } from './models.ts';
import { samDescriptor } from './descriptor.ts';
import { createSamServices, type SamServices } from './services/index.ts';
import { installSamMemoryHooks, wireSamPortIO } from './sam-io.ts';
import {
  SAM_BORDER_LEFT, SAM_BORDER_TOP, SAM_CPU_CLOCK, SAM_LINES_PER_FRAME,
  SAM_SAA_CLOCK,
  SAM_PALETTES, SAM_SCREEN_HEIGHT, SAM_SCREEN_WIDTH,
  SAM_T_PER_FRAME, SAM_T_PER_LINE,
  type SamColorMap,
} from './constants.ts';

export class SamMachine extends BaseMachine implements Machine {
  protected get audioChip(): SAA1099 { return this.psg; }

  readonly kind: MachineKind = 'sam';
  readonly model: SamModel;
  readonly config: SamConfig;
  /** Operator's panel (shell / MCP) — null when running headless. */
  host: MachineHost | null = null;
  readonly services: SamServices;

  readonly cpu: Z80;
  readonly memory: SamMemory;
  /** The custom silicon: video, palette, border and the interrupt sources. */
  readonly asic: SamAsic;
  readonly keyboard = new SamKeyboard();
  readonly joystick = new SamJoystick();
  /** The ASIC's RAM slot quantiser (see contention.ts). */
  readonly contention = new SamContention();
  readonly psg: SAA1099;
  /** The two internal 3.5" drives on their WD1772 controllers. */
  readonly disk = new SamDiskInterface();
  /** Cassette deck. Pulse lengths in tape images are referenced to 3.5 MHz,
   *  so the deck scales them to the SAM's 6 MHz clock. */
  readonly tape: TapeDeck;
  readonly mixer: AudioMixer;
  readonly audio: Audio;
  display: IScreenRenderer | null;

  // ── Latches read back through port 0xFE ───────────────────────────────────
  /** Beeper output (port 0xFE bit 4). */
  beeperBit = 0;
  /** Cassette MIC output (port 0xFE bit 3). */
  micBit = 0;
  /** Cassette EAR input level. */
  earBit = 0;

  /** Per-frame I/O activity, mapped onto the status-bar LEDs by the probe. */
  readonly activity = {
    kbdReads: 0, joystickReads: 0, beeperWrites: 0, psgWrites: 0,
    fdcAccesses: 0, tapeReads: 0,
  };

  /** RGBA frame buffer plus a Uint32 view for fast ASIC writes. */
  private readonly _pixels = new Uint8Array(SAM_SCREEN_WIDTH * SAM_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  get tStatesPerFrame(): number { return SAM_T_PER_FRAME; }
  get cpuClockHz(): number { return SAM_CPU_CLOCK; }
  get frameWidth(): number { return SAM_SCREEN_WIDTH; }
  get frameHeight(): number { return SAM_SCREEN_HEIGHT; }

  constructor(model: SamModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.config = createSamConfig(model);
    this.cpu = new Z80();
    this.memory = new SamMemory(this.config);
    this.asic = new SamAsic(this.memory);
    this.psg = new SAA1099(SAM_SAA_CLOCK, 44100);
    this.tape = new TapeDeck(SAM_CPU_CLOCK);
    this.tape.pulseScale = SAM_CPU_CLOCK / TAPE_REF_HZ;
    this.audio = new Audio();
    this.mixer = new AudioMixer(SAM_CPU_CLOCK);
    this.mixer.beeperGain = 1;
    this.mixer.psgGain = 1;
    this.display = display ?? null;

    installSamMemoryHooks(this);
    wireSamPortIO(this);

    this.services = createSamServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  get descriptor(): MachineDescriptor { return samDescriptor(this.model); }

  /** BaseMachine notifies `onStatus`; the SAM also forwards to the attached
   *  host so the shell's status line reflects ROM/reset events. */
  protected override setStatus(msg: string): void {
    super.setStatus(msg);
    this.host?.setStatus(msg);
  }

  // ── Seams used by sam-io.ts ───────────────────────────────────────────────

  /** Port 0xFE keyboard bits for the rows the port's high byte selects. */
  readKeyboardLow(rowSelect: number): number { return this.keyboard.readLow(rowSelect); }
  /** Port 0xF9's top three bits — the SAM's extra keys. */
  readKeyboardHigh(rowSelect: number): number { return this.keyboard.readHigh(rowSelect); }
  /** Kempston joystick on port 0x1F. */
  readKempston(): number { return this.joystick.read(); }

  /** T-state the deck was last advanced to. */
  private tapeLastAdvanceT = 0;

  /**
   * Catch the cassette up to the current T-state and latch its EAR level.
   *
   * Called from the port 0xFE read handler so each poll of the tape bit sees an
   * up-to-date edge, exactly as the Spectrum does. The SAM has no motor relay
   * to gate on, so playback runs whenever the deck is playing and unpaused.
   */
  advanceTapeTo(): void {
    const now = this.cpu.tStates;
    if (this.tape.playing && !this.tape.paused) {
      const delta = now - this.tapeLastAdvanceT;
      if (delta > 0) this.tape.advance(delta);
      this.earBit = this.tape.earBit;
    }
    // The baseline moves on even while stopped or paused. Leaving it stale
    // would hand the deck the whole paused interval as a single delta on
    // resume, skipping the tape forward by however long the user waited.
    this.tapeLastAdvanceT = now;
    this.activity.tapeReads++;
  }

  /** Ask for the frame buffer to be re-uploaded on the next display tick.
   *  Services use this after mutating machine state out-of-band. */
  requestRedraw(): void { this.needsDisplay = true; }

  /** Screen-off latch, read back through port 0xFE. */
  get screenOff(): boolean { return this.asic.screenOff; }
  /** Active-low interrupt status, read through port 0xF9. */
  get status(): number { return this.asic.status; }

  // ── Machine: settings, ROM, regions ───────────────────────────────────────

  applySettings(view: SettingsView): void {
    const map = view.get('sam-color-map', 'linear') as SamColorMap;
    this.asic.palette = SAM_PALETTES[map] ?? SAM_PALETTES.linear;
    this.contention.enabled = view.get('sam-contention', true);
    this.disk.setWriteProtect(0, view.get('sam-write-protect-1', false));
    this.disk.setWriteProtect(1, view.get('sam-write-protect-2', false));
    this.audio.setVolume(view.get('volume', 70) / 100);
    this.needsDisplay = true;
  }

  loadROM(data: Uint8Array): void {
    this.memory.loadRom(data);
    this.setStatus('ROM loaded');
  }

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    if (value === 'sam-rom0') return { data: this.memory.getRom(0), baseAddr: 0x0000 };
    if (value === 'sam-rom1') return { data: this.memory.getRom(1), baseAddr: 0xC000 };
    return null;
  }

  /** `.scr` export: the 24K display page pair the ASIC is currently fetching. */
  screenExportBytes(): Uint8Array {
    const base = this.memory.videoBasePage;
    const out = new Uint8Array(0x8000);
    out.set(this.memory.videoPage(base), 0);
    out.set(this.memory.videoPage(base + 1), 0x4000);
    return out;
  }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return {
      data: this.memory.allRam(),
      filename: `ram-${this.config.internalPages * 16}k.bin`,
    };
  }

  // ── Machine: lifecycle ────────────────────────────────────────────────────

  setBorderSize(mode: BorderMode): void {
    // The ASIC always renders the full field; the border size is a pure crop.
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(SAM_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(SAM_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY,
      SAM_SCREEN_WIDTH - cropX * 2,
      SAM_SCREEN_HEIGHT - cropY * 2,
    );
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    // The SAM's ROM runs in interrupt mode 1 (RST 38h). Z80.reset() already
    // defaults im = 1, so nothing to force here.
    this.memory.reset();
    this.asic.reset();
    this.keyboard.reset();
    this.joystick.reset();
    this.psg.reset();
    this.disk.reset();
    this.tape.stopPlayback();
    this.tapeLastAdvanceT = 0;
    this.beeperBit = 0;
    this.micBit = 0;
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  /**
   * Execute one PAL field: 312 scanlines of 384 T-states each.
   *
   * Per scanline: latch the ASIC's state, run the CPU to the end of the line
   * (journalling any mid-line palette/border writes), draw the line, then
   * advance the interrupt state machine at the boundary.
   */
  protected runFrame(): void {
    const cpu = this.cpu;
    const asic = this.asic;
    const memory = this.memory;
    const contention = this.contention;
    const skipAudio = this.speedMultiplier !== 1;
    const a = this.activity;
    a.kbdReads = 0; a.joystickReads = 0; a.beeperWrites = 0;
    a.psgWrites = 0; a.fdcAccesses = 0; a.tapeReads = 0;

    asic.beginFrame();
    this.tapeLastAdvanceT = cpu.tStates;

    let lineEnd = cpu.tStates;
    let lastAudioT = cpu.tStates;
    let broke = false;

    for (let line = 0; line < SAM_LINES_PER_FRAME; line++) {
      lineEnd += SAM_T_PER_LINE;
      asic.beginLine(line, cpu.tStates);
      contention.beginLine(line, cpu.tStates, memory.videoMode, asic.screenOff);

      while (cpu.tStates < lineEnd) {
        if (this.breakpoints.has(cpu.pc)) { this.breakpointHit = cpu.pc; broke = true; break; }
        if (this.onTrap !== null && this.onTrap(cpu.pc)) { broke = true; break; }

        // Sample where this instruction is fetched from BEFORE stepping: after
        // the step `pc` is the *next* instruction's address, which may well sit
        // in a different section.
        const stepStart = cpu.tStates;
        const contended = contention.enabled && memory.sectionContended[cpu.pc >>> 14] !== 0;
        cpu.step();
        // The ASIC owns most of the memory bus, so an instruction's duration
        // rounds up to the slot width where the raster currently is.
        if (contended) {
          cpu.tStates += contention.instructionDelay(stepStart, cpu.tStates - stepStart);
        }

        // The ASIC drops /INT once its hold time expires, whether or not the
        // CPU ever noticed — an interrupt missed behind a DI is missed for good.
        asic.releaseExpired(cpu.tStates);

        // /INT is level-sensitive and un-acknowledged, so take it as soon as
        // the CPU allows while it is still asserted.
        if (asic.intPending && cpu.iff1 && !cpu.eiDelay) {
          cpu.interrupt();
        }

        if (!skipAudio) {
          const elapsed = cpu.tStates - lastAudioT;
          if (elapsed > 0) {
            this.mixer.accumulate(this.beeperBit, elapsed);
            this.mixer.generateSamples(this.audio, this.psg, true);
            lastAudioT = cpu.tStates;
          }
        }
      }

      // Draw the line even when execution broke inside it, so a breakpoint
      // leaves a coherent partial frame on screen rather than a torn one.
      asic.renderScanline(this._pixels32, line);
      if (broke) break;

      asic.endLine(line, cpu.tStates);
    }

    this.needsDisplay = true;
  }

  /** True while any interrupt source is asserted (status bits are active low). */
  get intPending(): boolean { return this.asic.intPending; }

  // ── Machine: debug helpers ────────────────────────────────────────────────

  disasmAt(pc: number): DisasmLine {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 8; i++) buf[i] = this.memory.readByte((pc + i) & 0xFFFF);
    return { ...disasmOne(buf, 0), addr: pc };
  }

  startTrace(_mode: MachineTraceMode = 'full'): void {
    // Execution tracing arrives with the ASIC; no-op so the MCP tool degrades.
  }

  stopTrace(): string { return ''; }

  /**
   * Screen OCR — not implemented, and not a quick win.
   *
   * Every other machine here OCRs a character grid: the VDP machines read
   * character codes straight out of a name table, and the Spectrum matches
   * 8x8 cells against a ROM font. The SAM does neither. Its BASIC screen is a
   * plain bitmap (mode 4 at boot), and its font is PROPORTIONAL — measuring
   * the boot text's ink runs gives starts at 26, 35, 41, 50, 58, 66... which
   * is a mixture of 6, 8 and 9 pixel advances at phase 2 relative to the cell
   * grid, so not one of 27 glyphs begins on an 8-pixel boundary.
   *
   * Reading it back therefore needs variable-width glyph segmentation against
   * a font table that is not stored as plain 8-byte bitmaps either (searching
   * the ROM for the rendered glyphs finds nothing). That is a real piece of
   * work rather than polish, so this reports honestly instead of returning
   * plausible-looking nonsense.
   */
  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    return '[sam] OCR unavailable: the SAM renders text as a bitmap in a '
      + 'proportional font, so there is no character grid to read.';
  }
}
