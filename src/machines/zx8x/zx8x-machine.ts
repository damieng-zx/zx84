import { Z80 } from '@/cores/z80.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, MachineTraceMode, SettingsView,
} from '@/machines/machine.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type { OcrGridName, OcrResult } from '@/ocr/ocr.ts';
import type { Zx8xModel } from './models.ts';
import { Zx8xMemory } from './memory.ts';
import { Zx8xKeyboard } from './keyboard.ts';
import { zx8xDescriptor } from './descriptor.ts';
import { Zx8xScreenText } from './screen-text.ts';
import { createZx8xServices, type Zx8xServices } from './services/index.ts';
import {
  ZX8X_ACTIVE_HEIGHT, ZX8X_ACTIVE_WIDTH, ZX8X_BORDER_LEFT, ZX8X_BORDER_TOP,
  ZX8X_CPU_CLOCK, ZX8X_LINES_PER_FRAME, ZX8X_SCREEN_HEIGHT, ZX8X_SCREEN_WIDTH, ZX8X_T_PER_FRAME,
} from './constants.ts';

const WHITE = 0xffffffff;
const BLACK = 0xff000000;
const PSEUDO_HIRES_ROW_BYTES = 32;
const PSEUDO_HIRES_MAX_ROWS = 192;
const PSEUDO_HIRES_TEXT_MAX_ROWS = 64;
// A normal ZX81 scanline is 207T. Software-only hi-res rows are accepted only
// when their 32 display M1 fetches are contiguous 4T NOP cycles and bracketed
// by the program's sync pulses; this rejects arbitrary high-memory execution.
const PSEUDO_HIRES_SYNC_MAX_AGE_T = 207;
const PSEUDO_HIRES_FRAME_GAP_T = 512;
const PSEUDO_HIRES_TIMEOUT_T = ZX8X_T_PER_FRAME * 2;
const ZX81_CDFLAG = 0x403b;
const MEMOTECH_DFILE = 0x407b;
const MEMOTECH_ROW_BYTES = 33;
const MEMOTECH_PIXEL_BYTES = 31;
const QUICKSILVA_RAM = 0xa000;
const MEMOTECH_ROM_SOURCE = 'https://raw.githubusercontent.com/charlierobson/EightyOne/master/Source/ROMs/Graphics/memotechhrg.rom';
const QUICKSILVA_ROM_SOURCE = 'https://raw.githubusercontent.com/charlierobson/EightyOne/master/Source/ROMs/Graphics/quicksilvahires.rom';

export class Zx8xMachine extends BaseMachine implements Machine {
  protected get audioChip(): AY3891x { return this.ay; }
  readonly kind: MachineKind = 'zx8x';
  readonly model: Zx8xModel;
  readonly cpu = new Z80();
  readonly memory: Zx8xMemory;
  readonly keyboard = new Zx8xKeyboard();
  readonly screenText = new Zx8xScreenText();
  readonly ay = new AY3891x(ZX8X_CPU_CLOCK, 48000, 'ABC');
  readonly audio = new Audio();
  readonly mixer = new AudioMixer(ZX8X_CPU_CLOCK);
  readonly services: Zx8xServices;
  readonly activity = { kbdReads: 0 };
  host: MachineHost | null = null;
  display: IScreenRenderer | null;

  private readonly frame = new Uint8Array(ZX8X_SCREEN_WIDTH * ZX8X_SCREEN_HEIGHT * 4);
  private readonly frame32 = new Uint32Array(this.frame.buffer);
  private nmiEnabled = false;
  private memotechMode = 0;
  private quickSilvaMode = false;
  private m1ReadPending = false;
  private readonly pseudoHiresRow = new Uint8Array(PSEUDO_HIRES_ROW_BYTES);
  private readonly pseudoHiresBuilding = new Uint8Array(PSEUDO_HIRES_ROW_BYTES * PSEUDO_HIRES_MAX_ROWS);
  private readonly pseudoHiresFrame = new Uint8Array(PSEUDO_HIRES_ROW_BYTES * PSEUDO_HIRES_MAX_ROWS);
  private readonly pseudoHiresBuildingWidths = new Uint8Array(PSEUDO_HIRES_MAX_ROWS);
  private readonly pseudoHiresFrameWidths = new Uint8Array(PSEUDO_HIRES_MAX_ROWS);
  private readonly pseudoHiresTextBuilding = new Uint8Array(PSEUDO_HIRES_ROW_BYTES * PSEUDO_HIRES_TEXT_MAX_ROWS);
  private readonly pseudoHiresTextFrame = new Uint8Array(PSEUDO_HIRES_ROW_BYTES * PSEUDO_HIRES_TEXT_MAX_ROWS);
  private pseudoHiresRunLength = 0;
  private pseudoHiresRunValid = false;
  private pseudoHiresRunIsText = false;
  private pseudoHiresRunCommitOnFinish = false;
  private pseudoHiresRunIsUdg = false;
  private pseudoHiresRunIsWrx = false;
  private pseudoHiresRunGlyphRow = 0;
  private pseudoHiresRowWidth = PSEUDO_HIRES_ROW_BYTES;
  private pseudoHiresRowReady = false;
  private pseudoHiresRowIsText = false;
  private pseudoHiresBuildingRows = 0;
  private pseudoHiresBuildingMode: 'software' | 'udg' | 'wrx' | null = null;
  private pseudoHiresFrameRows = 0;
  private pseudoHiresTextBuildingRows = 0;
  private pseudoHiresTextFrameRows = 0;
  private pseudoHiresLastSyncT = -1;
  private pseudoHiresLastCommittedRowT = -1;
  private pseudoHiresLastTextRowT = -1;
  private pseudoHiresLastTextRunT = -1;
  private pseudoHiresTextLineCounter = 0;
  private pseudoHiresLastFetchT = -1;

  constructor(model: Zx8xModel, display: IScreenRenderer | null = null) {
    super();
    this.model = model;
    this.display = display;
    this.memory = new Zx8xMemory(model);
    this.mixer.beeperGain = 0;
    this.mixer.ayGain = 0;
    this.installCpuBus();
    this.installCpuStep();
    this.services = createZx8xServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }
  get descriptor(): MachineDescriptor { return zx8xDescriptor(this.model); }
  get pixels(): Uint8Array { return this.frame; }
  get frameWidth(): number { return ZX8X_SCREEN_WIDTH; }
  get frameHeight(): number { return ZX8X_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number { return ZX8X_T_PER_FRAME; }
  get cpuClockHz(): number { return ZX8X_CPU_CLOCK; }

  private installCpuBus(): void {
    this.cpu.read8 = (addr: number): number => {
      addr &= 0xffff;
      const m1 = this.m1ReadPending;
      if (m1) this.m1ReadPending = false;
      if (this.memory.hasQuickSilvaHrg && addr >= 0x2000 && addr < 0x4000) {
        this.quickSilvaMode = true;
      }
      let value = this.memory.hasMemotechHrg && (this.cpu.i & 1) !== 0 && addr < 0x400
        ? this.memory.readMemotechOverlay(addr)
        : this.memory.readByte(addr);
      // During an opcode fetch from the echoed display file the ULA presents a
      // NOP for a character byte; a 0x76 line terminator remains HALT.
      if (m1 && addr >= 0x8000 && (value & 0x40) === 0) value = 0x00;
      if (this.memWatchpoints.length && this.memWatchHit === null) {
        for (const wp of this.memWatchpoints) if ((wp.mode === 'read' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          this.memWatchHit = { addr, value, dir: 'read' }; break;
        }
      }
      return value;
    };
    this.cpu.write8 = (addr: number, value: number): void => {
      addr &= 0xffff;
      if (this.memory.hasQuickSilvaHrg && addr >= 0x2000 && addr < 0x4000) {
        this.quickSilvaMode = false;
      }
      this.memory.writeByte(addr, value);
      if (this.memWatchpoints.length && this.memWatchHit === null) {
        for (const wp of this.memWatchpoints) if ((wp.mode === 'write' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          this.memWatchHit = { addr, value: value & 0xff, dir: 'write' }; break;
        }
      }
    };
    this.cpu._contendAccurate = () => {};
    this.cpu.contend = () => {};
    this.cpu.portInHandler = (port: number): number => {
      if (this.memory.hasMemotechHrg && (port & 0xff) === 0x5f) {
        this.memotechMode = (port >> 8) & 0xff;
        return 0xff;
      }
      this.activity.kbdReads++;
      const value = 0x60 | this.keyboard.read((port >> 8) & 0xff);
      if (this.portWatchpoints.has(port & 0xffff) && this.portWatchHit === null) this.portWatchHit = { port: port & 0xffff, value, dir: 'in' };
      return value;
    };
    this.cpu.portOutHandler = (port: number, value: number): void => {
      const low = port & 0xff;
      if (this.model === 'zx81') {
        this.observeZx81SyncStart();
        if (low === 0xfe) this.nmiEnabled = true;
        else if (low === 0xfd) this.nmiEnabled = false;
      }
      if (this.portWatchpoints.has(port & 0xffff) && this.portWatchHit === null) this.portWatchHit = { port: port & 0xffff, value: value & 0xff, dir: 'out' };
    };
  }

  /** Mark the first memory read of every CPU step as its M1 opcode fetch.
   * This keeps ZX81 video interception machine-local and also covers debugger
   * stepping, whose debug service calls cpu.step() directly. */
  private installCpuStep(): void {
    const step = this.cpu.step.bind(this.cpu);
    this.cpu.step = (): void => {
      this.observePseudoHiresM1();
      this.m1ReadPending = true;
      try { step(); } finally { this.m1ReadPending = false; }
    };
  }

  loadROM(data: Uint8Array): void { this.memory.loadROM(data); }

  applySettings(view: SettingsView): void {
    this.memory.set16kExpansion(view.get('zx8x-16k-ram', false));
    this.memory.setUdgRam(false);
    this.memory.setUdg128Ram(false);
    this.memory.setWrxRam(false);
    this.memory.setMemotechHrg(false);
    this.memory.setQuickSilvaHrg(false);
    if (this.model === 'zx81') {
      if (view.get('zx81-quicksilva-hrg', false)) this.memory.setQuickSilvaHrg(true);
      else if (view.get('zx81-memotech-hrg', false)) this.memory.setMemotechHrg(true);
      else if (view.get('zx81-wrx-hires', false)) this.memory.setWrxRam(true);
      else if (view.get('zx81-udg128-ram', false)) this.memory.setUdg128Ram(true);
      else if (view.get('zx81-udg-ram', false)) this.memory.setUdgRam(true);
    }
    this.audio.setVolume(view.get('volume', 70) / 100);
  }

  prepare(view: SettingsView): AuxRomRequest[] {
    this.applySettings(view);
    if (this.memory.hasMemotechHrg) return [this.hrgAuxRom('memotech')];
    if (this.memory.hasQuickSilvaHrg) return [this.hrgAuxRom('quicksilva')];
    return [];
  }

  private hrgAuxRom(board: 'memotech' | 'quicksilva'): AuxRomRequest {
    const label = board === 'memotech' ? 'Memotech HRG' : 'QuickSilva HRG';
    return {
      cacheKey: `zx81-${board}-hrg-rom`,
      source: board === 'memotech' ? MEMOTECH_ROM_SOURCE : QUICKSILVA_ROM_SOURCE,
      fetchingMsg: `Fetching ${label} ROM…`,
      loadedMsg: bytes => `${label} ROM loaded (${bytes} bytes)`,
      failMsg: `Failed to load ${label} ROM`,
      failId: `zx81-${board}-hrg`,
      apply: data => this.memory.loadHrgROM(data),
      awaitLoad: true,
    };
  }

  loadProgram(data: Uint8Array, address: number): void {
    this.stop();
    this.reset();
    this.memory.loadRamImage(data, address);
    this.cpu.iy = 0x4000;
    this.cpu.i = this.model === 'zx80' ? 0x0e : 0x1e;
    if (this.model === 'zx81') {
      this.prepareZx81LoadedProgram();
    } else {
      this.cpu.sp = this.memory.has16kExpansion ? 0x7ffc : 0x43fc;
      this.cpu.pc = 0x0283;
    }
    this.renderCurrentVideo();
    this.needsDisplay = true;
    // Browser loads resume the live frame loop; the headless MCP deliberately
    // advances with tick()/runUntil() and has no requestAnimationFrame.
    if (this.display) void this.start();
  }

  /** Restore the CPU and the nine RAM bytes omitted from a ZX81 .p image.
   *
   * A real LOAD resumes at SLOW/FAST ($0207) after LOAD/SAVE has discarded its
   * own return address. The remaining stack returns through $0676 into the
   * BASIC next-line path. These values are the stable post-LOAD state recorded
   * by sz81; without them the first RET lands at $0000 and RAM-CHECK erases the
   * program a few frames later. */
  private prepareZx81LoadedProgram(): void {
    const expanded = this.memory.has16kExpansion;
    const ramTop = expanded ? 0x8000 : 0x4400;
    const sp = ramTop - 4;

    this.cpu.a = 0x0b; this.cpu.f = 0x00;
    this.cpu.b = 0x00; this.cpu.c = 0x02;
    this.cpu.d = expanded ? 0x43 : 0x40; this.cpu.e = 0x9b;
    this.cpu.h = expanded ? 0x43 : 0x40; this.cpu.l = 0x99;
    this.cpu.a_ = expanded ? 0xec : 0xf8; this.cpu.f_ = 0xa9;
    this.cpu.b_ = expanded ? 0x81 : 0x00; this.cpu.c_ = expanded ? 0x02 : 0x00;
    this.cpu.d_ = 0x00; this.cpu.e_ = 0x2b;
    this.cpu.h_ = 0x00; this.cpu.l_ = 0x00;
    this.cpu.ix = 0x0281;
    this.cpu.iy = 0x4000;
    this.cpu.i = 0x1e;
    this.cpu.r = 0xdd;
    this.cpu.sp = sp;
    this.cpu.pc = 0x0207;
    this.cpu.iff1 = false;
    this.cpu.iff2 = false;
    // sz81's internal value 2 denotes Z80 interrupt mode 1. Our Z80 core
    // uses the conventional 0/1/2 values, so translate it rather than
    // copying the emulator-internal representation literally.
    this.cpu.im = 1;

    // ERR_NR, FLAGS, ERR_SP, RAMTOP, MODE, PPC — not present in .p files,
    // whose first byte maps to VERSN at $4009.
    const prefix = [0xff, 0x80, sp & 0xff, sp >> 8, ramTop & 0xff, ramTop >> 8, 0x00, 0xfe, 0xff];
    for (let i = 0; i < prefix.length; i++) this.memory.writeByte(0x4000 + i, prefix[i]);

    // Return to the ROM's post-command next-line path, followed by its normal
    // stack sentinel. Little-endian words: $0676, $3E00.
    this.memory.writeByte(sp + 0, 0x76);
    this.memory.writeByte(sp + 1, 0x06);
    this.memory.writeByte(sp + 2, 0x00);
    this.memory.writeByte(sp + 3, 0x3e);
    this.nmiEnabled = false;
    this.memotechMode = 0;
    this.quickSilvaMode = false;
  }

  private read16(addr: number): number {
    return this.memory.readByte(addr) | (this.memory.readByte(addr + 1) << 8);
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.memory.reset();
    this.keyboard.reset();
    this.nmiEnabled = false;
    this.audio.reset();
    this.mixer.reset();
    this.resetPseudoHires();
    this.frame32.fill(WHITE);
    this.needsDisplay = true;
  }

  setBorderSize(mode: BorderMode): void {
    const fraction = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(ZX8X_BORDER_LEFT * (1 - fraction));
    const cropY = Math.round(ZX8X_BORDER_TOP * (1 - fraction));
    this.display?.setViewport(cropX, cropY, ZX8X_SCREEN_WIDTH - cropX * 2, ZX8X_SCREEN_HEIGHT - cropY * 2);
  }

  protected framePixels(): Uint8Array { return this.frame; }
  protected inTurbo(): boolean { return this.turbo; }

  protected runFrame(): void {
    this.activity.kbdReads = 0;
    const lineT = ZX8X_T_PER_FRAME / ZX8X_LINES_PER_FRAME;
    let lineEnd = this.cpu.tStates;
    let lastAudio = this.cpu.tStates;
    let broke = false;
    for (let line = 0; line < ZX8X_LINES_PER_FRAME; line++) {
      lineEnd += lineT;
      if (this.model === 'zx81' && this.nmiEnabled) this.cpu.nmi();
      while (this.cpu.tStates < lineEnd) {
        if (this.breakpoints.has(this.cpu.pc)) { this.breakpointHit = this.cpu.pc; broke = true; break; }
        if (this.onTrap?.(this.cpu.pc)) { broke = true; break; }
        // EI suppresses interrupts for one instruction; step() itself resets
        // and re-arms eiDelay per-instruction (see core.ts), so a plain
        // post-step check is enough here.
        this.cpu.step();
        if (this.cpu.halted && this.cpu.pc >= 0xc000 && this.cpu.iff1 && !this.cpu.eiDelay) this.cpu.interrupt();
        const elapsed = this.cpu.tStates - lastAudio;
        if (!this.turbo && elapsed > 0) {
          this.mixer.accumulate(0, elapsed);
          this.mixer.generateSamples(this.audio, null, false);
          lastAudio = this.cpu.tStates;
        }
      }
      if (broke) break;
    }
    this.renderCurrentVideo();
    this.needsDisplay = true;
  }

  /** Capture the video byte selected during this M1 fetch.
   *
   * Software-only hi-res temporarily points I at a nonstandard ROM page and
   * executes a 32-byte display stream in the A15-high memory echo. The ULA
   * gives the CPU NOPs while latching one 8-pixel pattern per 4T fetch. The
   * program restores I before the frame ends, so this must happen alongside
   * CPU execution rather than in the post-frame D_FILE renderer. */
  private observePseudoHiresM1(): void {
    const pc = this.cpu.pc & 0xffff;
    const raw = this.memory.readByte(pc);
    const fontPage = this.cpu.i & 0xff;
    const patternBase = (fontPage & 0xfe) << 8;
    const wrxAddress = (fontPage << 8) | (this.cpu.r & 0xff);
    const isUdg = this.memory.isUdgPatternAddress(patternBase);
    const isUdg128 = this.memory.isUdg128PatternAddress(patternBase);
    const isWrx = this.memory.isWrxBitmapAddress(wrxAddress);
    const isPseudoHires = this.model === 'zx81'
      && (pc & 0x8000) !== 0
      && (raw & 0x40) === 0
      && (fontPage < 0x20 || isUdg || isWrx);

    if (!isPseudoHires) {
      this.finishPseudoHiresRow();
      return;
    }

    const now = this.cpu.tStates;
    if (this.pseudoHiresRunLength === 0) {
      // A fresh display stream must follow a software-generated sync pulse.
      // Any unconsumed row means another stream began without the delimiter
      // that real pseudo-hires routines use, so discard it.
      this.pseudoHiresRowReady = false;
      const followsSync = this.pseudoHiresLastSyncT >= 0
        && now - this.pseudoHiresLastSyncT <= PSEUDO_HIRES_SYNC_MAX_AGE_T;
      // The first visible row after vertical blank can begin more than one
      // scanline after the preceding OUT. Once a real row has established the
      // stream, accept that frame boundary as well as an immediately preceding
      // horizontal sync pulse.
      const followsFrameGap = this.pseudoHiresLastCommittedRowT >= 0
        && now - this.pseudoHiresLastCommittedRowT > PSEUDO_HIRES_FRAME_GAP_T;
      // Explicit UDG/WRX hardware supplies its own qualified video source.
      // ROM pseudo-hires still needs the software sync contract to distinguish
      // it from arbitrary high-memory execution.
      this.pseudoHiresRunValid = isUdg || isWrx || followsSync || followsFrameGap;
      this.pseudoHiresRunIsText = fontPage === 0x1e;
      this.pseudoHiresRunCommitOnFinish = this.pseudoHiresRunIsText || isUdg || isWrx;
      this.pseudoHiresRunIsUdg = isUdg;
      this.pseudoHiresRunIsWrx = isWrx;
      if ((this.pseudoHiresRunIsText || isUdg) && !isWrx) {
        if (this.pseudoHiresLastTextRunT >= 0
            && now - this.pseudoHiresLastTextRunT <= PSEUDO_HIRES_SYNC_MAX_AGE_T) {
          this.pseudoHiresTextLineCounter = (this.pseudoHiresTextLineCounter + 1) & 7;
        } else {
          this.pseudoHiresTextLineCounter = 0;
        }
        this.pseudoHiresLastTextRunT = now;
        this.pseudoHiresRunGlyphRow = this.pseudoHiresTextLineCounter;
      } else {
        // Pseudo-hires resets the modulo-8 line counter for every raster row.
        this.pseudoHiresRunGlyphRow = 0;
      }
      this.pseudoHiresRow.fill(0);
    } else if (now - this.pseudoHiresLastFetchT !== 4) {
      this.pseudoHiresRunValid = false;
    }

    if (this.pseudoHiresRunLength < PSEUDO_HIRES_ROW_BYTES) {
      const charIndex = (raw & 0x3f) | (isUdg128 ? ((raw & 0x80) >> 1) : 0);
      const glyph = patternBase | (charIndex << 3) | this.pseudoHiresRunGlyphRow;
      let bits = this.pseudoHiresRunIsWrx
        ? this.memory.readByte(wrxAddress)
        : this.memory.readByte(glyph);
      if ((raw & 0x80) && !isUdg128) bits ^= 0xff;
      this.pseudoHiresRow[this.pseudoHiresRunLength] = bits;
    }
    this.pseudoHiresRunLength++;
    this.pseudoHiresLastFetchT = now;
  }

  private finishPseudoHiresRow(): void {
    if (this.pseudoHiresRunLength === 0) return;
    const commitOnFinish = this.pseudoHiresRunCommitOnFinish;
    const mainMode = this.pseudoHiresRunIsWrx ? 'wrx' : this.pseudoHiresRunIsUdg ? 'udg' : 'software';
    const runLength = this.pseudoHiresRunLength;
    this.pseudoHiresRowReady = this.pseudoHiresRunValid
      && (runLength === PSEUDO_HIRES_ROW_BYTES
        || (this.pseudoHiresRunIsWrx && runLength > 0 && runLength < PSEUDO_HIRES_ROW_BYTES));
    this.pseudoHiresRowWidth = Math.min(runLength, PSEUDO_HIRES_ROW_BYTES);
    this.pseudoHiresRowIsText = this.pseudoHiresRunIsText;
    this.pseudoHiresRunLength = 0;
    this.pseudoHiresRunValid = false;
    this.pseudoHiresRunIsText = false;
    this.pseudoHiresRunCommitOnFinish = false;
    this.pseudoHiresRunIsUdg = false;
    this.pseudoHiresRunIsWrx = false;
    // Standard-font scanlines are paced by the ZX81's NMI display cycle and
    // UDG/WRX hardware rows likewise do not use pseudo-hires' software OUT
    // delimiter. WRX1K programs use miniature rows from 1 to 31 bytes wide;
    // WRX16 and UDG normally use the full 32 bytes.
    if (this.pseudoHiresRowReady && commitOnFinish) {
      if (this.pseudoHiresRowIsText) this.commitPseudoHiresTextRow();
      else this.commitPseudoHiresMainRow(mainMode);
      this.pseudoHiresRowReady = false;
      this.pseudoHiresRowIsText = false;
    }
  }

  private commitPseudoHiresMainRow(mode: 'software' | 'udg' | 'wrx'): void {
    const now = this.cpu.tStates;
    if (this.pseudoHiresBuildingRows > 0 && this.pseudoHiresBuildingMode !== mode) {
      this.finishPseudoHiresFrame();
    }
    if (this.pseudoHiresBuildingRows > 0 && this.pseudoHiresLastCommittedRowT >= 0) {
      const delta = now - this.pseudoHiresLastCommittedRowT;
      if (mode === 'wrx') {
        // Compact WRX1K routines may omit completely blank scanlines. Preserve
        // their beam positions when the next run is an exact 207T multiple;
        // a gap over 32 lines is vertical blank and starts the next frame.
        const lines = Math.round(delta / PSEUDO_HIRES_SYNC_MAX_AGE_T);
        const timingError = Math.abs(delta - lines * PSEUDO_HIRES_SYNC_MAX_AGE_T);
        if (lines > 1 && lines <= 32 && timingError <= 8) {
          for (let line = 1; line < lines && this.pseudoHiresBuildingRows < PSEUDO_HIRES_MAX_ROWS; line++) {
            const offset = this.pseudoHiresBuildingRows * PSEUDO_HIRES_ROW_BYTES;
            this.pseudoHiresBuilding.fill(0, offset, offset + PSEUDO_HIRES_ROW_BYTES);
            this.pseudoHiresBuildingWidths[this.pseudoHiresBuildingRows] = this.pseudoHiresRowWidth;
            this.pseudoHiresBuildingRows++;
          }
        } else if (delta > PSEUDO_HIRES_FRAME_GAP_T) {
          this.finishPseudoHiresFrame();
        }
      } else if (delta > PSEUDO_HIRES_FRAME_GAP_T) {
        this.finishPseudoHiresFrame();
      }
    }
    if (this.pseudoHiresBuildingRows === PSEUDO_HIRES_MAX_ROWS) this.finishPseudoHiresFrame();
    if (this.pseudoHiresBuildingRows === 0) this.pseudoHiresBuildingMode = mode;
    this.pseudoHiresBuilding.set(
      this.pseudoHiresRow,
      this.pseudoHiresBuildingRows * PSEUDO_HIRES_ROW_BYTES,
    );
    this.pseudoHiresBuildingWidths[this.pseudoHiresBuildingRows] = this.pseudoHiresRowWidth;
    this.pseudoHiresBuildingRows++;
    this.pseudoHiresLastCommittedRowT = now;
  }

  private commitPseudoHiresTextRow(): void {
    const now = this.cpu.tStates;
    if (this.pseudoHiresTextBuildingRows > 0 && this.pseudoHiresLastTextRowT >= 0
        && now - this.pseudoHiresLastTextRowT > PSEUDO_HIRES_FRAME_GAP_T) {
      this.finishPseudoHiresTextFrame();
    }
    if (this.pseudoHiresTextBuildingRows === PSEUDO_HIRES_TEXT_MAX_ROWS) {
      this.finishPseudoHiresTextFrame();
    }
    this.pseudoHiresTextBuilding.set(
      this.pseudoHiresRow,
      this.pseudoHiresTextBuildingRows * PSEUDO_HIRES_ROW_BYTES,
    );
    this.pseudoHiresTextBuildingRows++;
    this.pseudoHiresLastTextRowT = now;
  }

  /** Every ZX81 OUT begins a sync interval. Pseudo-hires software issues one
   * after each RET-terminated raster row; using that real delimiter prevents
   * ordinary high-memory instruction streams from becoming bitmap noise. */
  private observeZx81SyncStart(): void {
    const now = this.cpu.tStates;
    if (this.pseudoHiresTextBuildingRows > 0 && this.pseudoHiresLastTextRowT >= 0
        && now - this.pseudoHiresLastTextRowT > PSEUDO_HIRES_FRAME_GAP_T) {
      this.finishPseudoHiresTextFrame();
    }
    if (this.pseudoHiresRowReady) {
      // Only a sync pulse that actually terminates a qualified display row can
      // delimit frames. Control OUTs elsewhere in the program must not publish
      // a one-row partial frame over the last complete raster.
      this.commitPseudoHiresMainRow('software');
    }
    this.pseudoHiresRowReady = false;
    this.pseudoHiresRowIsText = false;
    this.pseudoHiresLastSyncT = now;
  }

  private finishPseudoHiresFrame(): void {
    if (this.pseudoHiresBuildingRows === 0) return;
    // Manic Miner (and similar routines) performs an isolated display-shaped
    // transfer between its real raster passes. It is valid bus traffic, but
    // not a replacement frame. Debounce that solitary row once a multi-row
    // raster is established so it cannot flash as bitmap noise.
    if (this.pseudoHiresBuildingRows === 1 && this.pseudoHiresFrameRows > 1) {
      this.pseudoHiresBuildingRows = 0;
      this.pseudoHiresBuildingMode = null;
      return;
    }
    const length = this.pseudoHiresBuildingRows * PSEUDO_HIRES_ROW_BYTES;
    this.pseudoHiresFrame.fill(0);
    this.pseudoHiresFrame.set(this.pseudoHiresBuilding.subarray(0, length));
    this.pseudoHiresFrameWidths.fill(0);
    this.pseudoHiresFrameWidths.set(this.pseudoHiresBuildingWidths.subarray(0, this.pseudoHiresBuildingRows));
    this.pseudoHiresFrameRows = this.pseudoHiresBuildingRows;
    this.pseudoHiresBuildingRows = 0;
    this.pseudoHiresBuildingMode = null;
  }

  private finishPseudoHiresTextFrame(): void {
    if (this.pseudoHiresTextBuildingRows === 0) return;
    const length = this.pseudoHiresTextBuildingRows * PSEUDO_HIRES_ROW_BYTES;
    this.pseudoHiresTextFrame.fill(0);
    this.pseudoHiresTextFrame.set(this.pseudoHiresTextBuilding.subarray(0, length));
    this.pseudoHiresTextFrameRows = this.pseudoHiresTextBuildingRows;
    this.pseudoHiresTextBuildingRows = 0;
  }

  private pseudoHiresActive(): boolean {
    if (this.pseudoHiresFrameRows === 0) return false;
    if (this.pseudoHiresLastFetchT >= 0
        && this.cpu.tStates - this.pseudoHiresLastFetchT <= PSEUDO_HIRES_TIMEOUT_T) return true;
    this.pseudoHiresFrameRows = 0;
    return false;
  }

  private renderPseudoHires(): boolean {
    if (!this.pseudoHiresActive()) return false;
    if (this.pseudoHiresTextBuildingRows > 0 && this.pseudoHiresLastTextRowT >= 0
        && this.cpu.tStates - this.pseudoHiresLastTextRowT > PSEUDO_HIRES_FRAME_GAP_T) {
      this.finishPseudoHiresTextFrame();
    }
    this.frame32.fill(WHITE);
    const textRows = Math.min(
      this.pseudoHiresTextFrameRows,
      ZX8X_ACTIVE_HEIGHT - this.pseudoHiresFrameRows,
    );
    const totalRows = this.pseudoHiresFrameRows + textRows;
    const top = ZX8X_BORDER_TOP + ((ZX8X_ACTIVE_HEIGHT - totalRows) >> 1);
    for (let y = 0; y < this.pseudoHiresFrameRows; y++) {
      const width = this.pseudoHiresFrameWidths[y] || PSEUDO_HIRES_ROW_BYTES;
      const left = ZX8X_BORDER_LEFT + ((ZX8X_ACTIVE_WIDTH - width * 8) >> 1);
      const dest = (top + y) * ZX8X_SCREEN_WIDTH + left;
      const source = y * PSEUDO_HIRES_ROW_BYTES;
      for (let col = 0; col < width; col++) {
        const bits = this.pseudoHiresFrame[source + col];
        const px = dest + col * 8;
        for (let bit = 0; bit < 8; bit++) {
          this.frame32[px + bit] = bits & (0x80 >> bit) ? BLACK : WHITE;
        }
      }
    }
    for (let y = 0; y < textRows; y++) {
      const dest = (top + this.pseudoHiresFrameRows + y) * ZX8X_SCREEN_WIDTH + ZX8X_BORDER_LEFT;
      const source = y * PSEUDO_HIRES_ROW_BYTES;
      for (let col = 0; col < PSEUDO_HIRES_ROW_BYTES; col++) {
        const bits = this.pseudoHiresTextFrame[source + col];
        const px = dest + col * 8;
        for (let bit = 0; bit < 8; bit++) {
          this.frame32[px + bit] = bits & (0x80 >> bit) ? BLACK : WHITE;
        }
      }
    }
    return true;
  }

  private resetPseudoHires(): void {
    this.pseudoHiresRow.fill(0);
    this.pseudoHiresBuilding.fill(0);
    this.pseudoHiresFrame.fill(0);
    this.pseudoHiresBuildingWidths.fill(0);
    this.pseudoHiresFrameWidths.fill(0);
    this.pseudoHiresTextBuilding.fill(0);
    this.pseudoHiresTextFrame.fill(0);
    this.pseudoHiresRunLength = 0;
    this.pseudoHiresRunValid = false;
    this.pseudoHiresRunIsText = false;
    this.pseudoHiresRunCommitOnFinish = false;
    this.pseudoHiresRunIsUdg = false;
    this.pseudoHiresRunIsWrx = false;
    this.pseudoHiresRunGlyphRow = 0;
    this.pseudoHiresRowWidth = PSEUDO_HIRES_ROW_BYTES;
    this.pseudoHiresRowReady = false;
    this.pseudoHiresRowIsText = false;
    this.pseudoHiresBuildingRows = 0;
    this.pseudoHiresBuildingMode = null;
    this.pseudoHiresFrameRows = 0;
    this.pseudoHiresTextBuildingRows = 0;
    this.pseudoHiresTextFrameRows = 0;
    this.pseudoHiresLastSyncT = -1;
    this.pseudoHiresLastCommittedRowT = -1;
    this.pseudoHiresLastTextRowT = -1;
    this.pseudoHiresLastTextRunT = -1;
    this.pseudoHiresTextLineCounter = 0;
    this.pseudoHiresLastFetchT = -1;
  }

  /** Render software-generated pixels in either ZX81 mode. Ordinary display-
   * file video is available only in SLOW; FAST leaves the active area blank. */
  private renderCurrentVideo(): void {
    if (this.renderMemotechHrg() || this.renderQuickSilvaHrg()) return;
    if (this.renderPseudoHires()) return;
    if (this.model === 'zx81' && (this.memory.readByte(ZX81_CDFLAG) & 0x80) === 0) {
      this.frame32.fill(WHITE);
      return;
    }
    this.renderDisplayFile();
  }

  private renderMemotechHrg(): boolean {
    if (!this.memory.hasMemotechHrg || (this.cpu.i & 1) === 0
        || (this.memotechMode !== 2 && this.memotechMode !== 3)) return false;
    const pointer = this.read16(MEMOTECH_DFILE);
    if (pointer < 0x4000 || pointer > 0x7fff) return false;
    this.frame32.fill(WHITE);
    const inverse = this.memotechMode === 3;
    const left = ZX8X_BORDER_LEFT + 4;
    for (let y = 0; y < ZX8X_ACTIVE_HEIGHT; y++) {
      const source = pointer + y * MEMOTECH_ROW_BYTES + 2;
      const dest = (ZX8X_BORDER_TOP + y) * ZX8X_SCREEN_WIDTH + left;
      for (let col = 0; col < MEMOTECH_PIXEL_BYTES; col++) {
        const bits = this.memory.readByte(source + col) ^ (inverse ? 0xff : 0);
        for (let bit = 0; bit < 8; bit++) {
          this.frame32[dest + col * 8 + bit] = bits & (0x80 >> bit) ? BLACK : WHITE;
        }
      }
    }
    return true;
  }

  private renderQuickSilvaHrg(): boolean {
    if (!this.memory.hasQuickSilvaHrg || !this.quickSilvaMode) return false;
    this.frame32.fill(WHITE);
    for (let y = 0; y < ZX8X_ACTIVE_HEIGHT; y++) {
      const source = QUICKSILVA_RAM + y * PSEUDO_HIRES_ROW_BYTES;
      const dest = (ZX8X_BORDER_TOP + y) * ZX8X_SCREEN_WIDTH + ZX8X_BORDER_LEFT;
      for (let col = 0; col < PSEUDO_HIRES_ROW_BYTES; col++) {
        const bits = this.memory.readByte(source + col);
        for (let bit = 0; bit < 8; bit++) {
          this.frame32[dest + col * 8 + bit] = bits & (0x80 >> bit) ? BLACK : WHITE;
        }
      }
    }
    return true;
  }

  /** Render the current 32x24 display file with the character page selected by I. */
  private renderDisplayFile(): void {
    this.frame32.fill(WHITE);
    let ptr = this.read16(0x400c);
    if (ptr < 0x4000 || ptr > 0x7fff) return;
    if (this.memory.readByte(ptr) === 0x76) ptr++;
    const fontPage = this.cpu.i || (this.model === 'zx80' ? 0x0e : 0x1e);
    for (let row = 0; row < 24; row++) {
      let col = 0;
      while (col < 32) {
        const code = this.memory.readByte(ptr++);
        if (code === 0x76) break;
        const udg128 = this.memory.isUdg128PatternAddress(fontPage << 8);
        const inverse = (code & 0x80) !== 0 && !udg128;
        const charIndex = (code & 0x3f) | (udg128 ? ((code & 0x80) >> 1) : 0);
        const glyph = (fontPage << 8) + (charIndex << 3);
        for (let gy = 0; gy < 8; gy++) {
          const bits = this.memory.readByte(glyph + gy);
          const base = (ZX8X_BORDER_TOP + row * 8 + gy) * ZX8X_SCREEN_WIDTH + ZX8X_BORDER_LEFT + col * 8;
          for (let gx = 0; gx < 8; gx++) {
            const ink = ((bits >> (7 - gx)) & 1) !== 0;
            this.frame32[base + gx] = ink !== inverse ? BLACK : WHITE;
          }
        }
        col++;
      }
      // A collapsed display file uses an immediate newline for blank rows.
      if (col === 32 && this.memory.readByte(ptr) === 0x76) ptr++;
    }
  }

  screenExportBytes(): Uint8Array {
    const out = new Uint8Array((ZX8X_ACTIVE_WIDTH * ZX8X_ACTIVE_HEIGHT) >> 3);
    for (let y = 0; y < ZX8X_ACTIVE_HEIGHT; y++) {
      for (let xByte = 0; xByte < ZX8X_ACTIVE_WIDTH >> 3; xByte++) {
        let value = 0;
        const base = (ZX8X_BORDER_TOP + y) * ZX8X_SCREEN_WIDTH + ZX8X_BORDER_LEFT + xByte * 8;
        for (let bit = 0; bit < 8; bit++) if (this.frame32[base + bit] === BLACK) value |= 0x80 >> bit;
        out[y * 32 + xByte] = value;
      }
    }
    return out;
  }
  ocrScreenStyled(): OcrResult {
    if (this.pseudoHiresActive()) return this.screenText.ocrStyled(new Uint8Array(0x10000), this.model);
    return this.screenText.ocrStyled(this.memory.snapshot(), this.model);
  }
  blankTextCells(mask: readonly boolean[]): void {
    for (let row = 0; row < 24; row++) for (let col = 0; col < 32; col++) {
      if (!mask[row * 32 + col]) continue;
      for (let y = 0; y < 8; y++) {
        const start = (ZX8X_BORDER_TOP + row * 8 + y) * ZX8X_SCREEN_WIDTH + ZX8X_BORDER_LEFT + col * 8;
        this.frame32.fill(WHITE, start, start + 8);
      }
    }
    this.display?.updateTexture(this.frame);
  }
  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ramSnapshot(), filename: `ram-${this.memory.ramSize / 1024}k.bin` };
  }
  startTrace(_mode: MachineTraceMode = 'full'): void {}
  stopTrace(): string { return ''; }
  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    if (this.pseudoHiresActive()) return '[32x24]\n';
    return `[32x24]\n${this.screenText.ocr(this.memory.snapshot(), this.model)}`;
  }
  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    return value === 'rom0' ? { data: this.memory.getRom(), baseAddr: 0 } : null;
  }
}
