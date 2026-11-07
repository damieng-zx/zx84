/**
 * PcwMachine — Amstrad PCW 8256 / 8512 / 9512 orchestrator.
 *
 * The PCW's counterpart to `Spectrum` / `CpcMachine`: it owns the
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
 *
 * Snapshots are zx84's own `.pcwstate` (`snapshots/pcw-state.ts`).
 */

import { Z80 } from '@/cores/z80.ts';
import { UPD765A } from '@/cores/upd765a.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { disasmOne, type DisasmLine } from '@/debug/z80/disasm.ts';
import { z80ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { Z80Trace } from '@/debug/z80/trace.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind,
  AuxRomRequest, SettingsView,
} from '@/machines/machine.ts';
import { resolveDriveCount } from '@/machines/shared/drive-count.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import {
  PCW_FONT_BLOCK, PCW_FONT_BYTES, PCW_FONT_OFFSET,
  pcwScreenCells, pcwScreenText, type PcwOcrCells,
} from '@/ocr/pcw.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { withStopsDisarmed } from '@/machines/shared/native-state.ts';
import { PcwMemory } from './pcw-memory.ts';
import { PcwAsic, PCW_TIMING_50HZ, PCW_TIMING_60HZ, TickSync } from './asic.ts';
import { PcwKeyboard } from './pcw-keyboard.ts';
import { PcwJoystick } from './pcw-joystick.ts';
import { PcwPrinterLog } from './printer.ts';
import { createPcwConfig, type PcwConfig } from './config.ts';
import type { PcwModel } from './models.ts';
import { pcwDescriptor } from './descriptor.ts';
import { createPcwServices, type PcwServices } from './services/index.ts';
import { installPcwMemoryHooks, wirePcwPortIO } from './pcw-io.ts';
import { bootFailureMessage, loadBootSector } from './bootstrap.ts';
import {
  PCW_BOOT_ENTRY_ADDR, PCW_BOOT_LOAD_ADDR, PCW_BORDER_LEFT, PCW_BORDER_TOP,
  PCW_CPU_CLOCK, PCW_FDC_INT_RESPONSE_LINES, PCW_PHOSPHORS, PCW_SCREEN_HEIGHT,
  PCW_SCREEN_WIDTH, PCW_T_PER_LINE, PCW_TIMER_PULSE_T, PcwCommand,
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
  /** The add-on joystick interface (Kempston, Spectravideo or Cascade). */
  readonly joystick = new PcwJoystick();
  /** The 3" drives. Drive B exists only on the 8512. */
  readonly fdc = new UPD765A();
  /** Drives actually fitted: the model's own count, or fewer if the user chose
   *  so from the Drives pane (set from the settings in prepare()). */
  driveCount: number;
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
  /** T-state at which the current 300Hz timer pulse on /INT ends. */
  private timerPulseEnd = 0;
  /** T-state of the last audio mix step. */
  private lastAudioT = 0;

  /** Everything the BIOS has sent the printer controller (ports &FC/&FD),
   *  for the Save menu's printer-output download. */
  readonly printer = new PcwPrinterLog();

  /** Per-frame I/O activity, mapped onto the status-bar LEDs by the probe. */
  readonly activity = {
    kbdReads: 0, fdcAccesses: 0, beeperWrites: 0, printerWrites: 0,
  };

  /** RGBA frame buffer plus a Uint32 view for fast gate-array writes. */
  private readonly _pixels = new Uint8Array(PCW_SCREEN_WIDTH * PCW_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  /** 312 lines at 50Hz, 260 at 60Hz (the motherboard's frame-rate link). */
  get tStatesPerFrame(): number { return this.asic.timing.linesPerFrame * PCW_T_PER_LINE; }
  protected override get frameHz(): number { return this.asic.timing.hz; }
  get cpuClockHz(): number { return PCW_CPU_CLOCK; }
  get frameWidth(): number { return PCW_SCREEN_WIDTH; }
  get frameHeight(): number { return PCW_SCREEN_HEIGHT; }

  constructor(model: PcwModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.config = createPcwConfig(model);
    this.cpu = new Z80();
    this.cpu.onInterrupt = (handler, nmi) => this.noteInterrupt(handler, nmi);
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
    this.driveCount = this.config.drives;
    this.fdc.connected[1] = this.driveCount > 1;
    // Drive A is a single-sided mechanism on the 8000s; B (8512 only) and the
    // 9000s' A are double-sided. A one-headed drive has nothing on the head
    // select line, so the FDC reads side 0 whichever head a command names.
    this.fdc.singleSided[0] = !this.config.doubleSidedA;
    this.fdc.singleSided[1] = false;
    // The PCW is the only machine here that waits on the FDC's interrupt line
    // rather than polling the status register, so it is the only one that can
    // tell the controller answers instantly. Give it a response time.
    this.fdc.intResponseTicks = PCW_FDC_INT_RESPONSE_LINES;

    // The gate array presents the keyboard matrix at &3FF0-&3FFF of block 3.
    this.memory.attachKeyboard(this.keyboard.matrix);

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
   * The dot-matrix PCWs talk to a printer controller that drives the 9-pin
   * head, and the 9512 puts a daisywheel controller behind the same ports.
   * Neither mechanism is emulated: every byte is logged (`printer`) for the
   * Save menu, and &FD reads back "ready with paper" so the BIOS's handshake
   * never waits.
   */
  printerWrite(port: number, value: number): void {
    this.activity.printerWrites++;
    this.printer.write(port, value);
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
    // Said after any boot message, which would otherwise hide it.
    if (this.fdc.singleSided[unit] && image.numSides > 1 && !image.flippy) {
      this.setStatus(`Drive ${unit === 0 ? 'A' : 'B'} is single-sided: only the first side of this double-sided disc can be read`);
    }
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

  /** Build-time hook: fit the number of drives the user chose (never more than
   *  the model shipped with). A PCW has no peripheral ROMs to fetch. */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.driveCount = resolveDriveCount(view, 'pcw', this.config.drives);
    this.fdc.connected[1] = this.driveCount > 1;
    // The 50/60Hz link sets the frame length, so it is fitted at build time.
    this.asic.timing = view.get('pcw-60hz', false) ? PCW_TIMING_60HZ : PCW_TIMING_50HZ;
    return [];
  }

  applySettings(view: SettingsView): void {
    const phosphor = PCW_PHOSPHORS[view.get('pcw-phosphor', this.config.phosphor)]
      ?? PCW_PHOSPHORS[this.config.phosphor];
    this.asic.ink = phosphor.ink;
    this.asic.paper = phosphor.paper;
    this.fdc.writeProtect[0] = view.get('write-protect-a', false);
    this.fdc.writeProtect[1] = view.get('write-protect-b', false);
    this.joystick.setType(view.get<string>('joy-p1', 'kempston'));
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

  /** Save menu's printer output: the controller log decoded as text, or null
   *  while nothing has been sent to the printer. */
  printerExportBytes(): { data: Uint8Array; filename: string } | null {
    if (this.printer.empty) return null;
    return {
      data: new TextEncoder().encode(this.printer.text(this.config.printer)),
      filename: 'printer.txt',
    };
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
    this.timerPulseEnd = 0;
    this.printer.markReset();
    this.audio.reset();
    this.mixer.reset();
    this.resetFrameCount();
    this.needsDisplay = true;
    // A reset with a disc already in drive A boots straight back into it.
    if (!this.boot()) this.setStatus('Reset');
  }

  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  // ── Beam ────────────────────────────────────────────────────────────────

  /** The next line of the frame in progress to run, and whether its
   *  start-of-line work (gate array line, timer pulse, FDC sample) is done —
   *  both carry over a stop. */
  private fLine = 0;
  private fLineLive = false;

  /** Frame line 0 is the first displayed line. Each line is drawn whole when
   *  the CPU reaches its end. */
  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    const t = this.asic.timing;
    const ticks: number[] = [];
    for (let line = 0; line < t.linesPerFrame; line++) {
      if (PcwAsic.isInterruptLine(line)) ticks.push(line);
    }
    return {
      cyclesPerLine: PCW_T_PER_LINE,
      linesPerFrame: t.linesPerFrame,
      displayStart: 0,
      note: `${t.hz}Hz: line 0 is the first of the ${t.displayHeight} displayed lines; frame `
        + `flyback (the status byte's b6) is lines ${t.flybackStart}-${t.flybackStart + 25}; the `
        + `300Hz timer ticks at the start of lines ${ticks.join(', ')}, pulsing /INT for `
        + '~100us and counting in the &F4 register; each line '
        + 'is drawn whole when the CPU reaches its end, so t within '
        + 'a line is not a pixel position; a line is 218 T-states, 3.4MHz rounded to whole '
        + 'T-states per 64us line',
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return z80ReturnAddress(this.cpu.sp, a => this.memory.readByte(a)); }

  /**
   * Execute one field: 312 scan lines of 218 T-states (260 with the 60Hz link).
   *
   * Per scan line: advance the gate array (which raises a 300Hz timer tick, and
   * a ~100us pulse on /INT, on the lines that carry one), sample the FDC's
   * interrupt line, run the CPU to the end of the line — dropping the pulse
   * partway through the next line — then draw it.
   */
  protected runFrame(): void {
    const asic = this.asic;
    const lines = asic.timing.linesPerFrame;
    const skipAudio = this.speedMultiplier !== 1;
    // A frame a stop left part-way carries on from the line it was in.
    if (!this.openFrame(lines * PCW_T_PER_LINE)) {
      const a = this.activity;
      a.kbdReads = 0; a.fdcAccesses = 0; a.beeperWrites = 0; a.printerWrites = 0;
      asic.beginFrame(this._pixels32);
      this.fLine = 0;
      this.fLineLive = false;
    }
    this.portWatchHit = null;
    this.memWatchHit = null;
    this.lastAudioT = this.cpu.tStates;

    for (; this.fLine < lines; this.fLine++) {
      const line = this.fLine;
      const lineStart = this.frameStartT + line * PCW_T_PER_LINE;
      const lineEnd = lineStart + PCW_T_PER_LINE;

      if (!this.fLineLive) {
        this.fLineLive = true;
        asic.beginLine(line);

        if (PcwAsic.isInterruptLine(line)) {
          this.timerPulseEnd = lineStart + PCW_TIMER_PULSE_T;
          // The gate array scans the keyboard into block 3 continuously, "even
          // when interrupts are disabled". Refreshing it on the timer lines
          // gives software a matrix at most one 300Hz tick old, which is as
          // fresh as the real DMA ever is.
          this.scanKeyboard();
        }

        // The FDC's interrupt line is sampled per scan line: 64us of latency on
        // a signal the BIOS reaches through an interrupt handler is
        // immaterial, and this keeps the inner loop free of a per-instruction
        // chip poll. The same tick is what the controller's command-response
        // time is charged against (see PCW_FDC_INT_RESPONSE_LINES).
        this.fdc.tickIntResponse();
        asic.fdcInt = this.fdc.interruptLine;
      }

      // End the timer pulse where it falls inside this line. Only the pulse's
      // end clears `timerPending`, so after a stop this is still true exactly
      // when the stop fell before the pulse ended.
      let broke = false;
      if (asic.timerPending && this.timerPulseEnd < lineEnd) {
        broke = this.runCpuUntil(this.timerPulseEnd, skipAudio);
        if (!broke) asic.endTimerPulse();
      }
      if (!broke) broke = this.runCpuUntil(lineEnd, skipAudio);

      // Draw the line even when execution broke inside it, so a breakpoint
      // leaves a coherent partial frame rather than a torn one (the line is
      // drawn again when the resumed frame finishes it).
      asic.renderScanline(this._pixels32, line);
      if (broke) {
        // The frame stays open; the next call carries on in this line.
        this.midFrame = true;
        this.needsDisplay = true;
        return;
      }
      this.fLineLive = false;
    }

    this.needsDisplay = true;

    if (this.rebootRequested) {
      this.rebootRequested = false;
      this.reset();
    }
  }

  /** Run the CPU until `until` T-states, servicing /NMI, /INT and audio.
   *  Returns true if a stop (breakpoint, trap, beam target or watchpoint)
   *  ended the run. */
  private runCpuUntil(until: number, skipAudio: boolean): boolean {
    const cpu = this.cpu;
    const asic = this.asic;
    while (cpu.tStates < until) {
      if (this.checkStops(cpu.pc)) return true;

      this.beforeInsn(cpu.pc);
      // A timer tick reaches the &F4 counter over two opcode fetches (see
      // PcwAsic.syncTickBefore); only the instruction after a tick pays this.
      if (asic.tickSync === TickSync.Raised) asic.syncTickBefore(this.m1CyclesAtPc());
      cpu.step();
      if (asic.tickSync === TickSync.Latched) asic.syncTickAfter();
      const stopped = this.afterInsn();

      // /NMI is edge triggered, so it fires once per rising edge of the FDC's
      // interrupt line however long that line stays up.
      const nmiLine = asic.nmiPending;
      if (nmiLine && !this.lastNmiLine) cpu.nmi();
      this.lastNmiLine = nmiLine;

      // /INT is level-sensitive: the timer pulse (and a routed FDC interrupt)
      // stay asserted whether or not the CPU takes them.
      if (asic.intPending && cpu.iff1 && !cpu.eiDelay) cpu.interrupt();

      if (!skipAudio) {
        const elapsed = cpu.tStates - this.lastAudioT;
        if (elapsed > 0) {
          this.mixer.accumulate(this.beeperBit, elapsed);
          this.mixer.generateSamples(this.audio, null, false);
          this.lastAudioT = cpu.tStates;
        }
      }
      // Stop on the instruction that tripped a watchpoint, with the frame
      // open, after the interrupt check so a resume takes a pending one where
      // a run would.
      if (stopped) return true;
    }
    return false;
  }

  /** Opcode fetches the next instruction makes before its operands: two for
   *  a CB/DD/ED/FD prefix, otherwise one (a halted CPU fetches NOPs). */
  private m1CyclesAtPc(): number {
    if (this.cpu.halted) return 1;
    const op = this.memory.readByte(this.cpu.pc);
    return op === 0xCB || op === 0xDD || op === 0xED || op === 0xFD ? 2 : 1;
  }

  /** One keyboard transmission (the matrix itself is read live through the
   *  block-3 overlay). Counts as keyboard activity only while a key is held. */
  private scanKeyboard(): void {
    this.keyboard.scan();
    if (this.keyboard.anyKeyDown) this.activity.kbdReads++;
  }

  /** True while any interrupt source is asserted. */
  get intPending(): boolean { return this.asic.intPending; }

  // ── Snapshot state (.pcwstate) ────────────────────────────────────────────

  /** The PCW has no ROM (the bootstrap is native code), so no ROM CRCs. */
  stateRomCrcs(): number[] { return []; }

  /** Run the rest of a frame a stop left open, so the machine is between
   *  frames (where a snapshot is taken). */
  private completeFrame(): void {
    if (this.midFrame) withStopsDisarmed(this, () => this.stepFrame());
  }

  /**
   * Write the machine's sections of a `.pcwstate` (see snapshots/pcw-state.ts):
   * the fitted drive count first, so a restore can refuse a mismatch before it
   * changes anything, then the CPU, the frame grid and machine latches, RAM
   * and paging, the gate array, the keyboard latches, the discs (with
   * `withMedia`) and the uPD765A.
   */
  saveState(w: StateWriter, withMedia: boolean): void {
    this.completeFrame();
    w.section('CONF', () => { w.u8(this.driveCount); w.u8(this.asic.timing.hz); });
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameStartT); w.f64(this.frameEndT); w.f64(this.frameNumber);
      w.u8(this.beeperBit); w.bool(this.booted); w.bool(this.rebootRequested);
      w.bool(this.lastNmiLine); w.f64(this.timerPulseEnd);
    });
    w.section('MEM ', () => this.memory.saveState(w));
    w.section('ASIC', () => this.asic.saveState(w));
    w.section('KBD ', () => this.keyboard.saveState(w));
    w.section('MEDA', () => {
      w.bool(withMedia);
      if (withMedia) this.services.disks.saveState(w);
    });
    w.section('FDC ', () => this.fdc.saveState(w));
    w.section('PRN ', () => this.printer.saveState(w));
  }

  /** Restore a state written by {@link saveState}. The frame loop must be
   *  stopped. Throws before changing anything if the drive count differs. */
  loadState(r: StateReader): void {
    const conf = r.section('CONF');
    const drives = conf.u8();
    if (drives !== this.driveCount) {
      const n = (k: number) => (k === 1 ? 'one drive' : `${k} drives`);
      throw new Error(`This snapshot was saved with ${n(drives)} and this PCW has ${n(this.driveCount)}; change it in the Drives pane and load it again`);
    }
    // States from before the 50/60Hz link was modelled are all 50Hz.
    const hz = conf.remaining > 0 ? conf.u8() : 50;
    if (hz !== this.asic.timing.hz) {
      throw new Error(`This snapshot was saved on a ${hz}Hz PCW and this one is ${this.asic.timing.hz}Hz; change the 60Hz link in the Hardware pane and load it again`);
    }
    this.cpu.loadState(r.section('CPU '));
    {
      const s = r.section('MACH');
      this.frameStartT = s.f64(); this.frameEndT = s.f64(); this.frameNumber = s.f64();
      this.beeperBit = s.u8() & 1; this.booted = s.bool(); this.rebootRequested = s.bool();
      this.lastNmiLine = s.bool(); this.timerPulseEnd = s.f64();
    }
    this.memory.loadState(r.section('MEM '));
    this.asic.loadState(r.section('ASIC'));
    this.keyboard.loadState(r.section('KBD '));
    {
      // Discs go in before the FDC's state, which finds the track and sector
      // of a transfer in flight in them.
      const s = r.section('MEDA');
      if (s.bool()) this.services.disks.loadState(s);
    }
    this.fdc.loadState(r.section('FDC '));
    // Printer output was added after the first states were written.
    if (r.peekSection('PRN ')) this.printer.loadState(r.section('PRN '));
    else this.printer.clear();

    // What the state does not hold: nothing is part-way through a frame.
    this.midFrame = false;
    this.fLineLive = false;
    this.clearInterrupts();
    this.lastAudioT = this.cpu.tStates;
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
  }

  // ── Machine: debug helpers ────────────────────────────────────────────────

  disasmAt(pc: number): DisasmLine {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 8; i++) buf[i] = this.memory.readByte((pc + i) & 0xFFFF);
    return { ...disasmOne(buf, 0), addr: pc };
  }

  /** Execution trace: BaseMachine's startTrace/stopTrace drive it and
   *  beforeInsn/afterInsn feed it (debug/z80/trace.ts). */
  protected override tracer = new Z80Trace(this);

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

    const text = pcwScreenText(read, font, this.asic.timing.displayHeight / 8);
    if (text === null) return OCR_UNAVAILABLE;
    return text;
  }

  /** Grid label stamped on a transcription: 90 columns of 8x8 cells by the
   *  32 rows shown at 50Hz or the 25 shown at 60Hz. */
  private get ocrGrid(): OcrGridName {
    return this.asic.timing.hz === 60 ? '90x25' : '90x32';
  }

  /** The same transcription, shaped for the TEXT overlay: the full untrimmed
   *  grid as HTML, plus the mask of cells the overlay may blank. */
  ocrScreenStyled(): { text: string; html: string; grid: OcrGridName; cells: PcwOcrCells | null } {
    const font = this.memory.getRamBank(PCW_FONT_BLOCK)
      .subarray(PCW_FONT_OFFSET, PCW_FONT_OFFSET + PCW_FONT_BYTES);
    const read = (col: number, row: number, line: number): number =>
      this.memory.videoByte(this.asic.lineAddress(row * 8 + line) + col * 8);

    const cells = pcwScreenCells(read, font, this.asic.timing.displayHeight / 8);
    if (!cells) return { text: OCR_UNAVAILABLE, html: '', grid: this.ocrGrid, cells: null };

    // The overlay is a <pre>, and the PCW's screen is monochrome, so the rows
    // go out as plain escaped text — no per-cell colour spans to emit. Rows
    // keep their full width so the overlay scales to the picture predictably.
    const lines: string[] = [];
    for (let row = 0; row < cells.rows; row++) {
      const from = row * cells.cols;
      lines.push(cells.chars.slice(from, from + cells.cols).join(''));
    }
    const html = lines.map(escapeHtml).join('\n');
    return { text: lines.join('\n').replace(/\s+$/, ''), html, grid: this.ocrGrid, cells };
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


const OCR_UNAVAILABLE =
  '[pcw] OCR unavailable: no character set at the usual address '
  + '(block 2, &3800), so the screen cannot be transcribed.';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
