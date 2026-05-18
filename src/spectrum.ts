/**
 * ZX Spectrum machine orchestrator.
 *
 * Wires together Z80 CPU, AY sound chip, ULA, memory, display, audio, and keyboard.
 * Runs the frame loop at 50.08 Hz (69,888 T-states/frame, Z80 at 3.5 MHz).
 *
 * Timing: audio buffer fill level governs speed. Each rAF tick runs 0-2 frames
 * depending on how many audio samples the callback has consumed. This keeps the
 * emulator locked to real-time without drift.
 */

import { Z80 } from '@/cores/z80.ts';
import { disasmOne, stripMarkers, type DisasmLine } from '@/debug/z80-disasm.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { SpectrumMemory } from '@/memory.ts';
import { ULA, type BorderMode } from '@/cores/ula.ts';
import { SpectrumKeyboard } from '@/keyboard.ts';
import type { IScreenRenderer } from '@/display/display.ts';
import { Audio } from '@/audio.ts';
import { TapeDeck } from '@/tape/tap.ts';
import { UPD765A } from '@/cores/upd765a.ts';
import type { DskImage } from '@/plus3/dsk.ts';
import { Contention } from '@/contention.ts';
import { ScreenText, OCR_GRIDS, detectGrid } from '@/debug/screen-text.ts';
import type { FontSource, OcrResult, OcrGridName } from '@/debug/screen-text.ts';
import { trapTapeLoad } from '@/tape/tape-loader.ts';
import { EdgeLoader, type EdgeLoaderHost } from '@/tape/edge-loader.ts';
import { installMemoryHooks, wirePortIO } from '@/io-ports.ts';
import { KempstonJoystick } from '@/peripherals/joysticks.ts';
import { KempstonMouse } from '@/peripherals/kempston-mouse.ts';
import { AmxMouse } from '@/peripherals/amx-mouse.ts';
import { AudioMixer } from '@/peripherals/audio-mixer.ts';
import { Multiface } from '@/peripherals/multiface.ts';
import { VTX5000 } from '@/peripherals/vtx5000.ts';
import { hex8, hex16 } from '@/utils/hex.ts';
import { signed8 } from '@/utils/signed.ts';
import { DISPLAY_WIDTH, DISPLAY_HEIGHT } from '@/cores/ula.ts';
import { createVariant, type MachineVariant } from '@/variants/index.ts';

// Re-export model type and helpers from their canonical home (models.ts)
// so existing imports from '@/spectrum.ts' continue to work.
export { type SpectrumModel, is128kClass, isPlus2AClass, isPlus3 } from '@/models.ts';
export type { MachineVariant } from '@/variants/index.ts';

const AY_CLOCK = 1773400;        // ~1.77 MHz

/** Samples produced per Spectrum frame at a given sample rate */
function samplesPerFrame(sampleRate: number): number {
  return Math.round(sampleRate / 50);
}

/** Target buffer fill: ~3 frames of audio (~60ms). Below this we run a frame. */
const TARGET_BUFFER_FRAMES = 3;

/** Wall-clock frame period: 50 Hz = 20ms */
const FRAME_PERIOD = 1000 / 50;

/** No-op contend installed on cpu while UI turbo is engaged. Module-scope so
 *  every Spectrum instance shares the same identity (helps SpiderMonkey's
 *  inline-cache stability across instances). */
const NOOP_CONTEND = (_addr: number): void => {};

import type { SpectrumModel } from '@/models.ts';

export class IOActivity {
  /** Number of ULA port reads this frame (keyboard / tape) */
  ulaReads = 0;
  /** Number of Kempston joystick port reads this frame */
  kempstonReads = 0;
  /** Whether the beeper bit toggled this frame */
  beeperToggled = false;
  /** Number of AY register writes this frame */
  ayWrites = 0;
  /** Number of LD-BYTES (0x0556) calls this frame */
  tapeLoads = 0;
  /** Number of FDC data port accesses this frame */
  fdcAccesses = 0;
  /** Number of ULA reads while tape is active (EAR sampling) */
  earReads = 0;
  /** Set when LoaderDetector fires 'start' this frame — used to engage tape turbo */
  loaderDetected = false;
  /** Number of attribute-area (5800-5AFF) writes this frame */
  attrWrites = 0;
  /** Number of Kempston mouse port reads this frame */
  mouseReads = 0;

  reset(): void {
    this.ulaReads = 0;
    this.kempstonReads = 0;
    this.beeperToggled = false;
    this.ayWrites = 0;
    this.tapeLoads = 0;
    this.fdcAccesses = 0;
    this.earReads = 0;
    this.loaderDetected = false;
    this.attrWrites = 0;
    this.mouseReads = 0;
  }
}

export class Spectrum {
  model: SpectrumModel;
  variant: MachineVariant;
  memory: SpectrumMemory;
  cpu: Z80;
  ay: AY3891x;
  ula: ULA;
  keyboard: SpectrumKeyboard;
  display: IScreenRenderer | null;
  audio: Audio;
  tape: TapeDeck;
  fdc: UPD765A;
  contention: Contention;
  screenText = new ScreenText();

  /** Per-frame I/O activity counters */
  activity = new IOActivity();

  /** Kempston joystick peripheral */
  joystick = new KempstonJoystick();

  /** Kempston mouse peripheral */
  kempstonMouse = new KempstonMouse();

  /** AMX mouse peripheral */
  amxMouse = new AmxMouse();

  /** Audio mixer peripheral (beeper + AY mixing, DC filter) */
  mixer!: AudioMixer;

  /** Multiface peripheral (MF1/MF128/MF3) */
  multiface = new Multiface();

  /** VTX-5000 viewdata modem peripheral (48K only) */
  vtx5000 = new VTX5000();

  private running = false;
  private starting = false;
  private startGen = 0;
  private rafId = 0;

  /** Whether at least one frame has rendered (for display) */
  private needsDisplay = true;

  /** Wall-clock frame pacing (governs speed regardless of rAF rate) */
  private lastFrameTime = 0;
  private frameTimeAccum = 0;

  get tStatesPerFrame(): number { return this.contention.timing.tStatesPerFrame; }

  /** Turbo mode: run as many frames as fit in TURBO_BUDGET_MS per rAF. */
  turbo = false;

  /** Turbo batch budget is adaptive — a fixed budget is wrong for high-Hz
   *  displays (a 12ms batch on a 240Hz rAF (~4.2ms cadence) makes the browser
   *  throttle rAF down, halving effective throughput). We measure the actual
   *  rAF interval and spend a fraction of it. */
  private static readonly TURBO_BUDGET_FRACTION = 0.7;
  private static readonly TURBO_BUDGET_MIN_MS = 1.5;
  private static readonly TURBO_BUDGET_MAX_MS = 14;
  private _turboLastRaf = 0;
  private _turboBudgetMs = 4; // initial guess; replaced after 2 ticks

  /** Tracks turbo-state transitions so we can save/restore the user's
   *  scanlineAccuracy choice (turbo forces 'low' for throughput). */
  private _turboActive = false;
  private _savedScanAcc: 'high' | 'mid' | 'low' | null = null;

  /** When true, runFrame() skips its bulk renderFrame() call. Used to
   *  short-circuit pixel work for intermediate frames in a turbo batch —
   *  only the final frame in the batch actually produces displayed pixels. */
  private _skipRender = false;

  /** Scanline accuracy:
   *  'high' = per-instruction partial-scanline render (multicolor/rainbow)
   *  'mid'  = per-instruction but only completed lines (per-scanline border, no mid-line)
   *  'low'  = single bulk render at frame end (one border color, fastest)
   *
   *  Writes are intercepted while turbo is active so the user's choice is
   *  remembered (and restored on turbo-off) without overriding the forced
   *  'low' value. This matters when settings are reapplied mid-turbo —
   *  e.g. after a renderer swap calls applyDisplaySettings(). */
  private _scanlineAccuracy: 'high' | 'mid' | 'low' = 'high';
  get scanlineAccuracy(): 'high' | 'mid' | 'low' { return this._scanlineAccuracy; }
  set scanlineAccuracy(v: 'high' | 'mid' | 'low') {
    if (this._turboActive) {
      this._savedScanAcc = v;
    } else {
      this._scanlineAccuracy = v;
    }
  }

  /** Numeric cache of scanlineAccuracy for zero-cost hot-path checks.
   *  2 = high, 1 = mid, 0 = low.  Updated at frame start. */
  private _scanAcc = 2;

  /** Scanline rendering state */
  private nextRenderLine = 0;
  private nextRenderT = 0;
  private nextPixelX = 0;
  private nextDisplayCol = 0;  // next unrendered display cell (0..32) on current line
  private totalRenderLines = 0;
  /** Execution trace */
  private _tracing = false;
  private _traceMode: 'full' | 'portio' | 'zxtl' = 'full';
  private _traceBuffer: string[] = [];
  /** Loop detection (full mode): direct-mapped cache of PC → register hash */
  private _traceLoopPC = new Int32Array(1024).fill(-1);
  private _traceLoopHash = new Int32Array(1024);
  private _traceLoopAddr = -1;
  private _traceLoopCount = 0;
  /** Port IO tally (portio mode) */
  private _portTallyIn: Map<number, { count: number; pcs: Set<number>; vals: Set<number> }> | null = null;
  private _portTallyOut: Map<number, { count: number; pcs: Set<number>; vals: Set<number> }> | null = null;

  /** ZXTL trace: previous instruction PC and length for jump detection */
  private _zxtlPrevPC = -1;
  private _zxtlPrevLen = 0;

  /** Edge-loading subsystem: auto play/stop, structural loader fingerprint,
   *  and surgical edge acceleration. See docs/edge-loading.md. The property
   *  is named `loaderDetector` for compatibility with the UI/emulator layer
   *  that already references it. */
  loaderDetector = new EdgeLoader();

  /** Bridge handed to EdgeLoader so it can read CPU/tape state and the
   *  live (paging-aware) memory map without circularly importing Spectrum. */
  edgeLoaderHost!: EdgeLoaderHost;

  /** T-state at which the tape was last advanced (for sub-instruction accuracy) */
  tapeLastAdvanceT = 0;

  /** ROM trap instant load: intercept LD-BYTES at 0x0556 and copy block
   *  data directly into memory.  Works for standard TAP/TZX data blocks. */
  tapeInstantLoad = true;

  /** Tape turbo: auto-engage maximum emulation speed while a custom
   *  loader is actively reading the EAR port.  Disengages after a cooldown
   *  when EAR reads stop (loading finished). */
  tapeTurbo = true;

  /** Whether tape loading sounds are mixed into audio output */
  tapeSoundEnabled = true;

  /** Internal: whether tape turbo is currently engaged */
  private _tapeTurboActive = false;
  /** Frames remaining before tape turbo disengages (cooldown) */
  private _tapeTurboCooldown = 0;


  /** Per-cell render threshold: +1 on 48K/16K (Issue 2 ULA) to render when the
   *  beam enters each cell for tightest accuracy.  +0 on 128K/+2 (Ferranti) and
   *  +2A/+3 (Amstrad gate array) where deterministic timing makes the slightly
   *  later capture safe.  Set once in constructor from the variant. */
  private _cellRenderOffset: 0 | 1 = 1;

  /** Breakpoints (checked every instruction in runFrame) */
  breakpoints = new Set<number>();
  /** Set to the hit address when a breakpoint fires mid-frame */
  breakpointHit = -1;

  /** Port watchpoints: break when any watched port is accessed by IN or OUT */
  portWatchpoints = new Set<number>();
  /** Set when a port watchpoint fires; null means no hit this frame */
  portWatchHit: { port: number; value: number; dir: 'in' | 'out' } | null = null;

  /** Memory watchpoints: break on read/write access within a watched range */
  memWatchpoints: { start: number; end: number; mode: 'read' | 'write' | 'rw' }[] = [];
  /** Set when a memory watchpoint fires; null means no hit this frame */
  memWatchHit: { addr: number; value: number; dir: 'read' | 'write' } | null = null;

  /**
   * Pre-instruction trap hook.  Called with the current PC before each
   * instruction executes.  Return true to break execution (like a breakpoint).
   * The MCP server uses this for trap logic (log / respond / break).
   */
  onTrap: ((pc: number) => boolean) | null = null;

  /** Status callback */
  onStatus: ((msg: string) => void) | null = null;

  /** Frame callback (fires each rAF after rendering) */
  onFrame: (() => void) | null = null;

  constructor(model: SpectrumModel, display?: IScreenRenderer | null) {
    this.model = model;
    this.variant = createVariant(model);

    this.memory = new SpectrumMemory(model, {
      hasBanking: this.variant.hasBanking,
      romPageCount: this.variant.romPageCount,
      is16K: model === '16k',
    });
    this.cpu = new Z80();
    this.keyboard = new SpectrumKeyboard();
    this.ula = new ULA(this.keyboard);
    this.display = display ?? null;
    this.audio = new Audio();
    // Initial AY rate tracks the Audio default; start() updates it once the
    // AudioContext reports its real platform rate.
    this.ay = new AY3891x(AY_CLOCK, this.audio.sampleRate, 'ABC');
    this.contention = new Contention(this.variant, this.memory);
    this.mixer = new AudioMixer(this.contention.timing.cpuClock);
    this.tape = new TapeDeck(this.variant.timing.cpuClock);
    this.tape.is48K = this.variant.is48K;
    this.fdc = new UPD765A();
    // 48K/16K (Issue 2 ULA): render as the beam enters each cell (+1) for
    // tightest accuracy.  The beam flush (vramFlushEnd=0x5B00) ensures cells
    // are captured with the correct attribute before multicolor engines
    // overwrite them for the next scanline.
    // 128K/+2 (Ferranti) and +2A/+3 (Amstrad): render after the beam fully
    // passes (+0).  No beam flush on attr writes — deterministic timing (no IO
    // contention) keeps the renderer in sync without it.
    this._cellRenderOffset = this.variant.cellRenderOffset;
    installMemoryHooks(this);
    wirePortIO(this);

    // Bridge between EdgeLoader and the live machine state. Read through
    // memory.readByte so paging is respected (§3.2 in docs/edge-loading.md).
    this.edgeLoaderHost = {
      cpu: this.cpu,
      tape: this.tape,
      readMem: (addr) => this.memory.readByte(addr & 0xFFFF),
      // Bit 5 of port 0xFE on read carries EAR — the loader stores the
      // current EAR level there for its next iteration's XOR comparison.
      earBit: () => this.tape.earBit,
    };

    // Tape engine → EdgeLoader: publish the next edge's length category
    // every time a new pulse is scheduled. §5 of docs/edge-loading.md.
    this.tape.onEdgeScheduled = (flags, fromAcceleration) => {
      this.loaderDetector.setAccelerationFlags(flags, fromAcceleration);
    };
    this.tape.onPlayStateChange = () => {
      this.loaderDetector.onTapePlayStateChange();
      // runFrame's hot loop only calls advanceTapeTo (which would clear
      // ula.tapeActive on stop) when tape.playing && !tape.paused, so we
      // synchronously clear here on any stop/pause transition to avoid a
      // stale tapeEarBit being mixed into the ULA EAR read.
      if (!this.tape.playing || this.tape.paused) this.ula.tapeActive = false;
    };

    // VTX-5000: wire ROM paging callback driven by the 8251's RTS output.
    // When RTS changes, swap slot 0 between VTX ROM+RAM and Spectrum ROM.
    this.vtx5000.onRomPage = (rts: boolean) => {
      if (!this.vtx5000.enabled || !this.vtx5000.romLoaded) return;
      if (rts && this.vtx5000.vtxRomPaged) {
        // RTS=1 → page in Spectrum ROM. No state to save: VTX cartridge has
        // no RAM of its own; runtime state lives in Spectrum RAM ($4000+).
        this.vtx5000.vtxRomPaged = false;
        this.memory.externalRomPaged = false;
        this.memory.restoreSlot0();
      } else if (!rts && !this.vtx5000.vtxRomPaged) {
        // RTS=0 → page in VTX ROM (Spectrum ROM upper half stays at $2000-$3FFF)
        this.vtx5000.applyROM(this.memory);
        this.memory.externalRomPaged = true;
      }
    };
  }

  /** Trace state accessors for io-ports.ts */
  get tracing(): boolean { return this._tracing; }
  get traceMode(): 'full' | 'portio' | 'zxtl' { return this._traceMode; }
  get traceBuffer(): readonly string[] { return this._traceBuffer; }

  /** True when slot 0 is overlaid by an external ROM (Multiface or VTX-5000).
   *  Bank-switching paths use this to skip writing slot 0 so the overlay
   *  stays mapped. */
  get hasSlot0Overlay(): boolean {
    return this.multiface.pagedIn || (this.vtx5000.enabled && this.vtx5000.vtxRomPaged);
  }

  /** Flush pending pixels up to the current beam position.
   *  Called from the port handler BEFORE updating borderColor so that
   *  pixels between the last render and the port write keep the old color,
   *  and from the write8 hook before VRAM writes so completed scanlines
   *  see the old data. */
  flushBeam(): void {
    const sa = this._scanAcc;
    if (sa === 0) return;
    if (sa === 1) { this.renderCompletedScanlines(); return; }
    this.renderPendingScanlines();
  }

  /**
   * Advance the tape to the current cpu.tStates and update the ULA EAR bit.
   * Called from the port-in handler (for sub-instruction accuracy) and from
   * the main loop (to catch up after each instruction).
   */
  advanceTapeTo(): void {
    if (!this.tape.playing || this.tape.paused) {
      this.ula.tapeActive = false;
      return;
    }
    const delta = this.cpu.tStates - this.tapeLastAdvanceT;
    if (delta > 0) {
      this.tape.advance(delta);
      this.tapeLastAdvanceT = this.cpu.tStates;
    }
    this.ula.tapeActive = true;
    this.ula.tapeEarBit = this.tape.earBit;
  }

  /** Log a port access for trace modes (called from io-ports.ts). */
  logPortAccess(dir: string, port: number, val: number): void {
    const pc = this.cpu.pc;

    if (this._traceMode === 'portio') {
      const tally = dir === 'IN' ? this._portTallyIn! : this._portTallyOut!;
      let entry = tally.get(port);
      if (!entry) {
        entry = { count: 0, pcs: new Set(), vals: new Set() };
        tally.set(port, entry);
      }
      entry.count++;
      if (entry.pcs.size < 32) entry.pcs.add(pc);
      if (entry.vals.size < 64) entry.vals.add(val);
      return;
    }
    if (this._traceBuffer.length >= 500_000) this._tracing = false;
  }

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    if (this.vtx5000.enabled && this.vtx5000.romLoaded) {
      if (this.memory.is128K) {
        this.memory.currentROM = this.memory.romPages.length === 4 ? 3 : 1;
      }
      this.vtx5000.applyROM(this.memory);
      this.memory.externalRomPaged = true;
    }
    this.setStatus('ROM loaded');
  }

  setBorderSize(mode: BorderMode): void {
    this.ula.setBorderMode(mode);
    this.ula.renderFrame(this.memory.screenBank, 0x4000);
    if (this.display) this.display.resize(this.ula.screenWidth, this.ula.screenHeight);
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.ay.reset();
    this.ula.reset();
    this.keyboard.reset();
    this.audio.reset();
    this.fdc.reset();
    this.memory.reset();
    this.vtx5000.reset();
    if (this.vtx5000.enabled && this.vtx5000.romLoaded) {
      if (this.memory.is128K) {
        this.memory.currentROM = this.memory.romPages.length === 4 ? 3 : 1;
      }
      this.vtx5000.applyROM(this.memory);
      this.memory.externalRomPaged = true;
    }
    this.joystick.reset();
    this.kempstonMouse.reset();
    this.amxMouse.reset();
    this.mixer.reset();
    this.multiface.reset();
    this.loaderDetector.reset();
    this.contention.frameStartTStates = 0;
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    const gen = ++this.startGen;

    await this.audio.init();

    // Check if stop() was called or a newer start() was issued while we were awaiting
    if (!this.starting || gen !== this.startGen) return;
    this.starting = false;

    this.mixer.init(this.audio.sampleRate);
    this.ay.setSampleRate(this.audio.sampleRate);

    this.running = true;
    this.lastFrameTime = performance.now();
    this.frameTimeAccum = 0;
    // Only start rAF if not already looping (it stays alive across pause/resume)
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(this.frameLoop);
    }
    this.setStatus('Running');
  }

  stop(): void {
    this.starting = false; // cancel pending async start
    this.running = false;
    // rAF loop keeps running so the display stays alive (noise, settings changes).
    // Only destroy() cancels the rAF loop entirely.
  }

  destroy(): void {
    this.stop();
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.audio.destroy();
  }

  /** Run one frame (for headless / test harness use). */
  tick(): void { this.breakpointHit = -1; this.portWatchHit = null; this.memWatchHit = null; this.runFrame(); }

  /**
   * Run up to `maxFrames` frames, stopping early if a breakpoint or port
   * watchpoint is hit.  Returns the number of frames actually executed.
   */
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

  /** Whether tape turbo is currently engaged (read by UI for status) */
  get tapeTurboActive(): boolean { return this._tapeTurboActive; }

  private frameLoop = (): void => {
    if (this.running) {
      // Wall-clock pacing: accumulate elapsed time, run frames at 50Hz
      this.breakpointHit = -1;
      const now = performance.now();
      if (this.turbo || this._tapeTurboActive) {
        // Turbo: spend a fraction of the actual rAF interval running frames.
        // Adapting to the rAF cadence (60Hz / 144Hz / 240Hz / throttled) is
        // critical — overshooting the interval makes the browser throttle
        // rAF down, halving throughput. Undershooting leaves CPU idle.
        if (!this._turboActive) {
          // Bypass the setter so we write the internal field directly —
          // the setter would otherwise route 'low' into _savedScanAcc.
          this._savedScanAcc = this._scanlineAccuracy;
          this._scanlineAccuracy = 'low';
          // UI turbo opts out of cycle-exact contention for throughput.
          // MCP/tests never set this.turbo, so their accuracy is unaffected.
          this.cpu.accurateTiming = false;
          // Swap cpu.contend to a no-op closure so the hundreds of bare
          // `this.contend(addr); this.tStates += 1` sites in exec-* call an
          // empty function Firefox can inline away, instead of dispatching
          // through the assigned closure on every internal cycle.
          this.cpu.contend = NOOP_CONTEND;
          this._turboActive = true;
          this._turboLastRaf = now;
          this._turboBudgetMs = 4;
        } else if (this._turboLastRaf > 0) {
          const rafInterval = now - this._turboLastRaf;
          // EWMA smooths spikes (GC, browser hiccups) but reacts within
          // a few ticks when the user moves between monitors.
          const target = rafInterval * Spectrum.TURBO_BUDGET_FRACTION;
          this._turboBudgetMs = this._turboBudgetMs * 0.6 + target * 0.4;
          if (this._turboBudgetMs < Spectrum.TURBO_BUDGET_MIN_MS) {
            this._turboBudgetMs = Spectrum.TURBO_BUDGET_MIN_MS;
          } else if (this._turboBudgetMs > Spectrum.TURBO_BUDGET_MAX_MS) {
            this._turboBudgetMs = Spectrum.TURBO_BUDGET_MAX_MS;
          }
        }
        this._turboLastRaf = now;
        const budgetEnd = now + this._turboBudgetMs;
        this._skipRender = true;
        do {
          this.runFrame();
          if (this.breakpointHit >= 0) break;
        } while (performance.now() < budgetEnd);
        this._skipRender = false;
        // Produce a fresh frame of pixels for the display. Intermediate
        // frames skipped renderFrame to save work; this final call gives
        // the user the latest visible state.
        this.ula.renderFrame(this.memory.screenBank, 0x4000);
        this.needsDisplay = true;
        this.frameTimeAccum = 0;
        this.lastFrameTime = now;
      } else {
        if (this._turboActive) {
          // Clear _turboActive first so the setter writes the internal field.
          this._turboActive = false;
          if (this._savedScanAcc !== null) this._scanlineAccuracy = this._savedScanAcc;
          this._savedScanAcc = null;
          this.cpu.accurateTiming = true;
          this.cpu.contend = this.cpu._contendAccurate;
        }
        this.frameTimeAccum = Math.min(
          this.frameTimeAccum + (now - this.lastFrameTime),
          FRAME_PERIOD * 3 // cap catch-up to 3 frames (e.g. after tab hidden)
        );
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

      // Push rendered pixels to the display
      if (this.needsDisplay) {
        if (this.display) this.display.updateTexture(this.ula.pixels);
        this.needsDisplay = false;
      }

      if (this.onFrame) this.onFrame();
    } else {
      // Paused: keep rendering so display stays alive (noise animates,
      // settings changes take effect immediately).
      if (this.display) this.display.updateTexture(this.ula.pixels);
    }

    this.rafId = requestAnimationFrame(this.frameLoop);
  };

  private runFrame(): void {
    // Apply any deferred combo keys (modifier was pressed last frame).
    this.keyboard.processPending();
    // Reset activity counters for this frame
    this.activity.reset();
    this.portWatchHit = null;
    this.memWatchHit = null;
    // The ULA's frame boundary occurs at exact tStatesPerFrame intervals,
    // regardless of CPU instruction overshoot from the previous frame.
    // On real hardware the beam resets at fixed intervals; the CPU may still
    // be finishing an instruction from the previous frame, but the ULA doesn't
    // wait.  Using the ideal boundary (not cpu.tStates) keeps scanline timing
    // stable and prevents the overshoot from shifting border effects.
    const tpf = this.contention.timing.tStatesPerFrame;
    const idealStart = this.contention.frameStartTStates + tpf;
    // Use ideal boundary if the CPU has reached it (normal case).
    // Otherwise re-sync to current tStates (first frame, snapshot load, reset).
    this.contention.frameStartTStates =
      idealStart <= this.cpu.tStates ? idealStart : this.cpu.tStates;
    const frameStart = this.contention.frameStartTStates;
    this.tapeLastAdvanceT = this.cpu.tStates;
    const frameEnd = frameStart + tpf;
    const intWindowEnd = frameStart + this.contention.timing.intLength;

    // Fire interrupt (IM 1 = 13T, IM 2 = 19T — consumed from the frame budget).
    // On real hardware, INT is held LOW for a model-dependent window:
    //   48K: 32T, 128K/+2: 36T, +2A/+3: 32T
    // If IFF1 is false (DI), the interrupt stays pending until EI re-enables it,
    // but only within the INT window — after that, it's lost until the next frame.
    let intT = this.cpu.interrupt();
    // intT === 0 means the ack didn't take this attempt — could be DI (iff1=false)
    // OR EI delay (eiDelay=true at the frame edge). Either way the INT line is still
    // held LOW for the model's int window; retry until it fires or the window closes.
    let intPending = intT === 0;

    // AMX mouse: drain queued movement steps as PIO interrupts spread across frame
    if (this.amxMouse.enabled && (this.amxMouse.pendingX !== 0 || this.amxMouse.pendingY !== 0)) {
      this.amxMouse.drainMovement(this.cpu, frameEnd, this.activity);
    }

    // Cache accuracy level as integer for zero-cost hot-path checks
    const sa = this._scanlineAccuracy;
    this._scanAcc = sa === 'high' ? 2 : sa === 'mid' ? 1 : 0;
    // Cache the audio-skip decision once per frame so the per-instruction
    // loop doesn't re-read two properties on every iteration.
    const skipAudio = this.turbo || this._tapeTurboActive;
    // Cache watchpoint activity: when no watchpoints are configured the
    // post-step null-compare on portWatchHit/memWatchHit is dead weight.
    // Watchpoints are added/removed from the UI between rAFs, so caching
    // at frame start is exact for the duration of one frame.
    const watchActive = this.portWatchpoints.size > 0 || this.memWatchpoints.length > 0;

    // Init scanline rendering state for this frame
    // High and mid modes advance flash here (they render scanlines individually).
    // Low mode skips this — renderFrame() handles flash internally.
    if (this._scanAcc > 0) this.ula.advanceFlash();
    const borderTop = this.ula.borderTop;
    const borderLeft = this.ula.borderLeft;
    this.totalRenderLines = borderTop * 2 + DISPLAY_HEIGHT;
    this.nextRenderLine = 0;
    this.nextPixelX = 0;
    this.nextDisplayCol = 0;
    // displayOrigin = T-state of the first display pixel (varies by model).
    // Left border starts borderLeft/2 T-states before that on each line.
    this.nextRenderT = this.contention.frameStartTStates
                      + this.contention.timing.displayOrigin
                      - borderTop * this.contention.timing.tStatesPerLine
                      - (borderLeft >> 1);

    while (this.cpu.tStates < frameEnd) {
      const tBefore = this.cpu.tStates;

      // ROM routine activity detection (LD-BYTES entry)
      if (this.cpu.pc === 0x0556) this.activity.tapeLoads++;
      // ROM trap: intercept LD-BYTES partway through, at LD-START (0x056C),
      // after the routine has done EX AF,AF' and the BREAK check. This is
      // FUSE's trap point — it also catches loaders that CALL 0x056C directly
      // (a few protected loaders do this to reuse part of LD-BYTES).
      //
      // The trap is gated on the 48K BASIC ROM actually being in slot 0
      // (via memory.isBasicRomActive) — a byte-signature check at 0x056C
      // would mis-fire on +2A/+3 when a custom RAM bank happens to have the
      // same opcode there. Custom-speed / non-standard blocks fail the
      // trap's internal length check and fall through to real ROM execution.
      let trapHandled = false;
      if (this.tapeInstantLoad && this.tape.loaded && this.cpu.pc === 0x056C &&
          this.memory.isBasicRomActive() && this.tape.hasRomBlock()) {
        // Unpause so either path (trap success or real ROM fallback) sees
        // the tape playing. Tape starts paused on mount so the playback
        // engine doesn't race ahead.
        if (this.tape.paused) {
          this.tape.paused = false;
          this.tape.startPlayback();
        }
        if (trapTapeLoad(this.cpu, this.tape)) {
          this.tape.skipBlock(); // advance player past the consumed block
          trapHandled = true;
        }
        // Trap declined → fall through to normal CPU step so the real ROM
        // edge loop runs (custom-speed blocks, length mismatches, etc.).
      }
      if (trapHandled) {
        // no-op — already handled above
      } else if (this.cpu.halted) {
        // HALT repeats NOP-like M1 fetches from PC.  If PC or IR is in
        // contended memory each cycle gets a ULA delay; otherwise we can
        // fast-skip.  IR contention applies during the M1 refresh cycle
        // (T3-T4 put IR on the address bus).
        const irContended = this.contention.isContended(this.cpu.ir);
        if (this.contention.isContended(this.cpu.pc) || irContended) {
          // Step one NOP at a time so contention is applied correctly
          this.cpu.read8(this.cpu.pc);
          this.cpu.tStates += 3;  // M1 fetch cycle
          this.cpu.contend(this.cpu.ir);  // IR contention during refresh
          this.cpu.tStates += 1;  // M1 refresh cycle
          this.cpu.r = (this.cpu.r & 0x80) | ((this.cpu.r + 1) & 0x7F);
        } else {
          const toFrameEnd = frameEnd - this.cpu.tStates;
          const toNextSample = this.mixer.tStatesPerSample - this.mixer.beeperTStatesAccum;
          const skip = Math.min(toFrameEnd, toNextSample);
          const nops = Math.max(1, Math.ceil(skip / 4));
          this.cpu.tStates += nops * 4;
          this.cpu.r = (this.cpu.r & 0x80) | ((this.cpu.r + nops) & 0x7F);
        }
      } else {
        // Breakpoint check (skipped when set is empty for zero overhead)
        if (this.breakpoints.size > 0 && this.breakpoints.has(this.cpu.pc)) {
          this.breakpointHit = this.cpu.pc;
          break;
        }
        // Pre-instruction trap hook (MCP traps: log, respond, break)
        if (this.onTrap !== null && this.onTrap(this.cpu.pc)) {
          this.breakpointHit = this.cpu.pc;
          break;
        }
        if (this._tracing && this._traceMode === 'full' && this.cpu.pc >= 0x4000) this.captureTraceLine();
        const zxtlPC = this._tracing && this._traceMode === 'zxtl' ? this.cpu.pc : -1;
        this.cpu.step();
        if (zxtlPC >= 0) this.captureZxtlLine(zxtlPC);
        // Break mid-frame if a port or memory watchpoint fired during this instruction
        if (watchActive && (this.portWatchHit !== null || this.memWatchHit !== null)) break;
      }

      // Clear EI delay after each instruction (see timings.md § EI Delay).
      // The delay suppresses interrupts for exactly one instruction after EI.
      // We clear it here (not in interrupt()) so the suppression is tied to
      // one *instruction*, not one *frame boundary check*.
      if (this.cpu.eiDelay) {
        this.cpu.eiDelay = false;
      }

      // Pending interrupt: INT is only held LOW for a limited window.
      // If EI re-enables interrupts within the window, fire the interrupt.
      // After the window closes, the interrupt is lost until the next frame.
      // (eiDelay was already cleared above, so interrupt() can fire.)
      if (intPending) {
        if (this.cpu.tStates >= intWindowEnd) {
          intPending = false;
        } else if (this.cpu.iff1) {
          intT = this.cpu.interrupt();
          if (intT > 0) {
            intPending = false;
          }
        }
      }

      // Render display cells up to the current beam position.
      // High (2): partial-scanline render every instruction (multicolor/rainbow).
      // Mid  (1): whole-scanline render — cheap subtract+compare, ~312 renders/frame.
      // Low  (0): skipped entirely — single renderFrame() at frame end.
      if (this._scanAcc === 2) this.renderPendingScanlines();
      else if (this._scanAcc === 1) this.renderCompletedScanlines();

      const elapsed = this.cpu.tStates - tBefore;

      // Advance tape playback and update ULA EAR bit (catches up any
      // T-states not already advanced by the port-in handler mid-instruction).
      // Hoist the playing/paused check inline — saves the method-call frame
      // on every instruction in the common no-tape case.
      if (this.tape.playing && !this.tape.paused) this.advanceTapeTo();

      // Accumulate beeper duty and generate audio samples.
      // In any turbo mode (manual turbo or tape turbo) skip audio entirely:
      // at hundreds of MHz the buffer fills faster than realtime, the sound
      // is unrecognisable, and the per-instruction mixer work is the
      // dominant non-CPU cost. Zero the accumulator so it stays in sync
      // when turbo releases.
      if (skipAudio) {
        this.mixer.beeperTStatesAccum = 0;
      } else {
        this.mixer.accumulate(this.ula.getAudioEarBit(this.tapeSoundEnabled), elapsed);
        this.mixer.generateSamples(this.audio, this.ay, this.variant.hasAY);
      }
    }

    // Tape turbo cooldown.
    // earReads only counts ULA reads with high byte 0xFF (no keyboard row
    // selected), so it genuinely reflects tape loading, not keyboard polling.
    // Turbo is also engaged directly when the LoaderDetector fires 'start',
    // ensuring custom loaders get acceleration even before earReads accumulates.
    // Tape auto-pause is handled by LoaderDetector on a microsecond timescale
    // (src/io-ports.ts). This per-frame cooldown ONLY disengages turbo — it
    // does NOT pause the tape. Previous versions auto-paused here as a fallback
    // for the case where port activity stops entirely, but this caused custom
    // loaders to be paused mid-load (their EAR reads used non-0xFF port values,
    // keeping earReads at 0, so the cooldown expired and auto-paused the tape
    // every 25 frames, creating a restart loop on pure-tone blocks).
    // "Loading" signal — used to engage tape turbo and refresh its cooldown.
    // earReads alone is unreliable: custom loaders like Speedlock poll with
    // A=$7F (port high byte $7F, not $FF), so the strict $FF check on earReads
    // misses them. The authoritative signal is the LoaderDetector itself —
    // `loaderActive` stays true between its 'start' and 'stop' events, so the
    // cooldown refreshes every frame for as long as the loader is running.
    // userOverride wins: when the user has manually paused or stopped the
    // tape, turbo must release even if the detector still thinks a loader is
    // running — otherwise the visible MHz readout stays pinned at ~50 and
    // the user's pause feels broken.
    // A paused tape — whether paused by the user, by a TZX "stop tape"
    // block (duration=0), or by auto-rewind hitting end-of-tape — must
    // release tape turbo. `loaderActive` is sticky between §2 start/stop
    // events, so without the `!tape.paused` gate it would hold turbo on
    // long after the tape stopped advancing.
    const tapeLoading = !this.loaderDetector.userOverride
                     && !this.tape.paused
                     && (this.loaderDetector.loaderActive
                         || this.activity.earReads > 0
                         || this.activity.tapeLoads > 0
                         || this.activity.loaderDetected);

    if (this.tape.loaded && !this.tape.finished) {
      if (tapeLoading) {
        if (this.tapeTurbo && !this._tapeTurboActive) {
          this._tapeTurboActive = true;
        }
        this._tapeTurboCooldown = 25;
      } else if (this._tapeTurboCooldown > 0) {
        if (--this._tapeTurboCooldown <= 0) {
          this._tapeTurboActive = false;
          this.mixer.reset();
        }
      }
    } else if (this._tapeTurboActive) {
      this._tapeTurboActive = false;
      this.mixer.reset();
    }

    // Adjust loader detector T-state tracking across frame boundary
    this.loaderDetector.onFrameEnd(this.tStatesPerFrame);

    // Flush any remaining scanlines (bottom border / frame-end edge).
    // Low (0): bulk renderFrame() — one border color, fastest.
    // Mid/High: flushRemainingLines() — picks up any per-line / partial-line
    // state left by renderCompletedScanlines / renderPendingScanlines.
    if (this._skipRender) {
      // Intermediate frame in a turbo batch — skip pixel work. The frameLoop
      // will produce a single fresh frame at the end of the batch.
    } else if (this._scanAcc === 0) {
      this.ula.renderFrame(this.memory.screenBank, 0x4000);
    } else {
      this.flushRemainingLines();
    }

    // Mark that we have a new frame to display
    this.needsDisplay = true;
  }

  /**
   * Render one scanline segment from xStart..xEnd pixels, drawing display
   * cells colStart..colEnd on display lines.  Border pixels outside the
   * display window are filled with the current border colour.
   *
   * Shared by all three scanline-render paths (pending / completed / flush).
   * Callers handle their own gating, T-state advance, and partial-line state.
   */
  private renderLineSegment(
    i: number, xStart: number, xEnd: number, colStart: number, colEnd: number,
  ): void {
    const ula = this.ula;
    const borderTop = ula.borderTop;
    const borderLeft = ula.borderLeft;
    const dispEnd = borderLeft + DISPLAY_WIDTH;
    const w = ula.screenWidth;
    const border = ula.borderColor;

    if (i < borderTop || i >= borderTop + DISPLAY_HEIGHT) {
      ula.fillBorder(i, xStart, xEnd, border);
      return;
    }
    if (xStart < borderLeft) {
      ula.fillBorder(i, xStart, Math.min(xEnd, borderLeft), border);
    }
    if (xEnd > borderLeft && colStart < colEnd) {
      const dy = i - borderTop;
      for (let col = colStart; col < colEnd; col++) {
        ula.renderDisplayCell(dy, col, this.memory.screenBank, 0x4000);
      }
    }
    if (xEnd > dispEnd && xStart < w) {
      ula.fillBorder(i, Math.max(xStart, dispEnd), Math.min(xEnd, w), border);
    }
  }

  /**
   * High-accuracy renderer: render pixels up to the current beam position.
   * Border regions are rendered at sub-scanline granularity; display cells
   * are emitted one at a time as the beam passes each 8-pixel column.
   */
  private renderPendingScanlines(): void {
    const ula = this.ula;
    const borderLeft = ula.borderLeft;
    const dispEnd = borderLeft + DISPLAY_WIDTH;
    const w = ula.screenWidth;
    const tpl = this.contention.timing.tStatesPerLine;
    const t = this.cpu.tStates;

    while (this.nextRenderLine < this.totalRenderLines) {
      const lineRelT = t - this.nextRenderT;
      if (lineRelT < 0) break;

      const beamX = Math.min(w, lineRelT << 1); // 2 pixels per T-state
      if (beamX <= this.nextPixelX) break;

      // Display cell range visible up to the beam.
      // Ferranti ULA (48K/128K/+2): +1 renders as beam enters cell; the
      // write8 attr flush ensures correct per-scanline multicolor.
      // Amstrad gate array (+2A/+3): +0 renders after beam fully passes;
      // deterministic timing makes this safe without attr flushes.
      const endCol = Math.min(
        32, ((Math.min(beamX, dispEnd) - borderLeft) >> 3) + this._cellRenderOffset,
      );
      this.renderLineSegment(
        this.nextRenderLine, this.nextPixelX, beamX,
        this.nextDisplayCol, Math.max(this.nextDisplayCol, endCol),
      );
      if (endCol > this.nextDisplayCol) this.nextDisplayCol = endCol;

      this.nextPixelX = beamX;
      if (this.nextPixelX >= w) {
        this.nextRenderLine++;
        this.nextPixelX = 0;
        this.nextDisplayCol = 0;
        this.nextRenderT += tpl;
      } else {
        break; // beam is mid-line, wait for more T-states
      }
    }
  }

  /**
   * Mid-accuracy renderer: render only fully completed scanlines.
   * Called every instruction but extremely cheap — a single subtract+compare
   * returns immediately most of the time.  Only does real work ~312 times
   * per frame (once per visible line).  Each line gets the current border
   * color, giving per-scanline border effects without mid-line tracking.
   */
  private renderCompletedScanlines(): void {
    const w = this.ula.screenWidth;
    const tpl = this.contention.timing.tStatesPerLine;
    const t = this.cpu.tStates;

    while (this.nextRenderLine < this.totalRenderLines) {
      // Only render once the beam has fully passed this line
      if (t - this.nextRenderT < tpl) break;
      this.renderLineSegment(this.nextRenderLine, 0, w, 0, 32);
      this.nextRenderLine++;
      this.nextRenderT += tpl;
    }
  }

  /**
   * Flush all remaining unrendered lines at frame end (mid + high modes).
   * Picks up wherever the per-instruction renderer left off — partial-line
   * state (nextPixelX, nextDisplayCol) is zero in mid mode and non-zero in
   * high mode only when the beam stopped inside the last line.
   */
  private flushRemainingLines(): void {
    const w = this.ula.screenWidth;
    while (this.nextRenderLine < this.totalRenderLines) {
      this.renderLineSegment(
        this.nextRenderLine, this.nextPixelX, w, this.nextDisplayCol, 32,
      );
      this.nextRenderLine++;
      this.nextPixelX = 0;
      this.nextDisplayCol = 0;
    }
  }

  loadTAP(data: Uint8Array): void {
    this.tape.load(data);
  }

  loadDisk(image: DskImage, unit: number = 0): void {
    this.fdc.insertDisk(image, unit);
  }

  /** Get the 48K ROM font (768 bytes) regardless of current paging. */
  private get romFont(): Uint8Array {
    const pages = this.memory.romPages;
    const basicRom = pages.length === 4 ? pages[3] : pages[1];
    return basicRom.subarray(0x3D00, 0x3D00 + 768);
  }

  ocrScreen(extraFonts?: FontSource[], grid: OcrGridName = '32x24'): string {
    return this.screenText.ocr(
      this.memory.screenBank, this.memory.snapshot(), this.allMemBanks(),
      this.romFont, OCR_GRIDS[grid], extraFonts,
    );
  }

  ocrScreenStyled(
    extraFonts?: FontSource[],
    grid: OcrGridName | 'auto' = 'auto',
  ): OcrResult {
    const screenBankIdx = (this.memory.port7FFD & 0x08) ? 7 : 5;
    const resolved: OcrGridName = grid === 'auto'
      ? this.screenText.detectAndCacheGrid(this.memory.screenBank, `bank ${screenBankIdx}`)
      : grid;
    return this.screenText.ocrStyled(
      this.memory.screenBank, this.memory.snapshot(), this.allMemBanks(),
      this.romFont, this.ula.palette, this.ula.flashState,
      resolved, extraFonts,
    );
  }

  /** All RAM banks + ROM pages — handed to OCR's heuristic font scan so it
   *  can find fonts that live in ROM (e.g. the +3 boot menu's editor font). */
  private allMemBanks(): readonly Uint8Array[] {
    const banks: Uint8Array[] = [];
    for (let i = 0; i < 8; i++) banks.push(this.memory.getRamBank(i));
    for (const rom of this.memory.romPages) banks.push(rom);
    return banks;
  }

  /** OCR entry point for the MCP server. Detects the cell grid automatically
   *  when `mode` is 'auto', then runs OCR with the chosen grid. The returned
   *  string is prefixed with the grid label (e.g. "[51x24]\n...") so callers
   *  can see which grid was used. */
  ocrScreenForMcp(mode: OcrGridName | 'auto' = 'auto'): string {
    const screenBankIdx = (this.memory.port7FFD & 0x08) ? 7 : 5;
    const grid: OcrGridName = mode === 'auto'
      ? detectGrid(this.memory.screenBank, `bank ${screenBankIdx}`) : mode;
    const text = this.ocrScreen(undefined, grid);
    return `[${grid}]\n${text}`;
  }

  /** Disassemble a single instruction at `pc` without a full memory snapshot. */
  private disasmAt(pc: number): DisasmLine {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 8; i++) buf[i] = this.memory.readByte((pc + i) & 0xFFFF);
    const result = disasmOne(buf, 0);
    return { ...result, addr: pc };
  }

  startTrace(mode: 'full' | 'portio' | 'zxtl' = 'full'): void {
    this._traceBuffer = [];
    this._traceMode = mode;
    this._traceLoopPC.fill(-1);
    this._traceLoopHash.fill(0);
    this._traceLoopAddr = -1;
    this._traceLoopCount = 0;
    if (mode === 'portio') {
      this._portTallyIn = new Map();
      this._portTallyOut = new Map();
    }
    if (mode === 'zxtl') {
      this._zxtlPrevPC = -1;
      this._zxtlPrevLen = 0;
      this._traceBuffer.push('ZXTL V0001, ZX84 Emulator, JUMPS ADDRESS CYCLES MEM4 DISASSEMBLY REGS');
      this._traceBuffer.push('J   Cycle Addr. +0 +1 +2 +3 DISASSEMBLY          A  F  B  C  D  E  H  L  XH XL YH YL SP   PC   W  Z  I  R');
    }
    this._tracing = true;
  }

  stopTrace(): string {
    this._tracing = false;
    if (this._traceMode === 'portio') return this.formatPortTally();
    if (this._traceMode === 'full' && this._traceLoopCount > 0) {
      this._traceBuffer.push(`      ... loops back to ${hex16(this._traceLoopAddr)} x${this._traceLoopCount}`);
    }
    return this._traceBuffer.join('\n');
  }

  private captureTraceLine(): void {
    const cpu = this.cpu;
    const pc = cpu.pc;

    // Loop detection: mix the full architectural register state (not just
    // A/F/BC/DE/HL — IX/IY/SP progress must invalidate dedup too) through a
    // proper combining hash. R is excluded because it ticks every M1 fetch
    // and would defeat dedup entirely; memptr likewise changes on too many
    // instructions to be useful.
    const slot = pc & 0x3FF;
    let hash = cpu.a;
    hash = Math.imul(hash, 31) + cpu.f | 0;
    hash = Math.imul(hash, 31) + cpu.bc | 0;
    hash = Math.imul(hash, 31) + cpu.de | 0;
    hash = Math.imul(hash, 31) + cpu.hl | 0;
    hash = Math.imul(hash, 31) + cpu.ix | 0;
    hash = Math.imul(hash, 31) + cpu.iy | 0;
    hash = Math.imul(hash, 31) + cpu.sp | 0;
    hash = Math.imul(hash, 31) + cpu.i | 0;

    if (this._traceLoopPC[slot] === pc && this._traceLoopHash[slot] === hash) {
      // Same PC, same register state — suppress duplicate iteration
      if (this._traceLoopCount === 0) this._traceLoopAddr = pc;
      this._traceLoopCount++;
      return;
    }

    // Flush any accumulated loop marker
    if (this._traceLoopCount > 0) {
      this._traceBuffer.push(`      ... loops back to ${hex16(this._traceLoopAddr)} x${this._traceLoopCount}`);
      this._traceLoopCount = 0;
    }

    // Update cache
    this._traceLoopPC[slot] = pc;
    this._traceLoopHash[slot] = hash;

    // Record trace line
    const line = this.disasmAt(pc);
    const mnem = stripMarkers(line.text);
    const ctx = this.traceCtx(pc);
    const addr = hex16(pc);
    this._traceBuffer.push(ctx
      ? `${addr}  ${mnem.padEnd(24)} ${ctx}`
      : `${addr}  ${mnem}`);
    if (this._traceBuffer.length >= 500_000) this._tracing = false;
  }

  /**
   * Capture one ZXTL trace line.  Called after cpu.step() with the pre-step PC
   * so register values reflect the result of the executed instruction.
   */
  private captureZxtlLine(prePC: number): void {
    const cpu = this.cpu;
    const mem = this.memory;

    // Disassemble the instruction that was at prePC
    const dl = this.disasmAt(prePC);
    const mnem = stripMarkers(dl.text);

    // Jump detection: is prePC non-sequential from previous instruction?
    const isJump = this._zxtlPrevPC >= 0 &&
      prePC !== ((this._zxtlPrevPC + this._zxtlPrevLen) & 0xFFFF);
    this._zxtlPrevPC = prePC;
    this._zxtlPrevLen = dl.length;

    // Format: J Cycle Addr MEM4 DISASM REGS
    this._traceBuffer.push(
      `${isJump ? '*' : ' '} ${String(cpu.tStates).padStart(7)} ${String(prePC).padStart(5)} ` +
      `${hex8(mem.readByte(prePC))} ${hex8(mem.readByte((prePC + 1) & 0xFFFF))} ` +
      `${hex8(mem.readByte((prePC + 2) & 0xFFFF))} ${hex8(mem.readByte((prePC + 3) & 0xFFFF))} ` +
      `${mnem.padEnd(20)} ` +
      `${hex8(cpu.a)} ${hex8(cpu.f)} ` +
      `${hex8((cpu.bc >> 8) & 0xFF)} ${hex8(cpu.bc & 0xFF)} ` +
      `${hex8((cpu.de >> 8) & 0xFF)} ${hex8(cpu.de & 0xFF)} ` +
      `${hex8((cpu.hl >> 8) & 0xFF)} ${hex8(cpu.hl & 0xFF)} ` +
      `${hex8((cpu.ix >> 8) & 0xFF)} ${hex8(cpu.ix & 0xFF)} ` +
      `${hex8((cpu.iy >> 8) & 0xFF)} ${hex8(cpu.iy & 0xFF)} ` +
      `${hex16(cpu.sp)} ${hex16(cpu.pc)} ` +
      `${hex8((cpu.memptr >> 8) & 0xFF)} ${hex8(cpu.memptr & 0xFF)} ` +
      `${hex8(cpu.i)} ${hex8(cpu.r)}`
    );
    if (this._traceBuffer.length >= 500_000) this._tracing = false;
  }

  private traceCtx(pc: number): string {
    const cpu = this.cpu;
    const mem = this.memory;
    let op = mem.readByte(pc);

    // DD/FD prefix → IX/IY memory access
    if (op === 0xDD || op === 0xFD) {
      const ixr = op === 0xDD ? cpu.ix : cpu.iy;
      const op2 = mem.readByte((pc + 1) & 0xFFFF);
      if (op2 === 0xCB) {
        const d = mem.readByte((pc + 2) & 0xFFFF);
        const addr = (ixr + signed8(d)) & 0xFFFF;
        return `(${hex16(addr)})=${hex8(mem.readByte(addr))}`;
      }
      if (op2 === 0xED || op2 === 0xDD || op2 === 0xFD) return '';
      const x = (op2 >> 6) & 3, y = (op2 >> 3) & 7, z = op2 & 7;
      if ((x === 1 && (y === 6 || z === 6) && !(y === 6 && z === 6)) ||
          (x === 2 && z === 6) ||
          (x === 0 && (z === 4 || z === 5) && y === 6) ||
          op2 === 0x36) {
        const d = mem.readByte((pc + 2) & 0xFFFF);
        const addr = (ixr + signed8(d)) & 0xFFFF;
        if (x === 2) return `A=${hex8(cpu.a)} (${hex16(addr)})=${hex8(mem.readByte(addr))}`;
        return `(${hex16(addr)})=${hex8(mem.readByte(addr))}`;
      }
      return '';
    }

    // CB: bit ops on (HL)
    if (op === 0xCB) {
      if ((mem.readByte((pc + 1) & 0xFFFF) & 7) === 6) return `(${hex16(cpu.hl)})=${hex8(mem.readByte(cpu.hl))}`;
      return '';
    }

    // ED prefix
    if (op === 0xED) {
      const ed = mem.readByte((pc + 1) & 0xFFFF);
      const x = (ed >> 6) & 3, y = (ed >> 3) & 7, z = ed & 7;
      if (x === 1 && (z === 0 || z === 1)) return `port=${hex16(cpu.bc)}`;
      if (x === 2 && y >= 4 && z < 4) return `HL=${hex16(cpu.hl)} DE=${hex16(cpu.de)} BC=${hex16(cpu.bc)}`;
      return '';
    }

    // Main table
    const x = (op >> 6) & 3, y = (op >> 3) & 7, z = op & 7;
    const p = (y >> 1) & 3, q = y & 1;

    if (x === 0) {
      if (z === 0 && y === 2) return `B=${hex8((cpu.bc >> 8) & 0xFF)}`; // DJNZ
      if (z === 0 && y >= 4) return cpu.checkCondition(y - 4) ? 'taken' : '--'; // JR cc
      if (z === 2) {
        if (q === 0 && p <= 1) return `A=${hex8(cpu.a)}→(${hex16(p === 0 ? cpu.bc : cpu.de)})`;
        if (q === 1 && p === 0) return `(${hex16(cpu.bc)})=${hex8(mem.readByte(cpu.bc & 0xFFFF))}`;
        if (q === 1 && p === 1) return `(${hex16(cpu.de)})=${hex8(mem.readByte(cpu.de & 0xFFFF))}`;
      }
      if ((z === 4 || z === 5) && y === 6) return `(${hex16(cpu.hl)})=${hex8(mem.readByte(cpu.hl & 0xFFFF))}`;
    }

    if (x === 1) {
      if (y === 6 && z !== 6) return `${hex8(cpu.getReg8(z))}→(${hex16(cpu.hl)})`;
      if (z === 6 && y !== 6) return `(${hex16(cpu.hl)})=${hex8(mem.readByte(cpu.hl & 0xFFFF))}`;
    }

    if (x === 2) {
      if (z === 6) return `A=${hex8(cpu.a)} (${hex16(cpu.hl)})=${hex8(mem.readByte(cpu.hl & 0xFFFF))}`;
      return `A=${hex8(cpu.a)}`;
    }

    if (x === 3) {
      if (z === 0) return cpu.checkCondition(y) ? 'taken' : '--'; // RET cc
      if (z === 2) return cpu.checkCondition(y) ? 'taken' : '--'; // JP cc
      if (z === 4) return cpu.checkCondition(y) ? 'taken' : '--'; // CALL cc
      if (z === 6) return `A=${hex8(cpu.a)}`; // ALU A,n
      if (z === 3 && y === 2) return `A=${hex8(cpu.a)}`; // OUT (n),A
    }

    return '';
  }

  private portLabel(port: number): string {
    const v = this.variant;
    if ((port & 1) === 0) return 'ULA';
    if ((port & 0x00E0) === 0) return 'Kemp';
    if (v.hasAY) {
      if ((port & 0xC002) === 0xC000) return 'AY';
      if ((port & 0xC002) === 0x8000) return 'AY';
    }
    if (v.decodes7FFD(port)) return '7FFD';
    if (v.decodes1FFD(port)) return '1FFD';
    if (v.decodesFDCStatus(port)) return 'FDC';
    if (v.decodesFDCData(port)) return 'FDC';
    return '';
  }

  private formatPortTally(): string {
    const formatSection = (title: string, tally: Map<number, { count: number; pcs: Set<number>; vals: Set<number> }>) => {
      if (!tally.size) return '';
      const entries = [...tally.entries()].sort((a, b) => b[1].count - a[1].count);
      const lines = [`${title}:`];
      for (const [port, info] of entries) {
        const label = (this.portLabel(port) || '').padEnd(6);
        const pcs = [...info.pcs].map(hex16).join(',');
        const vals = [...info.vals].map(hex8).join(',');
        lines.push(`  ${hex16(port)}  ${String(info.count).padStart(8)}x  ${label} from ${pcs}  vals ${vals}`);
      }
      return lines.join('\n');
    };

    const parts = ['=== Port IO Summary ===', ''];
    // Idempotent: a second stopTrace() in portio mode must not crash on the
    // nulled-out tallies from the first call.
    if (this._portTallyIn) {
      const inSection = formatSection('IN', this._portTallyIn);
      if (inSection) parts.push(inSection, '');
    }
    if (this._portTallyOut) {
      const outSection = formatSection('OUT', this._portTallyOut);
      if (outSection) parts.push(outSection, '');
    }
    this._portTallyIn = null;
    this._portTallyOut = null;
    return parts.join('\n');
  }

  private setStatus(msg: string): void {
    if (this.onStatus) this.onStatus(msg);
  }
}
