/**
 * Acorn Electron motherboard.
 *
 * A 2 MHz 6502 with 32K RAM and a 32K ROM holding the OS and BASIC, all run by
 * one custom chip, the ULA (see `electron-ula.ts`): it draws the picture,
 * decides who may use RAM, pages the ROMs, reads the keyboard, makes the sound
 * and drives the cassette. The frame loop runs the CPU a scanline (128 cycles)
 * at a time, drawing each line as it finishes so mid-frame mode and palette
 * changes show.
 *
 * Memory timing follows the ElectrEm notes: ROM runs at 2 MHz; any RAM access
 * drops the CPU to the 1 MHz clock (costing a cycle, plus another when the
 * 2 MHz and 1 MHz clocks are out of step); and in modes 0-3, while the ULA is
 * fetching display bytes (the first 40 µs of each of the 256 picture lines),
 * a RAM access waits for the fetch to finish. FRED and JIM (0xFC/0xFD) are
 * also 1 MHz.
 */

import { M6502 } from '@/cores/m6502.ts';
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
import {
  ocrElectronBitmap, findElectronFont, ELECTRON_MODE_COLS, ELECTRON_MODE_ROWS,
} from '@/ocr/electron.ts';
import { ELECTRON_ROM_SIZE, type ElectronModel } from './models.ts';
import { ElectronMemory } from './electron-memory.ts';
import { ElectronKeyboard } from './electron-keyboard.ts';
import {
  ElectronUla, INT_DISPLAY_END, INT_RTC, MODE_DISPEND, MODE_MAX_RA,
} from './electron-ula.ts';
import { wireElectronIo } from './electron-io.ts';
import { withStopsDisarmed } from '@/machines/shared/native-state.ts';
import { ElectronPlus1, PLUS1_ROM_PAGE, CART_PAGES } from './peripherals/plus1.ts';
import { AnalogSticks, axisToRange } from '@/machines/shared/analog-stick.ts';
import { ADFS_SECTORS_PER_TRACK } from '@/media/floppy/adfs.ts';
import { SSD_SECTORS_PER_TRACK } from '@/media/floppy/ssd.ts';
import { resolveDriveCount } from '@/machines/shared/drive-count.ts';
import { DFS_ROM_PAGE, ElectronPlus3, PLUS3_ROM_PAGE } from './peripherals/plus3.ts';
import { electronDescriptor } from './descriptor.ts';
import { createElectronServices, type ElectronServices } from './services/index.ts';
import {
  ELECTRON_ACTIVE_WIDTH, ELECTRON_BORDER_LEFT, ELECTRON_BORDER_TOP, ELECTRON_CPU_CLOCK,
  ELECTRON_CYCLES_PER_LINE, ELECTRON_FETCH_CYCLES, ELECTRON_LINES_PER_FRAME,
  ELECTRON_SCREEN_HEIGHT, ELECTRON_SCREEN_WIDTH, ELECTRON_TSTATES_PER_FRAME,
} from './constants.ts';
import { crc32, type StateReader, type StateWriter } from '@/machines/shared/state-io.ts';

/** First line of the display-end interrupt window: the interrupt fires at the
 *  line equal to the mode's last displayed line (250 or 256). */
const PICTURE_LINES = 256;
const RTC_LINE = 100;
/** How long a SHIFT+BREAK holds SHIFT: the OS samples it early in its reset
 *  sequence; half a second covers it with margin, like a real key press. */
const BOOT_SHIFT_FRAMES = 25;

/** The Electron has no sound chip to feed: the ULA's beeper goes through the mixer. */
const NO_CHIP = { setSampleRate(): void {} };

export class ElectronMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'electron';
  readonly model: ElectronModel;
  host: MachineHost | null = null;
  readonly services: ElectronServices;

  readonly cpu = new M6502();
  readonly memory = new ElectronMemory();
  readonly keyboard = new ElectronKeyboard();
  /** Cassette deck, tone decoder and recorder, wired to the ULA. */
  readonly cassette = new CassetteDrive(ELECTRON_CPU_CLOCK);
  readonly ula = new ElectronUla(this.cassette);
  readonly mixer = new AudioMixer(ELECTRON_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  /** Frame buffer, one RGBA pixel per ULA pixel across a 640-pixel line. */
  readonly pixels = new Uint8Array(ELECTRON_SCREEN_WIDTH * ELECTRON_SCREEN_HEIGHT * 4);
  private readonly pixels32 = new Uint32Array(this.pixels.buffer);

  /** Per-frame activity counters for the frame probe. */
  readonly activity = { beeperToggles: 0 };

  // ── Expansions (Hardware pane) ───────────────────────────────────────────
  /** Plus 1: cartridge slots, analogue ports, printer port, expansion ROM. */
  readonly plus1 = new ElectronPlus1();
  /** Plus 3: WD1770 disc interface and ADFS ROM; its DRQ/INTRQ drive the NMI. */
  readonly plus3 = new ElectronPlus3((asserted) => { if (asserted) this.cpu.nmi(); });
  plus1Fitted = false;
  plus3Fitted = false;
  /** The two joysticks on the Plus 1's analogue port, as the host drives them. */
  readonly sticks = new AnalogSticks(2);
  /** How many of the Plus 3's two drives are fitted (1 or 2), from the Drives pane. */
  driveCount = 2;
  /** The Plus 3's drives run the ACP 1770 DFS (Acorn DFS discs) instead of ADFS. */
  dfsFitted = false;
  /** Name of the cartridge in the Plus 1's front slot, '' when empty. */
  cartridgeName = '';
  /** Frames left holding SHIFT for a SHIFT+BREAK boot of a disc or cartridge. */
  private bootShiftFrames = 0;
  private discAccum = 0;

  /** Run flat out while the tape is being read ('tape-turbo-load'). */
  private tapeTurboEnabled = true;
  /** Nominal start cycle of the current scanline, for the display-fetch halt. */
  private lineStart = 0;
  /** The ULA is fetching display bytes on this line (modes 0-3, picture lines). */
  private fetchLine = false;
  /** The next line of the frame in progress to run (it carries over a stop). */
  private fLine = 0;
  /** The start of line `fLine` (its interrupts and fetch window) is done, so
   *  a frame resumed part-way through the line does not repeat it. */
  private lineLive = false;
  private prevSound = 0;

  protected get audioChip(): { setSampleRate(rate: number): void } { return NO_CHIP; }

  get descriptor(): MachineDescriptor { return electronDescriptor(this.model); }
  get frameWidth(): number { return ELECTRON_SCREEN_WIDTH; }
  get frameHeight(): number { return ELECTRON_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number { return ELECTRON_TSTATES_PER_FRAME; }
  get cpuClockHz(): number { return ELECTRON_CPU_CLOCK; }

  constructor(model: ElectronModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.display = display ?? null;
    this.cpu.onInterrupt = (vector) => this.noteInterrupt(this.cpu.pc, vector === 0xFFFA);
    // The 6502 core makes its bus accesses before it counts the cycles.
    this.deferAccessStamps = true;
    this.cpu.read = (addr) => {
      this.contend(addr);
      const value = this.memory.readByte(addr);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, value, 'read');
      return value;
    };
    this.cpu.write = (addr, val) => {
      this.contend(addr);
      this.memory.writeByte(addr, val);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, val & 0xFF, 'write');
    };
    // Beeper-only machine: nothing to balance against.
    this.mixer.beeperGain = 1;
    this.mixer.psgGain = 0;
    this.ula.onCapsLock = (on) => { this.keyboard.capsLock = on; };
    wireElectronIo(this);
    this.services = createElectronServices(this);
    this.ula.clear(this.pixels32);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  loadROM(data: Uint8Array): void {
    this.memory.loadRom(data);
    this.setStatus(`Electron ROM loaded (${Math.min(data.length, 0x8000)} bytes)`);
  }

  /** Fit a ROM image into a paged window (Plus 1 slots, sideways sockets). */
  loadPagedRom(page: number, data: Uint8Array): void {
    this.memory.loadPagedRom(page, data);
  }

  /** Fit or remove the expansions and return the ROM loads they need. The ROMs
   *  are fitted at build time, so toggling a peripheral rebuilds the machine. */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.setDriveCount(resolveDriveCount(view, 'electron', 2));
    this.setExpansions(
      view.get('electron-plus1', false), view.get('electron-plus3', false), view.get('electron-dfs', false),
    );
    const requests: AuxRomRequest[] = [];
    if (this.plus1Fitted) {
      requests.push({
        cacheKey: 'electron-plus1-100',
        source: 'electron/plus1.rom',
        fetchingMsg: 'Fetching Electron Plus 1 ROM…',
        loadedMsg: (bytes) => `Electron Plus 1 ROM loaded (${bytes} bytes)`,
        failMsg: 'Failed to load the Electron Plus 1 ROM',
        failId: 'electron-plus1',
        apply: (data) => this.installPlus1Rom(data),
        awaitLoad: true,
      });
    }
    if (this.plus3Fitted && this.dfsFitted) {
      requests.push({
        cacheKey: 'electron-plus3-acpdfs200',
        source: 'electron/dfs.rom',
        fetchingMsg: 'Fetching Electron ACP 1770 DFS ROM�',
        loadedMsg: (bytes) => `Electron ACP 1770 DFS ROM loaded (${bytes} bytes)`,
        failMsg: 'Failed to load the Electron ACP 1770 DFS ROM',
        failId: 'electron-dfs',
        apply: (data) => this.installDfsRom(data),
        awaitLoad: true,
      });
    } else if (this.plus3Fitted) {
      requests.push({
        cacheKey: 'electron-plus3-adfs100',
        source: 'electron/plus3.rom',
        fetchingMsg: 'Fetching Electron Plus 3 ADFS ROM…',
        loadedMsg: (bytes) => `Electron Plus 3 ADFS ROM loaded (${bytes} bytes)`,
        failMsg: 'Failed to load the Electron Plus 3 ADFS ROM',
        failId: 'electron-plus3',
        apply: (data) => this.installPlus3Rom(data),
        awaitLoad: true,
      });
    }
    return requests;
  }

  /** Fit the first `count` Plus 3 drives. */
  setDriveCount(count: number): void {
    this.driveCount = count;
    this.plus3.setDriveCount(count);
  }

  /** `dfs` swaps the Plus 3's ADFS ROM for the ACP 1770 DFS: the same WD1770
   *  interface, but Acorn DFS discs (.ssd/.dsd) instead of ADFS ones. */
  setExpansions(plus1: boolean, plus3: boolean, dfs = false): void {
    this.plus1Fitted = plus1;
    this.plus3Fitted = plus3;
    this.dfsFitted = plus3 && dfs;
    this.plus3.setFormatSectors(this.dfsFitted ? SSD_SECTORS_PER_TRACK : ADFS_SECTORS_PER_TRACK);
    if (!plus1) {
      this.memory.setExpansionRom(PLUS1_ROM_PAGE, null);
      this.ejectCartridge();
    }
    if (!plus3 || dfs) this.memory.setExpansionRom(PLUS3_ROM_PAGE, null);
    if (!plus3 || !dfs) this.memory.setExpansionRom(DFS_ROM_PAGE, null);
    if (!plus3) {
      this.plus3.ejectDisk(0);
      this.plus3.ejectDisk(1);
    }
  }

  /** A joystick direction or fire button on the Plus 1's analogue port.
   *  Directions are full deflection. */
  joystickPress(dir: string, pressed: boolean, player: number): void {
    if (player !== 0 && player !== 1) return;
    if (dir === 'fire') { this.plus1.fire[player] = pressed; return; }
    if (this.sticks.press(dir, pressed, player)) this.updateStickInputs(player);
  }

  /** A gamepad's proportional axis (-1 left/up … +1 right/down). */
  joystickAnalog(axis: 'x' | 'y', value: number, player: number): void {
    if (player !== 0 && player !== 1) return;
    this.sticks.analog(axis, value, player);
    this.updateStickInputs(player);
  }

  releaseJoysticks(): void {
    this.sticks.reset();
    this.plus1.fire[0] = this.plus1.fire[1] = false;
    this.updateStickInputs(0);
    this.updateStickInputs(1);
  }

  /** Joystick `player` onto ADC channels 2p (X) and 2p+1 (Y); the sticks read
   *  255 at full left and full up, as on the BBC Micro. */
  private updateStickInputs(player: number): void {
    this.plus1.adc[player * 2] = axisToRange(this.sticks.x(player), 0xFF, true);
    this.plus1.adc[player * 2 + 1] = axisToRange(this.sticks.y(player), 0xFF, true);
  }

  installPlus1Rom(data: Uint8Array): void { this.memory.setExpansionRom(PLUS1_ROM_PAGE, data); }
  installPlus3Rom(data: Uint8Array): void { this.memory.setExpansionRom(PLUS3_ROM_PAGE, data); }
  installDfsRom(data: Uint8Array): void { this.memory.setExpansionRom(DFS_ROM_PAGE, data); }

  /** Put a cartridge in the Plus 1's front slot (its two 16K banks are ROMs 2
   *  and 3). The caller resets the machine so the OS finds it. */
  insertCartridge(data: Uint8Array, name: string): void {
    const [lo, hi] = ElectronPlus1.cartridgeBanks(data);
    this.memory.setExpansionRom(CART_PAGES[0], lo);
    this.memory.setExpansionRom(CART_PAGES[1], hi);
    this.cartridgeName = name;
  }

  ejectCartridge(): void {
    this.memory.setExpansionRom(CART_PAGES[0], null);
    this.memory.setExpansionRom(CART_PAGES[1], null);
    this.cartridgeName = '';
  }

  /** SHIFT+BREAK: reset and hold SHIFT while the OS starts, so a disc's !BOOT or
   *  a cartridge runs. Safe while running: it only touches the hardware between
   *  frames. */
  bootWithShift(): void {
    this.resetHardware(false);
    this.keyboard.setCell(13, 3, true);
    this.bootShiftFrames = BOOT_SHIFT_FRAMES;
    this.setStatus('SHIFT+BREAK');
  }

  applySettings(view: SettingsView): void {
    this.audio.setVolume(view.get('volume', 70) / 100);
    this.ula.paletteMode = view.get<'pal' | 'measured'>('bbc-color-map', 'pal');
    this.tapeTurboEnabled = view.get('tape-turbo-load', true);
  }

  /** The border is always black and fully rendered; the setting crops it:
   *  Normal shows it all, Small half, None just the 640×256 picture. */
  setBorderSize(mode: BorderMode): void {
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(ELECTRON_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(ELECTRON_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY, ELECTRON_SCREEN_WIDTH - cropX * 2, ELECTRON_SCREEN_HEIGHT - cropY * 2,
    );
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  /** Power-on: the ULA flags a cold start so the OS clears memory and shows its banner. */
  reset(): void {
    this.stop();
    this.resetHardware(true);
    this.resetFrameCount();
    this.setStatus('Reset');
  }

  /** The BREAK key: reset the CPU and ULA modes but leave RAM, and the ULA's
   *  power-on flag, alone so the OS recognises a warm start. Safe while running. */
  breakReset(): void {
    this.resetHardware(false);
    this.setStatus('BREAK');
  }

  private resetHardware(power: boolean): void {
    this.refreshResumed = false;
    this.memory.reset();
    if (power) this.ula.reset(); else this.ula.breakReset();
    this.cassette.reset();
    this.plus1.reset();
    this.plus3.reset();
    this.discAccum = 0;
    this.bootShiftFrames = 0;
    this.keyboard.reset();
    this.keyboard.capsLock = false;
    this.cpu.reset();
    // The clock restarts, so a frame a stop left open cannot be carried on.
    // BREAK keeps counting frames so a log that spans it stays in order.
    this.midFrame = false;
    this.fLine = 0;
    this.lineLive = false;
    this.clearInterrupts();
    this.lineStart = this.cpu.tStates;
    this.fetchLine = false;
    this.activity.beeperToggles = 0;
    this.prevSound = 0;
    this.mixer.reset();
    this.audio.reset();
    this.ula.clear(this.pixels32);
    this.needsDisplay = true;
  }

  protected framePixels(): Uint8Array { return this.pixels; }
  protected inTurbo(): boolean { return this.turbo || this.cassette.turboActive; }

  // ── Memory timing ────────────────────────────────────────────────────────

  /** Charge the CPU for the speed of the memory it is about to touch. */
  private contend(addr: number): void {
    const cpu = this.cpu;
    if (addr < 0x8000) {
      let t = cpu.tStates;
      if (this.fetchLine && (this.ula.dispMode & 4) === 0) {
        // The ULA owns RAM until it has fetched this line's bytes.
        const end = this.lineStart + ELECTRON_FETCH_CYCLES;
        if (t < end) t = end;
      }
      cpu.tStates = t + 1 + (t & 1);                // 1 MHz access, aligned to its clock
    } else if (addr >= 0xFC00 && addr < 0xFE00) {
      cpu.tStates += 1 + (cpu.tStates & 1);          // FRED / JIM
    } else if (addr < 0xC000 && (this.memory.romPage & 0x0E) === 8) {
      cpu.tStates += 1 + (cpu.tStates & 1);          // keyboard pages
    }
  }

  // ── Beam ─────────────────────────────────────────────────────────────────

  /** Frame line 0 is the first line of the 256-line picture; the RTC
   *  interrupt is raised at the start of line 100 and display end at the
   *  start of line 250 or 256. Each line is drawn when the CPU reaches its end. */
  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: ELECTRON_CYCLES_PER_LINE,
      linesPerFrame: ELECTRON_LINES_PER_FRAME,
      displayStart: 0,
      note: 'line 0 is the first line of the picture, whose bytes the ULA fetches in the first 80 cycles of each line; the RTC interrupt is raised at the start of line 100 and display end at the start of line 256 (250 in modes 3 and 6). Each line is drawn whole when the CPU reaches its end, so a register write shows from the line it is made in',
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return m6502ReturnAddress(this.cpu.sp, a => this.memory.peekByte(a)); }
  /** An opcode is never read from the hardware pages, where reads have side effects. */
  protected override peekOpcode(addr: number): number {
    return addr >= 0xFC00 && addr < 0xFF00 ? -1 : this.memory.peekByte(addr);
  }

  // ── Frame ────────────────────────────────────────────────────────────────

  protected override interruptEntryPending(): boolean { return this.cpu.interruptPending(); }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1 || this.cassette.turboActive;
    const cpu = this.cpu;
    const ula = this.ula;
    // A frame a stop left part-way carries on from the line it was in.
    if (!this.openFrame(ELECTRON_TSTATES_PER_FRAME)) {
      this.activity.beeperToggles = 0;
      ula.startFrame();
      this.fLine = 0;
      this.lineLive = false;
    }
    this.memWatchHit = null;

    for (; this.fLine < ELECTRON_LINES_PER_FRAME; this.fLine++) {
      const line = this.fLine;
      const lineEnd = this.frameStartT + (line + 1) * ELECTRON_CYCLES_PER_LINE;
      if (!this.lineLive) {
        this.lineLive = true;
        this.lineStart = lineEnd - ELECTRON_CYCLES_PER_LINE;
        const mode = ula.dispMode;
        if (line === RTC_LINE) ula.raise(INT_RTC);
        if ((line === 250 || line === PICTURE_LINES) && line === MODE_DISPEND[mode]) {
          ula.raise(INT_DISPLAY_END);
        }
        this.fetchLine = line < MODE_DISPEND[mode] && ula.screenRa < 8;
        cpu.setIRQ(ula.irq);
      }

      while (cpu.tStates < lineEnd) {
        if (this.checkStops(cpu.pc)) {
          // The frame stays open; the next call carries on in this line.
          this.midFrame = true;
          this.needsDisplay = true;
          return;
        }
        const before = cpu.tStates;
        this.beforeInsn(cpu.pc);
        cpu.step();
        const stopped = this.afterInsn();
        const elapsed = cpu.tStates - before;
        const now = cpu.tStates;
        this.cassette.step(elapsed, now);
        ula.tick(elapsed, now);
        if (this.plus3Fitted) {
          this.discAccum += elapsed;
          const disc = this.discAccum >> 1;               // 1 MHz disc clock
          if (disc > 0) { this.discAccum &= 1; this.plus3.tick(disc); }
        }
        cpu.setIRQ(ula.irq);
        if (!skipAudio) {
          this.mixer.accumulate(ula.soundLevel, elapsed);
          this.mixer.generateSamples(this.audio, null, false);
          if (ula.soundLevel !== this.prevSound) {
            this.prevSound = ula.soundLevel;
            this.activity.beeperToggles++;
          }
        }
        // Stop on the instruction that tripped a memory watchpoint, with the
        // frame open.
        if (stopped) {
          this.midFrame = true;
          this.needsDisplay = true;
          return;
        }
      }
      this.lineLive = false;
      if (line < PICTURE_LINES) {
        ula.renderLine(line, this.memory.ram, this.pixels32, ELECTRON_BORDER_TOP + line);
      }
    }

    this.cassette.frameTick(this.tapeTurboEnabled);
    if (this.plus3Fitted) this.plus3.tickFrame();
    if (this.bootShiftFrames > 0 && --this.bootShiftFrames === 0) {
      this.keyboard.setCell(13, 3, false);
    }
    this.needsDisplay = true;
  }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: `${this.model}-ram-32k.bin` };
  }

  /** Execution trace: BaseMachine's startTrace/stopTrace drive it and
   *  beforeInsn feeds it (debug/m6502/trace.ts). */
  protected override tracer = new M6502Trace(this, { io: [[0xFC00, 0xFEFF]], ioLabel: electronIoLabel });

  // ── Text recognition ─────────────────────────────────────────────────────

  /** Where the current mode's character grid sits in the frame buffer. */
  textLayout(): {
    cols: number; rows: number; x: number; y: number;
    cellW: number; cellH: number; glyphH: number;
  } {
    const mode = this.ula.dispMode;
    const cols = ELECTRON_MODE_COLS[mode];
    const rows = ELECTRON_MODE_ROWS[mode];
    return {
      cols, rows,
      x: ELECTRON_BORDER_LEFT,
      y: ELECTRON_BORDER_TOP,
      cellW: ELECTRON_ACTIVE_WIDTH / cols,
      cellH: MODE_MAX_RA[mode],
      glyphH: 8,
    };
  }

  private ocrInput() {
    return {
      ram: this.memory.ram,
      screenStart: this.ula.screenStart,
      mode: this.ula.dispMode,
      font: findElectronFont(this.memory.osRom),
      pens: this.ula.pens,
      palette: this.ula.colours,
    };
  }

  /** Screen text for the MCP `ocr` tool, read by matching the OS font. */
  ocrScreenForMcp(_mode?: string): string {
    const rows = ocrElectronBitmap(this.ocrInput()).text.split('\n').map(r => r.replace(/\s+$/, ''));
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  /** Styled OCR (text + coloured HTML + match mask + paper) for the TEXT overlay. */
  ocrScreenStyled(): OcrResult { return ocrElectronBitmap(this.ocrInput()); }

  /** Blank the matched character cells to their paper colour so the crisp
   *  overlay glyphs replace the bitmap underneath. */
  blankCells(mask: boolean[], cols: number, rows: number, paper?: number[]): void {
    const g = this.textLayout();
    const colours = this.ula.colours;
    const w = ELECTRON_SCREEN_WIDTH;
    const cw = Math.round(g.cellW);
    for (let row = 0; row < rows; row++) {
      const y0 = g.y + row * g.cellH;
      for (let col = 0; col < cols; col++) {
        if (!mask[row * cols + col]) continue;
        const x0 = g.x + Math.round(col * g.cellW);
        const fill = colours[(paper ? paper[row * cols + col] : 0) & 7];
        for (let y = 0; y < g.glyphH; y++) {
          const base = (y0 + y) * w + x0;
          this.pixels32.fill(fill, base, base + cw);
        }
      }
    }
  }

  // ── Snapshots (.elkstate; see shared/native-state.ts for the container) ──

  /** Set when a state without its media (the browser-refresh copy) has been
   *  restored: the shell then remounts the persisted discs, and that must not
   *  SHIFT+BREAK or move the heads (see the media service). Cleared by any
   *  reset. */
  refreshResumed = false;

  /** CRC-32s of the BASIC and OS ROMs and of what each of the sixteen paged
   *  windows holds besides a cartridge (which is in the state itself; an
   *  empty window counts as 0), for the snapshot header. */
  stateRomCrcs(): number[] {
    const mem = this.memory;
    const crcs = [crc32(mem.basicRom), crc32(mem.osRom)];
    for (let page = 0; page < mem.roms.length; page++) {
      const rom = (CART_PAGES as readonly number[]).includes(page) ? mem.roms[page] : mem.expansion[page] ?? mem.roms[page];
      crcs.push(rom ? crc32(rom) : 0);
    }
    return crcs;
  }

  /** The expansions fitted, as the Hardware pane names them. */
  private static expansionsName(plus1: boolean, plus3: boolean, dfs: boolean): string {
    return `${plus1 ? 'a Plus 1' : 'no Plus 1'} and ${plus3 ? `a Plus 3 (${dfs ? 'DFS' : 'ADFS'})` : 'no Plus 3'}`;
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

  /**
   * Write the machine's state between frames: the CPU, the RAM and paging,
   * the ULA, the cassette, the expansions (with the joysticks on the Plus 1's
   * analogue port as held) and a Plus 1 cartridge. `withMedia`
   * adds the discs and the tape; the refresh path leaves them to the shell.
   * Host input (held keys) is live state, not machine state.
   */
  saveState(w: StateWriter, withMedia: boolean): void {
    this.completeFrame();
    // The expansions first, so a restore can refuse a mismatch before it
    // changes anything.
    w.section('CONF', () => {
      w.bool(this.plus1Fitted); w.bool(this.plus3Fitted); w.bool(this.dfsFitted); w.u8(this.driveCount);
    });
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameNumber); w.f64(this.frameStartT); w.f64(this.frameEndT);
      w.u32(this.bootShiftFrames); w.u8(this.discAccum);
      w.f64(this.lineStart); w.bool(this.fetchLine); w.u8(this.prevSound);
    });
    w.section('MEM ', () => {
      w.raw(this.memory.ram);
      w.u8(this.memory.romPage);
    });
    w.section('CART', () => {
      const lo = this.memory.expansion[CART_PAGES[0]];
      const hi = this.memory.expansion[CART_PAGES[1]];
      w.bool(lo !== null && hi !== null);
      if (!lo || !hi) return;
      w.str(this.cartridgeName);
      w.raw(lo); w.raw(hi);
    });
    w.section('ULA ', () => this.ula.saveState(w));
    w.section('TAPE', () => this.cassette.saveState(w, withMedia));
    w.section('PLS1', () => {
      this.plus1.saveState(w);
      this.sticks.saveState(w);
    });
    // The discs go before the controller, whose transfer in flight points into them.
    w.section('MEDA', () => {
      w.bool(withMedia);
      if (withMedia) this.services.disks.saveState(w);
    });
    w.section('PLS3', () => this.plus3.saveState(w));
  }

  /**
   * Restore a state written by `saveState` into this machine, which has the
   * same model; one saved with other expansions or another drive count is
   * refused before anything changes. The frame loop must be stopped. The ROMs, settings and, for a state without media, the
   * drives and tape stay as they are.
   */
  loadState(r: StateReader): void {
    {
      const s = r.section('CONF');
      const plus1 = s.bool(), plus3 = s.bool(), dfs = s.bool(), drives = s.u8();
      if (plus1 !== this.plus1Fitted || plus3 !== this.plus3Fitted || dfs !== this.dfsFitted) {
        throw new Error(`This snapshot was saved with ${ElectronMachine.expansionsName(plus1, plus3, dfs)} and this Electron has ${ElectronMachine.expansionsName(this.plus1Fitted, this.plus3Fitted, this.dfsFitted)}; change it in the Hardware pane and load it again`);
      }
      if (plus3 && drives !== this.driveCount) {
        throw new Error(`This snapshot was saved with ${drives} drives and this Electron has ${this.driveCount}; change it in the Drives pane and load it again`);
      }
    }
    this.midFrame = false;
    this.fLine = 0;
    this.lineLive = false;
    this.clearInterrupts();
    this.cpu.loadState(r.section('CPU '));
    {
      const s = r.section('MACH');
      this.frameNumber = s.f64(); this.frameStartT = s.f64(); this.frameEndT = s.f64();
      this.bootShiftFrames = s.u32(); this.discAccum = s.u8();
      this.lineStart = s.f64(); this.fetchLine = s.bool(); this.prevSound = s.u8();
    }
    {
      const s = r.section('MEM ');
      s.rawInto(this.memory.ram);
      this.memory.romPage = s.u8() & 0x0F;
    }
    {
      const s = r.section('CART');
      if (s.bool()) {
        const name = s.str();
        const lo = new Uint8Array(ELECTRON_ROM_SIZE);
        const hi = new Uint8Array(ELECTRON_ROM_SIZE);
        s.rawInto(lo); s.rawInto(hi);
        this.memory.setExpansionRom(CART_PAGES[0], lo);
        this.memory.setExpansionRom(CART_PAGES[1], hi);
        this.cartridgeName = name;
      } else {
        this.ejectCartridge();
      }
    }
    this.ula.loadState(r.section('ULA '));
    this.cassette.loadState(r.section('TAPE'));
    {
      const s = r.section('PLS1');
      this.plus1.loadState(s);
      this.sticks.loadState(s);
    }
    let withMedia: boolean;
    {
      const s = r.section('MEDA');
      withMedia = s.bool();
      if (withMedia) this.services.disks.loadState(s);
    }
    this.plus3.loadState(r.section('PLS3'));

    // What the state does not hold: the host's keys are whatever they are
    // now, except the SHIFT a SHIFT+BREAK boot is still holding.
    this.keyboard.reset();
    this.keyboard.capsLock = this.ula.capsLock;
    if (this.bootShiftFrames > 0) this.keyboard.setCell(13, 3, true);
    this.refreshResumed = !withMedia;
    this.activity.beeperToggles = 0;
    this.audio.reset();
    this.mixer.reset();
    this.repaint();
    this.needsDisplay = true;
  }

  /** Draw the picture from the restored memory and ULA, as the next frame
   *  will, without moving the ULA's display counters. */
  private repaint(): void {
    const ula = this.ula;
    const addr = ula.screenAddr;
    const ra = ula.screenRa;
    ula.clear(this.pixels32);
    ula.startFrame();
    for (let line = 0; line < PICTURE_LINES; line++) {
      ula.renderLine(line, this.memory.ram, this.pixels32, ELECTRON_BORDER_TOP + line);
    }
    ula.screenAddr = addr;
    ula.screenRa = ra;
  }
}

/** Portio-trace names for the Electron's FRED, JIM and SHEILA (the ULA) pages. */
function electronIoLabel(addr: number): string {
  return addr < 0xFD00 ? 'FRED' : addr < 0xFE00 ? 'JIM' : 'ULA';
}
