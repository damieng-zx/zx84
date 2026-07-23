/**
 * EinsteinMachine — Tatung Einstein TC-01 orchestrator.
 *
 * The Einstein counterpart to `Spectrum` / `CpcMachine`: it owns the Z80, AY and
 * WD1770 (all reused unchanged), plus Einstein-specific parts — the TMS9929A VDP,
 * a Z80 CTC (the interrupt backbone), the AY-scanned keyboard and the paged
 * memory — and drives its own frame loop. Implements the shared `Machine`
 * interface so `emulator.ts`, the UI and the MCP server treat it like any machine.
 *
 * The 8KB MOS ROM is a boot monitor; the machine boots into it (BASIC/Xtal DOS
 * load from disk — a follow-up). Each frame the CPU runs a PAL field's worth of
 * T-states; at the end of the active display the TMS9929A raises its vblank,
 * which is wired to a CTC channel that pulls the Z80 /INT (serviced in IM 2).
 */

import { Z80 } from '@/cores/z80.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { WD179x } from '@/cores/wd179x.ts';
import { Tms9918a, EINSTEIN_PALETTES } from '@/cores/tms9918a.ts';
import { V9938 } from '@/cores/v9938.ts';
import { Z80Ctc } from '@/cores/z80-ctc.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { disasmOne, type DisasmLine } from '@/debug/z80/disasm.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type { Machine, MachineHost, MachineKind, MachineDescriptor, BorderMode, MachineTraceMode, SettingsView } from '@/machines/machine.ts';
import { applyAySettings } from '@/machines/shared/ay-settings.ts';
import { einsteinDescriptor } from '@/machines/einstein/descriptor.ts';
import { createEinsteinServices, type EinsteinServices } from '@/machines/einstein/services/index.ts';
import type { EinsteinModel } from '@/models.ts';
import type { OcrGridName, OcrResult } from '@/ocr/ocr.ts';
import { EinsteinScreenText } from '@/ocr/einstein.ts';
import { EinsteinV9938ScreenText } from '@/ocr/einstein256.ts';
import { EinsteinMemory } from '@/machines/einstein/einstein-memory.ts';
import { EinsteinKeyboard } from '@/machines/einstein/einstein-keyboard.ts';
import { installEinsteinMemoryHooks, wireEinsteinPortIO } from '@/machines/einstein/einstein-io.ts';
import { createEinsteinConfig, type EinsteinConfig } from '@/machines/einstein/config.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import {
  EINSTEIN_AY_CLOCK, EINSTEIN_CPU_CLOCK, EINSTEIN_T_PER_FRAME,
  EINSTEIN_SCREEN_WIDTH, EINSTEIN_SCREEN_HEIGHT,
  EINSTEIN_BORDER_LEFT, EINSTEIN_BORDER_TOP,
  EINSTEIN_256_SCREEN_WIDTH, EINSTEIN_256_SCREEN_HEIGHT,
  EINSTEIN_256_BORDER_LEFT, EINSTEIN_256_BORDER_TOP,
  EINSTEIN_256_VDP_INT_VECTOR,
} from '@/machines/einstein/constants.ts';

/** PAL scanlines per field. */
const LINES_PER_FRAME = 313;

export class EinsteinMachine extends BaseMachine implements Machine {
  protected get audioChip(): AY3891x { return this.ay; }
  readonly kind: MachineKind = 'einstein';
  readonly model: EinsteinModel;
  readonly config: EinsteinConfig;
  /** Operator's panel (shell / MCP) — null when running headless. */
  host: MachineHost | null = null;
  /** The service surface (§3.3): the only way shell/UI/MCP reach internals. */
  readonly services: EinsteinServices;

  readonly cpu: Z80;
  readonly memory: EinsteinMemory;
  readonly ay: AY3891x;
  readonly fdc: WD179x;
  /** Video chip: TMS9929A on the TC-01, V9938 on the Einstein 256. */
  readonly vdp: Tms9918a | V9938;
  readonly ctc: Z80Ctc;
  readonly keyboard: EinsteinKeyboard;
  readonly tape: TapeDeck;
  readonly mixer: AudioMixer;
  readonly audio: Audio;
  display: IScreenRenderer | null;

  /** Einstein 256: the V9938's daisy-chain interrupt can be masked off via
   *  port 0x80 (bit0 set = disabled). Enabled at reset. */
  vdpIntEnabled = true;

  /** Per-frame I/O activity for the status-bar LEDs. */
  readonly activity = { kbdReads: 0, fdcAccesses: 0, tapeReads: 0, ayWrites: 0 };
  bootDiskEnabled = true;

  /** Screen-text OCR engine for the MCP `ocr` tool and the TEXT overlay. The
   *  TC-01's TMS9929A and the 256's V9938 draw the same MOS font but with
   *  different addressing, so each gets its own engine (chosen in the ctor). */
  readonly screenText: EinsteinScreenText | EinsteinV9938ScreenText;

  /** Per-model output geometry (TC-01 320×240, 256 576×240). */
  private readonly _screenW: number;
  private readonly _screenH: number;
  private readonly _borderL: number;
  private readonly _borderT: number;

  /** RGBA frame buffer + a Uint32 view for fast VDP writes. */
  private readonly _pixels: Uint8Array;
  private readonly _pixels32: Uint32Array;
  get pixels(): Uint8Array { return this._pixels; }

  get tStatesPerFrame(): number { return EINSTEIN_T_PER_FRAME; }

  constructor(model: EinsteinModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.config = createEinsteinConfig(model);
    this.screenText = this.config.vdp === 'v9938'
      ? new EinsteinV9938ScreenText()
      : new EinsteinScreenText();
    this.cpu = new Z80();
    this.memory = new EinsteinMemory({
      romSize: this.config.romSizeKB * 1024,
      romMirrored: this.config.romMirrored,
    });
    this.ay = new AY3891x(EINSTEIN_AY_CLOCK, 48000, 'ABC');
    this.fdc = new WD179x({
      statusBit7: 'motor-on',
      formatSectorsPerTrack: 10,
    });
    // The MOS polls the WD1770 for BUSY to *set* (command accepted) before
    // waiting for it to clear, so Type I commands must pulse BUSY.
    this.fdc.pulseBusy = true;
    this.vdp = this.config.vdp === 'v9938' ? new V9938() : new Tms9918a();
    this.ctc = new Z80Ctc();
    // The Einstein clocks CTC channels 0–2 at 2MHz (4MHz CPU / 2) and chains
    // channel 2's zero-count to channel 3's trigger (zc2 → trg3); channel 3 is
    // the periodic interrupt source (IM 2). See MAME's einstein CTC wiring.
    this.ctc.inputClockDivide = 2;
    this.ctc.zcHandlers[2] = () => this.ctc.trigger(3);
    this.keyboard = new EinsteinKeyboard();
    // CDT/TZX pulse timings are 3.5MHz-referenced; scale to the 4MHz Z80.
    this.tape = new TapeDeck(EINSTEIN_CPU_CLOCK);
    this.tape.pulseScale = EINSTEIN_CPU_CLOCK / TAPE_REF_HZ;
    this.audio = new Audio();
    this.mixer = new AudioMixer(EINSTEIN_CPU_CLOCK);
    this.mixer.beeperGain = 0;   // AY only, no beeper
    this.mixer.ayGain = 1;
    this.display = display ?? null;

    if (this.config.vdp === 'v9938') {
      this._screenW = EINSTEIN_256_SCREEN_WIDTH;
      this._screenH = EINSTEIN_256_SCREEN_HEIGHT;
      this._borderL = EINSTEIN_256_BORDER_LEFT;
      this._borderT = EINSTEIN_256_BORDER_TOP;
    } else {
      this._screenW = EINSTEIN_SCREEN_WIDTH;
      this._screenH = EINSTEIN_SCREEN_HEIGHT;
      this._borderL = EINSTEIN_BORDER_LEFT;
      this._borderT = EINSTEIN_BORDER_TOP;
    }
    this._pixels = new Uint8Array(this._screenW * this._screenH * 4);
    this._pixels32 = new Uint32Array(this._pixels.buffer);

    installEinsteinMemoryHooks(this);
    wireEinsteinPortIO(this);

    this.services = createEinsteinServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  get descriptor(): MachineDescriptor { return einsteinDescriptor(this.model); }
  get frameWidth(): number { return this._screenW; }
  get frameHeight(): number { return this._screenH; }
  /** Nominal CPU clock (4 MHz). */
  get cpuClockHz(): number { return this.tape.cpuClock; }

  /** `.scr` export: the VDP's private VRAM *is* the screen. */
  screenExportBytes(): Uint8Array { return this.vdp.vram.slice(); }

  /** RAM export: the full 64K physical RAM image. */
  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ramSnapshot(), filename: 'ram-64k.bin' };
  }

  /** Apply the Einstein-specific settings: the TMS9929A colour map (TC-01
   *  only — the 256's palette is V9938 register-controlled) and the master
   *  volume (AY-only, no beeper). */
  applySettings(view: SettingsView): void {
    if (this.vdp instanceof Tms9918a) {
      this.vdp.palette = EINSTEIN_PALETTES[view.get('einstein-color-map', 'accurate') as keyof typeof EINSTEIN_PALETTES];
    }
    this.audio.setVolume(view.get('volume', 70) / 100);
    applyAySettings(this.ay, view);
    this.bootDiskEnabled = view.get('einstein-xtaldos', true);
  }

  /** Built-in WD1772 drive settings — once per build (no peripheral ROMs). */
  prepare(view: SettingsView): [] {
    this.bootDiskEnabled = view.get('einstein-xtaldos', true);
    if (this.config.hasFDC) {
      this.fdc.writeProtect[0] = view.get('write-protect-a', false);
      this.fdc.writeProtect[1] = view.get('write-protect-b', false);
      this.fdc.forceReady[1] = view.get('drive-b-force-ready', false);
    }
    return [];
  }

  // ── Machine: lifecycle ───────────────────────────────────────────────

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    this.setStatus('ROM loaded');
  }

  /** Insert a parsed disk image into a WD1770 drive (disk support is a
   *  follow-up; the image is held so it is ready once wired end-to-end). */
  loadDisk(image: DskImage, unit = 0): void {
    this.fdc.insertDisk(image, unit);
  }

  setBorderSize(mode: BorderMode): void {
    // The VDP always renders into the full framebuffer with the active area
    // centred; cropping is a pure display concern.
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(this._borderL * (1 - frac));
    const cropY = Math.round(this._borderT * (1 - frac));
    if (this.display) {
      this.display.setViewport(
        cropX, cropY,
        this._screenW - cropX * 2,
        this._screenH - cropY * 2,
      );
    }
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.cpu.im = 2;              // the Einstein runs in interrupt mode 2
    this.ay.reset();
    this.fdc.reset();
    this.vdp.reset();
    this.ctc.reset();
    this.memory.reset();
    this.keyboard.reset();
    this.audio.reset();
    this.mixer.reset();
    this.vdpIntEnabled = true;
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  // start / stop / destroy / tick / runUntil live on BaseMachine.

  protected framePixels(): Uint8Array { return this._pixels; }

  protected inTurbo(): boolean { return this.turbo; }

  /**
   * Execute one PAL field. Runs the CPU scanline by scanline, advancing the CTC
   * timers and servicing IM 2 interrupts as they arm; renders the active lines;
   * at the end of the active display the VDP raises its frame flag — polled by
   * the MOS on the TC-01, and fed to the Z80 /INT (vector 0xFE, maskable via
   * port 0x80) on the Einstein 256.
   */
  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    this.activity.kbdReads = 0;
    this.activity.fdcAccesses = 0;
    this.activity.tapeReads = 0;
    this.activity.ayWrites = 0;

    const vdp = this.vdp;
    const is256 = vdp instanceof V9938;
    // Active lines rendered per frame: the V9938's R9 LN bit picks 192/212.
    const activeLines = is256 ? vdp.visibleHeight : 192;
    if (is256) vdp.beginFrame();

    // Fill the whole buffer (incl. border) with the current backdrop.
    this._pixels32.fill(vdp.backdrop());

    const tPerLine = EINSTEIN_T_PER_FRAME / LINES_PER_FRAME;
    let lineEnd = this.cpu.tStates;
    let lastAudioT = this.cpu.tStates;
    let lastCtcT = this.cpu.tStates;
    let broke = false;

    for (let line = 0; line < LINES_PER_FRAME; line++) {
      lineEnd += tPerLine;
      if (is256) vdp.advanceScanline(line);

      while (this.cpu.tStates < lineEnd) {
        if (this.breakpoints.has(this.cpu.pc)) { this.breakpointHit = this.cpu.pc; broke = true; break; }
        if (this.onTrap !== null && this.onTrap(this.cpu.pc)) { broke = true; break; }

        const eiBefore = this.cpu.eiDelay;
        this.cpu.step();
        if (eiBefore) this.cpu.eiDelay = false;

        // Advance CTC timers by the elapsed T-states.
        const dt = this.cpu.tStates - lastCtcT;
        if (dt > 0) { this.ctc.addCycles(dt); lastCtcT = this.cpu.tStates; }

        // Service a pending IM 2 interrupt from the CTC.
        if (this.ctc.interruptPending && this.cpu.iff1 && !this.cpu.eiDelay) {
          const vec = this.ctc.pendingVector();
          if (vec >= 0 && this.cpu.interruptWithVector(vec) > 0) this.ctc.acknowledge();
        }

        // Einstein 256: the V9938's INT output sits on the daisy chain
        // (vector 0xFE), maskable via port 0x80.
        if (is256 && this.vdpIntEnabled && vdp.interruptPending() && this.cpu.iff1 && !this.cpu.eiDelay) {
          // Accepting the interrupt does not clear the V9938's F flag or INT
          // output; hardware holds both until the handler reads S0.
          this.cpu.interruptWithVector(EINSTEIN_256_VDP_INT_VECTOR);
        }

        if (!skipAudio) {
          const elapsed = this.cpu.tStates - lastAudioT;
          if (elapsed > 0) {
            this.mixer.accumulate(0, elapsed);
            this.mixer.generateSamples(this.audio, this.ay, true);
            lastAudioT = this.cpu.tStates;
          }
        }
      }
      if (broke) break;

      // Render active scanlines into the centred active area.
      if (line < activeLines) {
        // R9's 192-line mode starts ten lines later than 212-line mode on the
        // V9938, keeping both modes centred in the same output aperture.
        const activeTop = this._borderT + (is256 ? (212 - activeLines) >> 1 : 0);
        const rowStart = (activeTop + line) * this._screenW + this._borderL;
        vdp.renderScanline(this._pixels32, rowStart, line);
      } else if (line === activeLines) {
        // End of active display. On the TC-01 the VDP INT line is NOT wired
        // to the CPU (MAME confirms) — the MOS polls the status flag. On the
        // 256 the V9938's INT is on the daisy chain (serviced above). Either
        // way the CPU's periodic interrupts also come from the Z80 CTC
        // (2MHz-clocked, ch2→ch3 chain), advanced by ctc.addCycles above.
        if (is256) vdp.endActiveDisplay();
        else (vdp as Tms9918a).raiseFrameInterrupt();
      }
    }

    this.fdc.tickFrame();   // motor spin-down / display-latch decay
    this.needsDisplay = true;
  }

  // ── Machine: debug helpers ───────────────────────────────────────────

  disasmAt(pc: number): DisasmLine {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 8; i++) buf[i] = this.memory.readByte((pc + i) & 0xFFFF);
    return { ...disasmOne(buf, 0), addr: pc };
  }

  startTrace(_mode: MachineTraceMode = 'full'): void {
    // Execution tracing is a later addition; no-op so the MCP tool degrades.
  }

  stopTrace(): string { return ''; }

  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    // Recover the screen text from the VDP by matching each cell against the MOS
    // ROM font (the grid is fixed by the VDP mode, so `mode` is advisory).
    const rom = this.memory.getRom();
    if (this.vdp instanceof V9938) {
      return (this.screenText as EinsteinV9938ScreenText).ocr(this.vdp.vram, this.vdp.regs, this.vdp.mode(), rom);
    }
    return (this.screenText as EinsteinScreenText).ocr(this.vdp.vram, this.vdp.regs, this.vdp.mode(), rom);
  }

  /** Styled OCR (text + coloured HTML + match mask) for the TEXT overlay. */
  ocrScreenStyled(): OcrResult {
    const rom = this.memory.getRom();
    if (this.vdp instanceof V9938) {
      return (this.screenText as EinsteinV9938ScreenText).ocrStyled(this.vdp.vram, this.vdp.regs, this.vdp.mode(), rom, this.vdp.pens);
    }
    return (this.screenText as EinsteinScreenText).ocrStyled(this.vdp.vram, this.vdp.regs, this.vdp.mode(), rom, this.vdp.palette);
  }

  /**
   * Blank the matched character cells in the framebuffer to their paper colour
   * so the crisp overlay glyphs replace the underlying bitmap. `mask` is
   * row-major `cols×rows`. On the TC-01 cells are 6×8 at the active-area origin;
   * on the 256 the GRAPHIC 2 field is pixel-doubled to 512 and vertically
   * centred, so each source cell spans 12×8 screen pixels.
   */
  blankCells(mask: boolean[], cols: number, rows: number, paper?: number[]): void {
    const cellH = 8;
    if (this.vdp instanceof V9938) {
      const pens = this.vdp.pens;
      const cellW = 12;   // 6 source px doubled
      const yTop = this._borderT + ((212 - this.vdp.visibleHeight) >> 1);
      for (let row = 0; row < rows; row++) {
        const y0 = yTop + row * cellH;
        if (y0 + cellH > this._screenH) break;
        for (let col = 0; col < cols; col++) {
          if (!mask[row * cols + col]) continue;
          const x0 = this._borderL + col * cellW;
          if (x0 + cellW > this._screenW) continue;
          const fill = pens[(paper ? paper[row * cols + col] : 0) & 0x0F];
          for (let y = 0; y < cellH; y++) {
            const base = (y0 + y) * this._screenW + x0;
            this._pixels32.fill(fill, base, base + cellW);
          }
        }
      }
      return;
    }
    const cellW = 6;
    const pal = this.vdp.palette;
    for (let row = 0; row < rows; row++) {
      const y0 = this._borderT + row * cellH;
      if (y0 + cellH > this._screenH) break;
      for (let col = 0; col < cols; col++) {
        if (!mask[row * cols + col]) continue;
        const x0 = this._borderL + col * cellW;
        if (x0 + cellW > this._screenW) continue;
        const fill = pal[(paper ? paper[row * cols + col] : 0) & 0x0F];
        for (let y = 0; y < cellH; y++) {
          const base = (y0 + y) * this._screenW + x0;
          this._pixels32.fill(fill, base, base + cellW);
        }
      }
    }
  }
}
