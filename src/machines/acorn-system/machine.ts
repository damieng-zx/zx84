/**
 * Acorn System motherboard — the card frame, not one model.
 *
 * The four machines are the same backplane with different cards, so this class
 * is assembled from the model's card set (`models.ts`): the CPU clock, the VDU
 * card's geometry and address window, the RAM and ROM cards, and whether the
 * keyboard sits on an INS8154 or (System 5) a 6522A.
 *
 * Nothing contends and nothing steals cycles: the CPU runs flat out and the VDU
 * card reads its own character RAM transparently, so the frame loop is a
 * frame's worth of instructions followed by a whole-screen render. The only
 * per-frame device state is the CRTC cursor's blink phase.
 */

import { M6502 } from '@/cores/m6502.ts';
import { Ins8154 } from '@/cores/ins8154.ts';
import { M6522 } from '@/cores/m6522.ts';
import { Crtc6845 } from '@/cores/crtc-6845.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { CassetteDrive } from '@/machines/shared/cassette-drive.ts';
import { M6502MachineBase } from '@/machines/shared/m6502-machine-base.ts';
import type { BeamInfo, BeamPos } from '@/debug/beam-log.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import { acornSystemModelInfo, type AcornSystemModel, type AcornSystemModelInfo } from './models.ts';
import { AcornSystemMemory, type AcornSystemLayout } from './memory.ts';
import { AcornSystemVideo } from './video.ts';
import { AcornSystemKeyboard } from './keyboard.ts';
import { AcornSystemScreenText } from './screen-text.ts';
import { AcornSystemFdc } from './fdc.ts';
import { acornSystemDescriptor } from './descriptor.ts';
import { createAcornSystemServices, type AcornSystemServices } from './services/index.ts';
import {
  ACORN_SYSTEM_BASIC_BASE, ACORN_SYSTEM_BASIC_SIZE, ACORN_SYSTEM_CYCLES_PER_LINE,
  ACORN_SYSTEM_FDC_BASE, ACORN_SYSTEM_LINES_PER_FRAME, ACORN_SYSTEM_PIA_BASE,
  acornSystemFrameCycles, acornSystemVdu, type AcornSystemVduConfig,
} from './constants.ts';

/** The System makes no sound; this only gives the frame loop a chip to size. */
class NoSound {
  setSampleRate(_rate: number): void {}
}

/** The 6845's R10 cursor register (bit 6 = no blink, bit 5 = 1/32 field). */
const R_CURSOR_START = 10;

export class AcornSystemMachine extends M6502MachineBase implements Machine {
  readonly kind: MachineKind = 'acorn-system';
  readonly model: AcornSystemModel;
  readonly info: AcornSystemModelInfo;
  readonly vdu: AcornSystemVduConfig;

  host: MachineHost | null = null;
  readonly services: AcornSystemServices;

  readonly cpu = new M6502();
  readonly memory: AcornSystemMemory;
  /** The CPU card's INS8154 (System 1-4): keyboard on port B, cassette on port A. */
  readonly pia = new Ins8154();
  /** The 6502A card's 6522A (System 5): keyboard on port A, user port on B. */
  readonly via = new M6522();
  readonly crtc = new Crtc6845(0);
  readonly video: AcornSystemVideo;
  readonly keyboard = new AcornSystemKeyboard();
  readonly screenText = new AcornSystemScreenText();
  /** The 8271 card. Present in every machine object; only fitted to some models. */
  readonly fdc = new AcornSystemFdc((asserted) => { if (asserted) this.cpu.nmi(); });
  readonly diskFitted: boolean;
  /**
   * The CUTS cassette interface. Its transport is the recorder's own: the
   * computer has no motor relay (unlike the BBC's serial ULA), so the motor is
   * held on and the Tape pane's play/pause is what moves the tape.
   */
  readonly cassette: CassetteDrive;
  readonly mixer: AudioMixer;
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  /** Run flat out while a tape is being read ('tape-turbo-load'). */
  private tapeTurboEnabled = true;
  /** Per-frame activity for the frame probe: reads of the keyboard port. */
  readonly activity = { kbdReads: 0 };
  /** Frames since reset, for the cursor's blink phase. */
  private cursorFrame = 0;

  protected readonly audioChip = new NoSound();
  protected override get frameHz(): number {
    return this.info.clockHz / acornSystemFrameCycles(this.info.clockHz);
  }

  get descriptor(): MachineDescriptor { return acornSystemDescriptor(this.model); }
  get pixels(): Uint8Array { return this.video.pixels; }
  get frameWidth(): number { return this.vdu.width; }
  get frameHeight(): number { return this.vdu.height; }
  get tStatesPerFrame(): number { return acornSystemFrameCycles(this.info.clockHz); }
  get cpuClockHz(): number { return this.info.clockHz; }

  constructor(model: AcornSystemModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.info = acornSystemModelInfo(model);
    this.vdu = acornSystemVdu(this.info.vdu);
    this.diskFitted = this.info.disk;
    this.display = display ?? null;

    const layout: AcornSystemLayout = {
      mainRamSize: this.info.mainRamSize,
      vramBase: this.vdu.vramBase,
      vramSize: this.vdu.vramSize,
      crtcBase: this.vdu.crtcBase,
      fdcBase: ACORN_SYSTEM_FDC_BASE,
      piaBase: ACORN_SYSTEM_PIA_BASE,
      ramCards: this.info.ramCards,
      basicBase: ACORN_SYSTEM_BASIC_BASE,
      basicSize: this.info.basicFitted ? ACORN_SYSTEM_BASIC_SIZE : 0,
    };
    this.memory = new AcornSystemMemory(layout);
    this.memory.fdcFitted = this.diskFitted;
    this.video = new AcornSystemVideo(this.vdu, this.info.vdu);
    this.cassette = new CassetteDrive(this.info.clockHz);
    this.mixer = new AudioMixer(this.info.clockHz);

    // Nothing on a bare machine drives IRQ; the 8271's card drives NMI.
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

  /** CRTC, keyboard chip, 8271 and cassette wiring. All of it is memory-mapped. */
  private wireIo(): void {
    const { memory, crtc, pia, via } = this;
    memory.crtcRead = (reg) => (reg === 0 ? crtc.readStatus() : crtc.readRegister());
    memory.crtcWrite = (reg, val) => {
      if (reg === 0) crtc.selectRegister(val); else crtc.writeRegister(val);
    };
    memory.crtcPeek = (reg) => (reg === 0 ? crtc.readStatus() : crtc.readRegister());

    if (this.info.keyboardChip === 'm6522') {
      // The 6522 answers at &0E20 (ORB at +0, ORA at +1); the keyboard is ORA.
      memory.piaRead = (offset) => {
        const reg = offset & 0x0F;
        if (offset >= 0x20 && offset < 0x30) {
          if (reg === 1 || reg === 0x0F) {
            this.activity.kbdReads++;
            via.portAInput = this.keyboard.keyLine;
          }
          return via.read(reg);
        }
        return 0x00;
      };
      memory.piaWrite = (offset, value) => {
        if (offset >= 0x20 && offset < 0x30) via.write(offset & 0x0F, value);
      };
      memory.piaPeek = (offset) => {
        const reg = offset & 0x0F;
        if (offset >= 0x20 && offset < 0x30) {
          if (reg === 1 || reg === 0x0F) via.portAInput = this.keyboard.keyLine;
          return via.read(reg);
        }
        return 0x00;
      };
    } else {
      memory.piaRead = (offset) => {
        // Port B's data register is the keyboard; the KEY indicator shows the
        // OS polling it, not a key being held.
        if ((offset & 0x80) === 0 && (offset & 3) === 1) {
          this.activity.kbdReads++;
          pia.portBInput = this.keyboard.keyLine;
        }
        // Port A bit 7 is the CUTS cassette input's demodulated data line; the
        // other input pins are pulled high. (Bit 6 is the record output.)
        if ((offset & 0x80) === 0 && (offset & 3) === 0) {
          pia.portAInput = 0x7F | (this.cassette.fsk.level << 7);
        }
        return pia.read(offset);
      };
      memory.piaWrite = (offset, value) => pia.write(offset, value);
      memory.piaPeek = (offset) => {
        if ((offset & 0x80) === 0 && (offset & 3) === 0) {
          pia.portAInput = 0x7F | (this.cassette.fsk.level << 7);
        }
        return pia.peek(offset);
      };
    }

    memory.fdcRead = (offset) => this.fdc.read(offset);
    memory.fdcWrite = (offset, value) => this.fdc.write(offset, value);
    memory.fdcPeek = (offset) => this.fdc.peek(offset);
  }

  /** The fitted 8271 card, or null where none is. */
  get disk(): AcornSystemFdc | null { return this.diskFitted ? this.fdc : null; }

  attachHost(host: MachineHost): void { this.host = host; }

  /** Burn the system ROM in: 2K COS at &F800, or a 4K DOS at &F000. */
  loadROM(data: Uint8Array): void {
    this.memory.loadRom(data);
    this.setStatus(`${this.info.label} ROM loaded (${data.length} bytes)`);
  }

  /** Burn the 4K integer BASIC into the 8K RAM + 8K ROM card at &C000. */
  loadBasic(data: Uint8Array): void {
    this.memory.loadBasic(data);
  }

  /** Install the 80x25 card's character generator. */
  loadFont(data: Uint8Array): void {
    this.video.setFont(data);
    this.needsDisplay = true;
  }

  /** An on-screen cap going down: its ASCII code goes on the keyboard port. */
  pressKey(code: number): void { this.keyboard.press(code); }

  /** The cap was let go. */
  releaseKey(): void { this.keyboard.release(); }

  /** Forget every held cap (the pane closed). */
  releaseAllKeys(): void { this.keyboard.reset(); }

  /** The keyboard's BREAK key: the machine's reset line. */
  pressResetKey(): void { this.reset(); }

  /**
   * The cards the machine needs fetched besides the system ROM: the resident
   * BASIC where the memory card carries it, and the 80x25 VDU's character
   * generator. A failure leaves the machine booting without that piece rather
   * than not starting at all.
   */
  prepare(_view: SettingsView): AuxRomRequest[] {
    const requests: AuxRomRequest[] = [];
    if (this.info.basicSource !== '') {
      requests.push({
        cacheKey: `acorn-system-basic-${this.info.basicSource}`,
        source: this.info.basicSource,
        fetchingMsg: 'Fetching System BASIC ROM…',
        loadedMsg: (bytes) => `System BASIC loaded (${bytes} bytes)`,
        failMsg: 'Failed to load System BASIC — the machine will boot to its monitor only',
        failId: 'acorn-basic',
        apply: (data) => this.loadBasic(data),
        awaitLoad: true,
      });
    }
    if (this.info.vdu === 'mono80') {
      requests.push({
        cacheKey: 'acorn-system-80x25-font',
        source: 'acorn-system/80x25font.rom',
        fetchingMsg: 'Fetching 80x25 character generator ROM…',
        loadedMsg: (bytes) => `80x25 character generator loaded (${bytes} bytes)`,
        failMsg: 'Failed to load the 80x25 character generator — the screen stays blank',
        failId: 'acorn-chargen',
        apply: (data) => this.loadFont(data),
        awaitLoad: true,
      });
    }
    return requests;
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
    const cropX = Math.round(this.vdu.borderLeft * (1 - frac));
    const cropY = Math.round(this.vdu.borderTop * (1 - frac));
    this.display?.setViewport(
      cropX, cropY, this.vdu.width - cropX * 2, this.vdu.height - cropY * 2,
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
    this.via.reset();
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
      cyclesPerLine: (ACORN_SYSTEM_CYCLES_PER_LINE * this.info.clockHz) / 1_000_000,
      linesPerFrame: ACORN_SYSTEM_LINES_PER_FRAME,
      displayStart: 0,
      note: 'one buffer line per scanline of the 312-line field; the VDU card reads its own character RAM, so the picture is drawn whole at the end of the frame',
    };
  }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    if (!this.openFrame(this.tStatesPerFrame)) {
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
      const elapsed = this.cpu.tStates - before;
      this.cassette.step(elapsed, this.cpu.tStates);
      if (this.diskFitted) this.fdc.tick(elapsed);
      if (this.info.keyboardChip === 'm6522') this.via.addCycles(elapsed);
      if (!skipAudio) {
        // Silence still has to be fed: the frame loop paces itself on the buffer.
        this.mixer.accumulate(0, elapsed);
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
    const rows = this.screenText.ocr(this.memory.videoRam, this.crtc, this.vdu)
      .text.split('\n').map(r => r.replace(/\s+$/, ''));
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  /** Styled OCR (text, coloured HTML, match mask and paper) for the TEXT overlay. */
  ocrScreenStyled(): OcrResult {
    return this.screenText.ocr(this.memory.videoRam, this.crtc, this.vdu);
  }

  /** Where the TEXT overlay's grid sits in the frame buffer. */
  get textField(): { x: number; y: number; width: number; height: number } {
    return {
      x: this.vdu.borderLeft, y: this.vdu.borderTop,
      width: this.vdu.activeWidth, height: this.vdu.activeHeight,
    };
  }

  /** Blank the cells the overlay replaces (row-major over the screen grid). */
  blankCells(mask: readonly boolean[]): void {
    const px = new Uint32Array(this.video.pixels.buffer);
    const { width, cols, cellWidth, cellHeight, borderLeft, borderTop } = this.vdu;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      const x0 = borderLeft + col * cellWidth;
      const y0 = borderTop + row * cellHeight;
      for (let y = 0; y < cellHeight; y++) {
        const base = (y0 + y) * width + x0;
        px.fill(0xFF000000, base, base + cellWidth);
      }
    }
  }

  /** The CPU card's RAM and every RAM card, in order. */
  ramExportBytes(): { data: Uint8Array; filename: string } {
    const total = this.memory.mainRam.length
      + this.memory.cardRam.reduce((n, c) => n + c.length, 0);
    const data = new Uint8Array(total);
    let at = 0;
    data.set(this.memory.mainRam, at); at += this.memory.mainRam.length;
    for (const card of this.memory.cardRam) { data.set(card, at); at += card.length; }
    return { data, filename: `${this.model}-ram.bin` };
  }

  /** Execution trace: BaseMachine's startTrace/stopTrace drive it and
   *  beforeInsn feeds it (debug/m6502/trace.ts). */
  protected override tracer = new M6502Trace(this, {
    io: [[0x0800, 0x1FFF]],
    ioLabel: acornSystemIoLabel,
  });
}

/** Portio-trace names for the System's memory-mapped I/O. */
function acornSystemIoLabel(addr: number): string {
  if (addr >= 0x0800 && addr < 0x0900) return addr & 1 ? 'CRTC data' : 'CRTC select';
  if (addr >= 0x1840 && addr < 0x1850) return addr & 1 ? 'CRTC data' : 'CRTC select';
  if (addr >= 0x0900 && addr < 0x0A00) return 'PIA2';
  if (addr >= 0x0A00 && addr < 0x0B00) return 'FDC';
  if (addr >= 0x0C00 && addr < 0x0D00) return 'VIB';
  if (addr >= 0x0E00 && addr < 0x0F00) return 'PIA';
  return '';
}
