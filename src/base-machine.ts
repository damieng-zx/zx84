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
 *   - runTurboBurst()  — how a turbo batch is paced. The default is the CPC's
 *                        fixed budget; the Spectrum overrides it with its
 *                        adaptive, rAF-cadence-aware budget.
 *   - exitTurbo()      — restore per-frame state when leaving turbo. No-op by
 *                        default; the Spectrum restores timing accuracy.
 */

import type { Audio } from '@/audio.ts';
import type { AudioMixer } from '@/peripherals/audio-mixer.ts';
import type { AY3891x } from '@/cores/ay-3-8910.ts';
import type { IScreenRenderer } from '@/display/display.ts';

/** rAF-independent frame period: 50 Hz. */
const FRAME_PERIOD = 1000 / 50;
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
      this.breakpointHit = -1;
      const now = performance.now();
      if (this.inTurbo()) {
        this.runTurboBurst(now);
      } else {
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
   * Pace one turbo batch. Default: spend a fixed 8 ms budget running frames (the
   * CPC's model). The Spectrum overrides this with an adaptive, rAF-cadence-aware
   * budget. The chosen render path must leave `needsDisplay` set so the final
   * frame is uploaded by the loop above.
   */
  protected runTurboBurst(now: number): void {
    const budgetEnd = now + 8;
    do {
      this.runFrame();
      if (this.breakpointHit >= 0) break;
    } while (performance.now() < budgetEnd);
    this.lastFrameTime = now;
    this.frameTimeAccum = 0;
  }

  /** Restore per-frame state when leaving turbo. No-op by default. */
  protected exitTurbo(): void {}
}
