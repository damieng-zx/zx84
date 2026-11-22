/**
 * Acorn Atom motherboard.
 *
 * A 1 MHz 6502 with a 6847 VDG, an 8255 PPI joining the keyboard matrix, the
 * VDG mode pins and the cassette/speaker lines, and a 6522 VIA for the printer
 * (and user I/O). The 6847 fetches its own display from 1 KB (standard) or
 * 6 KB (expanded) of RAM at $8000; the 6502 sees the same RAM at the same
 * addresses. The machine runs a 60 Hz field and polls the PPI's VSYNC input for
 * the WAIT statement and the OS's screen timing.
 *
 * The Atom's standard 12 KB configuration is modelled by default: 1 KB of CPU
 * workspace, 5 KB of lower text RAM and 6 KB of display RAM. The Hardware pane
 * can drop to the 2 KB machine.
 */

import { M6502 } from '@/cores/m6502.ts';
import { M6522 } from '@/cores/m6522.ts';
import { I8255 } from '@/cores/i8255.ts';
import { Mc6847, mc6847Colour } from '@/cores/mc6847.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { m6502ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import { atomCodeToAscii, ocrAtomText } from '@/ocr/atom.ts';
import { AtomMemory } from './atom-memory.ts';
import { AtomKeyboard } from './atom-keyboard.ts';
import { AtomTape } from './atom-tape.ts';
import { AtomVideo } from './atom-video.ts';
import {
  ATOM_ACTIVE_HEIGHT, ATOM_ACTIVE_WIDTH, ATOM_BORDER_LEFT, ATOM_BORDER_TOP,
  ATOM_CPU_CLOCK, ATOM_CYCLES_PER_LINE, ATOM_FRAME_HZ, ATOM_LINES_PER_FRAME,
  ATOM_SCREEN_HEIGHT, ATOM_SCREEN_WIDTH, ATOM_TSTATES_PER_FRAME,
  ATOM_VBLANK_FIRST_LINE, ATOM_VBLANK_LAST_LINE,
} from './constants.ts';
import { atomModelInfo, type AtomModel } from './models.ts';
import { ATOM_DEFAULT_OPTIONS, readAtomOptions, type AtomOptions } from './options.ts';
import { atomDescriptor } from './descriptor.ts';
import { createAtomServices, type AtomServices } from './services/index.ts';
import { atomChips } from './atom-chips.ts';
import { withStopsDisarmed } from '@/machines/shared/native-state.ts';
import { crc32, type StateReader, type StateWriter } from '@/machines/shared/state-io.ts';

/** The Atom's colour-board palette, in the 6847 core's slot layout. Text has a
 *  black paper and green or orange ink; graphics use the eight-board colours. */
const ATOM_PALETTE = Uint32Array.from([
  mc6847Colour(0x30, 0xd2, 0x00), mc6847Colour(0xc1, 0xe5, 0x00),
  mc6847Colour(0x4c, 0x3a, 0xb4), mc6847Colour(0x9a, 0x32, 0x36),
  mc6847Colour(0xbf, 0xc8, 0xad), mc6847Colour(0x41, 0xaf, 0x71),
  mc6847Colour(0xc8, 0x4e, 0xf0), mc6847Colour(0xd4, 0x7f, 0x00),
  mc6847Colour(0x00, 0x00, 0x00), mc6847Colour(0x30, 0xd2, 0x00),
  mc6847Colour(0x00, 0x00, 0x00), mc6847Colour(0xbf, 0xc8, 0xad),
  mc6847Colour(0x00, 0x00, 0x00), mc6847Colour(0x30, 0xd2, 0x00),
  mc6847Colour(0x00, 0x00, 0x00), mc6847Colour(0xd4, 0x7f, 0x00),
]);

/** Frames a pasted key is held, and the gap before the next one. The Atom's
 *  OSRDCH waits for a release before accepting the next press, so the gap must
 *  be long enough for a full keyboard scan. */
const PASTE_HOLD_FRAMES = 3;
const PASTE_GAP_FRAMES = 3;

/** The Atom has a single-bit speaker; this only gives the frame loop a chip to size. */
class NoSound {
  setSampleRate(_rate: number): void {}
}

export class AtomMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'atom';
  readonly model: AtomModel;
  host: MachineHost | null = null;
  readonly services: AtomServices;
  /** Fitted memory; the defaults until `prepare()` reads the settings. */
  options: AtomOptions = ATOM_DEFAULT_OPTIONS;

  readonly cpu = new M6502();
  readonly memory = new AtomMemory(ATOM_DEFAULT_OPTIONS.ramKb);
  readonly ppi = new I8255();
  readonly via = new M6522();
  readonly vdg = new Mc6847();
  readonly keyboard = new AtomKeyboard();
  readonly mixer = new AudioMixer(ATOM_CPU_CLOCK);
  readonly audio = new Audio();
  readonly video = new AtomVideo();
  readonly tape = new AtomTape();
  display: IScreenRenderer | null;

  /** The keyboard row selected by PPI port A bits 0-3. */
  private keyRow = 0;
  /** Current speaker level (port C bit 2) and cassette output bits 0-1. */
  private speakerBit = 0;
  private cassetteOut = 0;

  /** Per-frame activity for the frame probe. */
  readonly activity = { keyboardReads: 0, speakerToggles: 0 };

  /** A listing being typed at the keyboard, one key at a time. */
  private paste: string[] = [];
  private pasteAt = 0;
  private pasteHold = 0;
  private pasteGap = 0;

  protected readonly audioChip = new NoSound();
  protected override get frameHz(): number { return ATOM_FRAME_HZ; }

  get descriptor(): MachineDescriptor { return atomDescriptor(this.model); }
  get pixels(): Uint8Array { return this.video.pixels; }
  get frameWidth(): number { return ATOM_SCREEN_WIDTH; }
  get frameHeight(): number { return ATOM_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number { return ATOM_TSTATES_PER_FRAME; }
  get cpuClockHz(): number { return ATOM_CPU_CLOCK; }

  constructor(model: AtomModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.display = display ?? null;
    this.memory.setRamKb(this.options.ramKb);
    this.vdg.palette.set(ATOM_PALETTE);
    this.vdg.dataPins = Mc6847.atomDataPins;

    // Nothing on the board drives NMI; the VIA can drive IRQ. The hook exists
    // for the interrupt log all the same.
    this.cpu.onInterrupt = (vector) => this.noteInterrupt(this.cpu.pc, vector === 0xFFFA);
    // The 6502 core makes its bus accesses before it counts the cycles.
    this.deferAccessStamps = true;
    this.cpu.read = (addr) => {
      const value = this.memory.readByte(addr);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, value, 'read');
      return value;
    };
    this.cpu.write = (addr, val) => {
      this.memory.writeByte(addr, val);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, val & 0xFF, 'write');
    };

    this.wireMemory();
    this.wirePpi();
    this.wireVia();
    this.via.portAInput = 0xFF;
    this.via.portBInput = 0xFF;

    this.mixer.beeperGain = 1;
    this.mixer.psgGain = 0;
    this.services = createAtomServices(this);
  }

  /** Route the address map's PPI/VIA windows to the chips. */
  private wireMemory(): void {
    const { memory } = this;
    memory.ppiRead = (reg) => {
      if (reg === 1) {
        this.ppi.portBInput = this.keyboard.readRow(this.keyRow);
        this.activity.keyboardReads++;
      } else if (reg === 2) {
        this.ppi.portCInput = this.portCInput();
      }
      return this.ppi.read(reg);
    };
    memory.ppiPeek = (reg) => {
      if (reg === 1) this.ppi.portBInput = this.keyboard.readRow(this.keyRow);
      else if (reg === 2) this.ppi.portCInput = this.portCInput();
      return this.ppi.peek(reg);
    };
    memory.ppiWrite = (reg, value) => this.ppi.write(reg, value);
    memory.viaRead = (reg) => this.via.read(reg);
    // The VIA core has no side-effect-free read (reading a timer/IFR register
    // clears an interrupt flag), so the debugger's Mapped view shows open bus
    // there; the Chips tool reads the VIA's own state instead.
    memory.viaPeek = () => 0xFF;
    memory.viaWrite = (reg, value) => this.via.write(reg, value);
  }

  /** Port A selects the keyboard row and holds the VDG mode pins; port C holds
   *  the speaker, cassette output and colour-set lines. */
  private wirePpi(): void {
    this.ppi.onPortAWrite = (value, ddr) => {
      const out = value & ddr;
      this.keyRow = out & 0x0F;
      this.vdg.setAtomModeBits(out);
    };
    this.ppi.onPortCWrite = (value, ddr) => {
      const out = value & ddr;
      const speaker = (out >> 2) & 1;
      if (speaker !== this.speakerBit) {
        this.speakerBit = speaker;
        this.activity.speakerToggles++;
      }
      this.vdg.css = (out & 0x08) !== 0;
      this.cassetteOut = out & 0x03;
    };
  }

  private wireVia(): void {
    // The printer's BUSY line is not asserted; no printer is fitted.
    this.via.onPortAWrite = () => {};
    this.via.onPortBWrite = () => {};
  }

  /** Port C's input pins: VSYNC (low in vertical blanking), the REPT key, the
   *  cassette input from the playing deck, and the interface's free-running
   *  2400 Hz tone. */
  private portCInput(): number {
    let value = 0;
    const line = this.beamLine();
    if (line < ATOM_VBLANK_FIRST_LINE || line > ATOM_VBLANK_LAST_LINE) value |= 0x80;
    if (!this.keyboard.repeat) value |= 0x40;
    if (this.tape.inputBit) value |= 0x20;
    if (Math.floor((this.cpu.tStates * 4800) / ATOM_CPU_CLOCK) & 1) value |= 0x10;
    return value;
  }

  /** The scanline the CPU is on, from the frame grid. */
  private beamLine(): number {
    const t = this.cpu.tStates - this.frameStartT;
    const line = Math.floor(t / ATOM_CYCLES_PER_LINE);
    return line < 0 ? 0 : line >= ATOM_LINES_PER_FRAME ? ATOM_LINES_PER_FRAME - 1 : line;
  }

  /** Advance the VIA timers after an instruction. The standard Atom does not
   *  fit the LK2 link that connects the 6522's IRQ pin to the CPU: the VIA is
   *  the printer/user port, and its interrupt line is left open. (Fitting it
   *  would need a Hardware-pane option; no software in the library relies on
   *  it.) */
  private clockChips(elapsed: number): void {
    this.via.addCycles(elapsed);
    this.tape.advance(elapsed);
  }

  prepare(view: SettingsView): AuxRomRequest[] {
    this.fit(readAtomOptions(view));
    return [];
  }

  applySettings(view: SettingsView): void {
    this.fit(readAtomOptions(view));
  }

  private fit(options: AtomOptions): void {
    this.options = options;
    this.memory.setRamKb(options.ramKb);
    this.needsDisplay = true;
  }

  attachHost(host: MachineHost): void { this.host = host; }

  loadROM(data: Uint8Array): void {
    if (!this.memory.loadRom(data)) {
      this.setStatus(`Atom ROM image has an unrecognised size (${data.length} bytes)`);
      return;
    }
    this.setStatus(`${atomModelInfo(this.model).label} ROM loaded (${data.length} bytes)`);
    this.needsDisplay = true;
  }

  setBorderSize(mode: BorderMode): void {
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(ATOM_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(ATOM_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY, ATOM_SCREEN_WIDTH - cropX * 2, ATOM_SCREEN_HEIGHT - cropY * 2,
    );
  }

  reset(): void {
    this.stop();
    this.resetHardware();
    this.resetFrameCount();
    this.setStatus('Reset');
  }

  /** The BREAK key: a 6502/PIA reset (RAM and the screen survive), not a power
   *  cycle. The OS's reset vector reinitialises the hardware. */
  pressBreak(): void {
    this.cancelPaste();
    this.cpu.reset();
    this.via.reset();
    this.ppi.reset();
    this.vdg.reset();
    this.keyboard.releaseAll();
    this.keyRow = 0;
    this.speakerBit = 0;
    this.cassetteOut = 0;
    this.midFrame = false;
    this.clearInterrupts();
    this.drawFrame();
  }

  private resetHardware(): void {
    this.cancelPaste();
    this.cpu.reset();
    this.via.reset();
    this.ppi.reset();
    this.vdg.reset();
    this.keyboard.releaseAll();
    this.keyRow = 0;
    this.speakerBit = 0;
    this.cassetteOut = 0;
    this.tape.reset();
    this.activity.keyboardReads = 0;
    this.activity.speakerToggles = 0;
    this.mixer.reset();
    this.audio.reset();
    this.drawFrame();
  }

  protected framePixels(): Uint8Array { return this.video.pixels; }
  protected inTurbo(): boolean { return this.turbo; }
  protected override exitTurbo(): void { this.mixer.reset(); }

  private drawFrame(): void {
    this.video.render(this.vdg, this.memory.vram);
    this.needsDisplay = true;
  }

  // â”€â”€ Beam â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: ATOM_CYCLES_PER_LINE,
      linesPerFrame: ATOM_LINES_PER_FRAME,
      displayStart: 0,
      note: 'The 6847 field is 262 lines of 228 dot clocks; the 6502 runs 64 cycles per line. Active video is the first 192 lines, vertical blanking the 32 lines from 192 to 223, which is the PPI\'s VSYNC input.',
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return m6502ReturnAddress(this.cpu.sp, a => this.memory.peekByte(a)); }
  protected override peekOpcode(addr: number): number { return this.memory.peekByte(addr); }
  protected override interruptEntryPending(): boolean { return this.cpu.interruptPending(); }

  stepInstruction(): void {
    const before = this.cpu.tStates;
    this.beforeInsn(this.cpu.pc);
    this.cpu.step();
    this.clockChips(this.cpu.tStates - before);
    this.afterInsn();
    this.drawFrame();
  }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    if (!this.openFrame(ATOM_TSTATES_PER_FRAME)) {
      this.activity.keyboardReads = 0;
      this.activity.speakerToggles = 0;
      this.feedPaste();
    }
    this.memWatchHit = null;
    const endT = this.frameEndT;

    while (this.cpu.tStates < endT) {
      if (this.checkStops(this.cpu.pc)) {
        this.midFrame = true;
        this.drawFrame();
        return;
      }
      const before = this.cpu.tStates;
      this.beforeInsn(this.cpu.pc);
      this.cpu.step();
      const elapsed = this.cpu.tStates - before;
      this.clockChips(elapsed);
      const stopped = this.afterInsn();
      if (!skipAudio) {
        this.mixer.accumulate(this.speakerBit, elapsed);
        this.mixer.generateSamples(this.audio, null, false);
      }
      if (stopped) {
        this.midFrame = true;
        this.drawFrame();
        return;
      }
    }
    this.drawFrame();
  }

  // â”€â”€ Paste (typed listings) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  /** Queue `text` at the keyboard, one key at a time. Newlines are RETURN. */
  typeText(text: string): number {
    const keys = [...text.replace(/\r\n?/g, '\n')].filter((ch) => ch === '\n' || ch === ' ' || ch in atomCharLookup());
    this.paste = keys;
    this.pasteAt = 0;
    this.pasteHold = 0;
    // Let the OS finish whatever it was printing and settle into its
    // release-wait phase before the first key arrives.
    this.pasteGap = 4;
    return keys.length;
  }

  get pasteRemaining(): number { return this.paste.length - this.pasteAt; }

  cancelPaste(): void {
    this.paste = [];
    this.pasteAt = 0;
    this.pasteHold = 0;
    this.pasteGap = 0;
    this.keyboard.releaseAll();
  }

  /** Hand the OS the next queued key, held long enough for a scan. */
  private feedPaste(): void {
    if (this.pasteHold > 0) {
      if (--this.pasteHold === 0) {
        this.keyboard.releaseAll();
        this.pasteGap = PASTE_GAP_FRAMES;
      }
      return;
    }
    if (this.pasteGap > 0) { this.pasteGap--; return; }
    if (this.pasteAt >= this.paste.length) return;
    const ch = this.paste[this.pasteAt++];
    if (ch === '\n') this.keyboard.setCell(6, 1, true);
    else this.keyboard.pressChar(ch);
    this.pasteHold = PASTE_HOLD_FRAMES;
  }

  // â”€â”€ Debug / OCR surface â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ocrScreenForMcp(_mode?: string): string {
    if (this.vdg.graphics) return '';
    const lines: string[] = [];
    const screen = this.memory.textScreen;
    for (let row = 0; row < 16; row++) {
      let text = '';
      for (let col = 0; col < 32; col++) {
        const ch = atomCodeToAscii(screen[row * 32 + col]);
        text += ch ?? ' ';
      }
      lines.push(text.replace(/\s+$/, ''));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  ocrScreenStyled(): OcrResult {
    return ocrAtomText(this.memory.textScreen);
  }

  get textField(): { x: number; y: number; width: number; height: number } {
    return {
      x: ATOM_BORDER_LEFT, y: ATOM_BORDER_TOP,
      width: ATOM_ACTIVE_WIDTH, height: ATOM_ACTIVE_HEIGHT,
    };
  }

  blankCells(mask: boolean[]): void { this.video.blankCells(mask); }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(0, 0xA000), filename: 'atom-ram.bin' };
  }

  chips() { return atomChips(this); }

  // â”€â”€ Snapshots (.atmstate; see shared/native-state.ts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  stateRomCrcs(): number[] {
    return [
      crc32(this.memory.basicRom), crc32(this.memory.floatRom), crc32(this.memory.kernelRom),
    ];
  }

  /** Run the rest of a frame a stop left part-way, with every stop set aside,
   *  so the machine is between frames (a snapshot is taken there). */
  private completeFrame(): void {
    if (!this.midFrame) return;
    withStopsDisarmed(this, () => {
      this.resumeSkipPc = -1;
      this.stepFrame();
    });
  }

  saveState(w: StateWriter, _withMedia: boolean): void {
    this.completeFrame();
    w.section('CONF', () => w.u8(this.options.ramKb));
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameNumber); w.f64(this.frameStartT); w.f64(this.frameEndT);
      w.u8(this.keyRow); w.u8(this.speakerBit); w.u8(this.cassetteOut);
    });
    w.section('MEM ', () => w.raw(this.memory.ram));
    w.section('PPI ', () => this.ppi.saveState(w));
    w.section('VIA ', () => this.via.saveState(w));
    w.section('VDG ', () => this.vdg.saveState(w));
  }

  loadState(r: StateReader): void {
    const conf = r.section('CONF');
    const ramKb = conf.u8();
    this.options = { ramKb: ramKb >= 12 ? 12 : 2 };
    this.memory.setRamKb(this.options.ramKb);

    this.midFrame = false;
    this.clearInterrupts();
    this.cancelPaste();
    this.keyboard.releaseAll();
    this.cpu.loadState(r.section('CPU '));
    {
      const s = r.section('MACH');
      this.frameNumber = s.f64(); this.frameStartT = s.f64(); this.frameEndT = s.f64();
      this.keyRow = s.u8(); this.speakerBit = s.u8(); this.cassetteOut = s.u8();
    }
    r.section('MEM ').rawInto(this.memory.ram);
    this.ppi.loadState(r.section('PPI '));
    this.via.loadState(r.section('VIA '));
    this.vdg.loadState(r.section('VDG '));
    this.cpu.setIRQ(false);
    this.activity.keyboardReads = 0;
    this.activity.speakerToggles = 0;
    this.mixer.reset();
    this.audio.reset();
    this.drawFrame();
  }

  // â”€â”€ Trace â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  protected override tracer = new M6502Trace(this, {
    io: [[0xB000, 0xB3FF], [0xB800, 0xBBFF]],
    ioLabel: atomIoLabel,
  });
}

/** Chars the paste path can type (kept in one lookup so `typeText` never
 *  queues a key the keyboard cannot press). */
function atomCharLookup(): Record<string, true> {
  // Built lazily in one object; letters and punctuation from the keyboard's maps.
  const out: Record<string, true> = {};
  for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') out[ch] = true;
  for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') out[ch] = true;
  return out;
}

/** Portio-trace names for the Atom's memory-mapped I/O. */
function atomIoLabel(addr: number): string {
  if (addr >= 0xB000 && addr < 0xB400) return ['PORTA', 'PORTB', 'PORTC', 'CTRL'][addr & 3];
  if (addr >= 0xB800 && addr < 0xBC00) {
    return [
      'ORB', 'ORA', 'DDRB', 'DDRA', 'T1CL', 'T1CH', 'T1LL', 'T1LH',
      'T2CL', 'T2CH', 'SR', 'ACR', 'PCR', 'IFR', 'IER', 'ORAh',
    ][addr & 0x0F];
  }
  return '';
}



