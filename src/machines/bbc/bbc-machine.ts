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
import { Sn76489, type Sn76489AntialiasMode, type Sn76489StereoMode } from '@/cores/sn76489.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import {
  BbcScreenText, BBC_FONT_BYTES, BBC_MODE7_CELL_H, BBC_MODE7_CELL_W, BBC_MODE7_COLS,
  BBC_MODE7_ORIGIN_X, BBC_MODE7_ORIGIN_Y, BBC_MODE7_ROWS, bbcBitmapCols, ocrBbcBitmap,
  type BbcBitmapOcrInput,
} from '@/ocr/bbc.ts';
import type { BbcModel, BbcDiskSystem } from './models.ts';
import { BbcMemory } from './bbc-memory.ts';
import { BbcKeyboard } from './bbc-keyboard.ts';
import { BbcVideo, bitmapMode, wrapSubtract } from './bbc-video.ts';
import { BbcDfs1770 } from './peripherals/wd1770-dfs.ts';
import { BbcAcornDfs } from './peripherals/acorn-8271-dfs.ts';
import type { BbcDiscController } from './peripherals/disc-controller.ts';
import { wireBbcIo } from './bbc-io.ts';
import { bbcDescriptor } from './descriptor.ts';
import { createBbcServices, type BbcServices } from './services/index.ts';
import {
  BBC_ACTIVE_HEIGHT, BBC_ACTIVE_WIDTH, BBC_BORDER_LEFT, BBC_BORDER_TOP,
  BBC_CPU_CLOCK, BBC_SCREEN_HEIGHT, BBC_SCREEN_WIDTH, BBC_SOUND_CLOCK,
  BBC_TSTATES_PER_FRAME,
} from './constants.ts';

/** PAL scanlines per frame. */
const LINES_PER_FRAME = 312;
/** How long a SHIFT+BREAK holds SHIFT — the MOS samples it early in its reset
 *  sequence; half a second covers it with margin, like a real key press. */
const BOOT_SHIFT_FRAMES = 25;

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

  /** Frames left holding SHIFT for a SHIFT+BREAK disc boot. */
  private bootShiftFrames = 0;
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
    this.psg.setStereoMode(view.get<Sn76489StereoMode>('sn-stereo', 'MONO'));
    this.video.paletteMode = view.get<'pal' | 'measured'>('bbc-color-map', 'pal');
    this.diskSystem = view.get<BbcDiskSystem>('bbc-disk-system', '1770');
  }

  /** The border is always black and fully rendered; the setting crops it:
   *  Normal shows it all, Small half, None just the 640×256 picture. */
  setBorderSize(mode: BorderMode): void {
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(BBC_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(BBC_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY, BBC_SCREEN_WIDTH - cropX * 2, BBC_SCREEN_HEIGHT - cropY * 2,
    );
  }

  /** A key changed: pulse CA2 (keyboard) when auto-scan is enabled. */
  keyboardActivity(): void {
    if (!this.ic32.keyboardScan) return;
    this.sysVia.setCA2(false);
    this.sysVia.setCA2(true);
  }

  reset(): void {
    this.stop();
    this.resetHardware();
    this.setStatus('Reset');
  }

  /** SHIFT+BREAK: reset and hold SHIFT while the MOS starts up, so the DFS
   *  auto-boots the disc in drive 0 (its !BOOT file, per the boot option).
   *  Safe while running: it only touches the hardware between frames. */
  bootDisc(): void {
    this.resetHardware();
    this.holdShiftForBoot();
    this.setStatus('SHIFT+BREAK: booting drive 0');
  }

  /** Library one-click play: the shell has just reset the machine. */
  armBootTrap(kind: 'menu' | 'rom48k' | 'disk'): void {
    if (kind === 'disk') this.holdShiftForBoot();
  }

  private holdShiftForBoot(): void {
    this.keyboard.setCell(0, 0, true);
    this.bootShiftFrames = BOOT_SHIFT_FRAMES;
  }

  private resetHardware(): void {
    this.bootShiftFrames = 0;
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
    if (this.bootShiftFrames > 0 && --this.bootShiftFrames === 0) {
      this.keyboard.setCell(0, 0, false);
    }
    this.needsDisplay = true;
  }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: `${this.model}-ram-32k.bin` };
  }

  startTrace(_mode = 'full'): void {}
  stopTrace(): string { return ''; }

  /** True while the Video ULA is in teletext (Mode 7). */
  private isMode7(): boolean { return (this.videoUlaControl & 0x02) !== 0; }

  /** Where the current mode's character grid sits in the frame buffer. In the
   *  bitmap modes a character is 8 pixels of the mode across the 640-pixel
   *  picture, and its 8 glyph lines sit in a row pitch of R9+1 scanlines (10
   *  in the gapped modes 3 and 6). */
  textLayout(): {
    cols: number; rows: number; x: number; y: number;
    cellW: number; cellH: number; glyphH: number;
  } {
    if (this.isMode7()) {
      return {
        cols: BBC_MODE7_COLS, rows: BBC_MODE7_ROWS,
        x: BBC_BORDER_LEFT + BBC_MODE7_ORIGIN_X, y: BBC_BORDER_TOP + BBC_MODE7_ORIGIN_Y,
        cellW: BBC_MODE7_CELL_W, cellH: BBC_MODE7_CELL_H, glyphH: BBC_MODE7_CELL_H,
      };
    }
    const { bpp } = bitmapMode(this.video.screenMode(this));
    const cols = Math.max(1, bbcBitmapCols(this.crtc.regs[1], bpp));
    const rows = this.crtc.regs[6];
    const cellH = (this.crtc.regs[9] & 0x1F) + 1;
    return {
      cols, rows,
      x: BBC_BORDER_LEFT,
      y: BBC_BORDER_TOP + ((BBC_ACTIVE_HEIGHT - rows * cellH) >> 1),
      cellW: BBC_ACTIVE_WIDTH / cols, cellH, glyphH: 8,
    };
  }

  /** Bitmap-mode OCR input: the display plus the MOS font from the OS ROM. */
  private bitmapOcrInput(): BbcBitmapOcrInput {
    return {
      ram: this.memory.ram,
      displayStart: this.crtc.displayStart,
      stride: this.crtc.regs[1],
      rows: this.crtc.regs[6],
      bpp: bitmapMode(this.video.screenMode(this)).bpp,
      wrapSubtract: wrapSubtract(this.ic32.c0, this.ic32.c1),
      font: this.memory.osRom.subarray(0, BBC_FONT_BYTES),
      logicalToPhysical: this.palette,
      palette: this.video.activePalette(),
    };
  }

  /** Screen text for the MCP `ocr` tool: Mode 7 is read from the teletext
   *  bytes, the bitmap modes are matched against the MOS font. */
  ocrScreenForMcp(_mode?: string): string {
    if (!this.isMode7()) {
      const rows = ocrBbcBitmap(this.bitmapOcrInput()).text.split('\n').map(r => r.replace(/\s+$/, ''));
      while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
      return rows.join('\n');
    }
    return this.screenText.ocr({
      ram: this.memory.ram,
      displayStart: this.crtc.displayStart,
      stride: this.crtc.regs[1],
      palette: this.video.activePalette(),
    });
  }

  /** Styled OCR (text + coloured HTML + match mask + paper) for the TEXT overlay. */
  ocrScreenStyled(): OcrResult {
    if (!this.isMode7()) return ocrBbcBitmap(this.bitmapOcrInput());
    return this.screenText.ocrStyled({
      ram: this.memory.ram,
      displayStart: this.crtc.displayStart,
      stride: this.crtc.regs[1],
      palette: this.video.activePalette(),
    });
  }

  /** Blank the matched character cells in the framebuffer to their (physical)
   *  paper colour so the crisp overlay glyphs replace the bitmap underneath.
   *  `mask` is row-major `cols×rows` over the current mode's text grid. */
  blankCells(mask: boolean[], cols: number, rows: number, paper?: number[]): void {
    const px = new Uint32Array(this.video.pixels.buffer);
    const pal = this.video.activePalette();
    const w = this.frameWidth;
    const g = this.textLayout();
    const cw = Math.round(g.cellW);
    for (let row = 0; row < rows; row++) {
      const y0 = g.y + row * g.cellH;
      if (y0 < 0 || y0 + g.glyphH > this.frameHeight) continue;
      for (let col = 0; col < cols; col++) {
        if (!mask[row * cols + col]) continue;
        const x0 = g.x + Math.round(col * g.cellW);
        if (x0 + cw > w) continue;
        const fill = pal[(paper ? paper[row * cols + col] : 0) & 7];
        for (let y = 0; y < g.glyphH; y++) {
          const base = (y0 + y) * w + x0;
          px.fill(fill, base, base + cw);
        }
      }
    }
  }
}
