/**
 * Oric-1 / Oric Atmos motherboard.
 *
 * A 6502A at 1 MHz, a custom ULA doing video and the memory decode, a 6522 VIA
 * joining the keyboard matrix, the AY-3-8912 and the cassette and printer
 * lines, and a passive keyboard with no encoder. The ULA renders 240x224 from
 * 40x28 text or 240x200 hires, with in-line serial attributes; the ROM's 100 Hz
 * timer-1 interrupt scans the keyboard through the VIA and the PSG's port A.
 *
 * The machine is "48K": 48 KB of RAM below $C000 plus a 16 KB overlay behind
 * the BASIC ROM, which a Microdisc uses to load a DOS.
 */

import { M6502 } from '@/cores/m6502.ts';
import { M6522 } from '@/cores/m6522.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { M6502MachineBase } from '@/machines/shared/m6502-machine-base.ts';
import type { BeamInfo, BeamPos } from '@/debug/beam-log.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind,
  MemoryMapSnapshot, SettingsView,
} from '@/machines/machine.ts';
import { soundDeviceGains } from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import { ocrOricText } from '@/ocr/oric.ts';
import { applyAySettings } from '@/machines/shared/ay-settings.ts';
import { crc32, type StateReader, type StateWriter } from '@/machines/shared/state-io.ts';
import {
  ORIC_ACTIVE_HEIGHT, ORIC_BORDER_LEFT, ORIC_BORDER_TOP, ORIC_CPU_CLOCK,
  ORIC_CYCLES_PER_LINE, ORIC_FRAME_HZ, ORIC_LINES_PER_FRAME,
  ORIC_SCREEN_HEIGHT, ORIC_SCREEN_WIDTH, ORIC_TEXT_COLS, ORIC_TEXT_ROWS,
  ORIC_TSTATES_PER_FRAME, ORIC_IO_BASE, ORIC_IO_END, ORIC_VIA_MASK,
  ORIC_TAPE_MOTOR, ORIC_TAPE_OUT,
} from './constants.ts';
import { OricKeyboard } from './oric-keyboard.ts';
import { OricMemory } from './oric-memory.ts';
import { OricPsg } from './oric-psg.ts';
import { OricTape } from './oric-tape.ts';
import { OricMicrodisc } from './microdisc.ts';
import { OricUla } from './oric-ula.ts';
import { oricModelInfo, type OricModel } from './models.ts';
import { ORIC_DEFAULT_OPTIONS, readOricOptions, type OricOptions } from './options.ts';
import { oricDescriptor } from './descriptor.ts';
import { createOricServices, type OricServices } from './services/index.ts';
import { oricChips } from './oric-chips.ts';

/** Frames a pasted key is held, and the gap before the next one. The ROM scans
 *  the keyboard three times in four jiffies, so a key must survive several
 *  scans to be latched — and a *shifted* key needs SHIFT and the symbol held
 *  together, which is why the hold is generous. */
const PASTE_HOLD_FRAMES = 6;
const PASTE_GAP_FRAMES = 3;

/** The one thing `BaseMachine` asks of an audio chip. */
interface SampleRateAware {
  setSampleRate(rate: number): void;
}

export class OricMachine extends M6502MachineBase implements Machine {
  readonly kind: MachineKind = 'oric';
  readonly model: OricModel;
  host: MachineHost | null = null;
  readonly services: OricServices;
  /** Fitted hardware; the defaults until `prepare()` reads the settings. */
  options: OricOptions = ORIC_DEFAULT_OPTIONS;

  readonly cpu = new M6502();
  readonly memory = new OricMemory();
  readonly via = new M6522();
  readonly psg = new OricPsg();
  readonly keyboard = new OricKeyboard();
  readonly ula = new OricUla(this.memory);
  readonly mixer = new AudioMixer(ORIC_CPU_CLOCK);
  readonly tape = new OricTape(ORIC_CPU_CLOCK);
  /** The Microdisc, when the Hardware pane fits one. */
  microdisc: OricMicrodisc | null = null;
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  /** Per-frame activity for the frame probe. */
  readonly activity = { keyboardReads: 0, psgWrites: 0 };

  /** A listing being typed at the keyboard, one key at a time. */
  private paste: string[] = [];
  private pasteAt = 0;
  private pasteHold = 0;
  private pasteGap = 0;

  protected get audioChip(): SampleRateAware { return { setSampleRate: (r) => this.psg.ay.setSampleRate(r) }; }
  protected override get frameHz(): number { return ORIC_FRAME_HZ; }

  get descriptor(): MachineDescriptor { return oricDescriptor(this.model); }
  get pixels(): Uint8Array { return this.ula.pixelBytes; }
  get frameWidth(): number { return ORIC_SCREEN_WIDTH; }
  get frameHeight(): number { return ORIC_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number {
    return this.ula.sixtyHz ? ORIC_CYCLES_PER_LINE * 260 : ORIC_TSTATES_PER_FRAME;
  }
  get cpuClockHz(): number { return ORIC_CPU_CLOCK; }

  constructor(model: OricModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.display = display ?? null;

    this.cpu.onInterrupt = () => this.noteInterrupt(this.cpu.pc, false);

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

    this.wireMemory();
    this.wireVia();

    this.mixer.beeperGain = 0;   // the PSG is the only sound source
    this.mixer.ayGain = 1;

    this.drawFrame();
    this.services = createOricServices(this);
  }

  /** Route the memory map's I/O window to the VIA and, when fitted, the card. */
  private wireMemory(): void {
    const { memory } = this;
    memory.ioRead = (addr) => {
      addr &= 0xFF;
      // The Microdisc decodes $0310-$031B *above* the VIA's mirror, so it must
      // be consulted first: an address the card owns never reaches the VIA.
      if (this.microdisc && OricMicrodisc.decodes(0x0300 | addr)) {
        return this.microdisc.read(0x0300 | addr);
      }
      // Any other page-3 address selects the VIA; its 16 registers are
      // mirrored across the whole page. The keyboard's sense line is a function
      // of the row the last port B write selected and the PSG's current column,
      // so refresh it before the read that observes it.
      if ((addr & ORIC_VIA_MASK) === 0) this.refreshPortBInput();
      return this.via.read(addr & ORIC_VIA_MASK);
    };
    memory.ioPeek = (addr) => {
      addr &= 0xFF;
      if (this.microdisc && OricMicrodisc.decodes(0x0300 | addr)) return 0xFF;
      return this.via.peek(addr & ORIC_VIA_MASK);
    };
    memory.ioWrite = (addr, value) => {
      addr &= 0xFF;
      if (this.microdisc && OricMicrodisc.decodes(0x0300 | addr)) {
        this.microdisc.write(0x0300 | addr, value & 0xFF);
        // The latch is what flips the memory map, so re-derive it immediately.
        this.syncMemoryMap();
        return;
      }
      this.via.write(addr & ORIC_VIA_MASK, value & 0xFF);
    };
  }

  /**
   * Reflect the Microdisc latch into the memory map: ROMDIS maps the overlay
   * RAM in at `$C000`, and EPROM-select maps the card's boot ROM at `$E000`.
   * With no card fitted the BASIC ROM stays put.
   */
  private syncMemoryMap(): void {
    if (!this.microdisc) {
      this.memory.basicRomOn = true;
      this.memory.epromOn = false;
      return;
    }
    this.memory.basicRomOn = !this.microdisc.romDisabled;
    this.memory.epromOn = this.microdisc.romDisabled && this.microdisc.epromSelected;
  }

  /**
   * The VIA's port A is a secondary bus: the PSG's data lines and the printer.
   * Its port B carries the keyboard row select, the keyboard sense input, the
   * printer strobe and the cassette in/out.
   *
   * The PSG selects itself from the CA2/CB2 output levels, so it acts on a PCR
   * write and on a port A write, in that order — which is exactly the ROM's
   * three-step `PCR; ORA; PCR` bus cycle for a register write.
   */
  private wireVia(): void {
    this.via.portAInput = 0xFF;
    this.via.portBInput = 0xFF;

    this.via.onPcrWrite = (pcr) => this.psg.onPcrWrite(this.via, pcr);

    this.via.onPortAWrite = (value, _ddr) => {
      // The PSG samples the port's *output* pins, so the raw written value is
      // what it sees — not the value masked against the data-direction register.
      this.psg.onPortAWrite(this.via, value & 0xFF);
      // A PSG read cycle leaves the register's contents on port A; a write
      // cycle leaves the keyboard's columns there. Either way the sense line
      // depends on it.
      this.refreshPortBInput();
      this.activity.psgWrites++;
    };
    this.via.onPortBWrite = (value, ddr) => {
      // The keyboard sense line is an input, so recompute it whenever the row
      // select changes (or a PSG column select above).
      this.via.portBInput = this.portBInput(value & ddr);
      // PB6 is the cassette motor relay, PB7 the data output.
      const driven = value & ddr;
      this.tape.setMotor((driven & ORIC_TAPE_MOTOR) !== 0);
      this.tape.observeOutput((driven & ORIC_TAPE_OUT) !== 0 ? 1 : 0, this.cpu.tStates);
    };

    this.refreshPortBInput();
  }

  /** Recompute the VIA's port B input latch from the driven row and the PSG's
   *  selected keyboard column. */
  private refreshPortBInput(): void {
    this.via.portBInput = this.portBInput(this.via.orb & this.via.ddrb);
  }

  /**
   * Port B's input pins: bit 3 is the keyboard sense line, which reads **high
   * when a key is pressed**, and the rest idle high. Bits the VIA drives are
   * merged in by the core itself, so the whole latch is returned.
   */
  private portBInput(outputs: number): number {
    const row = outputs & 0x07;
    const sense = this.keyboard.sense(row, this.psg.columns) ? 0x08 : 0x00;
    return (0xFF & ~0x08) | sense;
  }

  prepare(view: SettingsView): AuxRomRequest[] {
    this.fit(readOricOptions(view));
    return [];
  }

  applySettings(view: SettingsView): void {
    this.fit(readOricOptions(view));
    applyAySettings(this.psg.ay, view);
    // Master volume, plus the per-device gain the descriptor declares. With a
    // single sound device `soundDeviceGains` returns unity and the PSG slider
    // is the master — which is why the descriptor names `beeper-volume` for it.
    this.audio.setVolume(view.get('volume', 70) / 100);
    const gains = soundDeviceGains(this.descriptor.ui.soundDevices, view);
    this.mixer.ayGain = gains.psg ?? 1;
  }

  private fit(options: OricOptions): void {
    this.options = options;
    // Fit or remove the card. Its latch is the memory map, so re-derive that
    // and the page-3 decode as soon as it changes.
    if (options.microdisc && !this.microdisc) this.microdisc = new OricMicrodisc();
    else if (!options.microdisc) this.microdisc = null;
    this.syncMemoryMap();
    this.needsDisplay = true;
  }

  attachHost(host: MachineHost): void { this.host = host; }

  /** Burn the 16 KB system ROM. */
  loadROM(data: Uint8Array): void {
    if (!this.memory.loadRom(data)) {
      this.setStatus(`Oric ROM image has an unrecognised size (${data.length} bytes)`);
      return;
    }
    this.setStatus(`${oricModelInfo(this.model).label} ROM loaded (${data.length} bytes)`);
    this.needsDisplay = true;
  }

  /** Burn the Microdisc's 8 KB boot EPROM. */
  loadEprom(data: Uint8Array): boolean {
    const ok = this.memory.loadEprom(data);
    if (ok) this.setStatus(`Microdisc EPROM loaded (${data.length} bytes)`);
    return ok;
  }

  setBorderSize(mode: BorderMode): void {
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(ORIC_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(ORIC_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY, ORIC_SCREEN_WIDTH - cropX * 2, ORIC_SCREEN_HEIGHT - cropY * 2,
    );
  }

  reset(): void {
    this.stop();
    this.resetHardware();
    this.resetFrameCount();
    this.setStatus('Reset');
  }

  private resetHardware(): void {
    this.cancelPaste();
    this.cpu.reset();
    this.via.reset();
    this.psg.reset();
    this.keyboard.releaseAll();
    this.memory.reset();
    this.ula.reset();
    // The tape keeps its mounted signal across a reset, as a real deck keeps
    // its cassette; only the transport position returns to the start.
    this.tape.reset();
    // A fitted card is *not* unplugged by a reset: its latch keeps whatever it
    // was left holding, which is exactly how a Microdisc boots — the latch is
    // already mapping the overlay and the EPROM when the CPU comes out of
    // reset, and the EPROM's own code reads the disk. Resetting it here put the
    // BASIC ROM back and the boot never started.
    this.microdisc?.reset();
    this.syncMemoryMap();
    this.activity.keyboardReads = 0;
    this.activity.psgWrites = 0;
    this.mixer.reset();
    this.audio.reset();
    this.wireVia();
    this.drawFrame();
  }

  protected framePixels(): Uint8Array { return this.pixels; }
  protected inTurbo(): boolean { return this.turbo; }
  protected override exitTurbo(): void { this.mixer.reset(); }

  private drawFrame(): void {
    this.needsDisplay = true;
  }

  /** Draw the whole picture from memory: the ULA re-reads it every frame. */
  private renderScreen(): void {
    this.ula.beginFrame();
    for (let line = 0; line < ORIC_ACTIVE_HEIGHT; line++) this.ula.renderLine(line);
    this.ula.endFrame();
    this.needsDisplay = true;
  }

  // ── Beam ─────────────────────────────────────────────────────────────────
  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: ORIC_CYCLES_PER_LINE,
      linesPerFrame: this.ula.sixtyHz ? 260 : ORIC_LINES_PER_FRAME,
      displayStart: 0,
      note: 'The ULA shows 224 lines of 64 cycles; the 50 Hz frame is 312 lines, the 60 Hz one 260. One column of the display is one microsecond.',
    };
  }

  stepInstruction(): void {
    const before = this.cpu.tStates;
    this.beforeInsn(this.cpu.pc);
    this.cpu.step();
    this.clockChips(this.cpu.tStates - before);
    this.afterInsn();
    this.renderScreen();
  }

  /** Advance the VIA; its timer 1 is the ROM's 100 Hz interrupt. */
  private clockChips(elapsed: number): void {
    this.via.addCycles(elapsed);
    // The cassette only costs anything while a tape is mounted: an idle deck
    // has a static data line, so the per-instruction work is skipped outright.
    if (this.tape.loaded) {
      // CB1 carries the cassette's data line, so the deck runs as the machine
      // does and the ROM's edge-timed decoder sees a real signal.
      this.tape.advance(elapsed);
      this.via.setCB1(this.tape.earBit !== 0);
    }
    // PB7 is the cassette output. With ACR bit 7 the VIA's own timer drives
    // that pin, which is how the ROM's SAVE produces its 2400 Hz tone, so the
    // effective level has to be read from whichever source owns it.
    if ((this.via.acr & 0x80) !== 0) {
      this.tape.observeOutput(this.via.pb7 ? 1 : 0, this.cpu.tStates);
    }
    this.cpu.setIRQ(this.via.irq || (this.microdisc?.irq ?? false));
  }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    const cycles = this.tStatesPerFrame;
    if (!this.openFrame(cycles)) {
      this.activity.keyboardReads = 0;
      this.activity.psgWrites = 0;
      this.feedPaste();
    }
    this.memWatchHit = null;
    const endT = this.frameEndT;

    while (this.cpu.tStates < endT) {
      if (this.checkStops(this.cpu.pc)) {
        this.midFrame = true;
        this.renderScreen();
        return;
      }
      const before = this.cpu.tStates;
      this.beforeInsn(this.cpu.pc);
      this.cpu.step();
      const elapsed = this.cpu.tStates - before;
      this.clockChips(elapsed);
      const stopped = this.afterInsn();
      if (!skipAudio) {
        this.mixer.accumulate(0, elapsed);
        this.mixer.generateSamples(this.audio, this.psg.ay, true);
      }
      if (stopped) {
        this.midFrame = true;
        this.renderScreen();
        return;
      }
    }
    this.renderScreen();
  }

  // ── Paste (typed listings) ───────────────────────────────────────────────
  /** Queue `text` at the keyboard, one key at a time. Newlines are RETURN. */
  typeText(text: string): number {
    const keys = [...text.replace(/\r\n?/g, '\n')]
      .filter((ch) => ch === '\n' || ch === ' ' || oricCharLookup().has(ch));
    this.paste = keys;
    this.pasteAt = 0;
    this.pasteHold = 0;
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

  /** Hand the ROM the next queued key, held long enough for a scan. */
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
    if (ch === '\n') this.keyboard.setCell(7, 5, true);
    else this.keyboard.pressChar(ch);
    this.pasteHold = PASTE_HOLD_FRAMES;
  }

  // ── Debug / OCR surface ──────────────────────────────────────────────────
  ocrScreenForMcp(_mode?: string): string {
    return ocrOricText(this.memory.ram).text;
  }

  ocrScreenStyled(): OcrResult {
    return ocrOricText(this.memory.ram);
  }

  get textField(): { x: number; y: number; width: number; height: number } {
    return OricUla.activeRect;
  }

  blankCells(mask: boolean[]): void { this.ula.blankCells(mask); }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: 'oric-ram.bin' };
  }

  screenExportBytes(): Uint8Array | null {
    // The RAW/SCR-style export: the text screen alone, 40x28.
    const out = new Uint8Array(ORIC_TEXT_COLS * ORIC_TEXT_ROWS);
    out.set(this.memory.ram.subarray(0xBB80, 0xBB80 + out.length));
    return out;
  }

  chips() { return oricChips(this); }

  /** The memory-layout pane: what the CPU sees in each block right now. */
  memoryMap(): MemoryMapSnapshot {
    const ram = this.memory;
    const top = ram.basicRomOn ? 'BASIC ROM'
      : ram.epromOn ? 'Overlay RAM + Microdisc EPROM' : 'Overlay RAM';
    return {
      slots: [
        { range: '0000-BFFF', read: 'RAM (48K)' },
        { range: '0300-03FF', read: 'I/O: VIA, Microdisc', write: 'I/O' },
        {
          range: 'C000-FFFF', read: top, write: ram.basicRomOn ? '—' : 'RAM',
          flags: ram.basicRomOn ? [] : ['active'],
        },
        { range: '9800-BBFF', read: 'Character set', flags: ['screen'] },
        { range: 'A000-BF3F', read: 'Hires screen', flags: ['screen'] },
        { range: 'BB80-BFDF', read: 'Text screen (40x28)', flags: ['screen'] },
      ],
      registers: [
        { name: 'ROMDIS', value: ram.basicRomOn ? 'ROM' : 'overlay' },
        { name: 'EPROM', value: ram.epromOn ? 'on' : 'off' },
        { name: 'Mode', value: this.ula.hires ? (this.ula.sixtyHz ? 'HIRES 60' : 'HIRES 50')
          : (this.ula.sixtyHz ? 'TEXT 60' : 'TEXT 50') },
      ],
    };
  }

  // ── Snapshots (.oricstate; see shared/native-state.ts) ───────────────────
  stateRomCrcs(): number[] {
    return [crc32(this.memory.rom), crc32(this.memory.eprom)];
  }

  saveState(w: StateWriter, _withMedia: boolean): void {
    this.completeFrame();
    w.section('CONF', () => {
      w.str(this.model);
      w.bool(this.memory.basicRomOn);
      w.bool(this.memory.epromOn);
    });
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameNumber); w.f64(this.frameStartT); w.f64(this.frameEndT);
      w.u8(this.ula.mode); w.u16(this.ula.fieldCounter);
      w.u8(this.psg.columns);
    });
    w.section('MEM ', () => w.raw(this.memory.ram));
    w.section('VIA ', () => this.via.saveState(w));
    w.section('PSG ', () => this.psg.ay.saveState(w));
    w.section('TAPE', () => this.tape.saveState(w));
  }

  loadState(r: StateReader): void {
    const conf = r.section('CONF');
    conf.str();
    this.memory.basicRomOn = conf.bool();
    this.memory.epromOn = conf.bool();

    this.midFrame = false;
    this.clearInterrupts();
    this.cancelPaste();
    this.keyboard.releaseAll();
    this.cpu.loadState(r.section('CPU '));
    {
      const s = r.section('MACH');
      this.frameNumber = s.f64(); this.frameStartT = s.f64(); this.frameEndT = s.f64();
      this.ula.mode = s.u8(); this.ula.fieldCounter = s.u16();
      this.psg.columns = s.u8();
    }
    r.section('MEM ').rawInto(this.memory.ram);
    this.via.loadState(r.section('VIA '));
    this.psg.ay.loadState(r.section('PSG '));
    this.tape.loadState(r.section('TAPE'));
    this.cpu.setIRQ(false);
    this.activity.keyboardReads = 0;
    this.activity.psgWrites = 0;
    this.mixer.reset();
    this.audio.reset();
    this.renderScreen();
  }

  // ── Trace ───────────────────────────────────────────────────────────────
  protected override tracer = new M6502Trace(this, {
    io: [[ORIC_IO_BASE, ORIC_IO_END]],
    ioLabel: oricIoLabel,
  });
}

/** Chars the paste path can type. */
function oricCharLookup(): Set<string> {
  const out = new Set<string>();
  for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') out.add(ch);
  for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') out.add(ch);
  return out;
}

/** Portio-trace names for the VIA's registers. */
function oricIoLabel(addr: number): string {
  if (addr < ORIC_IO_BASE || addr >= ORIC_IO_END) return '';
  return [
    'ORB', 'ORA', 'DDRB', 'DDRA', 'T1CL', 'T1CH', 'T1LL', 'T1LH',
    'T2CL', 'T2CH', 'SR', 'ACR', 'PCR', 'IFR', 'IER', 'ORAh',
  ][addr & ORIC_VIA_MASK];
}
