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
import { Mc6850 } from '@/cores/mc6850.ts';
import { CassetteDrive } from '@/machines/shared/cassette-drive.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { m6502ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { accessTime } from '@/debug/m6502/bus-cycles.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, SettingsView,
} from '@/machines/machine.ts';
import type { OcrResult } from '@/ocr/ocr.ts';
import {
  BbcScreenText, BBC_FONT_BYTES, BBC_MODE7_CELL_H, BBC_MODE7_CELL_W, BBC_MODE7_COLS,
  BBC_MODE7_ORIGIN_X, BBC_MODE7_ROWS, bbcBitmapCols, ocrBbcBitmap,
  type BbcBitmapOcrInput,
} from '@/ocr/bbc.ts';
import type { BbcModel, BbcDiskSystem } from './models.ts';
import { BbcMemory } from './bbc-memory.ts';
import { BbcKeyboard } from './bbc-keyboard.ts';
import { BbcVideo, bitmapMode, wrapSubtract } from './bbc-video.ts';
import { BbcDfs1770 } from './peripherals/wd1770-dfs.ts';
import { BbcAcornDfs } from './peripherals/acorn-8271-dfs.ts';
import { resolveDriveCount } from '@/machines/shared/drive-count.ts';
import type { BbcDiscController } from './peripherals/disc-controller.ts';
import { wireBbcIo } from './bbc-io.ts';
import { bbcDescriptor } from './descriptor.ts';
import { createBbcServices, type BbcServices } from './services/index.ts';
import {
  BBC_ACTIVE_WIDTH, BBC_BORDER_LEFT, BBC_CPU_CLOCK, BBC_LAYOUT_1X, bbcLayoutForScale,
  BBC_SCREEN_WIDTH, BBC_SOUND_CLOCK,
  BBC_TSTATES_PER_FRAME,
} from './constants.ts';

/** Serial ULA baud-rate codes (bits 0-2 transmit, 3-5 receive). The cassette
 *  runs at 1200 or 300 baud; RS423 defaults to 9600 (code 4, hence 0x64). */
const SERIAL_BAUD = [19200, 1200, 4800, 150, 9600, 300, 2400, 75] as const;

/** PAL scanlines per frame. */
const LINES_PER_FRAME = 312;
/** What each accuracy means for reading a beam position against the picture. */
const VIDEO_NOTES: Readonly<Record<'high' | 'mid' | 'low', string>> = {
  high: 'At High accuracy the picture is drawn as the beam goes, to the character, so a write shows from the character the beam had reached',
  mid: 'At Mid accuracy each scanline is drawn whole when the beam reaches its end, with the state as it is then',
  low: 'At Low accuracy the picture is drawn at the end of the frame, so a mid-frame change shows for the whole frame',
};
/** How the frame in progress is drawn (see `videoAccuracy`). */
const VIDEO_LOW = 0;
const VIDEO_MID = 1;
const VIDEO_HIGH = 2;
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
  /** The 6850 ACIA behind the serial ULA: RS423 or, here, the cassette port. */
  readonly acia = new Mc6850();
  /** Cassette deck, tone decoder and recorder wired to the serial ULA. */
  readonly cassette = new CassetteDrive(BBC_CPU_CLOCK);
  readonly psg = new Sn76489(BBC_SOUND_CLOCK, 48_000, 'ti-15bit');
  readonly mixer = new AudioMixer(BBC_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  // Hardware register state.
  ic32: BbcIc32 = { soundEnabled: false, keyboardScan: false, c0: 0, c1: 0, capsLock: false, shiftLock: false };
  videoUlaControl = 0;
  videoPaletteRegister = 0;
  serialUlaControl = 0;
  /** Logical -> physical colour map (identity until the OS writes the palette). */
  readonly palette = Uint8Array.from({ length: 16 }, (_, i) => i);
  /** Mode 7 teletext OCR engine, driven by the TEXT status-icon overlay. */
  readonly screenText = new BbcScreenText();

  /** Per-frame activity counters for the frame probe. */
  readonly activity = { psgWrites: 0 };

  /** Which disc interface (if any) is fitted. */
  diskSystem: BbcDiskSystem = '1770';

  /** How many of the two DFS drives are fitted (1 or 2), from the Drives pane. */
  driveCount = 2;

  /** The fitted disc controller, or null when no disc interface is present. */
  get disc(): BbcDiscController | null {
    if (this.diskSystem === 'none') return null;
    return this.diskSystem === 'acorn' ? this.acorn8271 : this.fdc1770;
  }

  /** Frames left holding SHIFT for a SHIFT+BREAK disc boot. */
  private bootShiftFrames = 0;
  private borderMode: BorderMode = 2;
  private viaAccum = 0;
  private prevVsync = false;
  /** Run flat out while the tape is being read ('tape-turbo-load'). */
  private tapeTurboEnabled = true;

  protected get audioChip(): Sn76489 { return this.psg; }

  get descriptor(): MachineDescriptor {
    return bbcDescriptor(this.model, 'uk', this.video.layout);
  }
  get pixels(): Uint8Array { return this.video.pixels; }
  get frameWidth(): number { return BBC_SCREEN_WIDTH; }
  get frameHeight(): number { return this.video.layout.screenHeight; }
  get tStatesPerFrame(): number { return BBC_TSTATES_PER_FRAME; }
  get cpuClockHz(): number { return BBC_CPU_CLOCK; }

  constructor(model: BbcModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.display = display ?? null;
    this.cpu.onInterrupt = (vector) => this.noteInterrupt(this.cpu.pc, vector === 0xFFFA);
    // The 6502 core makes its bus accesses before it counts the cycles.
    this.deferAccessStamps = true;
    this.cpu.read = (addr) => {
      const value = this.memory.readByte(addr);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, value, 'read');
      return value;
    };
    this.cpu.write = (addr, val) => {
      // High accuracy: draw up to the beam with things as they were, so a
      // write to the screen, the palette, the ULA or the CRTC shows from the
      // character the beam has reached.
      if (this.frameVideo === VIDEO_HIGH) this.catchUpVideo(addr);
      this.memory.writeByte(addr, val);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, val & 0xFF, 'write');
    };
    // PSG-only machine: no beeper to balance against the SN76489.
    this.mixer.beeperGain = 0;
    this.mixer.psgGain = 1;
    wireBbcIo(this);
    this.acia.onTxByte = (value, startCycle) => {
      // Only the cassette port records; RS423 output goes nowhere.
      if ((this.serialUlaControl & 0x40) === 0 && this.cassette.motor) {
        this.cassette.recorder.setBaud(Math.round(this.acia.txBaud(BBC_CPU_CLOCK)));
        this.cassette.recorder.byte(value, startCycle);
      }
    };
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
    this.setDriveCount(resolveDriveCount(view, 'bbc', 2));
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

  /** Fit the first `count` drives. Applied to both controllers so the count
   *  holds whichever interface is (or is later) fitted. */
  setDriveCount(count: number): void {
    this.driveCount = count;
    this.fdc1770.setDriveCount(count);
    this.acorn8271.setDriveCount(count);
  }

  applySettings(view: SettingsView): void {
    this.audio.setVolume(view.get('volume', 70) / 100);
    // The SN76489 shares the Sound panel's anti-alias strategy control with the
    // AY-family PSGs; the strategies are equivalent (see Sn76489AntialiasMode).
    this.psg.antialias = view.get<Sn76489AntialiasMode>('ay-antialias', 'mute');
    this.psg.setStereoMode(view.get<Sn76489StereoMode>('sn-stereo', 'MONO'));
    this.video.paletteMode = view.get<'pal' | 'measured'>('bbc-color-map', 'pal');
    this.videoAccuracy = view.get<'high' | 'mid' | 'low'>('scanline-accuracy', 'high');
    this.diskSystem = view.get<BbcDiskSystem>('bbc-disk-system', '1770');
    this.tapeTurboEnabled = view.get('tape-turbo-load', true);
    // With the SAA5050 upscaler the display rounds and smooths the teletext
    // itself, at any scale, so give it the plain dots in the 1x layout.
    const raw = view.get('saa-scaler', false);
    const rawChanged = raw !== this.video.rawTeletext;
    this.video.rawTeletext = raw;
    // A scale change while paused has no frame to pick it up.
    if (this.syncLayoutToScale() || rawChanged) this.video.render(this);
  }

  /** Use the hi-res layout (full-detail Mode 7, doubled scanlines, 4:3, shown
   *  at half the display scale) at even scales from 2x and the one-line-per-
   *  scanline layout otherwise. Resizes the display and tells the shell its
   *  screen geometry changed. Returns whether the layout changed. */
  private syncLayoutToScale(): boolean {
    const want = this.video.rawTeletext
      ? BBC_LAYOUT_1X : bbcLayoutForScale(this.display?.scale ?? 1);
    if (want === this.video.layout) return false;
    this.video.setLayout(want);
    this.display?.resize(this.frameWidth, this.frameHeight);
    this.display?.setPixelAspectX(want.pixelAspectX);
    this.display?.setOversample(want.vscale);
    this.setBorderSize(this.borderMode);
    this.onScreenChange?.();
    this.needsDisplay = true;
    return true;
  }

  /** The border is always black and fully rendered; the setting crops it:
   *  Normal shows it all, Small half, None just the 640×256 picture. */
  setBorderSize(mode: BorderMode): void {
    this.borderMode = mode;
    const { borderTop, screenHeight } = this.video.layout;
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(BBC_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(borderTop * (1 - frac));
    this.display?.setViewport(
      cropX, cropY, BBC_SCREEN_WIDTH - cropX * 2, screenHeight - cropY * 2,
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
    this.resetFrameCount();
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
    // The clock restarts, so a frame a stop left open cannot be carried on.
    // SHIFT+BREAK keeps counting frames so a log that spans it stays in order.
    this.midFrame = false;
    this.fLine = 0;
    this.clearInterrupts();
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
    this.acia.reset();
    this.cassette.reset();
    this.writeSerialUla(0);
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
  protected inTurbo(): boolean { return this.turbo || this.cassette.turboActive; }

  /** Serial ULA (0xFE10): bits 0-2 transmit and 3-5 receive baud rate, bit 6
   *  selects RS423 (1) or cassette (0), bit 7 is the cassette motor relay. */
  writeSerialUla(value: number): void {
    this.serialUlaControl = value & 0xFF;
    this.cassette.setMotor((value & 0x80) !== 0, this.cpu.tStates);
    this.updateAciaClock();
    this.updateSerialInputs();
  }

  /** The serial ULA divides its 1.2288 MHz-derived clock into 64× the chosen
   *  baud rate for the ACIA; the ACIA's own ÷1/16/64 setting then picks the
   *  real bit rate from that. */
  updateAciaClock(): void {
    const div = this.acia.clockDivide / 64;
    const v = this.serialUlaControl;
    const tx = SERIAL_BAUD[v & 7];
    // On RS423 the receive rate has its own field; on the cassette port the
    // MOS leaves it at 19200 and the ACIA takes both clocks from the transmit
    // rate (it writes &85 — 300 baud ×4 from the ACIA's ÷16 — for 1200 baud).
    const rx = (v & 0x40) === 0 ? tx : SERIAL_BAUD[(v >> 3) & 7];
    this.acia.txBitCycles = (BBC_CPU_CLOCK / tx) * div;
    this.acia.rxBitCycles = (BBC_CPU_CLOCK / rx) * div;
  }

  /** Point the ACIA's receive line and carrier-detect pin at the cassette
   *  demodulator (cassette mode) or leave them idle (RS423, nothing attached). */
  private updateSerialInputs(): void {
    if ((this.serialUlaControl & 0x40) === 0) {
      const f = this.cassette.fsk;
      this.acia.setRxLine(f.level, f.levelSince, f.startLevel);
      this.acia.setDcd(f.carrier);
    } else {
      this.acia.setRxLine(1, 0);
      this.acia.setDcd(false);
    }
  }

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
    const now = this.cpu.tStates;
    this.cassette.step(elapsed, now);
    this.updateSerialInputs();
    this.acia.tick(now);
    this.cpu.setIRQ(this.sysVia.irq || this.userVia.irq || this.acia.irq);
  }

  // ── Beam ───────────────────────────────────────────────────────────────

  /** The next line of the frame in progress to run (it carries over a stop). */
  private fLine = 0;

  /** Frame line 0 is the CRTC's first character row, which `beginFrame`
   *  restarts at the top of each frame; VSYNC (System VIA CA1, the 50 Hz
   *  interrupt) starts on the first line of row R7. The frame is 20 ms split
   *  evenly into 312 lines, so a line is 40000/312 cycles, not 128. */
  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: BBC_TSTATES_PER_FRAME / LINES_PER_FRAME,
      linesPerFrame: LINES_PER_FRAME,
      displayStart: 0,
      note: 'line 0 is the first line of CRTC character row 0, which is restarted each frame; VSYNC, the frame interrupt (System VIA CA1), starts on the first line of row R7 (line 272 in modes 0-2, 4 and 5, 270 in 3, 6 and 7). The 40000-cycle frame is split evenly into 312 lines of about 128.2 cycles, not the 6845’s 128. '
        + VIDEO_NOTES[this.videoAccuracy],
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return m6502ReturnAddress(this.cpu.sp, a => this.memory.readByte(a)); }
  /** An opcode is never read from the hardware pages, where reads have side effects. */
  protected override peekOpcode(addr: number): number {
    return addr >= 0xFC00 && addr < 0xFF00 ? -1 : this.memory.readByte(addr);
  }

  protected override interruptEntryPending(): boolean { return this.cpu.interruptPending(); }

  // ── Video accuracy ─────────────────────────────────────────────────────

  /** The Display pane's accuracy: 'high' draws as the beam goes, to the
   *  character, 'mid' a scanline at a time, 'low' the whole frame at its end
   *  (the fastest, but a mode or palette change mid-frame shows everywhere). */
  videoAccuracy: 'high' | 'mid' | 'low' = 'high';
  /** The accuracy the frame in progress is drawn at (VIDEO_*), fixed when it
   *  starts; turbo draws at Low. */
  private frameVideo = VIDEO_LOW;

  /** Draw the scanline in progress up to where the beam is for an access the
   *  CPU is making to `addr` now (the 6502 core calls its bus before it counts
   *  the instruction's cycles, so the access's own cycle is worked out). */
  private catchUpVideo(addr: number): void {
    if (!this.frameOpen) return;
    const pc = this.insnPc;
    const t = accessTime(this.cpu.tStates, this.peekOpcode(pc), pc, addr, true, false);
    const lineStart = this.frameStartT + (this.fLine * BBC_TSTATES_PER_FRAME) / LINES_PER_FRAME;
    // A character a cycle in the 2MHz modes, every other cycle in the 1MHz ones.
    const perChar = (this.videoUlaControl & 0x10) !== 0 ? 1 : 2;
    this.video.drawLine(this, this.fLine, Math.floor((t - lineStart) / perChar));
  }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1 || this.cassette.turboActive;
    // A frame a stop left part-way carries on from the line it was in.
    if (!this.openFrame(BBC_TSTATES_PER_FRAME)) {
      this.activity.psgWrites = 0;
      this.crtc.beginFrame();
      this.fLine = 0;
      this.frameVideo = this.inTurbo() ? VIDEO_LOW
        : this.videoAccuracy === 'high' ? VIDEO_HIGH : this.videoAccuracy === 'mid' ? VIDEO_MID : VIDEO_LOW;
      if (this.frameVideo !== VIDEO_LOW) {
        this.syncLayoutToScale();
        this.video.beginFrame(this);
      }
    }
    this.memWatchHit = null;
    let lastAudioT = this.cpu.tStates;

    for (; this.fLine < LINES_PER_FRAME; this.fLine++) {
      const lineEnd = this.frameStartT + ((this.fLine + 1) * BBC_TSTATES_PER_FRAME) / LINES_PER_FRAME;
      while (this.cpu.tStates < lineEnd) {
        if (this.checkStops(this.cpu.pc)) {
          // The frame stays open; the next call carries on in this line.
          this.midFrame = true;
          this.needsDisplay = true;
          return;
        }
        const before = this.cpu.tStates;
        this.beforeInsn(this.cpu.pc);
        this.cpu.step();
        const stopped = this.afterInsn();
        this.tickChips(this.cpu.tStates - before);

        if (!skipAudio) {
          const audioElapsed = this.cpu.tStates - lastAudioT;
          if (audioElapsed > 0) {
            this.mixer.accumulate(0, audioElapsed);
            this.mixer.generateSamples(this.audio, this.psg, true);
            lastAudioT = this.cpu.tStates;
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
      // Mid and High: the scanline is drawn (the rest of it, at High) before
      // the CRTC moves on.
      if (this.frameVideo !== VIDEO_LOW) {
        this.video.drawLine(this, this.fLine, Infinity);
        this.video.endLine();
      }
      this.crtc.advanceLine();
      if (this.crtc.vsyncStart) {
        this.sysVia.setCA1(false);                       // VSYNC negative edge
      } else if (this.prevVsync && !this.crtc.vsyncActive) {
        this.sysVia.setCA1(true);                        // VSYNC ended
      }
      this.prevVsync = this.crtc.vsyncActive;
    }

    if (this.frameVideo === VIDEO_LOW) {
      this.syncLayoutToScale();
      this.video.render(this);
    }
    this.disc?.tickFrame();
    this.cassette.frameTick(this.tapeTurboEnabled);
    if (this.bootShiftFrames > 0 && --this.bootShiftFrames === 0) {
      this.keyboard.setCell(0, 0, false);
    }
    this.needsDisplay = true;
  }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: `${this.model}-ram-32k.bin` };
  }

  /** Execution trace: BaseMachine's startTrace/stopTrace drive it and
   *  beforeInsn feeds it (debug/m6502/trace.ts). */
  protected override tracer = new M6502Trace(this, { io: [[0xFC00, 0xFEFF]], ioLabel: bbcIoLabel });

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
    const { vscale, borderTop, activeHeight } = this.video.layout;
    if (this.isMode7()) {
      const cellH = BBC_MODE7_CELL_H * vscale;
      return {
        cols: BBC_MODE7_COLS, rows: BBC_MODE7_ROWS,
        x: BBC_BORDER_LEFT + BBC_MODE7_ORIGIN_X,
        y: borderTop + ((activeHeight - BBC_MODE7_ROWS * cellH) >> 1),
        cellW: BBC_MODE7_CELL_W, cellH, glyphH: cellH,
      };
    }
    const { bpp } = bitmapMode(this.video.screenMode(this));
    const cols = Math.max(1, bbcBitmapCols(this.crtc.regs[1], bpp));
    const rows = this.crtc.regs[6];
    const cellH = ((this.crtc.regs[9] & 0x1F) + 1) * vscale;
    return {
      cols, rows,
      x: BBC_BORDER_LEFT,
      y: borderTop + ((activeHeight - rows * cellH) >> 1),
      cellW: BBC_ACTIVE_WIDTH / cols, cellH, glyphH: 8 * vscale,
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

/** Portio-trace names for the BBC Micro's FRED, JIM and SHEILA pages. */
function bbcIoLabel(addr: number): string {
  if (addr < 0xFD00) return 'FRED';
  if (addr < 0xFE00) return 'JIM';
  const o = addr & 0xFF;
  if (o < 0x08) return 'CRTC';
  if (o < 0x10) return 'ACIA';
  if (o < 0x20) return 'SERULA';
  if (o < 0x30) return 'VIDULA';
  if (o < 0x40) return 'ROMSEL';
  return ['SYSVIA', 'USRVIA', 'FDC', 'ECONET', 'ADC', 'TUBE'][(o - 0x40) >> 5];
}
