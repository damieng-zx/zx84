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
import type { IScreenRenderer } from '@/display/renderer.ts';
import { BEAM_IO, BEAM_IRQ, type BeamInfo, type BeamLog, type BeamPos } from '@/debug/beam-log.ts';
import type { StopKind, StopReason } from '@/debug/stop-reason.ts';

/** A watched address range. */
export interface MemWatchpoint {
  start: number;
  end: number;
  mode: 'read' | 'write' | 'rw';
  /** `'break'` stops the run at the first access (the default); `'log'`
   *  records every access in the beam log and carries on. */
  action?: 'break' | 'log';
  /** A log watchpoint records only accesses of these values. */
  values?: number[];
}

interface SampleRateAwareAudioChip {
  setSampleRate(sampleRate: number): void;
}

/** rAF-independent default frame rate: 50 Hz (machines override {@link BaseMachine.frameHz}). */
const DEFAULT_FRAME_HZ = 50;
/** Per-burst budget for the turbo pump (ms). Each burst runs frames for this
 *  long, then yields (via postMessage) so input and the rAF render get
 *  serviced before the next burst re-arms. Larger = more throughput, but
 *  coarser input latency. The pump re-fires near-instantly, so the duty cycle
 *  is ~budget/(budget+yield) — close to 100%, vs the old rAF path's ~70%. */
const TURBO_PUMP_BUDGET_MS = 8;
/** Audio back-pressure target, in frames of buffered samples. */
const TARGET_BUFFER_FRAMES = 3;
/** Low-water mark, in frames of buffered samples, below which a frame runs
 *  immediately regardless of wall-clock pacing (see runPacedFrames). A real
 *  frame produces slightly fewer samples than the worklet consumes per
 *  nominal frame (e.g. the 48K's true 50.08 Hz vs the assumed flat 50 Hz —
 *  958.47 samples/frame vs 960 consumed, about -0.16%), so pacing purely on
 *  wall-clock time lets that drift accumulate into periodic underruns (the
 *  worklet zero-fills, an audible ~10-sample gap roughly every 100 ms). This
 *  gives the buffer a chance to catch back up before it actually runs dry,
 *  rather than only ever being throttled down once it's already full. */
const LOW_BUFFER_FRAMES = 1;
function samplesPerFrame(sampleRate: number, frameHz: number): number { return Math.round(sampleRate / frameHz); }

export abstract class BaseMachine {
  // ── Audio/video plumbing the driver needs (each machine supplies these) ──
  /** Nominal field rate (Hz) the wall-clock pacing and audio back-pressure run
   *  at. 50 Hz unless a machine (e.g. an NTSC MSX) says otherwise. */
  protected get frameHz(): number { return DEFAULT_FRAME_HZ; }
  /** Machine's primary sample-generating chip (AY, SN76489, etc.). */
  protected abstract get audioChip(): SampleRateAwareAudioChip;
  abstract mixer: AudioMixer;
  abstract audio: Audio;
  abstract display: IScreenRenderer | null;

  // ── Debug surface (consumed by the MCP server) ───────────────────────────
  breakpoints = new Set<number>();
  breakpointHit = -1;
  portWatchpoints = new Set<number>();
  portWatchHit: { port: number; value: number; dir: 'in' | 'out' } | null = null;
  /** Watched address ranges. `action` is `'break'` (the default: stop at the
   *  first access) or `'log'` (record every access in the beam log and carry
   *  on); `values` limits a log watchpoint to writes of those values. */
  memWatchpoints: MemWatchpoint[] = [];
  memWatchHit: { addr: number; value: number; dir: 'read' | 'write' } | null = null;
  /** The ports in `portWatchpoints` that log to the beam log instead of
   *  stopping. They are also in `portWatchpoints`, which is what opens the
   *  machines' `size > 0` guard. */
  portLogPorts = new Set<number>();
  /** The pc of the instruction now executing, for a machine that wants
   *  watchpoint log entries to name it. Set before each step. */
  insnPc = 0;
  /** Record an access that falls in a memory watchpoint: the first break-mode
   *  hit is kept for the run to stop on, and every log-mode access goes in the
   *  beam log. Machines call this only while `memWatchpoints` is non-empty and
   *  no hit is pending, so the bus pays nothing when none are set. Public so
   *  a machine's `io.ts` wiring can share it. */
  recordMemWatch(addr: number, value: number, dir: 'read' | 'write'): void {
    for (const wp of this.memWatchpoints) {
      if (!((wp.mode === dir || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end)) continue;
      if (wp.action === 'log') {
        this.logAccess(addr, value, dir === 'write', false, wp.values);
        continue;
      }
      this.memWatchHit = { addr, value, dir };
      return;
    }
  }
  /** Record a port access that hits a port watchpoint: a log port goes in the
   *  beam log; the first break-mode hit is kept for the run to stop on.
   *  Callers guard with `portWatchpoints.size > 0` so the port bus pays
   *  nothing otherwise. */
  recordPortWatch(port: number, value: number, dir: 'in' | 'out'): void {
    if (this.portLogPorts.size > 0 && this.portLogPorts.has(port)) {
      this.logAccess(port, value, dir === 'out', true);
      return;
    }
    if (this.portWatchHit === null && this.portWatchpoints.has(port)) {
      this.portWatchHit = { port, value, dir };
    }
  }
  /** Put one watched access in the beam log, stamped with the beam where the
   *  callback sees it. A machine whose bus callbacks run before the
   *  instruction's cycles are counted (the 6502 core) overrides this to queue
   *  the access and stamp it after the step. `flags`: bit 0 = write/out,
   *  bit 1 = port space. */
  protected logAccess(addr: number, value: number, write: boolean, port: boolean, values?: number[]): void {
    const log = this.beamLog;
    if (log === null) return;
    if (values !== undefined && !values.includes(value)) return;
    const pos = this.beam();
    if (pos === null) return;
    log.push(BEAM_IO, pos.frame, pos.t, this.insnPc, addr, value, (write ? 1 : 0) | (port ? 2 : 0));
  }
  /** Called before each instruction with its pc; returning true stops the run.
   *  `resume` is true for the first instruction after a trap stopped the run
   *  at this same pc, so the hook does not repeat what it did on the way in. */
  onTrap: ((pc: number, resume?: boolean) => boolean) | null = null;

  // ── Stop reasons and resuming (docs/beam-debug-mcp-spec.md P2) ───────────
  /** Why the last run stopped, or null if it ran to its end. Cleared when a
   *  run starts. */
  stopReason: StopReason | null = null;
  /** The pc a breakpoint or trap stopped at. The first instruction after it
   *  must not stop there again, or a resume would make no progress. -1 = none. */
  protected resumeSkipPc = -1;
  protected resumeSkipKind: 'breakpoint' | 'trap' = 'breakpoint';
  /** Record that the run is stopping, and why. A breakpoint or trap stop also
   *  sets `breakpointHit` and arms the skip-once for the resume. */
  protected markStop(kind: StopKind, pc: number, detail = ''): void {
    this.stopReason = { kind, pc, detail };
    if (kind === 'breakpoint' || kind === 'trap') {
      this.breakpointHit = pc;
      this.resumeSkipPc = pc;
      this.resumeSkipKind = kind;
    }
  }

  /** Stop at the first instruction boundary at or after this beam position
   *  (a run-to-beam request). Honoured only by a machine whose frame loop can
   *  stop and resume ({@link supportsBeamStops}); cleared when it fires. */
  beamTarget: { frame: number; t: number } | null = null;
  /** Whether {@link beamTarget} works on this machine. */
  supportsBeamStops(): boolean { return false; }

  /**
   * The check a frame loop makes before each instruction: true when the run
   * must stop at `pc`, for a breakpoint or for a trap that asks to break (and
   * then `stopReason` says which). The first instruction after such a stop at
   * the same pc is let through, or a resume would stop again at once; a trap
   * is told it is a resume so it does not log or break a second time. Costs
   * three compares when nothing is armed.
   */
  protected checkStops(pc: number): boolean {
    if (this.breakpoints.size === 0 && this.onTrap === null && this.resumeSkipPc < 0) return false;
    let skipBreakpoint = false;
    let trapResume = false;
    if (this.resumeSkipPc >= 0) {
      if (pc === this.resumeSkipPc) {
        skipBreakpoint = true;
        trapResume = this.resumeSkipKind === 'trap';
      }
      this.resumeSkipPc = -1;
    }
    if (!skipBreakpoint && this.breakpoints.has(pc)) {
      this.markStop('breakpoint', pc);
      return true;
    }
    // A 6502's next step may enter an interrupt instead of running the
    // instruction at pc, which a trap there would report though it never runs.
    if (this.onTrap !== null && !this.interruptEntryPending() && this.onTrap(pc, trapResume)) {
      this.markStop('trap', pc);
      return true;
    }
    return false;
  }
  /** The CPU's next step enters an interrupt (6502 machines override this). */
  protected interruptEntryPending(): boolean { return false; }

  // ── Interrupt log (docs/beam-debug-mcp-spec.md 2a) ────────────────────────
  /** Record interrupt entries and ends in the beam log. A machine that sets
   *  its CPU's `onInterrupt` to {@link noteInterrupt} and calls
   *  {@link closeInterrupts} after each instruction supports it. */
  interruptLogging = false;
  /** Interrupts entered and not yet ended: sp, frame, t, handler, nmi (5 each). */
  private readonly intStack: number[] = [];
  /** How many are open (read by the instruction loop as its cheap guard). */
  protected intOpen = 0;
  /** Whether this machine reports interrupts (see {@link interruptLogging}). */
  supportsInterruptLog(): boolean { return false; }
  /** The CPU's stack pointer, for pairing an interrupt's entry with its end. */
  protected stackPointer(): number { return 0; }
  /** The CPU's pc. */
  protected cpuPc(): number { return 0; }
  /** The pc an interrupt just taken will return to (the return address the CPU
   *  pushed), read off the stack. */
  protected interruptedPc(): number { return this.cpuPc(); }
  /** The CPU entered an interrupt whose handler starts at `handler`; `status`
   *  is whatever interrupt-status register the machine can say (NMIST/IRQST).
   *  Called from the core's `onInterrupt`, after the stack pushes, so the
   *  stack pointer is the one the interrupt's end is measured against. */
  protected noteInterrupt(handler: number, nmi: boolean, status = 0, extraFlags = 0): void {
    const log = this.beamLog;
    if (!this.interruptLogging || log === null) return;
    const pos = this.beam();
    if (pos === null) return;
    const depth = this.intOpen;
    this.intStack.push(this.stackPointer(), pos.frame, pos.t, handler, nmi ? 1 : 0);
    this.intOpen++;
    log.push(BEAM_IRQ, pos.frame, pos.t, this.interruptedPc(), handler, status, (nmi ? 1 : 0) | extraFlags | (depth << 8));
  }
  /** Close the interrupts the CPU has returned from: the end of one is the
   *  first instruction boundary at which the stack pointer has risen back
   *  above its value at entry. Pairing by stack depth, not by return opcode,
   *  because a handler may end in `EI; RET` as the 48K ROM's does. */
  protected closeInterrupts(): void {
    const st = this.intStack;
    const log = this.beamLog;
    const sp = this.stackPointer();
    while (st.length > 0 && sp > st[st.length - 5]) {
      const nmi = st.pop()!, handler = st.pop()!, t0 = st.pop()!, f0 = st.pop()!;
      st.pop();
      this.intOpen--;
      const pos = this.beam();
      if (!this.interruptLogging || log === null || pos === null) continue;
      const info = this.beamInfo();
      const frameCycles = info ? info.cyclesPerLine * info.linesPerFrame : 0;
      const cost = (pos.frame - f0) * frameCycles + (pos.t - t0);
      log.push(BEAM_IRQ, pos.frame, pos.t, this.cpuPc(), handler, cost, 2 | nmi | (this.intOpen << 8), f0, t0);
    }
  }
  /** Stop logging interrupts and forget any still open. */
  protected clearInterrupts(): void {
    this.intStack.length = 0;
    this.intOpen = 0;
  }

  // ── Beam seam and frame counter (docs/beam-debug-mcp-spec.md P1, P4) ─────
  /** The beam-stamped event ring. Null until a debugger arms it; every
   *  producer checks it before recording, so nothing is paid while it is off. */
  beamLog: BeamLog | null = null;
  /** The index of the frame in progress: the number of frames completed since
   *  reset. Only a machine that implements {@link beam} keeps it honest (it
   *  zeroes it on a cold reset). */
  frameNumber = 0;
  /** Set by a `runFrame` that returns before the frame is done (a stop in the
   *  middle of it) and cleared when a later call completes the frame, so the
   *  counter does not count the same frame twice. A machine whose `runFrame`
   *  always finishes the frame never sets it. */
  protected midFrame = false;
  /** Inside a `runFrame` call. */
  private inFrame = false;
  /** A reset happened inside the frame in progress (the Atari's autostart
   *  script cold-starts from inside `runFrame`): `stepFrame` leaves the zeroed
   *  counter alone instead of counting that frame. */
  private frameCountReset = false;
  /** A frame has started and not finished: either it is running now or it was
   *  stopped part-way. Between frames this is false. */
  protected get frameOpen(): boolean { return this.inFrame || this.midFrame; }
  /** Zero the frame counter (cold reset). */
  protected resetFrameCount(): void {
    this.frameNumber = 0;
    this.midFrame = false;
    if (this.inFrame) this.frameCountReset = true;
  }
  /** Where the beam is: the frame in progress and the cycles since it started.
   *  Valid inside `runFrame` and between frames; between frames it is the next
   *  frame, a few cycles in. Null on a machine with no raster to report. */
  beam(): BeamPos | null { return null; }
  /** The raster geometry `t` is measured in. */
  beamInfo(): BeamInfo | null { return null; }
  /** Run one frame, or the rest of one that was stopped, and count it. Every
   *  place that runs a frame goes through here. */
  protected stepFrame(): void {
    this.inFrame = true;
    try {
      this.runFrame();
    } finally {
      this.inFrame = false;
    }
    if (this.frameCountReset) this.frameCountReset = false;
    else if (!this.midFrame) this.frameNumber++;
  }

  onStatus: ((msg: string) => void) | null = null;
  onFrame: (() => void) | null = null;
  onScreenChange: (() => void) | null = null;

  // ── Frame-loop / lifecycle state ─────────────────────────────────────────
  /** Turbo mode: run as many frames as fit in the per-rAF budget. */
  turbo = false;
  /** Requested wall-clock speed. `null` selects the uncapped turbo pump. */
  speedMultiplier: number | null = 1;
  protected running = false;
  protected starting = false;
  protected startGen = 0;
  private destroyed = false;
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

  /** Unlock the AudioContext on a user gesture without starting the
   *  frame loop (browsers require a gesture before audio may run). No-op once
   *  audio is already running. */
  initAudio(): void {
    // Audio.running means the output pipeline exists, not that autoplay has
    // allowed its context to run. init() resumes an existing suspended context.
    if (!this.destroyed && this.audio.ctx?.state !== 'running') void this.audio.init();
  }

  setSpeedMultiplier(multiplier: number | null): void {
    this.speedMultiplier = multiplier;
    this.turbo = multiplier === null;
    // Do not carry pacing debt across a speed change.
    this.lastFrameTime = performance.now();
    this.frameTimeAccum = 0;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.destroyed || this.running || this.starting) return;
    this.starting = true;
    const gen = ++this.startGen;

    // Headless hosts (the MCP server, Node tests) have no AudioContext: skip
    // the audio pipeline. Frames are driven manually via tick()/runUntil().
    if (typeof AudioContext !== 'undefined') await this.audio.init();

    // Bail if stop() ran, or a newer start() superseded us, while awaiting.
    if (!this.starting || gen !== this.startGen) return;
    this.starting = false;

    this.mixer.init(this.audio.sampleRate);
    this.audioChip.setSampleRate(this.audio.sampleRate);

    this.running = true;
    this.lastFrameTime = performance.now();
    this.frameTimeAccum = 0;
    // The rAF loop stays alive across pause/resume, so only start it once.
    // Headless there is no rAF: nothing schedules frames autonomously.
    if (!this.rafId && typeof requestAnimationFrame !== 'undefined') {
      this.rafId = requestAnimationFrame(this.frameLoop);
    }
    this.setStatus('Running');
  }

  stop(): void {
    this.starting = false; // cancel a pending async start
    this.running = false;
    // The rAF loop keeps running so the display stays alive (noise animates,
    // setting changes take effect immediately). Only destroy() cancels it.
  }

  destroy(): void {
    this.destroyed = true;
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
    this.stopReason = null;
    this.stepFrame();
  }

  /** Run up to maxFrames, stopping early on a breakpoint/watchpoint hit. */
  runUntil(maxFrames: number): number {
    this.breakpointHit = -1;
    this.portWatchHit = null;
    this.memWatchHit = null;
    this.stopReason = null;
    for (let i = 0; i < maxFrames; i++) {
      this.stepFrame();
      if (this.breakpointHit >= 0 || this.portWatchHit !== null || this.memWatchHit !== null ||
          this.stopReason !== null) return i + 1;
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

  /** Wall-clock paced execution: catch up at {@link frameHz}, throttled by audio buffer
   *  at the high end (TARGET_BUFFER_FRAMES) and allowed to run ahead of
   *  wall-clock pacing at the low end (LOW_BUFFER_FRAMES) so small, steady
   *  sample-rate drift can't starve the audio worklet. */
  protected runPacedFrames(now: number): void {
    const multiplier = this.speedMultiplier ?? 1;
    if (multiplier <= 0) {
      this.lastFrameTime = now;
      this.frameTimeAccum = 0;
      return;
    }
    const nominalPeriod = 1000 / this.frameHz;
    const framePeriod = nominalPeriod / multiplier;
    this.frameTimeAccum = Math.min(
      this.frameTimeAccum + (now - this.lastFrameTime),
      Math.max(nominalPeriod * 3, framePeriod * 3),
    );
    this.lastFrameTime = now;

    const audioPacing = multiplier === 1
      && this.audio.ctx !== null && this.audio.ctx.state === 'running';
    const perFrame = samplesPerFrame(this.audio.sampleRate, this.frameHz);
    // The fallback consumes 4096 samples in one main-thread callback, unlike
    // the worklet's 128-sample quanta. Keep a full callback plus pacing slack
    // queued, and leave room for the final frame's overshoot in the ring.
    const blockSize = this.audio.outputBlockSize;
    const targetSamples = Math.min(
      this.audio.bufferCapacity - perFrame,
      Math.max(perFrame * TARGET_BUFFER_FRAMES, blockSize + perFrame * 2),
    );
    const lowWaterSamples = Math.min(targetSamples, Math.max(perFrame * LOW_BUFFER_FRAMES, blockSize));
    const maxFrames = Math.max(2, Math.ceil(multiplier * 2));

    let framesRun = 0;
    while (framesRun < maxFrames) {
      const bufferedSamples = audioPacing ? this.audio.bufferedSamples() : 0;
      if (audioPacing && bufferedSamples >= targetSamples) break;
      // Below the low-water mark, run a frame immediately even if wall-clock
      // time hasn't caught up yet — the buffer is at real risk of underrun
      // before the next naturally-paced frame would arrive (see
      // LOW_BUFFER_FRAMES). Otherwise, stick to normal wall-clock pacing.
      const catchingUp = audioPacing && bufferedSamples < lowWaterSamples;
      if (this.frameTimeAccum < framePeriod && !catchingUp) break;
      this.stepFrame();
      this.frameTimeAccum = Math.max(0, this.frameTimeAccum - framePeriod);
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
      this.stepFrame();
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
