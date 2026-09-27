/**
 * BBC Micro Model B motherboard.
 *
 * A 2 MHz 6502 with 32K RAM, the MOS OS + BASIC ROMs and sixteen sideways ROM
 * sockets, two 6522 VIAs, the 6845 CRTC and the Video ULA / SAA5050 pair. The
 * frame loop interleaves CPU execution with the 1 MHz CRTC/VIA bus: the CRTC's
 * VSYNC drives the System VIA's CA1 (the 50 Hz event) and Timer 1 free-runs as
 * the 100 Hz system clock, both feeding the CPU's IRQ line.
 */

import { M6502 } from '@/cores/m6502.ts';
import { M6522 } from '@/cores/m6522.ts';
import { Crtc6845 } from '@/cores/crtc-6845.ts';
import { Sn76489, type Sn76489AntialiasMode } from '@/cores/sn76489.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import {
  BbcScreenText, BBC_MODE7_CELL_H, BBC_MODE7_CELL_W,
  BBC_MODE7_ORIGIN_X, BBC_MODE7_ORIGIN_Y,
} from '@/ocr/bbc.ts';
import type { BbcModel, BbcDiskSystem } from './models.ts';
import { BbcMemory } from './bbc-memory.ts';
import { BbcKeyboard } from './bbc-keyboard.ts';
import { BbcVideo } from './bbc-video.ts';
import { BbcDfs1770 } from './peripherals/wd1770-dfs.ts';
import { BbcAcornDfs } from './peripherals/acorn-8271-dfs.ts';
import type { BbcDiscController } from './peripherals/disc-controller.ts';
import { wireBbcIo } from './bbc-io.ts';
import { bbcDescriptor } from './descriptor.ts';
import { createBbcServices, type BbcServices } from './services/index.ts';
import {
  BBC_CPU_CLOCK, BBC_SCREEN_HEIGHT, BBC_SCREEN_WIDTH, BBC_SOUND_CLOCK,
  BBC_TSTATES_PER_FRAME,
} from './constants.ts';

/** PAL scanlines per frame. */
const LINES_PER_FRAME = 312;

/** IC32 addressable-latch outputs (active levels per the MOS docs). */
export interface BbcIc32 {
  soundEnabled: boolean;
  keyboardScan: boolean;
  c0: number;
  c1: number;
  capsLock: boolean;
  shiftLock: boolean;
}

export class BbcMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'bbc';
  readonly model: BbcModel;
  host: MachineHost | null = null;
  readonly services: BbcServices;

  readonly cpu = new M6502();
  readonly memory = new BbcMemory();
  readonly keyboard = new BbcKeyboard();
  readonly sysVia = new M6522();
  readonly userVia = new M6522();
  readonly crtc = new Crtc6845(0);
  readonly video = new BbcVideo();
  readonly fdc1770 = new BbcDfs1770((asserted) => { if (asserted) this.cpu.nmi(); });
  readonly acorn8271 = new BbcAcornDfs(() => this.cpu.nmi());
  readonly psg = new Sn76489(BBC_SOUND_CLOCK, 48_000, 'ti-15bit');
  readonly mixer = new AudioMixer(BBC_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  // Hardware register state.
  ic32: BbcIc32 = { soundEnabled: false, keyboardScan: false, c0: 0, c1: 0, capsLock: false, shiftLock: false };
  videoUlaControl = 0;
  videoPaletteRegister = 0;
  serialUlaControl = 0;
  aciaControl = 0;
  /** Logical -> physical colour map (identity until the OS writes the palette). */
  readonly palette = Uint8Array.from({ length: 16 }, (_, i) => i);
  /** Mode 7 teletext OCR engine, driven by the TEXT status-icon overlay. */
  readonly screenText = new BbcScreenText();

  /** Per-frame activity counters for the frame probe. */
  readonly activity = { psgWrites: 0 };

  /** Which disc interface (if any) is fitted. */
  diskSystem: BbcDiskSystem = '1770';

  /** The fitted disc controller, or null when no disc interface is present. */
  get disc(): BbcDiscController | null {
    if (this.diskSystem === 'none') return null;
    return this.diskSystem === 'acorn' ? this.acorn8271 : this.fdc1770;
  }

  private borderMode: BorderMode = 2;
  private viaAccum = 0;
  private prevVsync = false;

  protected get audioChip(): Sn76489 { return this.psg; }

  get descriptor(): MachineDescriptor { return bbcDescriptor(this.model); }
  get pixels(): Uint8Array { return this.video.pixels; }
  get frameWidth(): number { return BBC_SCREEN_WIDTH; }
  get frameHeight(): number { return BBC_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number { return BBC_TSTATES_PER_FRAME; }
  get cpuClockHz(): number { return BBC_CPU_CLOCK; }

  constructor(model: BbcModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.display = display ?? null;
    this.cpu.read = (addr) => this.memory.readByte(addr);
    this.cpu.write = (addr, val) => this.memory.writeByte(addr, val);
    // PSG-only machine: no beeper to balance against the SN76489.
    this.mixer.beeperGain = 0;
    this.mixer.psgGain = 1;
    wireBbcIo(this);
    this.services = createBbcServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  loadROM(data: Uint8Array): void {
    this.memory.loadRom(data);
    this.setStatus(`BBC ROM loaded (${Math.min(data.length, 0x8000)} bytes)`);
  }

  /** Install a 16K sideways ROM (DFS) into a socket. */
  loadSidewaysRom(socket: number, data: Uint8Array): void {
    this.memory.loadSidewaysRom(socket, data);
  }

  /** Fit the selected disc interface's ROM into socket 13 (IC88) before reset.
   *  The 8271 interface uses the DNFS ROM (Acorn DFS 1.20 + NFS 3.60), which
   *  falls back to DFS when no Econet hardware is present. */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.setDiskSystem(view.get<BbcDiskSystem>('bbc-disk-system', '1770'));
    if (this.diskSystem === 'none') return [];
    const acorn = this.diskSystem === 'acorn';
    return [{
      cacheKey: acorn ? 'bbc-dnfs-120' : 'bbc-dfs-226',
      source: acorn ? 'bbc/dnfs.rom' : 'bbc/dfs-2.26.rom',
      fetchingMsg: `Fetching BBC ${acorn ? 'DNFS' : '1770 DFS'} ROM…`,
      loadedMsg: (bytes) => `BBC ${acorn ? 'DNFS (DFS 1.20 + NFS)' : '1770 DFS'} ROM loaded (${bytes} bytes)`,
      failMsg: `Failed to load the BBC ${acorn ? 'DNFS' : '1770 DFS'} ROM`,
      failId: 'bbc-dfs',
      apply: (data) => this.loadSidewaysRom(13, data),
      awaitLoad: true,
    }];
  }

  /** Fit or remove a disc interface. The ROM is loaded at build time, so a
   *  change takes effect on the next rebuild (the hardware pane does this). */
  setDiskSystem(system: BbcDiskSystem): void {
    if (system !== this.diskSystem) {
      // A different interface is being fitted: drop the old one's media.
      this.fdc1770.ejectDisk(0);
      this.fdc1770.ejectDisk(1);
      this.acorn8271.ejectDisk(0);
      this.acorn8271.ejectDisk(1);
    }
    this.diskSystem = system;
  }

  applySettings(view: SettingsView): void {
    this.audio.setVolume(view.get('volume', 70) / 100);
    // The SN76489 shares the Sound panel's anti-alias strategy control with the
    // AY-family PSGs; the strategies are equivalent (see Sn76489AntialiasMode).
    this.psg.antialias = view.get<Sn76489AntialiasMode>('ay-antialias', 'mute');
    this.video.paletteMode = view.get<'pal' | 'measured'>('bbc-color-map', 'pal');
    this.diskSystem = view.get<BbcDiskSystem>('bbc-disk-system', '1770');
  }

  setBorderSize(mode: BorderMode): void {
    this.borderMode = mode;
    void this.borderMode;
    this.display?.setViewport(0, 0, BBC_SCREEN_WIDTH, BBC_SCREEN_HEIGHT);
  }

  /** A key changed: pulse CA2 (keyboard) when auto-scan is enabled. */
  keyboardActivity(): void {
    if (!this.ic32.keyboardScan) return;
    this.sysVia.setCA2(false);
    this.sysVia.setCA2(true);
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.memory.reset();
    this.crtc.reset();
    this.video.reset();
    this.fdc1770.reset();
    this.acorn8271.reset();
    this.sysVia.reset();
    this.userVia.reset();
    // Park the active-low handshake lines high so their active edge is a
    // genuine transition (VSYNC on CA1, ADC EOC on CB1).
    this.sysVia.setCA1(true);
    this.sysVia.setCB1(true);
    this.ic32 = { soundEnabled: false, keyboardScan: false, c0: 0, c1: 0, capsLock: false, shiftLock: false };
    this.videoUlaControl = 0;
    this.videoPaletteRegister = 0;
    this.serialUlaControl = 0;
    this.aciaControl = 0;
    this.palette.fill(0);
    for (let i = 0; i < 16; i++) this.palette[i] = i;
    this.viaAccum = 0;
    this.prevVsync = false;
    this.activity.psgWrites = 0;
    this.psg.reset();
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  protected framePixels(): Uint8Array { return this.video.pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  /** Advance the 1 MHz devices (VIAs) by the CPU cycles just executed and
   *  propagate their interrupt line to the CPU. */
  private tickChips(elapsed: number): void {
    this.viaAccum += elapsed;
    const viaCycles = this.viaAccum >> 1;
    this.viaAccum &= 1;
    if (viaCycles > 0) {
      this.sysVia.addCycles(viaCycles);
      this.userVia.addCycles(viaCycles);
      this.disc?.tick(viaCycles);   // 1 MHz disc controller clock
    }
    this.cpu.setIRQ(this.sysVia.irq || this.userVia.irq);
  }

  protected runFrame(): void {
    const cyclesPerLine = BBC_TSTATES_PER_FRAME / LINES_PER_FRAME;
    const skipAudio = this.speedMultiplier !== 1;
    this.activity.psgWrites = 0;
    this.crtc.beginFrame();
    let lineEnd = this.cpu.tStates;
    let lastAudioT = this.cpu.tStates;

    for (let line = 0; line < LINES_PER_FRAME; line++) {
      lineEnd += cyclesPerLine;
      while (this.cpu.tStates < lineEnd) {
        if (this.breakpoints.has(this.cpu.pc)) {
          this.breakpointHit = this.cpu.pc;
          this.needsDisplay = true;
          return;
        }
        if (this.onTrap !== null && this.onTrap(this.cpu.pc)) {
          this.needsDisplay = true;
          return;
        }
        const before = this.cpu.tStates;
        this.cpu.step();
        this.tickChips(this.cpu.tStates - before);

        if (!skipAudio) {
          const audioElapsed = this.cpu.tStates - lastAudioT;
          if (audioElapsed > 0) {
            this.mixer.accumulate(0, audioElapsed);
            this.mixer.generateSamples(this.audio, this.psg, true);
            lastAudioT = this.cpu.tStates;
          }
        }
      }
      this.crtc.advanceLine();
      if (this.crtc.vsyncStart) {
        this.sysVia.setCA1(false);                       // VSYNC negative edge
      } else if (this.prevVsync && !this.crtc.vsyncActive) {
        this.sysVia.setCA1(true);                        // VSYNC ended
      }
      this.prevVsync = this.crtc.vsyncActive;
    }

    this.video.render(this);
    this.disc?.tickFrame();
    this.needsDisplay = true;
  }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: `${this.model}-ram-32k.bin` };
  }

  startTrace(_mode = 'full'): void {}
  stopTrace(): string { return ''; }

  /** True while the Video ULA is in teletext (Mode 7). */
  private isMode7(): boolean { return (this.videoUlaControl & 0x02) !== 0; }

  /** Mode 7 screen text for the MCP `ocr` tool. Bitmap modes 0-6 draw 8×8 OS
   *  font glyphs and are not transcribed yet, so they report an empty screen. */
  ocrScreenForMcp(_mode?: string): string {
    if (!this.isMode7()) return '';
    return this.screenText.ocr({
      ram: this.memory.ram,
      displayStart: this.crtc.displayStart,
      stride: this.crtc.regs[1],
      palette: this.video.activePalette(),
    });
  }

  /** Styled Mode 7 OCR (text + coloured HTML + match mask) for the TEXT
   *  overlay. Returns an empty match set in the bitmap modes. */
  ocrScreenStyled(): OcrResult {
    if (!this.isMode7()) {
      return {
        text: '', html: '', mask: [], paper: [],
        grid: '40x25',
        cellWidth: BBC_MODE7_CELL_W, cellHeight: BBC_MODE7_CELL_H, cols: 0, rows: 0,
      };
    }
    return this.screenText.ocrStyled({
      ram: this.memory.ram,
      displayStart: this.crtc.displayStart,
      stride: this.crtc.regs[1],
      palette: this.video.activePalette(),
    });
  }

  /** Blank the matched character cells in the framebuffer to their paper colour
   *  so the crisp overlay glyphs replace the underlying teletext bitmap. `mask`
   *  is row-major `cols×rows` over the Mode 7 window. */
  blankCells(mask: boolean[], cols: number, rows: number, paper?: number[]): void {
    const px = new Uint32Array(this.video.pixels.buffer);
    const pal = this.video.activePalette();
    const w = this.frameWidth;
    for (let row = 0; row < rows; row++) {
      const y0 = BBC_MODE7_ORIGIN_Y + row * BBC_MODE7_CELL_H;
      if (y0 + BBC_MODE7_CELL_H > this.frameHeight) break;
      for (let col = 0; col < cols; col++) {
        if (!mask[row * cols + col]) continue;
        const x0 = BBC_MODE7_ORIGIN_X + col * BBC_MODE7_CELL_W;
        if (x0 + BBC_MODE7_CELL_W > w) continue;
        const fill = pal[(paper ? paper[row * cols + col] : 0) & 7];
        for (let y = 0; y < BBC_MODE7_CELL_H; y++) {
          const base = (y0 + y) * w + x0;
          px.fill(fill, base, base + BBC_MODE7_CELL_W);
        }
      }
    }
  }
}
