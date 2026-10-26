/**
 * MsxMachine — MSX1 orchestrator (Toshiba HX-10 PAL, Sony HB-55 NTSC).
 *
 * The MSX counterpart to `Spectrum` / `CpcMachine` / `EinsteinMachine`: it owns
 * the Z80, AY-3-8910 PSG and TMS9929A VDP (all reused unchanged) plus MSX-
 * specific parts — the 8255 PPI (keyboard scan + primary-slot select), the slot-
 * paged memory and the keyboard — and drives its own field loop (313 PAL lines at
 * 50 Hz or 262 NTSC lines at 60 Hz, per the model's {@link MsxConfig}). Implements
 * the shared `Machine` interface so `emulator.ts`, the UI and the MCP server
 * treat it like any other machine.
 *
 * Unlike the Einstein, the MSX wires the VDP's end-of-active-display interrupt
 * straight to the Z80 /INT and services it in interrupt mode 1 (RST 38h); and
 * because MSX BASIC lives in the 32KB internal ROM, the machine boots straight
 * to the BASIC "Ok" prompt with no disk.
 */

import { Z80 } from '@/cores/z80.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { WD179x } from '@/cores/wd179x.ts';
import { Tms9918a, MSX_PALETTES } from '@/cores/tms9918a.ts';
import { TapeDeck } from '@/media/tape/tap.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { disasmOne, type DisasmLine } from '@/debug/z80/disasm.ts';
import { z80ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { Z80Trace } from '@/debug/z80/trace.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import { soundDeviceGains } from '@/machines/machine.ts';
import type { AuxRomRequest, Machine, MachineHost, MachineKind, MachineDescriptor, BorderMode, SettingsView } from '@/machines/machine.ts';
import { applyAySettings } from '@/machines/shared/ay-settings.ts';
import { resolveDriveCount } from '@/machines/shared/drive-count.ts';
import { msxDescriptor } from '@/machines/msx/descriptor.ts';
import { createMsxServices, type MsxServices } from '@/machines/msx/services/index.ts';
import type { MsxModel } from '@/models.ts';
import type { OcrGridName, OcrResult } from '@/ocr/ocr.ts';
import { MsxScreenText, msxTextGrid } from '@/ocr/msx.ts';
import { MsxCassette, MSX_TAPION, MSX_TAPIN, MSX_TAPOON, MSX_TAPOUT } from '@/machines/msx/msx-tape.ts';
import { MsxMemory } from '@/machines/msx/msx-memory.ts';
import { MsxKeyboard } from '@/machines/msx/msx-keyboard.ts';
import { MsxJoystick } from '@/machines/msx/msx-joystick.ts';
import { MsxDiskInterface } from '@/machines/msx/peripherals/disk-interface.ts';
import { msxDiskAuxRom, msxFirmwareAuxRom } from '@/machines/msx/aux-roms.ts';
import { MsxPpi, installMsxMemoryHooks, wireMsxPortIO } from '@/machines/msx/msx-io.ts';
import { createMsxConfig, type MsxConfig } from '@/machines/msx/config.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import {
  MSX_CPU_CLOCK, MSX_PSG_CLOCK, MSX_MAX_DRIVES,
  MSX_SCREEN_WIDTH, MSX_SCREEN_HEIGHT,
  MSX_BORDER_LEFT, MSX_BORDER_TOP,
} from '@/machines/msx/constants.ts';

/** The key click's level against the AY at full scale, before its Sound-pane volume. */
const KEY_CLICK_GAIN = 0.5;

/** Active display lines (0..191); the VDP raises its vblank at line 192. */
const ACTIVE_LINES = 192;

export class MsxMachine extends BaseMachine implements Machine {
  protected get audioChip(): AY3891x { return this.ay; }
  protected override get frameHz(): number { return this.config.frameHz; }
  readonly kind: MachineKind = 'msx';
  readonly model: MsxModel;
  readonly config: MsxConfig;
  /** Operator's panel (shell / MCP) — null when running headless. */
  host: MachineHost | null = null;
  /** The service surface (§3.3): the only way shell/UI/MCP reach internals. */
  readonly services: MsxServices;

  readonly cpu: Z80;
  readonly memory: MsxMemory;
  readonly ay: AY3891x;
  readonly vdp: Tms9918a;
  readonly keyboard: MsxKeyboard;
  readonly joystick: MsxJoystick;
  readonly ppi: MsxPpi;
  /** The optional floppy disk interface (slot 3): WD2793 + Disk BASIC ROM. */
  readonly diskIf = new MsxDiskInterface();
  /** Its controller, as the shared `Machine.fdc` surface (inert until fitted). */
  readonly fdc: WD179x = this.diskIf.fdc;
  /** Disk interface fitted (needs its Disk BASIC ROM loaded as well). */
  floppyEnabled = false;
  /** How many of the interface's two drives are fitted (Drives pane choice). */
  driveCount = MSX_MAX_DRIVES;
  /** Inert cassette deck (interface requirement; cassette is a follow-up). */
  readonly tape: TapeDeck;
  readonly mixer: AudioMixer;
  readonly audio: Audio;
  display: IScreenRenderer | null;

  /** Per-frame I/O activity for the status-bar LEDs / tape progress. */
  readonly activity = { kbdReads: 0, ayWrites: 0, casReads: 0, fdcAccesses: 0 };

  /** Screen-text OCR engine for the MCP `ocr` tool and the TEXT overlay. */
  readonly screenText = new MsxScreenText();

  /** Cassette (.cas) — loaded on demand; served through BIOS traps. */
  readonly cassette = new MsxCassette();

  /** Name of the mounted cartridge (empty if none), for the ROM pane. */
  cartridgeName = '';

  /** Kana-lock LED (PSG port B bit 7, active-low): lit while a Japanese MSX is
   *  in kana input mode. Always false on a machine whose BIOS never drives it. */
  kanaLed = false;

  /** RGBA frame buffer + a Uint32 view for fast VDP writes. */
  private readonly _pixels = new Uint8Array(MSX_SCREEN_WIDTH * MSX_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  get tStatesPerFrame(): number { return this.config.tStatesPerFrame; }

  constructor(model: MsxModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.config = createMsxConfig(model);
    this.cpu = new Z80();
    this.cpu.m1WaitStates = 1; // MSX adds one WAIT clock to each opcode fetch.
    this.cpu.onInterrupt = (handler, nmi) => this.noteInterrupt(handler, nmi);
    this.memory = new MsxMemory(this.config.layout);
    this.ay = new AY3891x(MSX_PSG_CLOCK, 48000, 'ABC');
    this.vdp = new Tms9918a();
    this.keyboard = new MsxKeyboard();
    this.joystick = new MsxJoystick();
    this.ppi = new MsxPpi(this.memory, this.keyboard);
    this.tape = new TapeDeck(MSX_CPU_CLOCK);
    this.audio = new Audio();
    this.mixer = new AudioMixer(MSX_CPU_CLOCK);
    // The 1-bit "beeper" path carries the PPI port C bit 7 key click.
    this.mixer.beeperGain = KEY_CLICK_GAIN;
    this.mixer.ayGain = 1;
    this.display = display ?? null;

    installMsxMemoryHooks(this);
    wireMsxPortIO(this);

    this.services = createMsxServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  get descriptor(): MachineDescriptor { return msxDescriptor(this.model); }
  get frameWidth(): number { return MSX_SCREEN_WIDTH; }
  get frameHeight(): number { return MSX_SCREEN_HEIGHT; }
  /** Nominal CPU clock (3.58 MHz). */
  get cpuClockHz(): number { return this.tape.cpuClock; }

  /** `.scr` export: the TMS9918A's 16KB VRAM *is* the screen. */
  screenExportBytes(): Uint8Array { return this.vdp.vram.slice(); }

  /** RAM export: the physical RAM image (64K on the HX-10, 16K on the HB-55). */
  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ramBytes(), filename: `ram-${this.config.ramKB}k.bin` };
  }

  /** Apply the MSX-specific settings: the TMS9918A PAL/NTSC colour map and the
   *  master volume (AY/PSG-only). */
  applySettings(view: SettingsView): void {
    this.vdp.palette = MSX_PALETTES[view.get('msx-color-map', 'pal') as keyof typeof MSX_PALETTES];
    this.audio.setVolume(view.get('volume', 70) / 100);
    // The key click and the AY each have a volume; 100 % keeps the hardware's levels.
    const gains = soundDeviceGains(this.descriptor.ui.soundDevices, view);
    this.mixer.beeperGain = KEY_CLICK_GAIN * gains.beeper;
    this.mixer.ayGain = gains.psg;
    applyAySettings(this.ay, view);
    // The Hardware pane's "reset settings" turns the option off underneath a
    // fitted card: take it out and cold-start, since Disk BASIC's hooks into
    // slot 3 must not outlive it. (Fitting is prepare()'s job — it has the ROM.)
    if (this.floppyEnabled && !view.get('msx-floppy', false)) {
      const wasRunning = this.running;
      this.setFloppyEnabled(false);
      this.reset();
      if (wasRunning) void this.start();
    }
  }

  // ── Machine: lifecycle ───────────────────────────────────────────────

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    this.setStatus('ROM loaded');
  }

  /** Install the model's on-board firmware ROM (HB-55 Personal Data Bank). */
  loadFirmware(data: Uint8Array): void {
    this.memory.loadFirmware(data);
  }

  /** Insert a disk into drive `unit` (0 = A:, 1 = B:) of the disk interface. */
  loadDisk(image: DskImage, unit = 0): void {
    this.fdc.insertDisk(image, unit);
  }

  /** Install the Disk BASIC ROM and (re)map slot 3. */
  loadDiskRom(data: Uint8Array): void {
    this.diskIf.loadROM(data);
    this.syncDiskSlot();
  }

  /** Fit or remove the floppy disk interface. Removing it ejects both drives. */
  setFloppyEnabled(enabled: boolean): void {
    if (!enabled && this.floppyEnabled) {
      this.fdc.ejectDisk(0);
      this.fdc.ejectDisk(1);
    }
    this.floppyEnabled = enabled;
    this.syncDiskSlot();
  }

  /** The card only appears in slot 3 once it is enabled *and* has its ROM —
   *  without the ROM there is nothing for the BIOS slot scan to find. */
  private syncDiskSlot(): void {
    this.memory.setDiskInterface(this.floppyEnabled && this.diskIf.romLoaded ? this.diskIf : null);
  }

  /** Configure the fitted disk interface from settings; the Disk BASIC ROM it
   *  needs is returned for the shell to fetch before the machine is reset. */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.fdc.writeProtect[0] = view.get('write-protect-a', false);
    this.fdc.writeProtect[1] = view.get('write-protect-b', false);
    this.driveCount = resolveDriveCount(view, 'msx', MSX_MAX_DRIVES);
    for (let u = 0; u < this.fdc.connected.length; u++) this.fdc.connected[u] = u < this.driveCount;
    this.setFloppyEnabled(view.get('msx-floppy', false));
    const requests: AuxRomRequest[] = [];
    // Optional on-board firmware (HB-55 Data Bank): a missing ROM only costs
    // that feature — the BIOS and BASIC still boot without it.
    if (this.config.firmware !== null && !this.memory.hasFirmware) requests.push(msxFirmwareAuxRom(this));
    if (this.floppyEnabled && !this.diskIf.romLoaded) requests.push(msxDiskAuxRom(this));
    return requests;
  }

  /** Mount a `.cas` cassette image (served instantly via BIOS TAPION/TAPIN). */
  mountCas(data: Uint8Array, name = ''): void {
    this.cassette.mount(data, name);
    this.setStatus(`Cassette: ${name || 'loaded'} — type CLOAD or BLOAD"CAS:"`);
  }

  /** Insert a cartridge ROM into slot 1. The caller resets the machine so the
   *  BIOS slot scan finds and auto-runs it. */
  insertCartridge(data: Uint8Array, name = ''): void {
    this.memory.insertCartridge(data);
    this.cartridgeName = name;
  }

  /** Remove the cartridge from slot 1. */
  ejectCartridge(): void {
    this.memory.removeCartridge();
    this.cartridgeName = '';
  }

  /** Resolve the Memory-pane ROM region: the 32KB internal ROM at &0000. */
  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    if (value === 'rom0') return { data: this.memory.getRom(), baseAddr: 0x0000 };
    const firmware = this.memory.getFirmware();
    if (value === 'rom-firmware' && firmware) return { data: firmware, baseAddr: (this.config.layout.firmwarePage ?? 0) * 0x4000 };
    if (value === 'rom-disk' && this.diskIf.romLoaded) return { data: this.diskIf.getRom(), baseAddr: 0x4000 };
    return null;
  }

  /** RET from a trapped BIOS routine: pop the return address into PC. */
  private retFromTrap(): void {
    const sp = this.cpu.sp;
    const lo = this.memory.readByte(sp);
    const hi = this.memory.readByte((sp + 1) & 0xFFFF);
    this.cpu.sp = (sp + 2) & 0xFFFF;
    this.cpu.pc = ((hi << 8) | lo) & 0xFFFF;
    this.cpu.tStates += 11;
  }

  /** TAPION: skip to the next block header; CY set on failure. */
  private trapTapion(): void {
    this.cpu.setFlag(Z80.FLAG_C, !this.cassette.findHeader());
    this.activity.casReads++;
    this.retFromTrap();
  }

  /** TAPIN: read one byte into A; CY set at end of stream. */
  private trapTapin(): void {
    this.activity.casReads++;
    const b = this.cassette.readByte();
    if (b < 0) {
      this.cpu.setFlag(Z80.FLAG_C, true);
    } else {
      this.cpu.a = b & 0xFF;
      this.cpu.setFlag(Z80.FLAG_C, false);
    }
    this.retFromTrap();
  }

  /** TAPOON: begin a saved block (sync ID); CY clear = success. */
  private trapTapoon(): void {
    this.cassette.beginRecordBlock();
    this.cpu.setFlag(Z80.FLAG_C, false);
    this.retFromTrap();
  }

  /** TAPOUT: save the byte in A; CY clear = success. */
  private trapTapout(): void {
    this.cassette.recordByte(this.cpu.a);
    this.cpu.setFlag(Z80.FLAG_C, false);
    this.retFromTrap();
  }

  setBorderSize(mode: BorderMode): void {
    // The VDP always renders into the full framebuffer with the active area
    // centred; cropping is a pure display concern.
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(MSX_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(MSX_BORDER_TOP * (1 - frac));
    if (this.display) {
      this.display.setViewport(
        cropX, cropY,
        MSX_SCREEN_WIDTH - cropX * 2,
        MSX_SCREEN_HEIGHT - cropY * 2,
      );
    }
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    // The MSX runs in interrupt mode 1 (VDP INT → RST 38h). Z80.reset() already
    // defaults im=1, so — unlike the Einstein — we must NOT force im=2 here.
    this.ay.reset();
    this.vdp.reset();
    this.memory.reset();
    this.keyboard.reset();
    this.joystick.reset();
    this.ppi.reset();
    this.diskIf.reset();
    this.kanaLed = false;
    this.cassette.clearRecording();
    this.audio.reset();
    this.mixer.reset();
    this.resetFrameCount();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  // start / stop / destroy / tick / runUntil live on BaseMachine.

  protected framePixels(): Uint8Array { return this._pixels; }

  protected inTurbo(): boolean { return this.turbo; }

  /**
   * Execute one field (PAL or NTSC). Runs the CPU scanline by scanline; renders the 192
   * active lines; at the end of the active display raises the VDP vblank, which
   * (with R1 interrupt-enable set) pulls the Z80 /INT — serviced in IM 1.
   */
  /** The next line of the frame in progress to run (it carries over a stop). */
  private fLine = 0;

  /** Frame line 0 is the VDP's first active line; the frame interrupt comes
   *  at the end of line 192. Each line is drawn when the CPU reaches its end. */
  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: this.config.tStatesPerFrame / this.config.linesPerFrame,
      linesPerFrame: this.config.linesPerFrame,
      displayStart: 0,
      note: 'line 0 is the first active line of the VDP; each line is drawn whole when the CPU reaches its end, so a VDP write shows from the line it is made in',
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return z80ReturnAddress(this.cpu.sp, a => this.memory.peekByte(a)); }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    const linesPerFrame = this.config.linesPerFrame;
    const tPerLine = this.config.tStatesPerFrame / linesPerFrame;
    // A frame a stop left part-way carries on from the line it was in.
    if (!this.openFrame(this.config.tStatesPerFrame)) {
      this.activity.kbdReads = 0;
      this.activity.ayWrites = 0;
      this.activity.casReads = 0;
      this.diskIf.accesses = 0;
      // Fill the whole buffer (incl. border) with the current backdrop.
      this._pixels32.fill(this.vdp.backdrop());
      this.fLine = 0;
    }
    this.portWatchHit = null;
    this.memWatchHit = null;

    let lastAudioT = this.cpu.tStates;
    let broke = false;

    for (; this.fLine < linesPerFrame; this.fLine++) {
      const line = this.fLine;
      const lineEnd = this.frameStartT + (line + 1) * tPerLine;

      while (this.cpu.tStates < lineEnd) {
        if (this.checkStops(this.cpu.pc)) { broke = true; break; }

        // Cassette: intercept the BIOS routines while the BIOS ROM is paged
        // into page 0 — TAPION/TAPIN serve a mounted .cas instantly, and
        // TAPOON/TAPOUT record whatever is saved. All sit in 0x00E0–0x00EF.
        if ((this.cpu.pc & 0xFFF0) === 0x00E0 && (this.memory.getPrimarySlot() & 0x03) === 0) {
          const pc = this.cpu.pc;
          if (this.cassette.loaded) {
            if (pc === MSX_TAPION) { this.trapTapion(); continue; }
            if (pc === MSX_TAPIN) { this.trapTapin(); continue; }
          }
          if (pc === MSX_TAPOON) { this.trapTapoon(); continue; }
          if (pc === MSX_TAPOUT) { this.trapTapout(); continue; }
        }

        // EI suppresses interrupts for one instruction; step() itself resets
        // and re-arms eiDelay per-instruction (see core.ts), so a plain
        // post-step check is enough here.
        this.beforeInsn(this.cpu.pc);
        this.cpu.step();
        const stopped = this.afterInsn();

        // The VDP INT line is level-sensitive: while its frame flag is set and
        // interrupts are enabled, take a maskable IM 1 interrupt as soon as the
        // CPU allows it. The BIOS ISR clears the flag by reading the status port.
        if (this.vdp.interruptPending() && this.cpu.iff1 && !this.cpu.eiDelay) {
          this.cpu.interrupt();
        }

        if (!skipAudio) {
          const elapsed = this.cpu.tStates - lastAudioT;
          if (elapsed > 0) {
            this.mixer.accumulate(this.ppi.keyClick, elapsed);
            this.mixer.generateSamples(this.audio, this.ay, true);
            lastAudioT = this.cpu.tStates;
          }
        }
        // A watchpoint fired during the instruction: stop after the interrupt
        // check above, so a resume takes a pending interrupt where a run would.
        if (stopped) { broke = true; break; }
      }
      if (broke) {
        // The frame stays open; the next call carries on in this line.
        this.midFrame = true;
        this.needsDisplay = true;
        return;
      }

      // Render active scanlines into the centred active area.
      if (line < ACTIVE_LINES) {
        const rowStart = (MSX_BORDER_TOP + line) * MSX_SCREEN_WIDTH + MSX_BORDER_LEFT;
        this.vdp.renderScanline(this._pixels32, rowStart, line);
      } else if (line === ACTIVE_LINES) {
        this.vdp.raiseFrameInterrupt();
      }
    }

    this.activity.fdcAccesses = this.diskIf.accesses;
    this.diskIf.tickFrame();
    this.needsDisplay = true;
  }

  // ── Machine: debug helpers ───────────────────────────────────────────

  disasmAt(pc: number): DisasmLine {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 8; i++) buf[i] = this.memory.peekByte((pc + i) & 0xFFFF);
    return { ...disasmOne(buf, 0), addr: pc };
  }

  /** Execution trace: BaseMachine's startTrace/stopTrace drive it and
   *  beforeInsn/afterInsn feed it (debug/z80/trace.ts). */
  protected override tracer = new Z80Trace(this);

  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    // The VDP name table holds character codes directly (grid fixed by mode).
    return this.screenText.ocr(this.vdp.vram, this.vdp.regs, this.vdp.mode());
  }

  /** Styled OCR (text + coloured HTML + match mask) for the TEXT overlay. */
  ocrScreenStyled(): OcrResult {
    return this.screenText.ocrStyled(this.vdp.vram, this.vdp.regs, this.vdp.mode(), this.vdp.palette);
  }

  /**
   * Blank the matched character cells in the framebuffer to their paper colour
   * so the crisp overlay glyphs replace the underlying bitmap. `mask` is
   * row-major `cols×rows`; cell width/x-origin follow the current VDP mode
   * (text = 6px from x=8, graphics I = 8px from x=0).
   */
  blankCells(mask: boolean[], cols: number, rows: number, paper?: number[]): void {
    const g = msxTextGrid(this.vdp.mode());
    if (!g) return;
    const cellW = g.cellWidth, cellH = 8;
    const pal = this.vdp.palette;
    for (let row = 0; row < rows; row++) {
      const y0 = MSX_BORDER_TOP + row * cellH;
      if (y0 + cellH > MSX_SCREEN_HEIGHT) break;
      for (let col = 0; col < cols; col++) {
        if (!mask[row * cols + col]) continue;
        const x0 = MSX_BORDER_LEFT + g.xOffset + col * cellW;
        if (x0 + cellW > MSX_SCREEN_WIDTH) continue;
        const fill = pal[(paper ? paper[row * cols + col] : 0) & 0x0F];
        for (let y = 0; y < cellH; y++) {
          const b = (y0 + y) * MSX_SCREEN_WIDTH + x0;
          this._pixels32.fill(fill, b, b + cellW);
        }
      }
    }
  }
}
