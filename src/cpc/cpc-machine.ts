/**
 * CpcMachine — Amstrad CPC orchestrator.
 *
 * The CPC counterpart to `Spectrum`: it owns the Z80, AY, uPD765A (all reused
 * unchanged), plus CPC-specific cores (CpcMemory, CRTC 6845, Gate Array, 8255
 * PPI, keyboard) and drives its own frame loop. Implements the shared `Machine`
 * interface so `emulator.ts`, the UI, and the MCP server can treat it like any
 * other machine.
 *
 * Phase 1 boots the firmware headlessly: the frame loop runs the CPU, drives the
 * Gate Array's raster interrupt off synthesised HSYNC/VSYNC timing, and mixes
 * AY audio. The real CRTC-driven raster + pixel output replace the synthesised
 * timing in the video phase; `pixels` is allocated but not yet drawn into.
 */

import { Z80 } from '@/cores/z80.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { UPD765A } from '@/cores/upd765a.ts';
import type { DskImage } from '@/plus3/dsk.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/peripherals/audio-mixer.ts';
import { disasmOne, type DisasmLine } from '@/debug/z80-disasm.ts';
import type { IScreenRenderer } from '@/display/display.ts';
import type { Machine, MachineKind, BorderMode, MachineTraceMode } from '@/machine.ts';
import type { CpcModel } from '@/models.ts';
import type { OcrGridName } from '@/debug/screen-text.ts';
import { CpcMemory } from '@/cpc/cpc-memory.ts';
import { CpcKeyboard } from '@/cpc/cpc-keyboard.ts';
import { Crtc6845 } from '@/cores/crtc-6845.ts';
import { GateArray } from '@/cores/gate-array.ts';
import { Ppi8255, installCpcMemoryHooks, wireCpcPortIO } from '@/cpc/cpc-io.ts';
import { createCpcConfig, type CpcConfig } from '@/cpc/config.ts';
import {
  CPC_AY_CLOCK, CPC_CPU_CLOCK, CPC_T_PER_CHAR,
  CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT, CPC_BORDER_TOP, CPC_BORDER_LEFT,
} from '@/cpc/constants.ts';

/** Wall-clock frame period (50 Hz). */
const FRAME_PERIOD = 1000 / 50;
const TARGET_BUFFER_FRAMES = 3;
function samplesPerFrame(sampleRate: number): number { return Math.round(sampleRate / 50); }

export class CpcMachine implements Machine {
  readonly kind: MachineKind = 'cpc';
  readonly model: CpcModel;
  readonly config: CpcConfig;

  readonly cpu: Z80;
  readonly memory: CpcMemory;
  readonly ay: AY3891x;
  readonly fdc: UPD765A;
  readonly keyboard: CpcKeyboard;
  readonly crtc: Crtc6845;
  readonly gateArray: GateArray;
  readonly ppi: Ppi8255;
  readonly mixer: AudioMixer;
  readonly audio: Audio;
  display: IScreenRenderer | null;

  /** RGBA frame buffer, with a Uint32 view for fast Gate-Array writes. */
  private readonly _pixels = new Uint8Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  /** Scanlines remaining until the post-VSYNC interrupt re-sync fires. */
  private vsyncResyncCountdown = 0;

  turbo = false;

  // ── Debug surface ────────────────────────────────────────────────────
  breakpoints = new Set<number>();
  breakpointHit = -1;
  portWatchpoints = new Set<number>();
  portWatchHit: { port: number; value: number; dir: 'in' | 'out' } | null = null;
  memWatchpoints: { start: number; end: number; mode: 'read' | 'write' | 'rw' }[] = [];
  memWatchHit: { addr: number; value: number; dir: 'read' | 'write' } | null = null;
  onTrap: ((pc: number) => boolean) | null = null;
  onStatus: ((msg: string) => void) | null = null;
  onFrame: (() => void) | null = null;

  // ── Frame loop state ─────────────────────────────────────────────────
  private running = false;
  private starting = false;
  private startGen = 0;
  private rafId = 0;
  private lastFrameTime = 0;
  private frameTimeAccum = 0;
  private needsDisplay = true;

  constructor(model: CpcModel, display?: IScreenRenderer | null) {
    this.model = model;
    this.config = createCpcConfig(model);
    this.cpu = new Z80();
    this.memory = new CpcMemory(this.config);
    this.ay = new AY3891x(CPC_AY_CLOCK, 48000, 'ABC');
    this.fdc = new UPD765A();
    this.keyboard = new CpcKeyboard();
    this.crtc = new Crtc6845(this.config.crtcType);
    this.gateArray = new GateArray();
    this.audio = new Audio();
    this.mixer = new AudioMixer(CPC_CPU_CLOCK);
    // The CPC has no beeper; the mixer carries the AY only.
    this.mixer.beeperGain = 0;
    this.mixer.ayGain = 1;
    this.ppi = new Ppi8255(this.ay, this.keyboard, () => this.crtc.vsyncActive);
    this.display = display ?? null;

    // Gate Array drives ROM enable + RAM banking through the memory.
    this.gateArray.onLowerRom = (on) => this.memory.setLowerRomEnabled(on);
    this.gateArray.onUpperRom = (on) => this.memory.setUpperRomEnabled(on);
    this.gateArray.onRamConfig = (val) => this.memory.setRamConfig(val);

    installCpcMemoryHooks(this);
    wireCpcPortIO(this);
  }

  private setStatus(msg: string): void { if (this.onStatus) this.onStatus(msg); }

  // ── Machine: lifecycle ───────────────────────────────────────────────

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    this.setStatus('ROM loaded');
  }

  /** Insert a parsed DSK image into a drive (uPD765A is shared with the +3). */
  loadDisk(image: DskImage, unit = 0): void {
    this.fdc.insertDisk(image, unit);
  }

  setBorderSize(mode: BorderMode): void {
    // The Gate Array always renders the full 768×272 buffer (active 640×200
    // centred, CPC_BORDER_LEFT/TOP border on each side). Cropping is purely a
    // display concern: show a centred sub-rect. Normal = whole buffer, Small =
    // half the border, None = just the active area.
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(CPC_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(CPC_BORDER_TOP * (1 - frac));
    if (this.display) {
      this.display.setViewport(
        cropX, cropY,
        CPC_SCREEN_WIDTH - cropX * 2,
        CPC_SCREEN_HEIGHT - cropY * 2,
      );
    }
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.ay.reset();
    this.fdc.reset();
    this.memory.reset();
    this.crtc.reset();
    this.gateArray.reset();
    this.ppi.reset();
    this.keyboard.reset();
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    const gen = ++this.startGen;
    await this.audio.init();
    if (!this.starting || gen !== this.startGen) return;
    this.starting = false;
    this.mixer.init(this.audio.sampleRate);
    this.ay.setSampleRate(this.audio.sampleRate);
    this.running = true;
    this.lastFrameTime = performance.now();
    this.frameTimeAccum = 0;
    if (!this.rafId) this.rafId = requestAnimationFrame(this.frameLoop);
    this.setStatus('Running');
  }

  stop(): void {
    this.starting = false;
    this.running = false;
  }

  destroy(): void {
    this.stop();
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.audio.destroy();
  }

  /** Run one frame (headless / tests). */
  tick(): void {
    this.breakpointHit = -1;
    this.portWatchHit = null;
    this.memWatchHit = null;
    this.runFrame();
  }

  runUntil(maxFrames: number): number {
    this.breakpointHit = -1;
    this.portWatchHit = null;
    this.memWatchHit = null;
    for (let i = 0; i < maxFrames; i++) {
      this.runFrame();
      if (this.breakpointHit >= 0 || this.portWatchHit !== null || this.memWatchHit !== null) return i + 1;
    }
    return maxFrames;
  }

  // ── rAF driver ───────────────────────────────────────────────────────

  private frameLoop = (): void => {
    if (this.running) {
      this.breakpointHit = -1;
      const now = performance.now();
      if (this.turbo) {
        const budgetEnd = now + 8;
        do { this.runFrame(); if (this.breakpointHit >= 0) break; } while (performance.now() < budgetEnd);
        this.lastFrameTime = now;
        this.frameTimeAccum = 0;
      } else {
        this.frameTimeAccum = Math.min(this.frameTimeAccum + (now - this.lastFrameTime), FRAME_PERIOD * 3);
        this.lastFrameTime = now;
        const audioPacing = this.audio.ctx !== null && this.audio.ctx.state === 'running';
        const targetSamples = samplesPerFrame(this.audio.sampleRate) * TARGET_BUFFER_FRAMES;
        let framesRun = 0;
        while (this.frameTimeAccum >= FRAME_PERIOD && framesRun < 2) {
          if (audioPacing && this.audio.bufferedSamples() >= targetSamples) break;
          this.runFrame();
          this.frameTimeAccum -= FRAME_PERIOD;
          framesRun++;
          if (this.breakpointHit >= 0) break;
        }
      }
      if (this.needsDisplay && this.display) {
        this.display.updateTexture(this._pixels);
        this.needsDisplay = false;
      }
      if (this.onFrame) this.onFrame();
    } else if (this.display) {
      this.display.updateTexture(this._pixels);
    }
    this.rafId = requestAnimationFrame(this.frameLoop);
  };

  /**
   * Execute one frame, rendering scanline by scanline. For each CRTC scanline:
   * run the CPU for that line's worth of T-states (servicing the Gate-Array
   * raster interrupt), then draw the line from the current CRTC/Gate-Array
   * state — so mid-frame mode/palette/scroll changes take effect per line.
   */
  private runFrame(): void {
    const crtc = this.crtc;
    const ga = this.gateArray;
    const skipAudio = this.turbo;

    crtc.beginFrame();
    ga.beginFrame(this._pixels32);

    const totalLines = crtc.linesPerFrame();
    const lineT = crtc.charsPerLine() * CPC_T_PER_CHAR;
    let lineEnd = this.cpu.tStates;
    let lastAudioT = this.cpu.tStates;
    let broke = false;

    for (let line = 0; line < totalLines; line++) {
      lineEnd += lineT;

      // Run the CPU up to the end of this scanline.
      while (this.cpu.tStates < lineEnd) {
        if (this.breakpoints.has(this.cpu.pc)) { this.breakpointHit = this.cpu.pc; broke = true; break; }
        if (this.onTrap !== null && this.onTrap(this.cpu.pc)) { broke = true; break; }

        // EI suppresses interrupts for one instruction. eiDelay is set by EI
        // during step(); clear it one instruction later so the interrupt fires
        // after the instruction following EI (and never gets stuck on).
        const eiBefore = this.cpu.eiDelay;
        this.cpu.step();
        if (eiBefore) this.cpu.eiDelay = false;

        if (ga.interruptRequested && this.cpu.iff1 && !this.cpu.eiDelay) {
          const t = this.cpu.interrupt();
          if (t > 0) ga.acknowledgeInterrupt();
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

      // Draw this scanline, then advance the raster.
      ga.renderScanline(this._pixels32, CPC_BORDER_TOP + line, crtc.currentLine(),
                        (addr) => this.memory.readVideo(addr));
      ga.onHSync();
      crtc.advanceLine();

      // Post-VSYNC interrupt re-sync, two lines after VSYNC onset.
      if (crtc.vsyncStart) {
        this.vsyncResyncCountdown = 2;
      } else if (this.vsyncResyncCountdown > 0 && --this.vsyncResyncCountdown === 0) {
        ga.onVSyncResync();
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
    // CPC execution tracing is a later addition; no-op for now so the MCP
    // trace tool degrades gracefully rather than throwing.
  }

  stopTrace(): string { return ''; }

  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    return 'CPC screen OCR not yet implemented';
  }
}
