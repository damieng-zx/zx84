/**
 * LynxMachine — the Camputers Lynx motherboard.
 *
 * A Z80 at 4MHz (6MHz on the 128K), a Motorola 6845 sequencing the raster over three one-bit
 * colour planes, a ten-line keyboard read through the address bus, a 6-bit
 * sound DAC on port 0x84 and, on the 96K/128K, an FD1793 floppy controller —
 * which is a WD1793, so the existing WD179x core covers it.
 *
 * Hardware behaviour follows MAME's `camputers/camplynx.cpp`, the only
 * detailed public description of this machine.
 *
 * Snapshots are zx84's own `.lynxstate` (`snapshots/lynx-state.ts`).
 */

import { Z80 } from '@/cores/z80.ts';
import { Crtc6845 } from '@/cores/crtc-6845.ts';
import { WD179x } from '@/cores/wd179x.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { resolveDriveCount } from '@/machines/shared/drive-count.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { crc32, type StateReader, type StateWriter } from '@/machines/shared/state-io.ts';
import { withStopsDisarmed } from '@/machines/shared/native-state.ts';
import { z80ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { Z80Trace } from '@/debug/z80/trace.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind,
  SettingsView,
} from '@/machines/machine.ts';
import {
  LYNX_BORDER_TOP, LYNX_MAX_DRIVES, LYNX_PAGE_SIZE, LYNX_PALETTE, lynxTStatesPerFrame,
} from './constants.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import {
  LYNX_CELL_HEIGHT, LYNX_CELL_WIDTH, LYNX_FONT_BYTES,
  LYNX_FONT_OFFSET_128, LYNX_FONT_OFFSET_48,
  LYNX_GEOMETRY_40, LYNX_GEOMETRY_80,
  lynxOcrResult, lynxScreenCells, lynxScreenText,
  type LynxOcrGeometry, type LynxPixelReader,
} from '@/ocr/lynx.ts';
import { lynxCpuClock, lynxHasDisk, type LynxModel } from './models.ts';
import { LynxMemory, DOS_ROM_OFFSET } from './lynx-memory.ts';
import { LynxKeyboard } from './lynx-keyboard.ts';
import { LynxVideo } from './lynx-video.ts';
import { wireLynxPortIO } from './lynx-io.ts';
import { lynxDescriptor } from './descriptor.ts';
import { createLynxServices, type LynxServices } from './services/index.ts';

/** Said when the character set is not where the stock ROM keeps it — a
 *  replaced system ROM. Better than transcribing a screenful of nonsense. */
const OCR_UNAVAILABLE =
  '[lynx] OCR unavailable: no character set at the usual address, so the '
  + 'screen cannot be transcribed.';

/** The Lynx's only audio is a DAC on the mixer's beeper channel, so there is
 *  no PSG to keep in step with the sample rate. */
const NO_PSG = { setSampleRate(_rate: number): void { /* no PSG fitted */ } };

/**
 * The sound DAC's output for each 6-bit code, 0..1.
 *
 * Camputers' 128K motherboard diagram (sheet 5, "Input/Output") latches D0-D5
 * of an OUT to port 0x84 into a 40174 hex flip-flop (IC25, cleared by /RESET)
 * whose outputs drive a binary-weighted resistor ladder into one node: D5
 * through 75K, D4 150K, D3 300K, D2 620K, D1 1.2M, D0 2.4M (R38-R40, R35-R37),
 * with 39K (R41) to 0V. D6 and D7 go nowhere. The node voltage is the sum of
 * the set bits' conductances over a fixed total, so each code's level is its
 * conductance over full scale's — linear but for D2's 620K, the nearest E24
 * value to 600K, which leaves that bit 3% light.
 */
const DAC_LEVELS: Float64Array = (() => {
  const ohms = [2_400_000, 1_200_000, 620_000, 300_000, 150_000, 75_000];   // D0..D5
  let full = 0;
  for (const r of ohms) full += 1 / r;
  const out = new Float64Array(64);
  for (let code = 0; code < 64; code++) {
    let g = 0;
    for (let bit = 0; bit < 6; bit++) if (code & (1 << bit)) g += 1 / ohms[bit];
    out[code] = g / full;
  }
  return out;
})();

/** Frames of quiet before tape turbo lets go, so the gap between two blocks
 *  does not drop the machine back to 1x and then straight up again. */
const TAPE_TURBO_COOLDOWN = 25;

export class LynxMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'lynx';
  readonly model: LynxModel;
  /** Z80 clock: 4MHz on the 48K/96K, 6MHz on the 128K. */
  readonly clock: number;
  private readonly tPerFrame: number;

  readonly services: LynxServices;

  readonly cpu = new Z80();
  readonly crtc = new Crtc6845(0);
  readonly memory: LynxMemory;
  readonly keyboard = new LynxKeyboard();
  readonly video: LynxVideo;
  /** FD1793 — a WD1793, so status bit 7 is NOT READY rather than MOTOR ON. */
  readonly fdc = new WD179x({ statusBit7: 'not-ready', formatSectorsPerTrack: 10 });
  /** The model carries a disk interface (the 96K and 128K). */
  readonly modelHasDisk: boolean;
  /** The interface is fitted: the model has one *and* the Hardware toggle is
   *  on. Drives the FDC ports, `.ldf` media, the DOS ROM and the Drive pane. */
  hasDisk: boolean;
  /** How many of the FD1793's drives are fitted (Drives pane choice). */
  driveCount = LYNX_MAX_DRIVES;

  /** The cassette deck. The Lynx has a real motor bit, so playback is gated on
   *  the motor rather than on read cadence the way the CPC's has to be. */
  readonly tape: TapeDeck;
  /** Edges of the cassette output since the last reset — what SAVE wrote. */
  readonly tapeRecorder = new PulseRecorder();

  readonly mixer: AudioMixer;
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  readonly activity = { kbdReads: 0, fdcAccesses: 0, casReads: 0 };

  /** Turbo while loading: run uncapped while the ROM is reading the cassette.
   *  The Lynx has a real motor relay, so the loading signal is the motor plus
   *  cassette-port reads rather than a read-cadence guess. */
  tapeTurbo = true;
  private _tapeTurboActive = false;
  private _tapeTurboCooldown = 0;

  /** True while tape turbo is engaged — the Tape pane's TURBO lamp. */
  get tapeTurboActive(): boolean { return this._tapeTurboActive; }

  /** The sound DAC's 6-bit latch: D0-D5 of port 0x84, written while the
   *  cassette motor is off (see DAC_LEVELS). */
  dacLevel = 0;
  /** Port 0x80 as last written. */
  private port80 = 0;
  /** CPU time the deck was last advanced to. */
  private tapeLastAdvanceT = 0;
  /** The motor relay, as port 0x80 last set it. */
  private tapeMotorRunning = false;

  private host: MachineHost | null = null;
  private readonly _pixels32: Uint32Array;
  private readonly _pixels: Uint8Array;

  constructor(model: LynxModel, display: IScreenRenderer | null = null) {
    super();
    this.model = model;
    this.clock = lynxCpuClock(model);
    this.tPerFrame = lynxTStatesPerFrame(this.clock);
    this.tape = new TapeDeck(this.clock);
    this.mixer = new AudioMixer(this.clock);
    this.modelHasDisk = lynxHasDisk(model);
    this.hasDisk = this.modelHasDisk;
    this.display = display;
    this.memory = new LynxMemory(model);
    this.video = new LynxVideo(this.memory, this.crtc);
    this._pixels32 = this.video.pixels;
    this._pixels = new Uint8Array(this._pixels32.buffer);

    this.tape.pulseScale = this.clock / TAPE_REF_HZ;
    this.cpu.onInterrupt = (handler, nmi) => this.noteInterrupt(handler, nmi);
    this.cpu.read8 = (addr: number): number => {
      const value = this.memory.readByte(addr);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xffff, value, 'read');
      return value;
    };
    this.cpu.write8 = (addr: number, v: number): void => {
      this.memory.writeByte(addr, v);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xffff, v & 0xff, 'write');
    };
    wireLynxPortIO(this);

    this.services = createLynxServices(this, () => this.host);
  }

  // ── Machine SPI ────────────────────────────────────────────────────────

  get descriptor(): MachineDescriptor { return lynxDescriptor(this.model); }
  get pixels(): Uint8Array { return this._pixels; }
  get frameWidth(): number { return this.video.geometry.width; }
  get frameHeight(): number { return this.video.geometry.height; }
  get tStatesPerFrame(): number { return this.tPerFrame; }
  get cpuClockHz(): number { return this.clock; }

  attachHost(host: MachineHost): void { this.host = host; }
  applySettings(view: SettingsView): void {
    this.tapeTurbo = view.get('tape-turbo-load', true);
    this.hasDisk = this.modelHasDisk && view.get('lynx-fdc', true);
    this.driveCount = resolveDriveCount(view, 'lynx', this.modelHasDisk ? LYNX_MAX_DRIVES : 2);
    for (let u = 0; u < this.fdc.connected.length; u++) this.fdc.connected[u] = u < this.driveCount;
  }
  setBorderSize(_mode: BorderMode): void { /* the Lynx border is not croppable */ }

  /**
   * Install the system ROM: the 8K images end to end, as romSources fetches
   * them. Two on the 48K; on the 96K and 128K three, then the DOS ROM, which
   * lives at the top of bank 0 rather than following the others.
   */
  loadROM(data: Uint8Array): void {
    const count = this.modelHasDisk ? 3 : 2;
    const images: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const at = i * LYNX_PAGE_SIZE;
      if (at + LYNX_PAGE_SIZE > data.length) break;
      images.push(data.subarray(at, at + LYNX_PAGE_SIZE));
    }
    const dosAt = count * LYNX_PAGE_SIZE;
    const dos = this.hasDisk && dosAt + LYNX_PAGE_SIZE <= data.length
      ? data.subarray(dosAt, dosAt + LYNX_PAGE_SIZE)
      : null;
    this.memory.loadRoms(images, dos);
  }

  reset(): void {
    this.cpu.reset();
    this.memory.reset();
    this.keyboard.reset();
    this.video.reset();
    this.crtc.reset();
    this.fdc.reset();
    this.port80 = 0;
    this.dacLevel = 0;
    this.tapeMotorRunning = false;
    this.tapeLastAdvanceT = 0;
    this.tapeRecorder.reset();
    this.tape.paused = true;
    this._tapeTurboActive = false;
    this._tapeTurboCooldown = 0;
    this.resetFrameCount();
  }

  // ── Port 0x80 and the cassette ─────────────────────────────────────────

  /** Port 0x80: bank decode, the alternate green plane, the cassette motor. */
  setPort80(value: number): void {
    this.port80 = value & 0xff;
    this.memory.setPort80(this.port80);
    this.video.altGreen = (this.port80 & 0x10) !== 0;
    this.setTapeMotor(this.tapeMotorOn);
  }

  /** The motor bit is bit 1 on the 48K/96K and bit 3 on the 128K. */
  get tapeMotorOn(): boolean {
    return (this.port80 & (this.memory.is128k ? 0x08 : 0x02)) !== 0;
  }

  /**
   * Tape input, sampled by the ROM's bit-timing loop.
   *
   * The deck is advanced here rather than once a frame because the ROM measures
   * the gap between edges: it has to see the level the tape is at *now*, at the
   * T-state of this read, not where the tape was at the last frame boundary.
   */
  cassetteInput(): boolean {
    if (!this.tape.playing || this.tape.paused) return false;
    const now = this.cpu.tStates;
    const gap = now - this.tapeLastAdvanceT;
    this.tapeLastAdvanceT = now;
    if (gap > 0) this.tape.advance(gap);
    return this.tape.earBit !== 0;
  }

  /** Tape output: the ROM's SAVE square wave on port 0x84 bit 5 while the
   *  motor runs. It is timed into the recorder (the Save menu decodes it back
   *  to a .tap) and kept off the DAC, or the speaker screams through every
   *  SAVE. */
  cassetteOutput(high: boolean): void {
    this.tapeRecorder.observe(high ? 1 : 0, this.cpu.tStates);
  }

  /**
   * The deck (re)started — rewind, play, a fresh mount. The advance clock is
   * re-based to now so the CPU time the deck spent stopped (which `cassetteInput`
   * does not accumulate) cannot fast-forward it on the next read. Without this a
   * rewind after the tape ran off the end jumps straight back to the end.
   */
  resetTapeAdvance(): void { this.tapeLastAdvanceT = this.cpu.tStates; }

  /** Start or stop the deck with the motor relay. */
  private setTapeMotor(on: boolean): void {
    if (on === this.tapeMotorRunning) return;
    this.tapeMotorRunning = on;
    if (!this.tape.loaded) return;
    if (on) {
      this.tapeLastAdvanceT = this.cpu.tStates;
      if (!this.tape.playing) this.tape.startPlayback();
      this.tape.paused = false;
    } else {
      this.tape.paused = true;
    }
  }

  // ── Snapshot state (.lynxstate) ────────────────────────────────────────

  /** CRC-32 of the ROM store (the system images and the DOS ROM, as loaded),
   *  for the snapshot header. */
  stateRomCrcs(): number[] { return [crc32(this.memory.rom)]; }

  /** Run the rest of a frame a stop left open, so the machine is between
   *  frames (where a snapshot is taken). */
  private completeFrame(): void {
    if (this.midFrame) withStopsDisarmed(this, () => this.stepFrame());
  }

  /**
   * Write the machine's sections of a `.lynxstate` (see
   * snapshots/lynx-state.ts): the disk-interface configuration first, so a
   * restore can refuse a mismatch before it changes anything, then the CPU,
   * the frame grid, the RAM and bank latches, the 6845 and port 0x80/DAC
   * latches, the drives (`withMedia`) and the FD1793. The cassette is not
   * part of the state.
   */
  saveState(w: StateWriter, withMedia: boolean): void {
    this.completeFrame();
    w.section('CONF', () => { w.bool(this.hasDisk); w.u8(this.driveCount); });
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameStartT); w.f64(this.frameEndT); w.f64(this.frameNumber);
    });
    w.section('MEM ', () => this.memory.saveState(w));
    w.section('VID ', () => this.crtc.saveState(w));
    w.section('PORT', () => {
      w.u8(this.port80); w.u8(this.dacLevel); w.bool(this.tapeMotorRunning);
    });
    w.section('MEDA', () => {
      w.bool(withMedia);
      if (withMedia) this.services.disks.saveState(w);
    });
    w.section('FDC ', () => this.fdc.saveState(w));
  }

  /** Restore a state written by {@link saveState}. The frame loop must be
   *  stopped. Throws before changing anything if the disk interface or the
   *  number of drives differs from this machine's. */
  loadState(r: StateReader): void {
    {
      const s = r.section('CONF');
      const hasDisk = s.bool();
      const drives = s.u8();
      if (hasDisk !== this.hasDisk) {
        throw new Error(`This snapshot was saved with the disk interface ${hasDisk ? 'fitted' : 'removed'}; ${hasDisk ? 'fit' : 'remove'} it in the Hardware pane and load it again`);
      }
      if (hasDisk && drives !== this.driveCount) {
        throw new Error(`This snapshot was saved with ${drives} drives and this Lynx has ${this.driveCount}; change it in the Drives pane and load it again`);
      }
    }
    this.cpu.loadState(r.section('CPU '));
    {
      const s = r.section('MACH');
      this.frameStartT = s.f64(); this.frameEndT = s.f64(); this.frameNumber = s.f64();
    }
    this.memory.loadState(r.section('MEM '));
    this.crtc.loadState(r.section('VID '));
    {
      const s = r.section('PORT');
      this.port80 = s.u8();
      this.dacLevel = s.u8() & 0x3f;
      this.tapeMotorRunning = s.bool();
      this.video.altGreen = (this.port80 & 0x10) !== 0;
    }
    {
      // The disks go in before the controller, so a transfer in flight finds
      // its track and sector in them.
      const s = r.section('MEDA');
      if (s.bool()) this.services.disks.loadState(s);
    }
    this.fdc.loadState(r.section('FDC '));
    this.afterStateLoad();
  }

  /** What no snapshot holds: the host's keys are whatever they are now, and
   *  nothing is part-way through a frame or a tape-turbo run. */
  private afterStateLoad(): void {
    this.midFrame = false;
    this.clearInterrupts();
    this.keyboard.reset();
    this._tapeTurboActive = false;
    this._tapeTurboCooldown = 0;
    this.tapeLastAdvanceT = this.cpu.tStates;
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
  }

  // ── Debug SPI ──────────────────────────────────────────────────────────

  /** Execution trace: BaseMachine's startTrace/stopTrace drive it and
   *  beforeInsn/afterInsn feed it (debug/z80/trace.ts). */
  protected override tracer = new Z80Trace(this);

  // ── Screen OCR ─────────────────────────────────────────────────────────
  //
  // The Lynx screen is a bitmap with no character grid behind it, so text is
  // recovered by cutting the picture into the ROM font's 6x10 cells and
  // matching each one. The font lives in the first ROM image, which sits at
  // the bottom of bank 0.

  /** The ROM's character set, as loaded. Bank 0 holds ROM image 0 at 0. */
  private get ocrFont(): Uint8Array {
    const at = this.memory.is128k ? LYNX_FONT_OFFSET_128 : LYNX_FONT_OFFSET_48;
    return this.memory.rom.subarray(at, at + LYNX_FONT_BYTES);
  }

  /** The text grid this model's display carries. */
  private get ocrGeometry(): LynxOcrGeometry {
    return this.memory.is128k ? LYNX_GEOMETRY_80 : LYNX_GEOMETRY_40;
  }

  /** Active-area pixel -> palette index, by matching the composited colour
   *  back to the palette. The renderer has already done the plane compositing,
   *  so OCR reads the same picture the user is looking at. */
  private get ocrReader(): LynxPixelReader {
    const geo = this.video.geometry;
    const px = this.video.pixels;
    const left = geo.borderLeft, top = LYNX_BORDER_TOP, width = geo.width;
    return (x: number, y: number): number => {
      const colour = px[(top + y) * width + left + x] >>> 0;
      for (let pen = 0; pen < 8; pen++) if (LYNX_PALETTE[pen] === colour) return pen;
      return 0;
    };
  }

  ocrScreenForMcp(): string {
    const text = lynxScreenText(this.ocrReader, this.ocrFont, this.ocrGeometry);
    if (text === null) return OCR_UNAVAILABLE;
    const geo = this.ocrGeometry;
    return `[${geo.grid}]
${text}`;
  }

  /** The same transcription, shaped for the TEXT overlay. */
  ocrScreenStyled(): OcrResult | null {
    const geo = this.ocrGeometry;
    const cells = lynxScreenCells(this.ocrReader, this.ocrFont, geo);
    if (!cells) return null;
    return lynxOcrResult(cells, LYNX_PALETTE, geo.grid);
  }

  /**
   * Where the text grid sits in the frame buffer, in buffer pixels.
   *
   * The Lynx's grid does not fill the active area — it is inset by a few
   * pixels and leaves a margin at the right and bottom — so the overlay has to
   * be told, or it stretches its rows across the whole picture and drifts out
   * of step with the text underneath.
   */
  ocrFieldBox(): { x: number; y: number; width: number; height: number } {
    const geo = this.ocrGeometry;
    return {
      x: this.video.geometry.borderLeft + geo.originX,
      y: LYNX_BORDER_TOP + geo.originY,
      width: geo.cols * LYNX_CELL_WIDTH,
      height: geo.rows * LYNX_CELL_HEIGHT,
    };
  }

  /** Blank the cells the overlay has taken over, so the text underneath does
   *  not show through it. Matched cells go to their own background colour. */
  blankTextCells(result: OcrResult): void {
    const geo = this.video.geometry;
    const px = this.video.pixels;
    const paper = result.paper;
    for (let row = 0; row < result.rows; row++) {
      for (let col = 0; col < result.cols; col++) {
        const idx = row * result.cols + col;
        if (!result.mask[idx]) continue;
        const colour = LYNX_PALETTE[(paper ? paper[idx] : 0) & 7];
        const x0 = geo.borderLeft + this.ocrGeometry.originX + col * LYNX_CELL_WIDTH;
        const y0 = LYNX_BORDER_TOP + this.ocrGeometry.originY + row * LYNX_CELL_HEIGHT;
        for (let line = 0; line < LYNX_CELL_HEIGHT; line++) {
          const start = (y0 + line) * geo.width + x0;
          px.fill(colour, start, start + LYNX_CELL_WIDTH);
        }
      }
    }
    this.display?.updateTexture(this.pixels);
  }

  /** Raw RAM dump for the `.bin` save: the whole physical store. */
  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ramSnapshot(), filename: `ram-${this.model}.bin` };
  }

  /** Memory-pane ROM regions: the DOS ROM the disk interface splices into
   *  bank 0's top page. */
  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    if (value === 'rom-dos' && this.hasDisk) {
      return { data: this.memory.dosRom, baseAddr: DOS_ROM_OFFSET };
    }
    return null;
  }

  // ── Beam ───────────────────────────────────────────────────────────────

  /** The next line of the frame in progress to run (it carries over a stop). */
  private fLine = 0;
  /** The 6845's line count, sampled when the frame in progress started. */
  private fLines = 0;
  /** VSYNC has interrupted the CPU in the frame in progress. */
  private fInterrupted = false;

  /** Frame line 0 is the 6845's first line (row 0, raster 0), the first
   *  displayed one; VSYNC interrupts at the end of the line before row R7. */
  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    const lines = this.frameOpen ? this.fLines : this.crtc.linesPerFrame();
    return {
      cyclesPerLine: this.tPerFrame / lines,
      linesPerFrame: lines,
      displayStart: 0,
      note: 'line 0 is the first line of the 6845\'s character row 0, restarted each frame, which is the first displayed line; VSYNC, wired straight to /INT, interrupts at the end of the line before row R7\'s first. The 50Hz frame is split evenly over the lines R4/R5/R9 program (312 by default), so a line follows the frame, not R0, and its length may be fractional. Each line is drawn whole when the CPU reaches its end',
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return z80ReturnAddress(this.cpu.sp, a => this.memory.readByte(a)); }

  // ── Frame ──────────────────────────────────────────────────────────────

  protected get audioChip() { return NO_PSG; }
  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo || this._tapeTurboActive; }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1 || this._tapeTurboActive;
    // A frame a stop left part-way carries on from the line it was in.
    if (!this.openFrame(this.tPerFrame)) {
      this.activity.kbdReads = 0;
      this.activity.fdcAccesses = 0;
      this.activity.casReads = 0;
      this.video.beginFrame();
      // The 6845 owns the line count; the 50Hz frame is divided among however
      // many lines it has been programmed for, so an unusual R4/R9 stretches or
      // squeezes the raster rather than losing lines off the bottom.
      this.fLines = this.crtc.linesPerFrame();
      this.fLine = 0;
      this.fInterrupted = false;
    }
    this.portWatchHit = null;
    this.memWatchHit = null;

    const lines = this.fLines;
    const tPerLine = this.tPerFrame / lines;
    const keyboard = this.keyboard;
    let lastAudioT = this.cpu.tStates;

    for (; this.fLine < lines; this.fLine++) {
      const line = this.fLine;
      // The last line ends on the frame's end exactly: lines × (frame / lines)
      // can round a hair past it.
      const lineEnd = line + 1 === lines ? this.frameEndT : this.frameStartT + (line + 1) * tPerLine;

      while (this.cpu.tStates < lineEnd) {
        // BREAK holds /INT low for as long as it is down, so the CPU takes an
        // interrupt at every instruction boundary where it has them enabled.
        if (keyboard.breakDown) this.cpu.interrupt();
        if (this.checkStops(this.cpu.pc)) {
          // The frame stays open; the next call carries on in this line.
          this.midFrame = true;
          this.needsDisplay = true;
          return;
        }
        this.beforeInsn(this.cpu.pc);
        this.cpu.step();
        const stopped = this.afterInsn();

        if (!skipAudio) {
          const elapsed = this.cpu.tStates - lastAudioT;
          if (elapsed > 0) {
            // The DAC's level, through the speaker's DC blocker like a beeper.
            this.mixer.accumulateLevel(DAC_LEVELS[this.dacLevel], elapsed);
            this.mixer.generateSamples(this.audio, null, false);
            lastAudioT = this.cpu.tStates;
          }
        }

        // Stop mid-frame on the instruction that tripped a watchpoint, with
        // the frame open.
        if (stopped) {
          this.midFrame = true;
          this.needsDisplay = true;
          return;
        }
      }

      this.video.renderScanline();

      // VSYNC is wired straight to /INT.
      if (this.crtc.vsyncStart) { this.cpu.interrupt(); this.fInterrupted = true; }
    }

    // Until the ROM has programmed R7 there is no VSYNC to interrupt from, and
    // the machine would never leave its initialisation loop.
    if (!this.fInterrupted) this.cpu.interrupt();

    this.updateTapeTurbo();
    if (this.display) this.display.updateTexture(this._pixels);
  }

  /**
   * Engage or release tape turbo for the frame just run.
   *
   * The Lynx's motor relay is the loading signal: the ROM spins the motor only
   * while it is reading the cassette, and a read of the cassette port while the
   * deck runs confirms it. That is exact where the CPC has to infer loading
   * from read cadence. A paused deck or a stopped motor reads zero, so the
   * user's pause and the end of the load release turbo too.
   */
  private updateTapeTurbo(): void {
    const loading = this.tapeMotorOn && this.tape.playing && !this.tape.paused
      && this.activity.casReads > 0;
    if (loading) {
      this._tapeTurboActive = this.tapeTurbo;
      this._tapeTurboCooldown = TAPE_TURBO_COOLDOWN;
    } else if (this._tapeTurboCooldown > 0) {
      if (--this._tapeTurboCooldown <= 0) this.releaseTapeTurbo();
    } else if (this._tapeTurboActive) {
      // Turbo outlived its cooldown — the tape was ejected or ran out mid-load.
      this.releaseTapeTurbo();
    }
  }

  private releaseTapeTurbo(): void {
    if (!this._tapeTurboActive) return;
    this._tapeTurboActive = false;
    // Frames run under turbo generate no samples, so the mixer holds a stale
    // accumulation that would click on the way back to 1x.
    this.mixer.reset();
  }
}
