/**
 * The Commodore Datasette, shared by the C64, C128, VIC-20 and Plus/4: the
 * transport state machine around the pulse-level TapeDeck.
 *
 * What the deck needs from the machine's own board is narrow: the three
 * cassette lines as the CPU drives or reads them (motor, write, and where the
 * read line lands), the per-frame counters of the lines software polls while
 * a tape moves, where the sound the deck fed gets flushed, and the line for
 * the status bar when PLAY presses itself. Everything else — the motor
 * follow, the transport, auto-play, the turbo with its cooldown, the
 * loading-sound level, the SAVE recorder — lives here once.
 *
 * The board's hooks run per port write, per tape edge or per frame; `step`
 * itself (once per instruction) touches only the deck.
 */

import { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import { TapeDeck } from '@/media/tape/tap.ts';

/** Frames the turbo stays engaged after the last tape access. */
export const TAPE_TURBO_COOLDOWN = 25;
/** Sense-line reads in one frame before PLAY presses itself. */
export const AUTO_PLAY_POLLS = 100;
/** Interrupt-flag register reads in one frame while a loader reads the tape. */
export const TURBO_TAPE_READS = 10;

/** The machine's own board, as the Datasette sees it. */
export interface CbmDatasetteBoard {
  /** The motor line, as the CPU last wrote it. */
  motor(): boolean;
  /** The cassette write line, as the CPU last wrote it. */
  cassetteWrite(): boolean;
  /** The deck's read line changed level: deliver it where this machine
   *  carries it — a CIA FLAG pulse on the C64 and C128, VIA 2 CA1 on the
   *  VIC-20, the 7501 port's bit 4 on the Plus/4 — and count the edge. */
  read(level: 0 | 1): void;
  /** Take this frame's count of reads of the PLAY sense line (the KERNAL's
   *  PRESS PLAY ON TAPE loop, or a loader's own). */
  takePolls(): number;
  /** Take this frame's count of interrupt-flag register reads (what a loader
   *  does while the deck moves). */
  takeFlagReads(): number;
  /** A transport change settled: sync the board's own view of the cassette
   *  lines (the C64's cassetteSense, the Plus/4's PLAY pin). */
  transportChanged(): void;
  /** The turbo dropped: flush the sound chip the deck fed, and reset the
   *  mixer's accumulator. */
  releaseTurbo(): void;
  /** PLAY pressed itself: one line for the status bar. */
  pressedPlay(): void;
}

export class CbmDatasette {
  readonly tape: TapeDeck;
  readonly recorder = new PulseRecorder();

  /** Fast tape loading while the KERNAL reads, on the tape-turbo setting. */
  tapeTurbo = true;
  /** The Datasette EAR line mixed as loading sound, on the tape-sound setting. */
  tapeSoundEnabled = true;

  private _turboActive = false;
  private cooldown = 0;
  private tapeLastT = 0;
  private prevEar: number = 0;
  private motorWasOn = false;
  private autoPlayArmed = false;
  private recordedAtFrame = 0;

  constructor(private readonly board: CbmDatasetteBoard, clockHz: number) {
    this.tape = new TapeDeck(clockHz);
  }

  get turboActive(): boolean { return this._turboActive; }

  /** A button is down on the deck. A mounted tape has PLAY down until the
   *  user stops it; an empty deck stands for a blank cassette with RECORD and
   *  PLAY down, so SAVE goes straight to the recorder (and LOAD searches, as
   *  it would on a blank tape). */
  get sense(): boolean { return !this.tape.loaded || this.tape.playing; }

  /** The EAR line as loading sound, only while the deck actually moves. */
  audioLevel(): number {
    return this.tapeSoundEnabled && this.tape.playing && !this.tape.paused ? this.tape.earBit : 0;
  }

  /** The tape was mounted, ejected, played or stopped: PLAY follows it, and
   *  the deck runs only while the motor is on. */
  transportChanged(now: number): void {
    this.motorWasOn = this.board.motor();
    this.tapeLastT = now;
    this.prevEar = this.tape.earBit;
    if (this.tape.loaded && this.tape.playing) this.tape.paused = !this.motorWasOn;
    this.board.transportChanged();
  }

  /** A port or PIO carrying the cassette lines was written at cycle `now`:
   *  follow the motor, and feed the recorder while the motor runs. */
  portsChanged(now: number): void {
    const motor = this.board.motor();
    if (motor !== this.motorWasOn) {
      this.motorWasOn = motor;
      if (this.tape.loaded && this.tape.playing) {
        if (motor) this.tapeLastT = now;
        this.tape.paused = !motor;
      }
    }
    if (motor) this.recorder.observe(this.board.cassetteWrite() ? 1 : 0, now);
  }

  /** Move the deck to `now` and hand its read line to the board. A no-op
   *  unless the deck is moving; runs once per instruction. */
  step(now: number): void {
    const tape = this.tape;
    if (!tape.playing || tape.paused) return;
    const gap = now - this.tapeLastT;
    this.tapeLastT = now;
    if (gap > 0) tape.advance(gap);
    const ear = tape.earBit as 0 | 1;
    if (ear !== this.prevEar) {
      this.prevEar = ear;
      this.board.read(ear);
    }
  }

  /** Mounting a tape leaves PLAY up; it goes down by itself the first time
   *  software sits waiting for it (PRESS PLAY ON TAPE). */
  armAutoPlay(): void { this.autoPlayArmed = true; }

  /** PLAY, pressed for a program polling the sense line. */
  checkAutoPlay(now: number): void {
    const polls = this.board.takePolls();
    if (!this.autoPlayArmed || !this.tape.loaded || this.tape.playing) return;
    if (polls < AUTO_PLAY_POLLS) return;
    this.autoPlayArmed = false;
    this.tape.startPlayback();
    this.transportChanged(now);
    this.board.pressedPlay();
  }

  /** Turbo while the KERNAL (or a loader) reads the tape with the motor on,
   *  or saves to the empty deck — but never while a disk is busy, whose
   *  transfer must not be accelerated into corruption. */
  updateTurbo(diskBusy: boolean): void {
    const flagReads = this.board.takeFlagReads();
    const reading = this.tape.playing && !this.tape.paused && flagReads >= TURBO_TAPE_READS;
    const writing = this.recorder.count !== this.recordedAtFrame;
    this.recordedAtFrame = this.recorder.count;
    const loading = (this.board.motor() && (reading || writing)) || diskBusy;
    if (loading) {
      this._turboActive = this.tapeTurbo;
      this.cooldown = TAPE_TURBO_COOLDOWN;
    } else if (this.cooldown > 0) {
      if (--this.cooldown === 0) this.releaseTurbo();
    } else if (this._turboActive) {
      this.releaseTurbo();
    }
  }

  private releaseTurbo(): void {
    if (!this._turboActive) return;
    this._turboActive = false;
    this.board.releaseTurbo();
  }

  /** The driver clock re-anchored at `now` (a seek, a debugger stop): the
   *  deck advances from here. */
  syncClock(now: number): void { this.tapeLastT = now; }

  /** A reset: an empty recorder, the motor line dropped, a mounted tape
   *  paused, the turbo off. */
  reset(now: number): void {
    this.recorder.reset();
    this.recordedAtFrame = 0;
    this.motorWasOn = false;
    if (this.tape.loaded) this.tape.paused = true;
    this._turboActive = false;
    this.cooldown = 0;
    this.tapeLastT = now;
  }

  /** A state was loaded: re-read the board and stand between frames, so the
   *  first step after the load advances the deck from here. */
  resync(now: number): void {
    this.motorWasOn = this.board.motor();
    this._turboActive = false;
    this.cooldown = 0;
    this.tapeLastT = now;
  }
}
