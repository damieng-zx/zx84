/**
 * NewBrainMachine — the Grundy NewBrain orchestrator.
 *
 * A Z80A at 4 MHz with 32K of RAM and 24K of ROM, a COP420 microcontroller
 * that does the keyboard, the vacuum-fluorescent display and the cassette
 * relays (its firmware runs for real, see `cop-board.ts`), and a discrete
 * video circuit that reads the picture out of main RAM (`newbrain-video.ts`).
 *
 * Interrupts are one open-collector IRQ line in interrupt mode 1: the 50 Hz
 * clock (gated by bit 0 of the enable register, active low), the COP asking
 * for service (G0), and the expansion bus (not modelled). The OS reads the
 * status register to find out which, and acknowledges the clock by touching
 * port 4. The NewBrain makes no sound.
 *
 * Cassette: the Z80 bit-bangs its tape format through the enable register and
 * reads it back through the status register, while the COP switches the
 * motors. Playback therefore runs only while a relay is on.
 */

import { Z80 } from '@/cores/z80.ts';
import { TapeDeck } from '@/media/tape/tap.ts';
import { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  Machine, MachineHost, MachineKind, MachineDescriptor, BorderMode, SettingsView, AuxRomRequest,
} from '@/machines/machine.ts';
import { newBrainDescriptor } from './descriptor.ts';
import { createNewBrainServices, type NewBrainServices } from './services/index.ts';
import type { NewBrainModel } from './models.ts';
import { NewBrainMemory } from './newbrain-memory.ts';
import { NewBrainCopBoard } from './cop-board.ts';
import { NewBrainKeyboard } from './keyboard.ts';
import { installNewBrainMemoryHooks, wireNewBrainPortIO } from './newbrain-io.ts';
import { renderNewBrainFrame, newBrainScreenRows, newBrainScreenCells } from './newbrain-video.ts';
import type { OcrGridName, OcrResult } from '@/ocr/ocr.ts';
import { newBrainOcrResult } from '@/ocr/newbrain.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { crc32, type StateReader, type StateWriter } from '@/machines/shared/state-io.ts';
import { z80ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { Z80Trace } from '@/debug/z80/trace.ts';
import {
  NB_CPU_CLOCK, NB_T_PER_FRAME, NB_LINES_PER_FRAME, NB_T_PER_LINE, NB_ACTIVE_LINES,
  NB_SCREEN_WIDTH, NB_SCREEN_HEIGHT, NB_POWERUP_T, NB_T_PER_COP_CYCLE, NB_PAPER, NB_INK,
} from './constants.ts';

/** The make-believe sound chip the frame loop sizes its buffers against. */
class NoSound {
  setSampleRate(_rate: number): void {}
}

export class NewBrainMachine extends BaseMachine implements Machine {
  protected readonly audioChip = new NoSound();
  readonly kind: MachineKind = 'newbrain';
  readonly model: NewBrainModel;
  host: MachineHost | null = null;
  readonly services: NewBrainServices;

  readonly cpu: Z80;
  readonly memory = new NewBrainMemory();
  /** The COP420 and the board around it. */
  board: NewBrainCopBoard;
  /** Host keys onto the matrix the COP scans. */
  readonly keyboard = new NewBrainKeyboard(() => this.board.keys);
  /** Cassette playback deck; the Z80's tape input reads its EAR bit. */
  readonly tape: TapeDeck;
  /** Times the COP's tape-out line so a SAVE can be recovered as a recording. */
  readonly tapeRecorder = new PulseRecorder();
  readonly mixer = new AudioMixer(NB_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  // ── Registers of the board ───────────────────────────────────────────────
  /** Enable register (port 7). */
  enrg = 0;
  /** Video start address, A6-A14 (ports 8-11). */
  tvl = 0;
  /** Video control register (ports 12-15). */
  tvctl = 0;
  /** The 50 Hz clock interrupt is waiting to be acknowledged (port 4). */
  clkPending = false;

  /** Z80 T-states the COP has not yet been run for. */
  private copDebt = 0;
  private powerUpAt = NB_POWERUP_T;
  /** Video registers as they stood when the picture started. */
  private frameTvl = 0;
  private frameTvctl = 0;

  /** T-state of the last deck advance, for sub-instruction tape catch-up. */
  tapeLastAdvanceT = 0;
  /** The user has the deck paused (the motor relays cannot override that). */
  tapeUserPaused = false;

  readonly activity = { kbdScans: 0, copWrites: 0, tapeReads: 0, tapeWrites: 0 };

  private readonly _pixels = new Uint8Array(NB_SCREEN_WIDTH * NB_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  get tStatesPerFrame(): number { return NB_T_PER_FRAME; }

  constructor(model: NewBrainModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.cpu = new Z80();
    this.cpu.onInterrupt = (handler, nmi) => this.noteInterrupt(handler, nmi);
    this.board = new NewBrainCopBoard(new Uint8Array(1024));
    this.tape = new TapeDeck(NB_CPU_CLOCK);
    this.mixer.beeperGain = 0;
    this.display = display ?? null;

    installNewBrainMemoryHooks(this);
    wireNewBrainPortIO(this);

    this.services = createNewBrainServices(this, () => this.host);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  get descriptor(): MachineDescriptor { return newBrainDescriptor(this.model); }
  get frameWidth(): number { return NB_SCREEN_WIDTH; }
  get frameHeight(): number { return NB_SCREEN_HEIGHT; }
  get cpuClockHz(): number { return NB_CPU_CLOCK; }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: 'newbrain-ram.bin' };
  }

  applySettings(_view: SettingsView): void {
    this.audio.setVolume(0);
  }

  prepare(_view: SettingsView): AuxRomRequest[] { return []; }

  // ── Machine: lifecycle ───────────────────────────────────────────────

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    // The COP420's firmware is mask ROM on the chip itself: rebuild the chip
    // around whatever image arrived.
    this.board = new NewBrainCopBoard(this.memory.getCopRom());
    this.board.onRelays = () => this.relaysChanged();
    this.board.onTape = level => {
      this.tapeRecorder.observe(level, this.cpu.tStates);
      this.activity.tapeWrites++;
    };
    this.setStatus('ROM loaded');
  }

  loadDisk(_image: unknown, _unit = 0): void {}

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    switch (value) {
      case 'rom0': return { data: this.memory.getRom(), baseAddr: 0xA000 };
      case 'cop': return { data: this.memory.getCopRom(), baseAddr: 0 };
      case 'chars': return { data: this.memory.getCharRom(), baseAddr: 0 };
      case 'ram': return { data: this.memory.ram, baseAddr: 0 };
      default: return null;
    }
  }

  setBorderSize(_mode: BorderMode): void {
    // The picture fills the whole frame; there is no border to crop.
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.memory.reset();
    this.board.reset();
    this.keyboard.reset();
    this.enrg = 0;
    this.tvl = 0;
    this.tvctl = 0;
    this.clkPending = false;
    this.copDebt = 0;
    this.powerUpAt = this.cpu.tStates + NB_POWERUP_T;
    this.frameTvl = 0;
    this.frameTvctl = 0;
    this.tapeLastAdvanceT = 0;
    this.board.tapeIn = 0;
    this.tapeRecorder.reset();
    this.audio.reset();
    this.mixer.reset();
    this.resetFrameCount();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  // ── Board registers ────────────────────────────────────────────────────

  /** Port 4: any access acknowledges the 50 Hz clock interrupt. */
  clearClockInterrupt(): void { this.clkPending = false; }

  /** Port 7: the enable register. */
  writeEnable(v: number): void {
    this.enrg = v;
    if (this.tape.loaded) this.relaysChanged();
  }

  /** Ports 8-11: a write to an even port sets A6 (and reloads A7-A14); an
   *  odd one loads A7-A14 and drops A6. */
  writeTvl(v: number, setA6: boolean): void {
    this.tvl = (v << 7) | (setA6 ? 0x40 : 0);
  }

  copWrite(v: number): void {
    this.activity.copWrites++;
    this.board.cop.hostWrite(v);
  }

  copRead(): number { return this.board.cop.hostRead(); }

  /** The status register, port A. The two interrupt bits read low while the
   *  interrupt is pending. Bit 0 is the tape input when the enable register
   *  selects it; bit 1 is the power-up flag on selection 0. */
  statusA(): number {
    const e = this.enrg;
    let v = 0x5C;
    if (((e >> 6) & 3) === 2) { if (this.board.tapeIn) v |= 1; this.activity.tapeReads++; } else v |= 1;
    const sel = (e >> 4) & 3;
    if (sel === 0 ? !this.memory.poweredUp : sel >= 2) v |= 2;
    if (!this.clkPending) v |= 0x20;
    if (!this.board.interrupt) v |= 0x80;
    return v;
  }

  /** The status register, port B: the serial lines (idle) and the tape input. */
  statusB(): number {
    this.activity.tapeReads++;
    return 0x5C | 0x03 | 0x80 | (this.board.tapeIn ? 0x20 : 0);
  }

  /** The IRQ line: the clock when its gate is open, or the COP. */
  private irqAsserted(): boolean {
    return (this.clkPending && (this.enrg & 1) === 0) || this.board.interrupt;
  }

  // ── Cassette ───────────────────────────────────────────────────────────

  /** The deck runs while a motor relay is on and the user has not paused it. */
  private relaysChanged(): void {
    if (!this.tape.loaded) return;
    const on = this.board.motor1 || this.board.motor2;
    this.advanceTapeTo();
    this.tape.paused = !on || this.tapeUserPaused;
    if (!this.tape.playing && on) this.tape.startPlayback();
  }

  advanceTapeTo(): void {
    if (!this.tape.playing || this.tape.paused) return;
    const delta = this.cpu.tStates - this.tapeLastAdvanceT;
    if (delta > 0) {
      this.tape.advance(delta);
      this.tapeLastAdvanceT = this.cpu.tStates;
    }
    this.board.tapeIn = this.tape.earBit;
  }

  // ── Beam ───────────────────────────────────────────────────────────────

  private fLine = 0;

  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: NB_T_PER_LINE,
      linesPerFrame: NB_LINES_PER_FRAME,
      displayStart: 0,
      note: 'line 0 is the first of the 250 picture lines; the picture is drawn whole at the end of line 249 from RAM as it stands then, so a screen write shows from the next frame; the 50 Hz clock interrupt is raised with the end of the picture',
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return z80ReturnAddress(this.cpu.sp, a => this.memory.readByte(a)); }

  /** Run the COP up to the Z80's current time. */
  private catchUpCop(dt: number): void {
    this.copDebt += dt;
    const cop = this.board.cop;
    while (this.copDebt >= NB_T_PER_COP_CYCLE) {
      this.copDebt -= cop.step() * NB_T_PER_COP_CYCLE;
    }
  }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    const resumed = this.openFrame(NB_T_PER_FRAME);
    if (!resumed) {
      this.activity.kbdScans = 0;
      this.activity.copWrites = 0;
      this.activity.tapeReads = 0;
      this.activity.tapeWrites = 0;
      this.keyboard.tick();
      this.fLine = 0;
      this.frameTvl = this.tvl;
      this.frameTvctl = this.tvctl;
    }
    this.portWatchHit = null;
    this.memWatchHit = null;
    this.tapeLastAdvanceT = this.cpu.tStates;

    let lastAudioT = this.cpu.tStates;
    let lastCopT = this.cpu.tStates;
    let broke = false;

    for (; this.fLine < NB_LINES_PER_FRAME; this.fLine++) {
      const line = this.fLine;
      const lineEnd = this.frameStartT + (line + 1) * NB_T_PER_LINE;

      while (this.cpu.tStates < lineEnd) {
        if (this.checkStops(this.cpu.pc)) { broke = true; break; }

        this.beforeInsn(this.cpu.pc);
        this.cpu.step();
        const stopped = this.afterInsn();

        const dt = this.cpu.tStates - lastCopT;
        lastCopT = this.cpu.tStates;
        this.catchUpCop(dt);

        if (this.irqAsserted() && this.cpu.iff1 && !this.cpu.eiDelay) this.cpu.interrupt();

        if (this.tape.playing && !this.tape.paused) this.advanceTapeTo();

        if (!skipAudio) {
          const elapsed = this.cpu.tStates - lastAudioT;
          if (elapsed > 0) {
            this.mixer.accumulate(0, elapsed);
            this.mixer.generateSamples(this.audio, null, false);
            lastAudioT = this.cpu.tStates;
          }
        }
        if (stopped) { broke = true; break; }
      }
      if (broke) {
        this.midFrame = true;
        this.needsDisplay = true;
        return;
      }

      if (!this.memory.poweredUp && this.cpu.tStates >= this.powerUpAt) this.memory.poweredUp = true;

      if (line === NB_ACTIVE_LINES - 1) {
        this.drawPicture();
        // The end of the picture raises the 50 Hz clock interrupt.
        this.clkPending = true;
      }
    }

    if (skipAudio) this.mixer.discardPending();
    this.needsDisplay = true;
  }

  /** Draw the whole picture from the video registers latched at its start. */
  private drawPicture(): void {
    if (!this.memory.poweredUp || (this.enrg & 4) === 0) {
      this._pixels32.fill(NB_PAPER);
      return;
    }
    renderNewBrainFrame(
      this._pixels32, this.memory.ram, this.frameTvl, this.frameTvctl, this.memory.getCharRom(),
    );
  }

  // ── Snapshot state ─────────────────────────────────────────────────────

  stateRomCrcs(): number[] { return [crc32(this.memory.getRom()), crc32(this.memory.getCopRom())]; }

  saveState(w: StateWriter, _withMedia: boolean): void {
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameStartT); w.f64(this.frameEndT); w.f64(this.frameNumber);
      w.u8(this.enrg); w.u16(this.tvl); w.u8(this.tvctl); w.bool(this.clkPending);
      w.f64(this.copDebt); w.f64(this.powerUpAt);
    });
    w.section('MEM ', () => this.memory.saveState(w));
    w.section('COP ', () => this.board.saveState(w));
  }

  loadState(r: StateReader): void {
    this.cpu.loadState(r.section('CPU '));
    {
      const s = r.section('MACH');
      this.frameStartT = s.f64(); this.frameEndT = s.f64(); this.frameNumber = s.f64();
      this.enrg = s.u8(); this.tvl = s.u16(); this.tvctl = s.u8(); this.clkPending = s.bool();
      this.copDebt = s.f64(); this.powerUpAt = s.f64();
    }
    this.memory.loadState(r.section('MEM '));
    this.board.loadState(r.section('COP '));
    this.midFrame = false;
    this.clearInterrupts();
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
  }

  // ── Debug helpers ──────────────────────────────────────────────────────

  protected override tracer = new Z80Trace(this);

  /** The text on screen, read straight from RAM. */
  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    const rows = newBrainScreenRows(this.memory.ram, this.tvl, this.tvctl);
    const cols = (this.tvctl & 0x40) ? 80 : 40;
    return `[${cols}x${rows.length}]\n${rows.join('\n')}`;
  }

  /** The text screen shaped for the TEXT overlay. */
  ocrScreenStyled(): OcrResult {
    return newBrainOcrResult(newBrainScreenCells(this.memory.ram, this.tvl, this.tvctl));
  }

  /** Blank the cells the overlay has taken over, so the glyphs underneath do
   *  not show through it. */
  blankTextCells(result: OcrResult): void {
    const fill = (this.tvctl & 1) ? NB_INK : NB_PAPER;      // reverse video swaps the ground
    for (let r = 0; r < result.rows; r++) {
      for (let c = 0; c < result.cols; c++) {
        if (!result.mask[r * result.cols + c]) continue;
        for (let y = 0; y < result.cellHeight; y++) {
          const from = (r * result.cellHeight + y) * NB_SCREEN_WIDTH + c * result.cellWidth;
          if (from + result.cellWidth > this._pixels32.length) break;
          this._pixels32.fill(fill, from, from + result.cellWidth);
        }
      }
    }
    this.display?.updateTexture(this._pixels);
  }
}
