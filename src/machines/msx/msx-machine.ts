/**
 * MsxMachine — Toshiba HX-10 (MSX1) orchestrator.
 *
 * The MSX counterpart to `Spectrum` / `CpcMachine` / `EinsteinMachine`: it owns
 * the Z80, AY-3-8910 PSG and TMS9929A VDP (all reused unchanged) plus MSX-
 * specific parts — the 8255 PPI (keyboard scan + primary-slot select), the slot-
 * paged memory and the keyboard — and drives its own PAL field loop. Implements
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
import type { IScreenRenderer } from '@/display/renderer.ts';
import type { Machine, MachineHost, MachineKind, MachineDescriptor, BorderMode, MachineTraceMode, SettingsView } from '@/machines/machine.ts';
import { applyAySettings } from '@/machines/shared/ay-settings.ts';
import { msxDescriptor } from '@/machines/msx/descriptor.ts';
import { createMsxServices, type MsxServices } from '@/machines/msx/services/index.ts';
import type { MsxModel } from '@/models.ts';
import type { OcrGridName, OcrResult } from '@/ocr/ocr.ts';
import { MsxScreenText, msxTextGrid } from '@/ocr/msx.ts';
import { MsxCassette, MSX_TAPION, MSX_TAPIN } from '@/machines/msx/msx-tape.ts';
import { MsxMemory } from '@/machines/msx/msx-memory.ts';
import { MsxKeyboard } from '@/machines/msx/msx-keyboard.ts';
import { MsxJoystick } from '@/machines/msx/msx-joystick.ts';
import { MsxPpi, installMsxMemoryHooks, wireMsxPortIO } from '@/machines/msx/msx-io.ts';
import { createMsxConfig, type MsxConfig } from '@/machines/msx/config.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import {
  MSX_CPU_CLOCK, MSX_PSG_CLOCK, MSX_T_PER_FRAME,
  MSX_SCREEN_WIDTH, MSX_SCREEN_HEIGHT,
  MSX_BORDER_LEFT, MSX_BORDER_TOP,
} from '@/machines/msx/constants.ts';

/** PAL scanlines per field. */
const LINES_PER_FRAME = 313;
/** Active display lines (0..191); the VDP raises its vblank at line 192. */
const ACTIVE_LINES = 192;

export class MsxMachine extends BaseMachine implements Machine {
  protected get audioChip(): AY3891x { return this.ay; }
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
  /** The HX-10 has no floppy controller; this inert WD1772 exists only to
   *  satisfy the shared `Machine.fdc` type — it is never wired to any port. */
  readonly fdc: WD179x;
  /** Inert cassette deck (interface requirement; cassette is a follow-up). */
  readonly tape: TapeDeck;
  readonly mixer: AudioMixer;
  readonly audio: Audio;
  display: IScreenRenderer | null;

  /** Per-frame I/O activity for the status-bar LEDs / tape progress. */
  readonly activity = { kbdReads: 0, ayWrites: 0, casReads: 0 };

  /** Screen-text OCR engine for the MCP `ocr` tool and the TEXT overlay. */
  readonly screenText = new MsxScreenText();

  /** Cassette (.cas) — loaded on demand; served through BIOS traps. */
  readonly cassette = new MsxCassette();

  /** Name of the mounted cartridge (empty if none), for the ROM pane. */
  cartridgeName = '';

  /** RGBA frame buffer + a Uint32 view for fast VDP writes. */
  private readonly _pixels = new Uint8Array(MSX_SCREEN_WIDTH * MSX_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  get tStatesPerFrame(): number { return MSX_T_PER_FRAME; }

  constructor(model: MsxModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.config = createMsxConfig(model);
    this.cpu = new Z80();
    this.memory = new MsxMemory();
    this.ay = new AY3891x(MSX_PSG_CLOCK, 48000, 'ABC');
    this.vdp = new Tms9918a();
    this.keyboard = new MsxKeyboard();
    this.joystick = new MsxJoystick();
    this.ppi = new MsxPpi(this.memory, this.keyboard);
    this.fdc = new WD179x({
      statusBit7: 'motor-on',
      formatSectorsPerTrack: 10,
    });
    this.tape = new TapeDeck(MSX_CPU_CLOCK);
    this.audio = new Audio();
    this.mixer = new AudioMixer(MSX_CPU_CLOCK);
    this.mixer.beeperGain = 0;   // AY/PSG only, no beeper
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

  /** RAM export: the full 64K physical RAM image. */
  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ramSnapshot(), filename: 'ram-64k.bin' };
  }

  /** Apply the MSX-specific settings: the TMS9918A PAL/NTSC colour map and the
   *  master volume (AY/PSG-only). */
  applySettings(view: SettingsView): void {
    this.vdp.palette = MSX_PALETTES[view.get('msx-color-map', 'pal') as keyof typeof MSX_PALETTES];
    this.audio.setVolume(view.get('volume', 70) / 100);
    applyAySettings(this.ay, view);
  }

  // ── Machine: lifecycle ───────────────────────────────────────────────

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    this.setStatus('ROM loaded');
  }

  /** The HX-10 has no disk drive; accept the call so the media layer stays
   *  uniform, but there is nowhere to insert it. */
  loadDisk(_image: DskImage, _unit = 0): void {}

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
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  // start / stop / destroy / tick / runUntil live on BaseMachine.

  protected framePixels(): Uint8Array { return this._pixels; }

  protected inTurbo(): boolean { return this.turbo; }

  /**
   * Execute one PAL field. Runs the CPU scanline by scanline; renders the 192
   * active lines; at the end of the active display raises the VDP vblank, which
   * (with R1 interrupt-enable set) pulls the Z80 /INT — serviced in IM 1.
   */
  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    this.activity.kbdReads = 0;
    this.activity.ayWrites = 0;
    this.activity.casReads = 0;

    // Fill the whole buffer (incl. border) with the current backdrop.
    this._pixels32.fill(this.vdp.backdrop());

    const tPerLine = MSX_T_PER_FRAME / LINES_PER_FRAME;
    let lineEnd = this.cpu.tStates;
    let lastAudioT = this.cpu.tStates;
    let broke = false;

    for (let line = 0; line < LINES_PER_FRAME; line++) {
      lineEnd += tPerLine;

      while (this.cpu.tStates < lineEnd) {
        if (this.breakpoints.has(this.cpu.pc)) { this.breakpointHit = this.cpu.pc; broke = true; break; }
        if (this.onTrap !== null && this.onTrap(this.cpu.pc)) { broke = true; break; }

        // Cassette instant-load: intercept the BIOS TAPION/TAPIN routines while a
        // .cas is mounted and the BIOS ROM is paged into page 0.
        if (this.cassette.loaded && (this.memory.getPrimarySlot() & 0x03) === 0) {
          if (this.cpu.pc === MSX_TAPION) { this.trapTapion(); continue; }
          if (this.cpu.pc === MSX_TAPIN) { this.trapTapin(); continue; }
        }

        // EI suppresses interrupts for one instruction; step() itself resets
        // and re-arms eiDelay per-instruction (see core.ts), so a plain
        // post-step check is enough here.
        this.cpu.step();

        // The VDP INT line is level-sensitive: while its frame flag is set and
        // interrupts are enabled, take a maskable IM 1 interrupt as soon as the
        // CPU allows it. The BIOS ISR clears the flag by reading the status port.
        if (this.vdp.interruptPending() && this.cpu.iff1 && !this.cpu.eiDelay) {
          this.cpu.interrupt();
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
      if (line < ACTIVE_LINES) {
        const rowStart = (MSX_BORDER_TOP + line) * MSX_SCREEN_WIDTH + MSX_BORDER_LEFT;
        this.vdp.renderScanline(this._pixels32, rowStart, line);
      } else if (line === ACTIVE_LINES) {
        this.vdp.raiseFrameInterrupt();
      }
    }

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
