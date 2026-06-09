/**
 * Edge-loading and loader detection.
 *
 * Three cooperating pieces, per docs/edge-loading.md:
 *
 *  1. Auto play/stop heuristic (§2) — sniffs the cadence of IN A,(0xFE)
 *     reads to decide when to start/stop the tape automatically.
 *  2. Structural loader fingerprint (§3) — walks bytes forward from PC-6
 *     and matches a small state machine, anchored by the loop's final JR
 *     operand or JP target so false-positives are essentially impossible.
 *  3. Edge acceleration (§4) with a two-slot length pipeline (§5) — when
 *     the next tape edge's length category is known, skips the loader's
 *     busy poll: simulates its RET, sets B/C/F to plausible exit values,
 *     and advances the tape to the next edge in one step.
 *
 * The detector is purely structural — it never executes code, never traps,
 * never patches ROM. The accelerator is a state shortcut that pops the
 * loader's CALL return address into PC, so it works for any caller that
 * entered the loop via CALL (which all the recognised loaders do).
 */

import type { Z80 } from '@/cores/z80.ts';
import type { TapeDeck } from '@/tape/tap.ts';

// ── Settings ──────────────────────────────────────────────────────────────

/** §2 auto play/stop thresholds. Exact values from the reference spec. */
const START_GAP_T = 500;          // gap ≤ this counts as a start-loop iteration
const STOP_GAP_T  = 1000;         // gap > this is "loader has moved on"
const START_THRESHOLD = 10;       // consecutive in-shape reads to auto-start
const STOP_THRESHOLD  = 2;        // consecutive out-of-shape reads to auto-stop

/** Per-signature auto-stop gap override. Loaders that do heavy per-byte
 *  computation between IN reads (checksums, decryption) need a wider gap
 *  tolerance to avoid false-positive auto-stop mid-block. */
function getStopGapT(sig: LoaderSignature): number {
  switch (sig) {
    case 'speedlock':           return 2000;
    case 'alkatraz':            return 1500;
    case 'alkatraz-variant':    return 1500;
    case 'dinaload':            return 1500;
    default:                    return STOP_GAP_T;
  }
}

/** Per-signature auto-stop threshold: how many consecutive out-of-shape reads
 *  before we decide the loader has genuinely stopped polling. */
function getStopThreshold(sig: LoaderSignature): number {
  switch (sig) {
    case 'speedlock':           return 4;
    case 'alkatraz':            return 3;
    case 'alkatraz-variant':    return 3;
    default:                    return STOP_THRESHOLD;
  }
}

const NO_PREV = -1_000_000;       // sentinel: lastTStatesRead "minus infinity"

// ── Length pipeline ───────────────────────────────────────────────────────

export type EdgeLengthFlags = 'short' | 'long' | 'unknown';

// ── Detector result ───────────────────────────────────────────────────────

export type AccelMode = 'none' | 'increasing' | 'decreasing';

/** Public signature tag — surfaced to UI/tests. 'none' inside the detector
 *  maps to 'unknown' here. */
export type LoaderSignature =
  | 'unknown'
  | 'rom'             // pattern A with LD A,$7F
  | 'search'          // pattern A with LD A,$00, or pattern B
  | 'dinaload'        // pattern A with LD A,$FF
  | 'speedlock'       // pattern A with XOR C variant
  | 'bleepload'       // pattern A with NOP variant
  | 'microsphere'     // pattern A with AND A variant
  | 'paul-owens'      // pattern A with RET Z variant
  | 'rom-variant'     // pattern A with RET NC variant (not standard ROM)
  | 'digital-integration'  // pattern C (DECREASING)
  | 'alkatraz'        // pattern D
  | 'alkatraz-variant';  // pattern E

/** Human-readable label for a signature — used in the status bar message
 *  when a loader is first detected ("Running accelerated tape loading for X"). */
export function loaderSignatureLabel(sig: LoaderSignature): string {
  switch (sig) {
    case 'rom':                 return 'ROM loader';
    case 'rom-variant':         return 'ROM-variant loader';
    case 'search':              return 'Search Loader';
    case 'dinaload':            return 'Dinaload';
    case 'speedlock':           return 'Speedlock';
    case 'bleepload':           return 'Bleepload';
    case 'microsphere':         return 'Microsphere';
    case 'paul-owens':          return 'Paul Owens';
    case 'digital-integration': return 'Digital Integration';
    case 'alkatraz':            return 'Alkatraz';
    case 'alkatraz-variant':    return 'Alkatraz (variant)';
    case 'unknown':             return 'unknown loader';
  }
}

// ── Bridge to host machine ────────────────────────────────────────────────

export interface EdgeLoaderHost {
  cpu: Z80;
  tape: TapeDeck;
  /** Read through the live Z80 memory map (paging-aware). */
  readMem(addr: number): number;
  /** Current EAR input (0 or 1) at the tape's mic — used to set C bit 5. */
  earBit(): number;
}

/**
 * Whether the §4 acceleration trick (set B to 0x00/0xFE, set CF, pop PC) is
 * safe for this loader. Safe loaders treat B as a binary signal — they
 * check `RET Z` or `JR Z` directly on overflow and don't compare B against
 * a calibrated threshold. Unsafe loaders (Speedlock-class) use `CP B`
 * against a runtime-tuned value with shadow-register state, where any
 * synthesised B value yields wrong bits.
 *
 * Unsafe signatures still benefit from auto play/stop and the structural
 * fingerprint (which engages the tape-turbo frame multiplier); only the
 * surgical edge-skip is suppressed.
 */
function isAccelSafeSignature(sig: LoaderSignature): boolean {
  switch (sig) {
    case 'rom':
    case 'rom-variant':
    case 'search':
    case 'dinaload':
    case 'bleepload':
    case 'microsphere':
    case 'paul-owens':
    case 'digital-integration':
      return true;
    // Speedlock and Alkatraz calibrate B against a runtime threshold —
    // pre-loading B with 0x00/0xFE produces wrong bit classifications.
    case 'speedlock':
    case 'alkatraz':
    case 'alkatraz-variant':
    case 'unknown':
      return false;
  }
}

// ── Detector ──────────────────────────────────────────────────────────────

interface DetectResult { mode: Exclude<AccelMode, 'none'>; signature: LoaderSignature; }

/**
 * Walk bytes forward from `pc - 6` and recognise one of the canonical
 * edge-loop bodies in docs/edge-loading.md §3.1. Returns null on no match.
 *
 * The function is the most fiddly part of the system. Anchors:
 *   - Pattern A/B: final JR Z operand equals 0x100 - matched_window_length
 *     (a backward jump to the start of the window).
 *   - Pattern C: the JP Z absolute target equals PC-4 (offset 2, the RET Z
 *     at the head of the decreasing-B loop body).
 *   - Pattern D/E: final data byte is 0xF1 or 0xF3.
 *
 * `read` is the live Z80 memory reader (so ROM paging is respected, per §3.2).
 */
function detect(read: (addr: number) => number, pc: number): DetectResult | null {
  const b = (off: number): number => read((pc - 6 + off) & 0xFFFF) & 0xFF;

  // Pattern E (variant Alkatraz): 04 20 01 C9, then Alkatraz tail starting
  // at offset 4. We test this before pattern A because both start with 04.
  if (b(0) === 0x04 && b(1) === 0x20 && b(2) === 0x01 && b(3) === 0xC9) {
    if (b(4) === 0xDB && b(5) === 0xFE && b(6) === 0x1F && b(7) === 0xC8
        && b(8) === 0xA9 && b(9) === 0xE6 && b(10) === 0x20 && b(11) === 0x28
        && (b(13) === 0xF1 || b(13) === 0xF3)) {
      return { mode: 'increasing', signature: 'alkatraz-variant' };
    }
  }

  // Pattern A (classic ROM-style INCREASING):
  //   04 C8 3E xx DB FE 1F <variant> [A9] E6 20 28 <op>
  // Variant byte determines which loader, and whether second XOR C is skipped.
  if (b(0) === 0x04 && b(1) === 0xC8 && b(2) === 0x3E
      && b(4) === 0xDB && b(5) === 0xFE && b(6) === 0x1F) {
    const aImm = b(3);
    const variant = b(7);
    const speedlockFold = variant === 0xA9;   // XOR C as variant folds the canonical XOR C
    const andOff = speedlockFold ? 8 : 9;
    const jrOff  = speedlockFold ? 10 : 11;
    const opOff  = jrOff + 1;
    const windowLen = opOff + 1;              // window starts at offset 0
    const expectedOp = (0x100 - windowLen) & 0xFF;

    const variantOK = speedlockFold
      ? true
      : (variant === 0x00 || variant === 0xA7 || variant === 0xC8 || variant === 0xD0);

    if (variantOK
        && (speedlockFold || b(8) === 0xA9)   // XOR C
        && b(andOff) === 0xE6 && b(andOff + 1) === 0x20
        && b(jrOff) === 0x28 && b(opOff) === expectedOp) {
      let sig: LoaderSignature;
      if (speedlockFold) sig = 'speedlock';
      else if (variant === 0x00) sig = 'bleepload';
      else if (variant === 0xA7) sig = 'microsphere';
      else if (variant === 0xC8) sig = 'paul-owens';
      else /* 0xD0 */ {
        if (aImm === 0x7F) sig = 'rom';
        else if (aImm === 0x00) sig = 'search';
        else if (aImm === 0xFF) sig = 'dinaload';
        else sig = 'rom-variant';
      }
      // For the canonical ROM loader the variant is RET NC and aImm=$7F.
      // Other aImm values keep the same INCREASING classification but tag
      // a less specific name so the UI can tell loaders apart.
      return { mode: 'increasing', signature: sig };
    }
  }

  // Pattern B (Search Loader INCREASING):
  //   04 C8 3E 00 DB FE A9 E6 40 [variants below]
  if (b(0) === 0x04 && b(1) === 0xC8 && b(2) === 0x3E && b(3) === 0x00
      && b(4) === 0xDB && b(5) === 0xFE && b(6) === 0xA9
      && b(7) === 0xE6 && b(8) === 0x40) {
    // Short tail:  28 <op>             window = 11, op = 0xF5
    if (b(9) === 0x28 && b(10) === ((0x100 - 11) & 0xFF)) {
      return { mode: 'increasing', signature: 'search' };
    }
    // Long tail:   D8 00 28 <op>       window = 13, op = 0xF3
    if (b(9) === 0xD8 && b(10) === 0x00 && b(11) === 0x28
        && b(12) === ((0x100 - 13) & 0xFF)) {
      return { mode: 'increasing', signature: 'search' };
    }
  }

  // Pattern C (Digital Integration DECREASING):
  //   <wild> 05 C8 DB FE A9 E6 40 CA lo hi
  //   Anchor: lo|hi<<8 == PC - 4 (offset 2 = the C8 RET Z = loop head).
  if (b(1) === 0x05 && b(2) === 0xC8 && b(3) === 0xDB && b(4) === 0xFE
      && b(5) === 0xA9 && b(6) === 0xE6 && b(7) === 0x40 && b(8) === 0xCA) {
    const target = b(9) | (b(10) << 8);
    if (target === ((pc - 4) & 0xFFFF)) {
      return { mode: 'decreasing', signature: 'digital-integration' };
    }
  }

  // Pattern D (Alkatraz INCREASING):
  //   03 C3 lo hi DB FE 1F C8 A9 E6 20 28 xx <F1|F3>
  if (b(0) === 0x03 && b(1) === 0xC3
      && b(4) === 0xDB && b(5) === 0xFE && b(6) === 0x1F && b(7) === 0xC8
      && b(8) === 0xA9 && b(9) === 0xE6 && b(10) === 0x20 && b(11) === 0x28
      && (b(13) === 0xF1 || b(13) === 0xF3)) {
    return { mode: 'increasing', signature: 'alkatraz' };
  }

  return null;
}

// ── EdgeLoader ────────────────────────────────────────────────────────────

export class EdgeLoader {
  /** Settings (§6) — both opt-in, default on. */
  detectLoader = true;
  accelerateLoader = true;

  // ── Auto play/stop state (§2) ────────────────────────────────────────
  private lastTStatesRead = NO_PREV;
  private lastBRead = 0;
  private successiveReads = 0;

  // ── Acceleration state (§3) ──────────────────────────────────────────
  private accelMode: AccelMode = 'none';
  private accelPC = 0;

  // ── Two-slot length pipeline (§5) ────────────────────────────────────
  private lengthKnown1 = false;
  private lengthLong1 = false;
  private lengthKnown2 = false;
  private lengthLong2 = false;

  // ── Host-visible surface (compat with existing UI / tests) ───────────

  /** True between 'start' and 'stop' events — used by spectrum.ts to keep
   *  tape turbo engaged for the full duration of the load. */
  loaderActive = false;

  /** User override: when true, auto-start is suppressed so post-load games
   *  whose keyboard polling looks like a loader can't yank the tape back on.
   *  Cleared by reset() and by the user manually pressing play. */
  userOverride = false;

  /** Most recently fingerprinted loader. 'unknown' until §3 matches. */
  signature: LoaderSignature = 'unknown';

  // ── §2: auto play/stop heuristic ─────────────────────────────────────

  /**
   * Called on every IN A,(0xFE). Returns 'start' / 'stop' to ask the caller
   * to change tape playback state, or null. Runs §2 first, then (if the
   * tape is playing and accelerateLoader is on) §3/§4.
   */
  onULARead(host: EdgeLoaderHost, playing: boolean): 'start' | 'stop' | null {
    const t = host.cpu.tStates;
    const b = host.cpu.b;

    if (this.lastTStatesRead === NO_PREV) {
      this.lastTStatesRead = t;
      this.lastBRead = b;
      return null;
    }

    const tDiff = t - this.lastTStatesRead;
    const bDiff = (b - this.lastBRead) & 0xFF;
    this.lastTStatesRead = t;
    this.lastBRead = b;

    let event: 'start' | 'stop' | null = null;

    if (!this.detectLoader) {
      // Detector disabled — never auto-anything, just slide the counters.
      this.successiveReads = 0;
    } else if (playing) {
      // Watching for the loader to have finished polling. We require BOTH
      // a wide T-state gap AND an unexpected B-delta — either alone produces
      // false positives during normal ROM data sampling. The 48K ROM's
      // LD-MARKER reloads `B,$B0` between every bit, so the first IN of
      // each new bit shows a bDiff way outside {0,1,0xFF}; with the old
      // `OR` test, two close bit boundaries would stop the tape mid-block.
      // Real "loader has moved on" code hits both criteria together
      // (game code runs >1000T between port reads AND mutates B freely).
      const stopGap = getStopGapT(this.signature);
      const outOfShape = tDiff > stopGap
        && (bDiff !== 0 && bDiff !== 1 && bDiff !== 0xFF);
      if (outOfShape) {
        if (++this.successiveReads >= getStopThreshold(this.signature)) {
          this.successiveReads = 0;
          this.loaderActive = false;
          this.accelMode = 'none';
          event = 'stop';
        }
      } else {
        this.successiveReads = 0;
        // Tape may have been started by some other path (instant-ROM trap,
        // user pressing Play) without §2 ever firing a 'start' event —
        // loaderActive would still be false, so the per-frame turbo logic
        // in spectrum.ts wouldn't engage tape turbo even though a loader
        // is plainly polling. Mark the loader active on any in-shape read
        // while playing so turbo engages for these paths too.
        if (tDiff <= START_GAP_T && (bDiff === 1 || bDiff === 0xFF)) {
          this.loaderActive = true;
        }
      }
    } else {
      // Watching for the loader to have started polling.
      if (this.userOverride) {
        this.successiveReads = 0;
      } else {
        const inShape = tDiff <= START_GAP_T && (bDiff === 1 || bDiff === 0xFF);
        if (inShape) {
          if (++this.successiveReads >= START_THRESHOLD) {
            this.successiveReads = 0;
            this.loaderActive = true;
            event = 'start';
          }
        } else {
          this.successiveReads = 0;
        }
      }
    }

    // §3/§4: fingerprint + accelerate. Only when accel is on and tape is
    // actually playing — including the just-fired 'start' case (the caller
    // will set the tape playing immediately on that event).
    if (this.accelerateLoader && (playing || event === 'start')) {
      this.maybeAccelerate(host);
    }

    return event;
  }

  // ── §3 + §4: fingerprint and accelerate ──────────────────────────────

  private maybeAccelerate(host: EdgeLoaderHost): void {
    const pc = host.cpu.pc;

    // PC changed since last accel → loader changed; force re-detect.
    if (this.accelMode !== 'none' && pc !== this.accelPC) {
      this.accelMode = 'none';
    }

    if (this.accelMode === 'none') {
      const result = detect(host.readMem, pc);
      if (result) {
        this.accelMode = result.mode;
        this.signature = result.signature;
        this.accelPC = pc;
      }
    }

    if (this.accelMode !== 'none') {
      this.accelerate(host);
    }
  }

  /**
   * The acceleration step (§4): if next-edge length is known, set B/C/F
   * to plausible exit values, pop the loader's CALL return into PC, and
   * advance the tape to the next edge boundary. Always rotates the length
   * pipeline at the end so slot 2 (the just-scheduled edge) promotes into
   * slot 1 (the edge we're now inside).
   */
  private accelerate(host: EdgeLoaderHost): void {
    if (!this.lengthKnown1) {
      this.rotateLengthPipeline();
      return;
    }

    const cpu = host.cpu;
    const tape = host.tape;

    // Speedlock-class loaders (and any with `safeAccel = false` in the
    // signature table) use B as a calibrated raw-count measurement with
    // runtime-tuned thresholds and shadow-register state. Synthesising any
    // B value — extreme (0x00/0xFE per spec §4.1) or computed from the
    // pulse length — breaks their calibration. For those, just rotate the
    // pipeline (so the tape advances naturally) and don't touch CPU state.
    // Tape turbo still gives a meaningful speed-up via the frame multiplier.
    if (!isAccelSafeSignature(this.signature)) {
      this.rotateLengthPipeline();
      return;
    }

    // §4.1: force B to the value the loader will treat as a finished edge.
    let setBHigh = this.lengthLong1;
    if (this.accelMode === 'decreasing') setBHigh = !setBHigh;
    cpu.b = setBHigh ? 0xFE : 0x00;

    // §4.2: bit 5 of C carries the current EAR/MIC level in many loaders.
    const ear = host.earBit();
    cpu.c = (cpu.c & ~0x20) | (ear ? 0x00 : 0x20);

    // §4.3: set CF so the conditional that exits the inner loop fires.
    cpu.f |= 0x01;

    // §4.4: pop the CALL return address. SP currently sits on it because
    // every recognised loader is entered via CALL. We read through the
    // live memory map so paging is respected.
    const lo = host.readMem(cpu.sp); cpu.sp = (cpu.sp + 1) & 0xFFFF;
    const hi = host.readMem(cpu.sp); cpu.sp = (cpu.sp + 1) & 0xFFFF;
    cpu.pc = lo | (hi << 8);

    // §4.5: advance tape to the next edge boundary in one step. The
    // inAcceleration flag tells the tape engine NOT to invalidate the
    // length pipeline's slot 1 — we just consumed it and slot 2's value
    // is about to promote in (via rotateLengthPipeline below).
    const dt = tape.tStatesToNextEdge();
    if (dt !== null) {
      const adv = dt > 0 ? dt : 1;
      cpu.tStates += adv;
      tape.inAcceleration = true;
      tape.advance(adv, true);
      tape.inAcceleration = false;
    }

    // We just rewrote cpu.b and pushed cpu.tStates forward by a whole
    // pulse (2168T for pilot — well past STOP_GAP_T=1000). If we leave
    // lastTStatesRead/lastBRead pointing at pre-accel values, the next
    // IN A,($FE) computes a huge tDiff and a synthetic bDiff outside
    // {0,1,0xFF}, which auto-stop reads as outOfShape and pauses the
    // tape — producing visible leader-bar flapping while a loader runs.
    this.lastTStatesRead = cpu.tStates;
    // B was just forced to 0xFE or 0x00 above. The loader will INC B (increasing)
    // or DEC B (decreasing) before its next IN, so predict the expected B-delta
    // for auto-stop. Using the raw synthetic B would produce a wild bDiff on the
    // next real IN and fire auto-stop after just 2 reads if the byte-processing
    // gap is >1000T.
    this.lastBRead = this.accelMode === 'decreasing'
      ? ((cpu.b - 1) & 0xFF)
      : ((cpu.b + 1) & 0xFF);
    this.successiveReads = 0;
    this.rotateLengthPipeline();
  }

  private rotateLengthPipeline(): void {
    this.lengthKnown1 = this.lengthKnown2;
    this.lengthLong1 = this.lengthLong2;
  }

  // ── §5: edge-length pipeline callback ────────────────────────────────

  /**
   * Called by the tape engine after it schedules the next edge. The flags
   * describe that newly-scheduled edge; we store them in slot 2.
   *
   * If the just-fired edge was a normal, scheduled one (fromAcceleration=false)
   * we invalidate slot 1 — otherwise the next IN would accelerate using a
   * length we've already consumed. §5 in docs/edge-loading.md.
   */
  setAccelerationFlags(flags: EdgeLengthFlags, fromAcceleration: boolean): void {
    if (flags === 'short') {
      this.lengthKnown2 = true; this.lengthLong2 = false;
    } else if (flags === 'long') {
      this.lengthKnown2 = true; this.lengthLong2 = true;
    } else {
      this.lengthKnown2 = false;
    }
    if (!fromAcceleration) this.lengthKnown1 = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Slide lastTStatesRead so the next frame's first read still computes
   *  a sensible gap. §1. */
  onFrameEnd(frameTstates: number): void {
    if (this.lastTStatesRead !== NO_PREV) {
      this.lastTStatesRead -= frameTstates;
    }
  }

  /** Called when the tape transitions between play and stop. §6. */
  onTapePlayStateChange(): void {
    this.successiveReads = 0;
    this.accelMode = 'none';
    this.lengthKnown1 = false;
    this.lengthLong1 = false;
    this.lengthKnown2 = false;
    this.lengthLong2 = false;
  }

  /** Full reset — machine reset, tape eject, etc. */
  reset(): void {
    this.lastTStatesRead = NO_PREV;
    this.lastBRead = 0;
    this.successiveReads = 0;
    this.accelMode = 'none';
    this.accelPC = 0;
    this.lengthKnown1 = false;
    this.lengthLong1 = false;
    this.lengthKnown2 = false;
    this.lengthLong2 = false;
    this.loaderActive = false;
    this.userOverride = false;
    this.signature = 'unknown';
  }
}
