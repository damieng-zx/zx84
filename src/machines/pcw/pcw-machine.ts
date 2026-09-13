/**
 * PcwMachine — Amstrad PCW 8256 / 8512 / 9512 orchestrator.
 *
 * The PCW's counterpart to `Spectrum` / `CpcMachine` / `SamMachine`: it owns the
 * Z80A, the paged RAM, the gate array and the uPD765A, and drives its own PAL
 * field loop. Implements the shared `Machine` SPI so the shell, UI and MCP
 * server treat it like any other machine.
 *
 * What makes this machine unusual, and where each part lives:
 *
 *  - **No ROM.** The machine boots from the disc in drive A. See
 *    `bootstrap.ts` for what stands in for the gate array's bootstrap mode.
 *  - **The keyboard is memory-mapped**, not ported: the gate array scans it and
 *    writes 16 bytes into physical block 3. See `pcw-keyboard.ts`.
 *  - **The video is a roller-RAM bitmap**, fetched through a per-scan-line
 *    address table in RAM. See `asic.ts`.
 *  - **Port &F8 takes command numbers**, not bit fields — `systemCommand`.
 *
 * Sound is the 1-bit beeper only; there is no sound chip in a PCW.
 */

import { Z80 } from '@/cores/z80.ts';
import { UPD765A } from '@/cores/upd765a.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { disasmOne, type DisasmLine } from '@/debug/z80/disasm.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind,
  MachineTraceMode, SettingsView,
} from '@/machines/machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import {
  PCW_FONT_BLOCK, PCW_FONT_BYTES, PCW_FONT_OFFSET,
  pcwScreenCells, pcwScreenText, type PcwOcrCells,
} from '@/ocr/pcw.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { PcwMemory } from './pcw-memory.ts';
import { PcwAsic } from './asic.ts';
import { PcwKeyboard } from './pcw-keyboard.ts';
import { createPcwConfig, type PcwConfig } from './config.ts';
import type { PcwModel } from './models.ts';
import { pcwDescriptor } from './descriptor.ts';
import { createPcwServices, type PcwServices } from './services/index.ts';
import { installPcwMemoryHooks, wirePcwPortIO } from './pcw-io.ts';
import { bootFailureMessage, loadBootSector } from './bootstrap.ts';
import {
  PCW_BOOT_ENTRY_ADDR, PCW_BOOT_LOAD_ADDR, PCW_BORDER_LEFT, PCW_BORDER_TOP,
  PCW_CPU_CLOCK, PCW_FDC_INT_RESPONSE_LINES,
  PCW_KEYBOARD_BLOCK, PCW_KEYBOARD_OFFSET, PCW_LINES_PER_FRAME,
  PCW_PHOSPHORS, PCW_SCREEN_HEIGHT, PCW_SCREEN_WIDTH, PCW_T_PER_FRAME,
  PCW_T_PER_LINE, PcwCommand,
} from './constants.ts';

/** The PCW has no sound chip; the mixer only ever sees the beeper bit. */
const NO_SOUND_CHIP = { setSampleRate(_rate: number): void {} };

export class PcwMachine extends BaseMachine implements Machine {
  protected get audioChip(): { setSampleRate(rate: number): void } { return NO_SOUND_CHIP; }

  readonly kind: MachineKind = 'pcw';
  readonly model: PcwModel;
  readonly config: PcwConfig;
  /** Operator's panel (shell / MCP) — null when running headless. */
  host: MachineHost | null = null;
  readonly services: PcwServices;

  readonly cpu: Z80;
  readonly memory: PcwMemory;
  /** The custom silicon: video, the 300Hz timer and the status byte. */
  readonly asic: PcwAsic;
  readonly keyboard = new PcwKeyboard();
  /** The 3" drives. Drive B exists only on the 8512. */
  readonly fdc = new UPD765A();
  readonly mixer: AudioMixer;
  readonly audio: Audio;
  display: IScreenRenderer | null;

  /** Beeper output, toggled by port &F8 commands 11 and 12. */
  beeperBit = 0;

  /** True once a boot sector has been loaded and entered. */
  booted = false;
  /** Set by port &F8 command 1; acted on at the end of the frame, never inside
   *  the port write that requested it. */
  private rebootRequested = false;
  /** Edge state for the FDC's /NMI routing, so a held line fires once. */
  private lastNmiLine = false;

  /** Per-frame I/O activity, mapped onto the status-bar LEDs by the probe. */
  readonly activity = {
    kbdReads: 0, fdcAccesses: 0, beeperWrites: 0, printerWrites: 0,
  };

  /** RGBA frame buffer plus a Uint32 view for fast gate-array writes. */
  private readonly _pixels = new Uint8Array(PCW_SCREEN_WIDTH * PCW_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  get tStatesPerFrame(): number { return PCW_T_PER_FRAME; }
  get cpuClockHz(): number { return PCW_CPU_CLOCK; }
  get frameWidth(): number { return PCW_SCREEN_WIDTH; }
  get frameHeight(): number { return PCW_SCREEN_HEIGHT; }

  constructor(model: PcwModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.config = createPcwConfig(model);
    this.cpu = new Z80();
    this.memory = new PcwMemory(this.config);
    this.asic = new PcwAsic(this.memory);
    this.audio = new Audio();
    this.mixer = new AudioMixer(PCW_CPU_CLOCK);
    this.mixer.beeperGain = 1;
    this.mixer.psgGain = 0;
    this.display = display ?? null;

    const phosphor = PCW_PHOSPHORS[this.config.phosphor];
    this.asic.ink = phosphor.ink;
    this.asic.paper = phosphor.paper;

    // Only the 8512 shipped with a second mechanism. On the others nothing is
    // wired to that select line, so recalibrating it must fail — which is how
    // CP/M Plus counts drives for its banner.
    this.fdc.connected[1] = this.config.drives > 1;
    // The PCW is the only machine here that waits on the FDC's interrupt line
    // rather than polling the status register, so it is the only one that can
    // tell the controller answers instantly. Give it a response time.
    this.fdc.intResponseTicks = PCW_FDC_INT_RESPONSE_LINES;

    installPcwMemoryHooks(this);
    wirePcwPortIO(this);

    this.services = createPcwServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  get descriptor(): MachineDescriptor { return pcwDescriptor(this.model); }

  protected override setStatus(msg: string): void {
    super.setStatus(msg);
    this.host?.setStatus(msg);
  }

  // ── Seams used by pcw-io.ts ───────────────────────────────────────────────

  /**
   * Port &F8 out. The byte is a **command number**, not a bit field:
   * "0 end bootstrap, 1 reboot, 2/3/4 connect FDC to NMI/standard interrupts/
   * neither, 5/6 set/clear FDC terminal count, 7/8 screen on/off, 9/10 disc
   * motor on/off, 11/12 beep on/off".
   */
  systemCommand(value: number): void {
    switch (value) {
      case PcwCommand.EndBootstrap:
        // Bootstrap mode is short-circuited (see bootstrap.ts), so by the time
        // any code can execute this the machine is already out of it. The boot
        // sector still issues it, and it must not fall through to a default.
        return;
      case PcwCommand.Reboot:
        // Deferred: this arrives from inside a port write, half way through an
        // instruction, and reset() tears down the frame loop underneath it.
        this.rebootRequested = true;
        return;
      case PcwCommand.FdcToNmi: this.asic.fdcRoute = 'nmi'; return;
      case PcwCommand.FdcToInt: this.asic.fdcRoute = 'int'; return;
      case PcwCommand.FdcToNeither: this.asic.fdcRoute = 'none'; return;
      case PcwCommand.SetTerminalCount: this.fdc.setTerminalCount(true); return;
      case PcwCommand.ClearTerminalCount: this.fdc.setTerminalCount(false); return;
      case PcwCommand.ScreenOn: this.asic.screenEnabled = true; return;
      case PcwCommand.ScreenOff: this.asic.screenEnabled = false; return;
      case PcwCommand.MotorOn: this.fdc.motorOn = true; this.activity.fdcAccesses++; return;
      case PcwCommand.MotorOff: this.fdc.motorOn = false; return;
      case PcwCommand.BeepOn:
        this.beeperBit = 1;
        this.activity.beeperWrites++;
        return;
      case PcwCommand.BeepOff:
        this.beeperBit = 0;
        this.activity.beeperWrites++;
        return;
      default: return;
    }
  }

  /**
   * Printer ports &FC/&FD.
   *
   * The 8000-series drives a 9-pin dot-matrix head directly — position, pin
   * solenoids and motors are all the CPU's job — and the 9512 puts a daisywheel
   * behind the same two ports. Neither is emulated: the writes are counted and
   * discarded, and &FD reads back "ready with paper" so the BIOS's
   * printer-present check passes instead of hanging. Printing itself is future
   * work, and is the one place where the 9512 differs substantially.
   */
  printerWrite(_value: number, _control: boolean): void {
    this.activity.printerWrites++;
  }

  /** Ask for the frame buffer to be re-uploaded on the next display tick. */
  requestRedraw(): void { this.needsDisplay = true; }

  // ── Discs and booting ─────────────────────────────────────────────────────

  /** Insert a disc. Booting an idle machine on an A: insert is what real
   *  hardware does: its boot loader sits retrying the drive until a disc
   *  turns up. */
  loadDisk(image: DskImage, unit = 0): void {
    this.fdc.insertDisk(image, unit);
    if (unit === 0 && !this.booted) this.boot();
  }

  /**
   * Load and enter the boot sector of the disc in drive A.
   *
   * Everything past the entry point is the disc's own code driving the emulated
   * FDC — only the gate array's invented bootstrap code is short-circuited.
   */
  boot(): boolean {
    const result = loadBootSector(this.fdc.getDiskImage(0));
    if (!result.ok) {
      this.booted = false;
      this.setStatus(bootFailureMessage(result.reason));
      return false;
    }

    for (let i = 0; i < result.data.length; i++) {
      this.memory.writeByte(PCW_BOOT_LOAD_ADDR + i, result.data[i]);
    }
    this.cpu.pc = PCW_BOOT_ENTRY_ADDR;
    this.booted = true;
    this.setStatus('Booting from drive A');
    return true;
  }

  // ── Machine: settings, ROM, regions ───────────────────────────────────────

  applySettings(view: SettingsView): void {
    const phosphor = PCW_PHOSPHORS[view.get('pcw-phosphor', this.config.phosphor)]
      ?? PCW_PHOSPHORS[this.config.phosphor];
    this.asic.ink = phosphor.ink;
    this.asic.paper = phosphor.paper;
    this.fdc.writeProtect[0] = view.get('write-protect-a', false);
    this.fdc.writeProtect[1] = view.get('write-protect-b', false);
    this.audio.setVolume(view.get('volume', 70) / 100);
    this.needsDisplay = true;
  }

  /** There is no system ROM in a PCW. The shell still calls this with an empty
   *  image on every build, so it must exist and do nothing. */
  loadROM(_data: Uint8Array): void {}

  resolveMemoryRegion(_value: string): { data: Uint8Array; baseAddr: number } | null {
    return null;
  }

  /** `.scr` export: the 32K the display fetch walks, as one block pair. */
  screenExportBytes(): Uint8Array {
    const out = new Uint8Array(0x8000);
    for (let i = 0; i < out.length; i++) out[i] = this.memory.videoByte(i);
    return out;
  }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.allRam(), filename: `ram-${this.config.ramLabel}.bin` };
  }

  // ── Machine: lifecycle ────────────────────────────────────────────────────

  setBorderSize(mode: BorderMode): void {
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(PCW_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(PCW_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY,
      PCW_SCREEN_WIDTH - cropX * 2,
      PCW_SCREEN_HEIGHT - cropY * 2,
    );
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    // The PCW runs in interrupt mode 1 (the gate array supplies no vector).
    // Z80.reset() already defaults im = 1, so nothing to force here.
    this.memory.reset();
    this.asic.reset();
    this.keyboard.reset();
    this.fdc.reset();
    this.beeperBit = 0;
    this.booted = false;
    this.rebootRequested = false;
    this.lastNmiLine = false;
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
    // A reset with a disc already in drive A boots straight back into it.
    if (!this.boot()) this.setStatus('Reset');
  }

  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  /**
   * Execute one PAL field: 312 scan lines of 218 T-states.
   *
   * Per scan line: advance the gate array (which raises the 300Hz timer
   * interrupt on the six lines that carry one), run the CPU to the end of the
   * line, then draw the line.
   */
  protected runFrame(): void {
    const cpu = this.cpu;
    const asic = this.asic;
    const skipAudio = this.speedMultiplier !== 1;
    const a = this.activity;
    a.kbdReads = 0; a.fdcAccesses = 0; a.beeperWrites = 0; a.printerWrites = 0;

    asic.beginFrame(this._pixels32);

    let lineEnd = cpu.tStates;
    let lastAudioT = cpu.tStates;
    let broke = false;

    for (let line = 0; line < PCW_LINES_PER_FRAME; line++) {
      lineEnd += PCW_T_PER_LINE;
      asic.beginLine(line);

      // The gate array scans the keyboard into block 3 continuously, "even when
      // interrupts are disabled". Refreshing it on the interrupt lines gives
      // software a matrix at most one 300Hz tick old, which is as fresh as the
      // real DMA ever is.
      if (PcwAsic.isInterruptLine(line)) this.scanKeyboard();

      // The FDC's interrupt line is sampled per scan line: 64us of latency on a
      // signal the BIOS reaches through an interrupt handler is immaterial, and
      // this keeps the inner loop free of a per-instruction chip poll. The same
      // tick is what the controller's command-response time is charged against
      // (see PCW_FDC_INT_RESPONSE_LINES).
      this.fdc.tickIntResponse();
      asic.fdcInt = this.fdc.interruptLine;

      while (cpu.tStates < lineEnd) {
        if (this.breakpoints.has(cpu.pc)) { this.breakpointHit = cpu.pc; broke = true; break; }
        if (this.onTrap !== null && this.onTrap(cpu.pc)) { broke = true; break; }

        cpu.step();

        // /NMI is edge triggered, so it fires once per rising edge of the FDC's
        // interrupt line however long that line stays up.
        const nmiLine = asic.nmiPending;
        if (nmiLine && !this.lastNmiLine) cpu.nmi();
        this.lastNmiLine = nmiLine;

        if (asic.intPending && cpu.iff1 && !cpu.eiDelay) {
          cpu.interrupt();
          asic.acknowledgeTimer();
        }

        if (!skipAudio) {
          const elapsed = cpu.tStates - lastAudioT;
          if (elapsed > 0) {
            this.mixer.accumulate(this.beeperBit, elapsed);
            this.mixer.generateSamples(this.audio, null, false);
            lastAudioT = cpu.tStates;
          }
        }
      }

      // Draw the line even when execution broke inside it, so a breakpoint
      // leaves a coherent partial frame rather than a torn one.
      asic.renderScanline(this._pixels32, line);
      if (broke) break;
    }

    this.needsDisplay = true;

    if (this.rebootRequested) {
      this.rebootRequested = false;
      this.reset();
    }
  }

  /** Copy the keyboard matrix into physical block 3, as the gate array's DMA
   *  does. Counts as keyboard activity only while a key is actually held. */
  private scanKeyboard(): void {
    this.keyboard.writeInto(this.memory.getRamBank(PCW_KEYBOARD_BLOCK), PCW_KEYBOARD_OFFSET);
    if (this.keyboard.anyKeyDown) this.activity.kbdReads++;
  }

  /** True while any interrupt source is asserted. */
  get intPending(): boolean { return this.asic.intPending; }

  // ── Machine: debug helpers ────────────────────────────────────────────────

  disasmAt(pc: number): DisasmLine {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 8; i++) buf[i] = this.memory.readByte((pc + i) & 0xFFFF);
    return { ...disasmOne(buf, 0), addr: pc };
  }

  startTrace(_mode: MachineTraceMode = 'full'): void {
    // Execution tracing is not wired up yet; no-op so the MCP tool degrades.
  }

  stopTrace(): string { return ''; }

  /**
   * Screen OCR.
   *
   * The screen is a bitmap, so text is recovered by matching 8x8 cells against
   * the CP/M character set in RAM. Both the cell walk (through roller RAM) and
   * the font's address are CP/M conventions rather than hardware, so a screen
   * that is not CP/M's says so instead of transcribing noise.
   */
  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    const font = this.memory.getRamBank(PCW_FONT_BLOCK)
      .subarray(PCW_FONT_OFFSET, PCW_FONT_OFFSET + PCW_FONT_BYTES);

    const read = (col: number, row: number, line: number): number =>
      this.memory.videoByte(this.asic.lineAddress(row * 8 + line) + col * 8);

    const text = pcwScreenText(read, font);
    if (text === null) return OCR_UNAVAILABLE;
    return text;
  }

  /** The same transcription, shaped for the TEXT overlay: the full untrimmed
   *  grid as HTML, plus the mask of cells the overlay may blank. */
  ocrScreenStyled(): { text: string; html: string; grid: OcrGridName; cells: PcwOcrCells | null } {
    const font = this.memory.getRamBank(PCW_FONT_BLOCK)
      .subarray(PCW_FONT_OFFSET, PCW_FONT_OFFSET + PCW_FONT_BYTES);
    const read = (col: number, row: number, line: number): number =>
      this.memory.videoByte(this.asic.lineAddress(row * 8 + line) + col * 8);

    const cells = pcwScreenCells(read, font);
    if (!cells) return { text: OCR_UNAVAILABLE, html: '', grid: PCW_OCR_GRID, cells: null };

    // The overlay is a <pre>, and the PCW's screen is monochrome, so the rows
    // go out as plain escaped text — no per-cell colour spans to emit. Rows
    // keep their full width so the overlay scales to the picture predictably.
    const lines: string[] = [];
    for (let row = 0; row < cells.rows; row++) {
      const from = row * cells.cols;
      lines.push(cells.chars.slice(from, from + cells.cols).join(''));
    }
    const html = lines.map(escapeHtml).join('\n');
    return { text: lines.join('\n').replace(/\s+$/, ''), html, grid: PCW_OCR_GRID, cells };
  }

  /** Paint every transcribed cell out of the framebuffer, so the overlay's text
   *  replaces the picture instead of sitting on top of it. */
  blankTextCells(cells: PcwOcrCells): void {
    const fill = this.asic.paper;
    for (let row = 0; row < cells.rows; row++) {
      for (let col = 0; col < cells.cols; col++) {
        if (!cells.mask[row * cells.cols + col]) continue;
        const x0 = PCW_BORDER_LEFT + col * 8;
        for (let y = 0; y < 8; y++) {
          const base = (PCW_BORDER_TOP + row * 8 + y) * PCW_SCREEN_WIDTH + x0;
          this._pixels32.fill(fill, base, base + 8);
        }
      }
    }
  }
}

/** Grid label stamped on every PCW transcription: 90 columns of 8x8 cells. */
const PCW_OCR_GRID: OcrGridName = '90x32';

const OCR_UNAVAILABLE =
  '[pcw] OCR unavailable: no character set at the usual address '
  + '(block 2, &3800), so the screen cannot be transcribed.';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
