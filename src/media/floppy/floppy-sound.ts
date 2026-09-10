/**
 * Synthesised floppy drive soundscape.
 *
 * Three profiles:
 *  - "3inch" : Amstrad/Hitachi CF2 — clunky, resonant, pronounced engage click
 *  - "3.5inch": Sony/Alps 720K — smoother, higher-pitched, quieter seeks
 *  - "5.25inch": half-height 40-track (Memotech FDX) — the loudest of the
 *    three: an audible belt-driven spin-up and a band step that lands as a
 *    low clack rather than a click
 *
 * Motor drone, step clicks, and seek-to-zero rattle — all generated
 * from Web Audio oscillators and noise bursts. Connects directly to
 * ctx.destination via its own GainNode (independent of emulated audio).
 */

import type { DskImage } from '@/media/floppy/disk-image.ts';

export type DriveType = '3inch' | '3.5inch' | '5.25inch';

/** Wire form of DriveType on FrameIndicators.floppyProfile — a machine's frame
 *  probe publishes a number, the bridge maps it back with driveTypeForProfile.
 *  KEEP means "leave the synth on whatever profile it already has". */
export const DRIVE_PROFILE = {
  keep: -1,
  threeInch: 0,
  threeAndAHalfInch: 1,
  fiveAndAQuarterInch: 2,
} as const;

const PROFILE_BY_CODE: Record<number, DriveType> = {
  [DRIVE_PROFILE.threeInch]: '3inch',
  [DRIVE_PROFILE.threeAndAHalfInch]: '3.5inch',
  [DRIVE_PROFILE.fiveAndAQuarterInch]: '5.25inch',
};

/** Map a published profile code to a DriveType, or null for "keep the current
 *  one" (-1, and any code this build does not know). */
export function driveTypeForProfile(code: number): DriveType | null {
  return PROFILE_BY_CODE[code] ?? null;
}

/**
 * What a drive path sounds like, as its machine declares it.
 *
 * Most machines only ever shipped one kind of drive and say so once with
 * `fixedDrive`; a few were routinely re-fitted and follow whatever disk is in
 * the drive being heard (`byCapacity`). A machine with more than one disk
 * interface declares one of these per interface, not per machine — the
 * Spectrum's +3 controller adapts while its +D/Beta path is always 3.5".
 *
 * Called once per frame from a probe's `sample()`, so it allocates nothing:
 * `fixedDrive` closes over its code when the probe's module is first loaded.
 */
export type DriveSound = (disk?: DskImage | null) => number;

const PROFILE_FOR_TYPE: Record<DriveType, number> = {
  '3inch': DRIVE_PROFILE.threeInch,
  '3.5inch': DRIVE_PROFILE.threeAndAHalfInch,
  '5.25inch': DRIVE_PROFILE.fiveAndAQuarterInch,
};

/** A machine whose drives are always the same units, whatever is in them. */
export function fixedDrive(type: DriveType): DriveSound {
  const code = PROFILE_FOR_TYPE[type];
  return () => code;
}

/** Pick 3" vs 3.5" from a mounted disk's capacity, for the machines that took
 *  either — the +3 and the CPC shipped a 3" CF2 but were routinely fitted with
 *  a 720K 3.5" B:. An empty drive keeps the synth's current profile. */
export const byCapacity: DriveSound = profileForDisk;

export function profileForDisk(disk: DskImage | null | undefined): number {
  if (!disk) return DRIVE_PROFILE.keep;
  const t0 = disk.tracks[0]?.[0];
  const spt = t0 ? t0.sectors.length : 0;
  const secSize = t0?.sectors[0] ? (128 << t0.sectors[0].n) : 512;
  const capacityKB = (disk.numSides * disk.numTracks * spt * secSize) / 1024;
  return capacityKB > 500 ? DRIVE_PROFILE.threeAndAHalfInch : DRIVE_PROFILE.threeInch;
}

interface DriveProfile {
  motorHumFreq: number;
  motorHumGain: number;
  motorNoiseFreq: number;
  motorNoiseQ: number;
  motorNoiseGain: number;
  motorRampUp: number;
  motorRampDown: number;
  engageHpStart: number;
  engageHpEnd: number;
  engageGain: number;
  engageLatchFreq: number;
  engageLatchQ: number;
  engageLatchGain: number;
  stepFreq: number;
  stepQ: number;
  stepGain: number;
  stepDur: number;
  seekInterval: number;
  seekToZeroInterval: number;
  /** Spin-up sweep: the hum starts here and rises to motorHumFreq over
   *  motorRampUp. Omitted on the direct-drive 3"/3.5" units, which reach
   *  speed too fast for the run-up to be heard. */
  motorHumSpinUpFreq?: number;
  /** Low body under each step, for a drive whose band stepper lands as a
   *  clack rather than a click. Omitted = noise burst alone, as before. */
  stepThumpFreq?: number;
  stepThumpGain?: number;
  stepThumpDur?: number;
}

const PROFILES: Record<DriveType, DriveProfile> = {
  '3inch': {
    // Amstrad/Hitachi CF2 — chunky, mechanical, resonant
    motorHumFreq: 120, motorHumGain: 0.06,
    motorNoiseFreq: 160, motorNoiseQ: 4, motorNoiseGain: 0.1,
    motorRampUp: 0.1, motorRampDown: 0.15,
    engageHpStart: 3000, engageHpEnd: 400, engageGain: 0.3,
    engageLatchFreq: 1800, engageLatchQ: 5, engageLatchGain: 0.45,
    stepFreq: 1200, stepQ: 2, stepGain: 1.0, stepDur: 0.03,
    seekInterval: 0.01, seekToZeroInterval: 0.008,
  },
  '3.5inch': {
    // Sony/Alps 720K — smoother, lighter, higher-pitched
    motorHumFreq: 180, motorHumGain: 0.03,
    motorNoiseFreq: 280, motorNoiseQ: 3, motorNoiseGain: 0.06,
    motorRampUp: 0.06, motorRampDown: 0.1,
    engageHpStart: 4000, engageHpEnd: 800, engageGain: 0.15,
    engageLatchFreq: 2800, engageLatchQ: 3, engageLatchGain: 0.25,
    stepFreq: 2200, stepQ: 3, stepGain: 0.5, stepDur: 0.015,
    seekInterval: 0.006, seekToZeroInterval: 0.005,
  },
  '5.25inch': {
    // Half-height 40-track (Canon/Chinon, as fitted to the Memotech FDX) —
    // a belt-driven spindle that takes a moment to reach 300rpm, and a band
    // stepper heavy enough to shake the case on every track.
    motorHumFreq: 72, motorHumGain: 0.09,
    motorNoiseFreq: 110, motorNoiseQ: 2.5, motorNoiseGain: 0.13,
    motorRampUp: 0.35, motorRampDown: 0.3,
    motorHumSpinUpFreq: 42,
    engageHpStart: 2200, engageHpEnd: 250, engageGain: 0.35,
    engageLatchFreq: 900, engageLatchQ: 4, engageLatchGain: 0.4,
    stepFreq: 700, stepQ: 1.6, stepGain: 0.9, stepDur: 0.045,
    seekInterval: 0.012, seekToZeroInterval: 0.01,
    stepThumpFreq: 90, stepThumpGain: 0.45, stepThumpDur: 0.06,
  },
};

export class FloppySound {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  // Motor sound nodes
  private motorOsc: OscillatorNode | null = null;
  private motorNoise: AudioBufferSourceNode | null = null;
  private motorGain: GainNode | null = null;
  private motorRunning = false;

  // Previous state for edge detection
  private prevMotor = false;
  private prevTrack = 0;

  /** Current drive sound profile */
  driveType: DriveType = '3inch';

  private get P(): DriveProfile { return PROFILES[this.driveType]; }

  /** Attach to an existing AudioContext (lazy — may not exist until first click). */
  attach(ctx: AudioContext): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.4;
    this.masterGain.connect(ctx.destination);
  }

  /** Polling entry point — call every frame with current FDC state. */
  update(motorOn: boolean, track: number): void {
    if (!this.ctx || !this.masterGain) return;

    // Motor transitions
    if (motorOn && !this.prevMotor) this.startMotor();
    if (!motorOn && this.prevMotor) this.stopMotor();

    // Track transitions (only while motor is on)
    if (motorOn && track !== this.prevTrack) {
      const delta = Math.abs(track - this.prevTrack);
      if (track === 0 && this.prevTrack > 1) {
        // Seek-to-zero rattle
        this.seekToZero(this.prevTrack);
      } else if (delta === 1) {
        this.stepClick();
      } else if (delta > 1) {
        this.scheduledClicks(delta);
      }
    }

    this.prevMotor = motorOn;
    this.prevTrack = track;
  }

  /** Reset previous state to avoid false triggers after machine reset. */
  reset(): void {
    this.stopMotor();
    this.prevMotor = false;
    this.prevTrack = 0;
  }

  destroy(): void {
    // Funnel through reset() so edge state is always cleared. Without this,
    // a destroy() followed by a fresh attach() would inherit stale
    // prevMotor/prevTrack and the first update() could skip the motor-on
    // edge or fire a spurious track delta.
    this.reset();
    this.masterGain?.disconnect();
    this.masterGain = null;
    this.ctx = null;
  }

  // ── Motor sound ──────────────────────────────────────────────────────

  private startMotor(): void {
    if (!this.ctx || !this.masterGain || this.motorRunning) return;
    this.motorRunning = true;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const P = this.P;

    // Gain envelope
    this.motorGain = ctx.createGain();
    this.motorGain.gain.setValueAtTime(0, now);
    this.motorGain.gain.linearRampToValueAtTime(1, now + P.motorRampUp);
    this.motorGain.connect(this.masterGain);

    // Mechanical engage click
    this.motorStartClick(now);

    // Subtle motor hum
    this.motorOsc = ctx.createOscillator();
    this.motorOsc.type = 'sine';
    this.motorOsc.frequency.value = P.motorHumFreq;
    // A belt-driven spindle is heard reaching speed; schedule the run-up over
    // the same window the gain envelope uses.
    if (P.motorHumSpinUpFreq !== undefined) {
      this.motorOsc.frequency.setValueAtTime(P.motorHumSpinUpFreq, now);
      this.motorOsc.frequency.exponentialRampToValueAtTime(P.motorHumFreq, now + P.motorRampUp);
    }
    const oscGain = ctx.createGain();
    oscGain.gain.value = P.motorHumGain;
    this.motorOsc.connect(oscGain);
    oscGain.connect(this.motorGain);
    this.motorOsc.start(now);

    // Gentle filtered noise (soft whirr)
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const noise = noiseBuf.getChannelData(0);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;

    this.motorNoise = ctx.createBufferSource();
    this.motorNoise.buffer = noiseBuf;
    this.motorNoise.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = P.motorNoiseFreq;
    bp.Q.value = P.motorNoiseQ;

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = P.motorNoiseGain;
    this.motorNoise.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(this.motorGain);
    this.motorNoise.start(now);
  }

  private stopMotor(): void {
    if (!this.ctx || !this.motorRunning) return;
    this.motorRunning = false;
    const now = this.ctx.currentTime;

    if (this.motorGain) {
      this.motorGain.gain.cancelScheduledValues(now);
      this.motorGain.gain.setValueAtTime(this.motorGain.gain.value, now);
      this.motorGain.gain.linearRampToValueAtTime(0, now + this.P.motorRampDown);
    }

    // Capture the nodes being shut down in the closure and null out the
    // instance fields immediately. If a new motor starts inside the 200ms
    // cleanup window, startMotor() builds a fresh graph and *this* cleanup
    // tears down only the old one — without the capture, the deferred
    // cleanup would read this.motorOsc at fire-time and stop the new motor.
    const osc = this.motorOsc;
    const noise = this.motorNoise;
    const gain = this.motorGain;
    this.motorOsc = null;
    this.motorNoise = null;
    this.motorGain = null;

    setTimeout(() => {
      osc?.stop();
      osc?.disconnect();
      noise?.stop();
      noise?.disconnect();
      gain?.disconnect();
    }, 200);
  }

  // ── Motor start click ─────────────────────────────────────────────

  private motorStartClick(now: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const P = this.P;
    const dur = 0.09;
    const samples = Math.ceil(ctx.sampleRate * dur);

    // Filtered noise sweep — mechanism engaging
    const noiseBuf = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(P.engageHpStart, now);
    hp.frequency.exponentialRampToValueAtTime(P.engageHpEnd, now + 0.06);

    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(P.engageGain, now);
    noiseEnv.gain.linearRampToValueAtTime(P.engageGain * 0.5, now + 0.04);
    noiseEnv.gain.exponentialRampToValueAtTime(0.01, now + dur);

    noiseSrc.connect(hp);
    hp.connect(noiseEnv);
    noiseEnv.connect(this.masterGain);
    noiseSrc.start(now);
    noiseSrc.stop(now + dur);

    // Sharp resonant click — latch catching
    const clickTime = now + 0.05;
    const clickBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.015), ctx.sampleRate);
    const clickData = clickBuf.getChannelData(0);
    for (let i = 0; i < clickData.length; i++) clickData[i] = Math.random() * 2 - 1;
    const clickSrc = ctx.createBufferSource();
    clickSrc.buffer = clickBuf;

    const clickBp = ctx.createBiquadFilter();
    clickBp.type = 'bandpass';
    clickBp.frequency.value = P.engageLatchFreq;
    clickBp.Q.value = P.engageLatchQ;

    const clickEnv = ctx.createGain();
    clickEnv.gain.setValueAtTime(P.engageLatchGain, clickTime);
    clickEnv.gain.exponentialRampToValueAtTime(0.01, clickTime + 0.015);

    clickSrc.connect(clickBp);
    clickBp.connect(clickEnv);
    clickEnv.connect(this.masterGain);
    clickSrc.start(clickTime);
    clickSrc.stop(clickTime + 0.015);
  }

  // ── Step click ───────────────────────────────────────────────────────

  private stepClick(when?: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const P = this.P;
    const t = when ?? ctx.currentTime;

    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * P.stepDur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = P.stepFreq;
    bp.Q.value = P.stepQ;

    const env = ctx.createGain();
    env.gain.setValueAtTime(P.stepGain, t);
    env.gain.exponentialRampToValueAtTime(0.01, t + P.stepDur);

    src.connect(bp);
    bp.connect(env);
    env.connect(this.masterGain);
    src.start(t);
    src.stop(t + P.stepDur);

    // Low body under the click — the mass of a band stepper hitting its stop.
    if (P.stepThumpFreq === undefined) return;
    const thumpDur = P.stepThumpDur ?? P.stepDur;
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(P.stepThumpFreq, t);
    thump.frequency.exponentialRampToValueAtTime(P.stepThumpFreq * 0.6, t + thumpDur);

    const thumpEnv = ctx.createGain();
    thumpEnv.gain.setValueAtTime(P.stepThumpGain ?? 0.4, t);
    thumpEnv.gain.exponentialRampToValueAtTime(0.01, t + thumpDur);

    thump.connect(thumpEnv);
    thumpEnv.connect(this.masterGain);
    thump.start(t);
    thump.stop(t + thumpDur);
  }

  // ── Bounded multi-step click scheduler ──────────────────────────────
  //
  // A real Spectrum +3 drive tops out at ~80 tracks. Any count above that is
  // either a future caller bug or corrupted FDC state — clamp so we never
  // queue thousands of buffer sources. seekToZero and scheduledClicks both
  // funnel through here so the clamp can't drift.

  private scheduleSteps(count: number, interval: number): void {
    if (!this.ctx) return;
    const clamped = Math.min(Math.max(count, 0), 80);
    const now = this.ctx.currentTime;
    for (let i = 0; i < clamped; i++) {
      this.stepClick(now + i * interval);
    }
  }

  private seekToZero(fromTrack: number): void {
    this.scheduleSteps(fromTrack, this.P.seekToZeroInterval);
  }

  private scheduledClicks(steps: number): void {
    this.scheduleSteps(steps, this.P.seekInterval);
  }
}
