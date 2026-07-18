/**
 * BaseMachine — the driver scaffolding shared by every emulated computer.
 *
 * The Spectrum and the CPC have completely different video, memory, and I/O, but
 * they share the same *driver*: the requestAnimationFrame loop, wall-clock frame
 * pacing, audio back-pressure, turbo batching, the start/stop/destroy lifecycle,
 * the headless tick()/runUntil() helpers, and the debug-surface fields the MCP
 * server reads. That scaffolding used to exist as two near-identical copies that
 * drifted independently; it lives here once.
 *
 * Each machine supplies only the parts that genuinely differ, via these hooks:
 *   - runFrame()       — execute + render one video frame (ULA per-pixel vs the
 *                        CPC's per-scanline CRTC engine)
 *   - framePixels()    — the RGBA buffer to upload to the display
 *   - inTurbo()        — whether the turbo / fast-load batch path is engaged
 *   - runTurboBurst()  — execute one turbo batch within a wall-clock budget.
 *                        The default runs frames for the budget; the Spectrum
 *                        overrides it to swap in fast timing and skip renders.
 *                        Turbo is driven by a MessageChannel pump (not rAF) so
 *                        it isn't capped at the vsync rate.
 *   - exitTurbo()      — restore per-frame state when leaving turbo. No-op by
 *                        default; the Spectrum restores timing accuracy.
 */

import type { Audio } from '@/audio.ts';
import type { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import type { AY3891x } from '@/cores/ay-3-8910.ts';
import type { IScreenRenderer } from '@/display/display.ts';

/** rAF-independent frame period: 50 Hz. */
const FRAME_PERIOD = 1000 / 50;
/** Per-burst budget for the turbo pump (ms). Each burst runs frames for this
 *  long, then yields (via postMessage) so input and the rAF render get
 *  serviced before the next burst re-arms. Larger = more throughput, but
 *  coarser input latency. The pump re-fires near-instantly, so the duty cycle
 *  is ~budget/(budget+yield) — close to 100%, vs the old rAF path's ~70%. */
const TURBO_PUMP_BUDGET_MS = 8;
/** Audio back-pressure target, in frames of buffered samples. */
const TARGET_BUFFER_FRAMES = 3;
function samplesPerFrame(sampleRate: number): number { return Math.round(sampleRate / 50); }

export abstract class BaseMachine {
  // ── Audio/video plumbing the driver needs (each machine supplies these) ──
  abstract ay: AY3891x;
  abstract mixer: AudioMixer;
  abstract audio: Audio;
  abstract display: IScreenRenderer | null;

  // ── Debug surface (consumed by the MCP server) ───────────────────────────
  breakpoints = new Set<number>();
  breakpointHit = -1;
  portWatchpoints = new Set<number>();
  portWatchHit: { port: number; value: number; dir: 'in' | 'out' } | null = null;
  memWatchpoints: { start: number; end: number; mode: 'read' | 'write' | 'rw' }[] = [];
  memWatchHit: { addr: number; value: number; dir: 'read' | 'write' } | null = null;
  onTrap: ((pc: number) => boolean) | null = null;
  onStatus: ((msg: string) => void) | null = null;
  onFrame: (() => void) | null = null;

  // ── Frame-loop / lifecycle state ─────────────────────────────────────────
  /** Turbo mode: run as many frames as fit in the per-rAF budget. */
  turbo = false;
  protected running = false;
  protected starting = false;
  protected startGen = 0;
  protected rafId = 0;
  /** Turbo pump: drives turbo execution off a MessageChannel postMessage loop
   *  instead of rAF, so it isn't capped at the vsync rate nor penalised for
   *  overrunning a frame deadline. Created lazily on first turbo entry. */
  private turboChannel: MessageChannel | null = null;
  private turboPumpQueued = false;
  /** Wall-clock frame pacing (governs speed regardless of rAF rate). */
  protected lastFrameTime = 0;
  protected frameTimeAccum = 0;
  /** Whether a fresh frame is waiting to be uploaded to the display. */
  protected needsDisplay = true;

  // ── Hooks each machine implements ────────────────────────────────────────
  /** Execute + render exactly one video frame. */
  protected abstract runFrame(): void;
  /** The RGBA buffer to upload to the display. */
  protected abstract framePixels(): Uint8Array;
  /** Whether the turbo / fast-load batch path is currently engaged. */
  protected abstract inTurbo(): boolean;

  protected setStatus(msg: string): void { if (this.onStatus) this.onStatus(msg); }

  /** Live AudioContext once audio is initialised (drive-sound synth attach). */
  get audioContext(): AudioContext | null { return this.audio.ctx; }

  /** Unlock the AudioContext on the first user gesture without starting the
   *  frame loop (browsers require a gesture before audio may run). No-op once
   *  audio is already running. */
  initAudio(): void {
    if (!this.audio.running) void this.audio.init();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    const gen = ++this.startGen;

    await this.audio.init();

    // Bail if stop() ran, or a newer start() superseded us, while awaiting.
    if (!this.starting || gen !== this.startGen) return;
    this.starting = false;

    this.mixer.init(this.audio.sampleRate);
    this.ay.setSampleRate(this.audio.sampleRate);

    this.running = true;
    this.lastFrameTime = performance.now();
    this.frameTimeAccum = 0;
    // The rAF loop stays alive across pause/resume, so only start it once.
    if (!this.rafId) this.rafId = requestAnimationFrame(this.frameLoop);
    this.setStatus('Running');
  }

  stop(): void {
    this.starting = false; // cancel a pending async start
    this.running = false;
    // The rAF loop keeps running so the display stays alive (noise animates,
    // setting changes take effect immediately). Only destroy() cancels it.
  }

  destroy(): void {
    this.stop();
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    if (this.turboChannel) {
      this.turboChannel.port1.onmessage = null;
      this.turboChannel.port1.close();
      this.turboChannel.port2.close();
      this.turboChannel = null;
      this.turboPumpQueued = false;
    }
    this.audio.destroy();
  }

  /** Run one frame (headless / test harness). */
  tick(): void {
    this.breakpointHit = -1;
    this.portWatchHit = null;
    this.memWatchHit = null;
    this.runFrame();
  }

  /** Run up to maxFrames, stopping early on a breakpoint/watchpoint hit. */
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

  // ── rAF driver ───────────────────────────────────────────────────────────

  private frameLoop = (): void => {
    if (this.running) {
      const now = performance.now();
      if (this.inTurbo()) {
        // Turbo execution is driven by the MessageChannel pump (decoupled from
        // vsync — see ensureTurboPump). The rAF loop only renders the latest
        // frame and runs the per-frame UI upkeep at the display's refresh rate.
        // Do NOT clear breakpointHit here: a hit raised inside the pump must
        // survive until onFrame() below pauses the machine.
        this.ensureTurboPump();
      } else {
        this.breakpointHit = -1;
        this.exitTurbo();
        this.runPacedFrames(now);
      }

      // Push the rendered frame to the display.
      if (this.needsDisplay) {
        if (this.display) this.display.updateTexture(this.framePixels());
        this.needsDisplay = false;
      }

      if (this.onFrame) this.onFrame();
    } else if (this.display) {
      // Paused: keep uploading so the display stays alive.
      this.display.updateTexture(this.framePixels());
    }

    this.rafId = requestAnimationFrame(this.frameLoop);
  };

  /** Wall-clock paced execution: catch up at 50 Hz, throttled by audio buffer. */
  protected runPacedFrames(now: number): void {
    this.frameTimeAccum = Math.min(
      this.frameTimeAccum + (now - this.lastFrameTime),
      FRAME_PERIOD * 3, // cap catch-up to 3 frames (e.g. after the tab was hidden)
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

  /**
   * Run one turbo batch: execute frames for `budgetMs` of wall-clock (or until a
   * breakpoint hits). Called repeatedly by the turbo pump, which controls the
   * cadence — so this no longer sizes itself to the rAF interval. The chosen
   * render path must leave `needsDisplay` set so the final frame is uploaded by
   * the rAF loop. The Spectrum overrides this to swap in fast (no-contention)
   * timing and skip intermediate renders.
   */
  protected runTurboBurst(budgetMs: number): void {
    const budgetEnd = performance.now() + budgetMs;
    do {
      this.runFrame();
      if (this.breakpointHit >= 0) break;
    } while (performance.now() < budgetEnd);
    this.lastFrameTime = performance.now();
    this.frameTimeAccum = 0;
  }

  /** Ensure the turbo pump is scheduled. Idempotent — safe to call every rAF
   *  tick. Creates the MessageChannel lazily on first turbo entry. */
  private ensureTurboPump(): void {
    if (!this.turboChannel) {
      this.turboChannel = new MessageChannel();
      this.turboChannel.port1.onmessage = this.turboPump;
    }
    if (!this.turboPumpQueued) {
      this.turboPumpQueued = true;
      this.turboChannel.port2.postMessage(0);
    }
  }

  /** One turbo burst, then re-arm immediately. postMessage re-fires in well
   *  under a millisecond and isn't vsync-locked, so successive bursts use the
   *  main thread near-continuously (each burst still yields between runs, so
   *  input and the rAF render get serviced). Stops re-arming when turbo is
   *  released, the machine pauses, or a breakpoint hits — in the last case the
   *  hit is left set so the next rAF's onFrame() pauses the machine. */
  private turboPump = (): void => {
    this.turboPumpQueued = false;
    if (!this.running || !this.inTurbo()) return;
    this.breakpointHit = -1;
    this.runTurboBurst(TURBO_PUMP_BUDGET_MS);
    if (this.breakpointHit >= 0) return;
    this.ensureTurboPump();
  };

  /** Restore per-frame state when leaving turbo. No-op by default. */
  protected exitTurbo(): void {}
}
