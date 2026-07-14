/**
 * EinsteinMachine — Tatung Einstein TC-01 orchestrator.
 *
 * The Einstein counterpart to `Spectrum` / `CpcMachine`: it owns the Z80, AY and
 * WD1770 (all reused unchanged), plus Einstein-specific parts — the TMS9929A VDP,
 * a Z80 CTC (the interrupt backbone), the AY-scanned keyboard and the paged
 * memory — and drives its own frame loop. Implements the shared `Machine`
 * interface so `emulator.ts`, the UI and the MCP server treat it like any machine.
 *
 * The 8KB MOS ROM is a boot monitor; the machine boots into it (BASIC/Xtal DOS
 * load from disk — a follow-up). Each frame the CPU runs a PAL field's worth of
 * T-states; at the end of the active display the TMS9929A raises its vblank,
 * which is wired to a CTC channel that pulls the Z80 /INT (serviced in IM 2).
 */

import { Z80 } from '@/cores/z80.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { WD1772 } from '@/cores/wd1772.ts';
import { Tms9918a } from '@/cores/tms9918a.ts';
import { Z80Ctc } from '@/cores/z80-ctc.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/tape/tap.ts';
import type { DskImage } from '@/floppy/disk-image.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/peripherals/audio-mixer.ts';
import { disasmOne, type DisasmLine } from '@/debug/z80-disasm.ts';
import type { IScreenRenderer } from '@/display/display.ts';
import type { Machine, MachineKind, BorderMode, MachineTraceMode } from '@/machine.ts';
import type { EinsteinModel } from '@/models.ts';
import type { OcrGridName } from '@/debug/screen-text.ts';
import { EinsteinMemory } from '@/einstein/einstein-memory.ts';
import { EinsteinKeyboard } from '@/einstein/einstein-keyboard.ts';
import { installEinsteinMemoryHooks, wireEinsteinPortIO } from '@/einstein/einstein-io.ts';
import { createEinsteinConfig, type EinsteinConfig } from '@/einstein/config.ts';
import { BaseMachine } from '@/base-machine.ts';
import {
  EINSTEIN_AY_CLOCK, EINSTEIN_CPU_CLOCK, EINSTEIN_T_PER_FRAME,
  EINSTEIN_SCREEN_WIDTH, EINSTEIN_SCREEN_HEIGHT,
  EINSTEIN_BORDER_LEFT, EINSTEIN_BORDER_TOP,
} from '@/einstein/constants.ts';

/** PAL scanlines per field, and the CTC channel the VDP vblank is wired to. */
const LINES_PER_FRAME = 313;
const VDP_CTC_CHANNEL = 0;

export class EinsteinMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'einstein';
  readonly model: EinsteinModel;
  readonly config: EinsteinConfig;

  readonly cpu: Z80;
  readonly memory: EinsteinMemory;
  readonly ay: AY3891x;
  readonly fdc: WD1772;
  readonly vdp: Tms9918a;
  readonly ctc: Z80Ctc;
  readonly keyboard: EinsteinKeyboard;
  readonly tape: TapeDeck;
  readonly mixer: AudioMixer;
  readonly audio: Audio;
  display: IScreenRenderer | null;

  /** Per-frame I/O activity for the status-bar LEDs. */
  readonly activity = { kbdReads: 0, fdcAccesses: 0, tapeReads: 0 };

  /** RGBA frame buffer + a Uint32 view for fast VDP writes. */
  private readonly _pixels = new Uint8Array(EINSTEIN_SCREEN_WIDTH * EINSTEIN_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  get tStatesPerFrame(): number { return EINSTEIN_T_PER_FRAME; }

  constructor(model: EinsteinModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.config = createEinsteinConfig(model);
    this.cpu = new Z80();
    this.memory = new EinsteinMemory();
    this.ay = new AY3891x(EINSTEIN_AY_CLOCK, 48000, 'ABC');
    this.fdc = new WD1772();
    this.vdp = new Tms9918a();
    this.ctc = new Z80Ctc();
    this.keyboard = new EinsteinKeyboard();
    // CDT/TZX pulse timings are 3.5MHz-referenced; scale to the 4MHz Z80.
    this.tape = new TapeDeck(EINSTEIN_CPU_CLOCK);
    this.tape.pulseScale = EINSTEIN_CPU_CLOCK / TAPE_REF_HZ;
    this.audio = new Audio();
    this.mixer = new AudioMixer(EINSTEIN_CPU_CLOCK);
    this.mixer.beeperGain = 0;   // AY only, no beeper
    this.mixer.ayGain = 1;
    this.display = display ?? null;

    installEinsteinMemoryHooks(this);
    wireEinsteinPortIO(this);
  }

  // ── Machine: lifecycle ───────────────────────────────────────────────

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    this.setStatus('ROM loaded');
  }

  /** Insert a parsed disk image into a WD1770 drive (disk support is a
   *  follow-up; the image is held so it is ready once wired end-to-end). */
  loadDisk(image: DskImage, unit = 0): void {
    this.fdc.insertDisk(image, unit);
  }

  setBorderSize(mode: BorderMode): void {
    // The VDP always renders into the full framebuffer with the active area
    // centred; cropping is a pure display concern.
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(EINSTEIN_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(EINSTEIN_BORDER_TOP * (1 - frac));
    if (this.display) {
      this.display.setViewport(
        cropX, cropY,
        EINSTEIN_SCREEN_WIDTH - cropX * 2,
        EINSTEIN_SCREEN_HEIGHT - cropY * 2,
      );
    }
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.cpu.im = 2;              // the Einstein runs in interrupt mode 2
    this.ay.reset();
    this.fdc.reset();
    this.vdp.reset();
    this.ctc.reset();
    this.memory.reset();
    this.keyboard.reset();
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  // start / stop / destroy / tick / runUntil live on BaseMachine.

  protected framePixels(): Uint8Array { return this._pixels; }

  protected inTurbo(): boolean { return this.turbo; }

  /**
   * Execute one PAL field. Runs the CPU scanline by scanline, advancing the CTC
   * timers and servicing IM 2 interrupts as they arm; renders the 192 active
   * lines; at the end of the active display raises the VDP vblank, which pulses
   * the CTC channel wired to the Z80 /INT.
   */
  protected runFrame(): void {
    const skipAudio = this.turbo;
    this.activity.kbdReads = 0;
    this.activity.fdcAccesses = 0;
    this.activity.tapeReads = 0;

    // Fill the whole buffer (incl. border) with the current backdrop.
    this._pixels32.fill(this.vdp.backdrop());

    const tPerLine = EINSTEIN_T_PER_FRAME / LINES_PER_FRAME;
    let lineEnd = this.cpu.tStates;
    let lastAudioT = this.cpu.tStates;
    let lastCtcT = this.cpu.tStates;
    let broke = false;

    for (let line = 0; line < LINES_PER_FRAME; line++) {
      lineEnd += tPerLine;

      while (this.cpu.tStates < lineEnd) {
        if (this.breakpoints.has(this.cpu.pc)) { this.breakpointHit = this.cpu.pc; broke = true; break; }
        if (this.onTrap !== null && this.onTrap(this.cpu.pc)) { broke = true; break; }

        const eiBefore = this.cpu.eiDelay;
        this.cpu.step();
        if (eiBefore) this.cpu.eiDelay = false;

        // Advance CTC timers by the elapsed T-states.
        const dt = this.cpu.tStates - lastCtcT;
        if (dt > 0) { this.ctc.addCycles(dt); lastCtcT = this.cpu.tStates; }

        // Service a pending IM 2 interrupt from the CTC.
        if (this.ctc.interruptPending && this.cpu.iff1 && !this.cpu.eiDelay) {
          const vec = this.ctc.pendingVector();
          if (vec >= 0 && this.cpu.interruptWithVector(vec) > 0) this.ctc.acknowledge();
        }

        if (!skipAudio) {
          const elapsed = this.cpu.tStates - lastAudioT;
          if (elapsed > 0) {
            this.mixer.accumulate(0, elapsed);
            this.mixer.generateSamples(this.audio, this.ay, true);
            lastAudioT = this.cpu.tStates;
          }
        }
      }
      if (broke) break;

      // Render active scanlines into the centred active area.
      if (line < 192) {
        const rowStart = (EINSTEIN_BORDER_TOP + line) * EINSTEIN_SCREEN_WIDTH + EINSTEIN_BORDER_LEFT;
        this.vdp.renderScanline(this._pixels32, rowStart, line);
      } else if (line === 192) {
        // End of active display: VDP vblank → CTC → /INT.
        this.vdp.raiseFrameInterrupt();
        this.ctc.trigger(VDP_CTC_CHANNEL);
      }
    }

    this.needsDisplay = true;
  }

  // ── Machine: debug helpers ───────────────────────────────────────────

  disasmAt(pc: number): DisasmLine {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 8; i++) buf[i] = this.memory.readByte((pc + i) & 0xFFFF);
    return { ...disasmOne(buf, 0), addr: pc };
  }

  startTrace(_mode: MachineTraceMode = 'full'): void {
    // Execution tracing is a later addition; no-op so the MCP tool degrades.
  }

  stopTrace(): string { return ''; }

  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    // TMS9929A text OCR is a follow-up; report the current VDP mode for now.
    return `[Einstein VDP mode: ${this.vdp.mode()}]`;
  }
}
