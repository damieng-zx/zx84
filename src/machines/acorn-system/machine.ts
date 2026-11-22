/**
 * Acorn System 2 motherboard.
 *
 * The disc-less Eurocard system: a 1 MHz 6502 CPU card with 1K of static RAM
 * and an INS8154 (the parallel keyboard on port B, the cassette on port A), an
 * 8K RAM + 8K ROM card carrying the resident 4K BASIC, and the 40x25 teletext
 * VDU card that is 1K of character RAM driven by an MC6845 into an SAA5050.
 *
 * Nothing contends and nothing steals cycles: the CPU runs flat out and the VDU
 * card reads its character RAM transparently, so the frame loop is simply a
 * frame's worth of instructions followed by a whole-screen render. The only
 * per-frame device state is the CRTC cursor's blink phase.
 */

import { M6502 } from '@/cores/m6502.ts';
import { Ins8154 } from '@/cores/ins8154.ts';
import { Crtc6845 } from '@/cores/crtc-6845.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { CassetteDrive } from '@/machines/shared/cassette-drive.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { m6502ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import { acornSystemModelInfo, type AcornSystemModel } from './models.ts';
import { AcornSystemMemory } from './memory.ts';
import { AcornSystemVideo } from './video.ts';
import { AcornSystemKeyboard } from './keyboard.ts';
import { AcornSystemScreenText } from './screen-text.ts';
import { AcornSystemFdc } from './fdc.ts';
import { acornSystemDescriptor } from './descriptor.ts';
import { createAcornSystemServices, type AcornSystemServices } from './services/index.ts';
import {
  ACORN_SYSTEM_ACTIVE_HEIGHT, ACORN_SYSTEM_ACTIVE_WIDTH, ACORN_SYSTEM_BORDER_LEFT,
  ACORN_SYSTEM_BORDER_TOP, ACORN_SYSTEM_CELL_HEIGHT, ACORN_SYSTEM_CELL_WIDTH,
  ACORN_SYSTEM_COLS, ACORN_SYSTEM_CPU_CLOCK,
  ACORN_SYSTEM_CYCLES_PER_LINE, ACORN_SYSTEM_LINES_PER_FRAME,
  ACORN_SYSTEM_SCREEN_HEIGHT, ACORN_SYSTEM_SCREEN_WIDTH, ACORN_SYSTEM_TSTATES_PER_FRAME,
  ACORN_SYSTEM_FRAME_HZ,
} from './constants.ts';

/** The System 2 makes no sound; this only gives the frame loop a chip to size. */
class NoSound {
  setSampleRate(_rate: number): void {}
}

/** The 6845's R10/R11 cursor registers. */
const R_CURSOR_START = 10;

export class AcornSystemMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'acorn-system';
  readonly model: AcornSystemModel;
  host: MachineHost | null = null;
  readonly services: AcornSystemServices;

  readonly cpu = new M6502();
  readonly memory = new AcornSystemMemory();
  /** The CPU card's INS8154: keyboard on port B, cassette on port A. */
  readonly pia = new Ins8154();
  readonly crtc = new Crtc6845(0);
  readonly video = new AcornSystemVideo();
  readonly keyboard = new AcornSystemKeyboard(this.pia);
  readonly screenText = new AcornSystemScreenText();
  /** The 8271 card. Present in every machine object; only fitted to the model. */
  readonly fdc = new AcornSystemFdc((asserted) => { if (asserted) this.cpu.nmi(); });
  /** Whether the 8271 card is fitted (the System 3 and 4 have one). */
  readonly diskFitted: boolean;
  /**
   * The CUTS cassette interface. Its transport is the recorder's own: the
   * computer has no motor relay (unlike the BBC's serial ULA), so the motor is
   * held on and the Tape pane's play/pause is what moves the tape.
   */
  readonly cassette = new CassetteDrive(ACORN_SYSTEM_CPU_CLOCK);
  readonly mixer = new AudioMixer(ACORN_SYSTEM_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  /** Run flat out while a tape is being read ('tape-turbo-load'). */
  private tapeTurboEnabled = true;

  /** Per-frame activity for the frame probe: reads of the keyboard port. */
  readonly activity = { kbdReads: 0 };

  /** Frames since reset, for the cursor's blink phase. */
  private cursorFrame = 0;

  protected readonly audioChip = new NoSound();
  protected override get frameHz(): number { return ACORN_SYSTEM_FRAME_HZ; }

  get descriptor(): MachineDescriptor { return acornSystemDescriptor(this.model); }
  get pixels(): Uint8Array { return this.video.pixels; }
  get frameWidth(): number { return ACORN_SYSTEM_SCREEN_WIDTH; }
  get frameHeight(): number { return ACORN_SYSTEM_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number { return ACORN_SYSTEM_TSTATES_PER_FRAME; }
  get cpuClockHz(): number { return ACORN_SYSTEM_CPU_CLOCK; }

  constructor(model: AcornSystemModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.diskFitted = acornSystemModelInfo(model).disk;
    this.memory.fdcFitted = this.diskFitted;
    this.display = display ?? null;
    // Nothing on a bare System 2 drives IRQ or NMI (the disc controller does on
    // a System 3); the hook is here for the interrupt log all the same.
    this.cpu.onInterrupt = (vector) => this.noteInterrupt(this.cpu.pc, vector === 0xFFFA);
    // The 6502 core makes its bus accesses before it counts the cycles.
    this.deferAccessStamps = true;
    this.cpu.read = (addr) => {
      const value = this.memory.readByte(addr);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) {
        this.recordMemWatch(addr & 0xFFFF, value, 'read');
      }
      return value;
    };
    this.cpu.write = (addr, val) => {
      this.memory.writeByte(addr, val);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) {
        this.recordMemWatch(addr & 0xFFFF, val & 0xFF, 'write');
      }
    };
    this.wireIo();
    this.mixer.beeperGain = 0;
    this.mixer.psgGain = 0;
    this.services = createAcornSystemServices(this);
  }

  /** CRTC and INS8154 wiring. Both are memory-mapped, so this is the whole I/O map. */
  private wireIo(): void {
    const { memory, crtc, pia } = this;
    memory.crtcRead = (reg) => (reg === 0 ? crtc.readStatus() : crtc.readRegister());
    memory.crtcWrite = (reg, val) => {
      if (reg === 0) crtc.selectRegister(val); else crtc.writeRegister(val);
    };
    memory.crtcPeek = (reg) => (reg === 0 ? crtc.readStatus() : crtc.readRegister());
    memory.piaRead = (offset) => {
      // Port B's data register is the keyboard; the KEY indicator shows the OS
      // polling it, not a key being held.
      if ((offset & 0x80) === 0 && (offset & 3) === 1) this.activity.kbdReads++;
      // Port A bit 7 is the CUTS cassette input's demodulated data line; the
      // other input pins are pulled high. (Bit 6 is the record output.)
      if ((offset & 0x80) === 0 && (offset & 3) === 0) {
        this.pia.portAInput = 0x7F | (this.cassette.fsk.level << 7);
      }
      return pia.read(offset);
    };
    memory.piaWrite = (offset, value) => pia.write(offset, value);
    memory.piaPeek = (offset) => pia.peek(offset);
    memory.fdcRead = (offset) => this.fdc.read(offset);
    memory.fdcWrite = (offset, value) => this.fdc.write(offset, value);
    memory.fdcPeek = (offset) => this.fdc.peek(offset);
  }

  /** The fitted 8271 card, or null on a System 2. */
  get disk(): AcornSystemFdc | null { return this.diskFitted ? this.fdc : null; }

  attachHost(host: MachineHost): void { this.host = host; }

  /** Burn the system ROM in: 2K COS at &F800, or a 4K DOS at &F000. */
  loadROM(data: Uint8Array): void {
    this.memory.loadRom(data);
    this.setStatus(`${acornSystemModelInfo(this.model).label} ROM loaded (${data.length} bytes)`);
  }

  /** Burn the 4K integer BASIC into the 8K RAM + 8K ROM card at &C000. */
  loadBasic(data: Uint8Array): void {
    this.memory.loadBasic(data);
  }

  /**
   * The resident BASIC lives on the memory card rather than in the system ROM
   * socket, so it is fetched as a separate image: a failure leaves the machine
   * booting into the COS with no BASIC, not a machine that will not start.
   */
  prepare(_view: SettingsView): AuxRomRequest[] {
    return [{
      cacheKey: 'acorn-system-basic',
      source: acornSystemModelInfo(this.model).basicSource,
      fetchingMsg: 'Fetching System BASIC ROM…',
      loadedMsg: (bytes) => `System BASIC loaded (${bytes} bytes)`,
      failMsg: 'Failed to load System BASIC — the System 2 will boot to the COS only',
      failId: 'acorn-basic',
      apply: (data) => this.loadBasic(data),
      awaitLoad: true,
    }];
  }

  applySettings(view: SettingsView): void {
    this.audio.setVolume(view.get('volume', 70) / 100);
    this.video.paletteMode = view.get<'pal' | 'measured'>('bbc-color-map', 'pal');
    this.tapeTurboEnabled = view.get('tape-turbo-load', true);
    // A palette change while paused has no frame to pick it up.
    this.renderScreen();
  }

  /** Border setting crops the black margin; the picture itself is fixed. */
  setBorderSize(mode: BorderMode): void {
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(ACORN_SYSTEM_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(ACORN_SYSTEM_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY, ACORN_SYSTEM_SCREEN_WIDTH - cropX * 2, ACORN_SYSTEM_SCREEN_HEIGHT - cropY * 2,
    );
  }

  reset(): void {
    this.stop();
    this.midFrame = false;
    this.cursorFrame = 0;
    this.activity.kbdReads = 0;
    this.cpu.reset();
    this.crtc.reset();
    this.video.reset();
    this.keyboard.reset();
    this.pia.reset();
    this.cassette.reset();
    // No motor relay on this machine: the recorder's transport is live.
    this.cassette.setMotor(true, this.cpu.tStates);
    if (this.diskFitted) this.fdc.reset();
    this.mixer.reset();
    this.audio.reset();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  protected framePixels(): Uint8Array { return this.video.pixels; }
  protected inTurbo(): boolean { return this.turbo || this.cassette.turboActive; }

  // ── Beam ───────────────────────────────────────────────────────────────

  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: ACORN_SYSTEM_CYCLES_PER_LINE,
      linesPerFrame: ACORN_SYSTEM_LINES_PER_FRAME,
      displayStart: 0,
      note: 'one buffer line per 64-cycle scanline of the 312-line field; the VDU card reads its own 1K of character RAM, so the picture is drawn whole at the end of the frame',
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number {
    return m6502ReturnAddress(this.cpu.sp, a => this.memory.peekByte(a));
  }
  protected override peekOpcode(addr: number): number { return this.memory.peekByte(addr); }
  protected override interruptEntryPending(): boolean { return this.cpu.interruptPending(); }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    if (!this.openFrame(ACORN_SYSTEM_TSTATES_PER_FRAME)) {
      this.activity.kbdReads = 0;
      this.cursorFrame++;
      this.crtc.beginFrame();
    }
    this.memWatchHit = null;
    const endT = this.frameEndT;

    while (this.cpu.tStates < endT) {
      if (this.checkStops(this.cpu.pc)) {
        // The frame stays open; the next call carries on from here.
        this.midFrame = true;
        this.renderScreen();
        return;
      }
      const before = this.cpu.tStates;
      this.beforeInsn(this.cpu.pc);
      this.cpu.step();
      const stopped = this.afterInsn();
      this.cassette.step(this.cpu.tStates - before, this.cpu.tStates);
      if (this.diskFitted) this.fdc.tick(this.cpu.tStates - before);
      if (!skipAudio) {
        // Silence still has to be fed: the frame loop paces itself on the buffer.
        this.mixer.accumulate(0, this.cpu.tStates - before);
        this.mixer.generateSamples(this.audio, null, false);
      }
      if (stopped) {
        this.midFrame = true;
        this.renderScreen();
        return;
      }
    }
    this.cassette.frameTick(this.tapeTurboEnabled);
    this.renderScreen();
  }

  /** Draw the whole screen with the cursor in its blink phase for this frame. */
  private renderScreen(): void {
    // R10: bit 6 = no blink, bit 5 = 1/32 field (16 frames on, 16 off) else 1/16 (8/8).
    const start = this.crtc.regs[R_CURSOR_START];
    const steady = (start & 0x40) !== 0;
    const half = (start & 0x20) !== 0 ? 16 : 8;
    const cursorOn = steady || this.cursorFrame % (half * 2) < half;
    this.video.render(this.crtc, this.memory.videoRam, cursorOn);
    this.needsDisplay = true;
  }

  // ── Debug / OCR surface ────────────────────────────────────────────────

  /** The screen is already text: read the display bytes the CRTC is showing. */
  ocrScreenForMcp(_mode?: string): string {
    const rows = this.screenText.ocr(this.memory.videoRam, this.crtc)
      .text.split('\n').map(r => r.replace(/\s+$/, ''));
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  /** Styled OCR (text, coloured HTML, match mask and paper) for the TEXT overlay. */
  ocrScreenStyled(): OcrResult {
    return this.screenText.ocr(this.memory.videoRam, this.crtc);
  }

  /** Where the TEXT overlay's grid sits in the frame buffer. */
  get textField(): { x: number; y: number; width: number; height: number } {
    return {
      x: ACORN_SYSTEM_BORDER_LEFT, y: ACORN_SYSTEM_BORDER_TOP,
      width: ACORN_SYSTEM_ACTIVE_WIDTH, height: ACORN_SYSTEM_ACTIVE_HEIGHT,
    };
  }

  /** Blank the cells the overlay replaces (row-major over the 40x25 grid). */
  blankCells(mask: readonly boolean[]): void {
    const px = new Uint32Array(this.video.pixels.buffer);
    const w = ACORN_SYSTEM_SCREEN_WIDTH;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const col = i % ACORN_SYSTEM_COLS;
      const row = (i / ACORN_SYSTEM_COLS) | 0;
      const x0 = ACORN_SYSTEM_BORDER_LEFT + col * ACORN_SYSTEM_CELL_WIDTH;
      const y0 = ACORN_SYSTEM_BORDER_TOP + row * ACORN_SYSTEM_CELL_HEIGHT;
      for (let y = 0; y < ACORN_SYSTEM_CELL_HEIGHT; y++) {
        const base = (y0 + y) * w + x0;
        px.fill(0xFF000000, base, base + ACORN_SYSTEM_CELL_WIDTH);
      }
    }
  }

  /** The 1K CPU-card RAM followed by the 8K card's RAM. */
  ramExportBytes(): { data: Uint8Array; filename: string } {
    const data = new Uint8Array(this.memory.mainRam.length + this.memory.cardRam.length);
    data.set(this.memory.mainRam, 0);
    data.set(this.memory.cardRam, this.memory.mainRam.length);
    return { data, filename: `${this.model}-ram.bin` };
  }

  /** Execution trace: BaseMachine's startTrace/stopTrace drive it and
   *  beforeInsn feeds it (debug/m6502/trace.ts). */
  protected override tracer = new M6502Trace(this, {
    io: [[0x0800, 0x08FF], [0x0900, 0x0FFF]],
    ioLabel: acornSystemIoLabel,
  });
}

/** Portio-trace names for the System 2's memory-mapped I/O. */
function acornSystemIoLabel(addr: number): string {
  if (addr >= 0x0800 && addr < 0x0900) return addr & 1 ? 'CRTC data' : 'CRTC select';
  if (addr >= 0x0900 && addr < 0x0A00) return 'PIA2';
  if (addr >= 0x0A00 && addr < 0x0B00) return 'FDC';
  if (addr >= 0x0C00 && addr < 0x0D00) return 'VIB';
  if (addr >= 0x0E00 && addr < 0x0F00) return 'PIA';
  return '';
}
