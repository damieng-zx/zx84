/**
 * Cassette drive shared by the BBC Micro and the Acorn Electron: the pulse
 * `TapeDeck` that plays the mounted tape, the FSK demodulator that turns its
 * audio into a data line, and the recorder that collects what the machine
 * writes to the tape port.
 *
 * Both machines run the tape the same way. The user loads a tape and presses
 * play; the computer's motor relay (a bit in the serial ULA / the Electron's
 * misc-control register) then moves the tape, so the deck only runs while the
 * motor is on and the user has not paused it. The owning machine calls `step`
 * after every CPU instruction with the cycles it took and its running cycle
 * count; the data line and carrier flag are then read from `fsk`.
 */

import { TapeDeck, TAPE_REF_HZ, type TapeBlock } from '@/media/tape/tap.ts';
import { UefRecorder } from '@/media/tape/uef.ts';
import { CassetteFsk } from './cassette-fsk.ts';

/** Frames the tape-turbo stays engaged after the tape stops being consumed,
 *  riding out the gaps between blocks so acceleration doesn't stutter. */
const TURBO_COOLDOWN_FRAMES = 25;

export class CassetteDrive {
  readonly deck: TapeDeck;
  readonly fsk: CassetteFsk;
  readonly recorder: UefRecorder;

  /** Mounted filename. */
  name = '';
  /** The user has paused the tape. */
  userPaused = false;
  /** Motor relay state, as last set by the machine. */
  private motorOn = false;
  private prevEar = 0;
  /** The demodulator has been fed since it was last reset. */
  private fskLive = false;
  private turboCooldown = 0;
  turboActive = false;

  /** @param cpuClock CPU cycles per second */
  constructor(readonly cpuClock: number) {
    this.deck = new TapeDeck(cpuClock);
    this.deck.pulseScale = cpuClock / TAPE_REF_HZ;
    this.fsk = new CassetteFsk(cpuClock);
    this.recorder = new UefRecorder(cpuClock);
  }

  get loaded(): boolean { return this.deck.blocks.length > 0; }
  get motor(): boolean { return this.motorOn; }

  /** True while the tape is actually moving. */
  get running(): boolean {
    return this.motorOn && this.deck.playing && !this.deck.paused;
  }

  /** Put a parsed tape in the drive at the start, play armed. */
  mount(blocks: TapeBlock[], name: string): void {
    this.deck.blocks = blocks;
    this.deck.position = 0;
    this.userPaused = false;
    this.name = name;
    this.deck.startPlayback();
    this.applyRun();
  }

  eject(): void {
    this.deck.stopPlayback();
    this.deck.blocks = [];
    this.deck.position = 0;
    this.userPaused = false;
    this.name = '';
    this.fsk.reset();
  }

  /** The machine switched the motor relay at CPU cycle `now`. */
  setMotor(on: boolean, now: number): void {
    if (on === this.motorOn) return;
    this.motorOn = on;
    this.recorder.motor(on, now);
    this.fsk.reset(now);
    this.applyRun();
  }

  /** Re-derive the deck's pause state from the motor relay and the user. */
  applyRun(): void {
    this.deck.paused = this.userPaused || !this.motorOn;
  }

  /** Power-on / reset: motor off, recorder and demodulator cleared. */
  reset(): void {
    this.motorOn = false;
    this.deck.earBit = 0;
    this.prevEar = 0;
    this.fsk.reset();
    this.recorder.reset();
    this.turboActive = false;
    this.turboCooldown = 0;
    this.applyRun();
  }

  /** Advance the tape by `elapsed` CPU cycles, ending at cycle `now`. */
  step(elapsed: number, now: number): void {
    if (!this.running) {
      // Tape stopped, paused or finished: the line goes quiet.
      if (this.fskLive) { this.fsk.reset(now); this.fskLive = false; }
      return;
    }
    this.fskLive = true;
    this.deck.advance(elapsed);
    const ear = this.deck.earBit;
    if (ear !== this.prevEar) {
      this.prevEar = ear;
      this.fsk.edge(now);
    }
    this.fsk.update(now);
  }

  /** Once per frame: decide whether the tape-turbo (run flat out while a tape
   *  is being read) is engaged. A user pause or eject always ends it. */
  frameTick(turboEnabled: boolean): void {
    if (turboEnabled && this.running) {
      this.turboActive = true;
      this.turboCooldown = TURBO_COOLDOWN_FRAMES;
    } else if (this.turboCooldown > 0 && this.loaded && !this.userPaused) {
      if (--this.turboCooldown === 0) this.turboActive = false;
    } else {
      this.turboActive = false;
      this.turboCooldown = 0;
    }
  }
}
