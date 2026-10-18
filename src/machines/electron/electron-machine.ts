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
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import {
  ocrElectronBitmap, findElectronFont, ELECTRON_MODE_COLS, ELECTRON_MODE_ROWS,
} from '@/ocr/electron.ts';
import type { ElectronModel } from './models.ts';
import { ElectronMemory } from './electron-memory.ts';
import { ElectronKeyboard } from './electron-keyboard.ts';
import {
  ElectronUla, INT_DISPLAY_END, INT_RTC, MODE_DISPEND, MODE_MAX_RA,
} from './electron-ula.ts';
import { wireElectronIo } from './electron-io.ts';
import { ElectronPlus1, PLUS1_ROM_PAGE, CART_PAGES } from './peripherals/plus1.ts';
import { ADFS_SECTORS_PER_TRACK } from '@/media/floppy/adfs.ts';
import { SSD_SECTORS_PER_TRACK } from '@/media/floppy/ssd.ts';
import { DFS_ROM_PAGE, ElectronPlus3, PLUS3_ROM_PAGE } from './peripherals/plus3.ts';
import { electronDescriptor } from './descriptor.ts';
import { createElectronServices, type ElectronServices } from './services/index.ts';
import {
  ELECTRON_ACTIVE_WIDTH, ELECTRON_BORDER_LEFT, ELECTRON_BORDER_TOP, ELECTRON_CPU_CLOCK,
  ELECTRON_CYCLES_PER_LINE, ELECTRON_FETCH_CYCLES, ELECTRON_LINES_PER_FRAME,
  ELECTRON_SCREEN_HEIGHT, ELECTRON_SCREEN_WIDTH, ELECTRON_TSTATES_PER_FRAME,
} from './constants.ts';

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
    this.cpu.read = (addr) => { this.contend(addr); return this.memory.readByte(addr); };
    this.cpu.write = (addr, val) => { this.contend(addr); this.memory.writeByte(addr, val); };
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
    this.setStatus('Reset');
  }

  /** The BREAK key: reset the CPU and ULA modes but leave RAM, and the ULA's
   *  power-on flag, alone so the OS recognises a warm start. Safe while running. */
  breakReset(): void {
    this.resetHardware(false);
    this.setStatus('BREAK');
  }

  private resetHardware(power: boolean): void {
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

  // ── Frame ────────────────────────────────────────────────────────────────

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1 || this.cassette.turboActive;
    const cpu = this.cpu;
    const ula = this.ula;
    this.activity.beeperToggles = 0;
    ula.startFrame();
    let lineEnd = cpu.tStates;

    for (let line = 0; line < ELECTRON_LINES_PER_FRAME; line++) {
      this.lineStart = lineEnd;
      lineEnd += ELECTRON_CYCLES_PER_LINE;
      const mode = ula.dispMode;
      if (line === RTC_LINE) ula.raise(INT_RTC);
      if ((line === 250 || line === PICTURE_LINES) && line === MODE_DISPEND[mode]) {
        ula.raise(INT_DISPLAY_END);
      }
      this.fetchLine = line < MODE_DISPEND[mode] && ula.screenRa < 8;
      cpu.setIRQ(ula.irq);

      while (cpu.tStates < lineEnd) {
        if (this.breakpoints.has(cpu.pc)) {
          this.breakpointHit = cpu.pc;
          this.needsDisplay = true;
          return;
        }
        if (this.onTrap !== null && this.onTrap(cpu.pc)) {
          this.needsDisplay = true;
          return;
        }
        const before = cpu.tStates;
        cpu.step();
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
      }
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

  startTrace(_mode = 'full'): void {}
  stopTrace(): string { return ''; }

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
}
