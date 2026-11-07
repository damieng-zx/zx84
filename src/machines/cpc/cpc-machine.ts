/**
 * CpcMachine — Amstrad CPC orchestrator.
 *
 * The CPC counterpart to `Spectrum`: it owns the Z80, AY, uPD765A (all reused
 * unchanged), plus CPC-specific cores (CpcMemory, CRTC 6845, Gate Array, 8255
 * PPI, keyboard) and drives its own frame loop. Implements the shared `Machine`
 * interface so `emulator.ts`, the UI, and the MCP server can treat it like any
 * other machine.
 *
 * Phase 1 boots the firmware headlessly: the frame loop runs the CPU, drives the
 * Gate Array's raster interrupt off synthesised HSYNC/VSYNC timing, and mixes
 * AY audio. The real CRTC-driven raster + pixel output replace the synthesised
 * timing in the video phase; `pixels` is allocated but not yet drawn into.
 */

import { Z80 } from '@/cores/z80.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { UPD765A } from '@/cores/upd765a.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { isCpr, parseCpr } from '@/media/cartridge/cpr.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { disasmOne, type DisasmLine } from '@/debug/z80/disasm.ts';
import { z80ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { Z80Trace } from '@/debug/z80/trace.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type { Machine, MachineHost, MachineKind, MachineDescriptor, BorderMode, SettingsView, AuxRomRequest } from '@/machines/machine.ts';
import { applyAySettings } from '@/machines/shared/ay-settings.ts';
import { cpcDescriptor } from '@/machines/cpc/descriptor.ts';
import { createCpcServices, type CpcServices } from '@/machines/cpc/services/index.ts';
import type { CpcModel } from '@/models.ts';
import type { OcrGridName, OcrResult } from '@/ocr/ocr.ts';
import { CpcScreenText, cpcGrid, CPC_FONT_OFFSET, type CpcOcrInput } from '@/ocr/cpc.ts';
import { CpcMemory } from '@/machines/cpc/cpc-memory.ts';
import { CpcKeyboard } from '@/machines/cpc/cpc-keyboard.ts';
import {
  Crtc6845, R_HORIZ_DISPLAYED, R_VERT_DISPLAYED, R_MAX_RASTER, R_VERT_ADJUST, R_VERT_TOTAL,
} from '@/cores/crtc-6845.ts';
import { GateArray } from '@/machines/cpc/gate-array.ts';
import { Asic } from '@/machines/cpc/asic.ts';
import { Ppi8255, installCpcMemoryHooks, wireCpcPortIO } from '@/machines/cpc/cpc-io.ts';
import { CpcMultiface } from '@/machines/cpc/peripherals/cpc-multiface.ts';
import { KempstonMouse } from '@/machines/shared/kempston-mouse.ts';
import { resolveDriveCount } from '@/machines/shared/drive-count.ts';
import { CpcAmxMouse } from '@/machines/cpc/peripherals/cpc-amx-mouse.ts';
import { trapCpcCasRead, scanCpcCasRead } from '@/machines/cpc/cpc-tape-loader.ts';
import type { CpcCasReadRoutine, CpcCasReadRequest } from '@/machines/cpc/cpc-tape-loader.ts';
import { createCpcConfig, type CpcConfig } from '@/machines/cpc/config.ts';
import {
  CPC_DEFAULT_OPTIONS, cpcTakesClassicOptions, cpcTakesDdi1, readCpcOptions, type CpcOptions,
} from '@/machines/cpc/options.ts';
import { cpcAcknowledgeInterrupt } from '@/machines/cpc/wait-states.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import {
  CPC_AY_CLOCK, CPC_CPU_CLOCK, CPC_T_PER_CHAR,
  CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT, CPC_BORDER_TOP, CPC_BORDER_LEFT,
  CPC_PALETTES,
} from '@/machines/cpc/constants.ts';

/** Cassette read-cadence thresholds (CPU T-states between consecutive Port B
 *  reads). A gap below ENTER means the firmware is in its tight tape-edge timing
 *  loop (measured ~tens of T-states); above EXIT means idle (measured ~9000+ for
 *  VSYNC polls). Inter-byte gaps fall between and keep the tape advancing. */
const TAPE_LOAD_ENTER_GAP = 500;
const TAPE_LOAD_EXIT_GAP = 5000;

/** The CPC's disk controller (built in, or the DDI-1) takes two drives. */
export const CPC_MAX_DRIVES = 2;

export class CpcMachine extends BaseMachine implements Machine {
  protected get audioChip(): AY3891x { return this.ay; }
  readonly kind: MachineKind = 'cpc';
  readonly model: CpcModel;
  readonly config: CpcConfig;
  /** Operator's panel (shell / MCP) — null when running headless. */
  host: MachineHost | null = null;
  /** The service surface (§3.3): the only way shell/UI/MCP reach internals. */
  readonly services: CpcServices;

  readonly cpu: Z80;
  readonly memory: CpcMemory;
  readonly ay: AY3891x;
  readonly fdc: UPD765A;
  /** A uPD765A is on the bus: built in (664/6128/6128 Plus) or a DDI-1 on the
   *  464. Set by fit(); the port decode is rewired when it changes. */
  hasFdc: boolean;
  /** The Hardware-pane fit (CRTC, RAM expansion, DDI-1, links); the defaults
   *  until prepare() reads the settings. */
  options: CpcOptions = CPC_DEFAULT_OPTIONS;
  /** Drives fitted to the controller (1..2) — set from the settings in prepare(). */
  driveCount = CPC_MAX_DRIVES;
  readonly tape: TapeDeck;
  readonly keyboard: CpcKeyboard;
  readonly crtc: Crtc6845;
  readonly gateArray: GateArray;
  readonly ppi: Ppi8255;
  readonly multiface = new CpcMultiface();
  /** Kempston mouse (ports 0xFBEE/0xFBEF/0xFAEF). Same L/R bit layout as the
   *  Spectrum (bit0 = right, bit1 = left) but with no middle button. */
  readonly kempstonMouse = new KempstonMouse({ 0: 1, 2: 0 });
  /** AMX mouse — presents on keyboard line 9 (joystick 0). */
  readonly amxMouse = new CpcAmxMouse();
  readonly mixer: AudioMixer;
  readonly audio: Audio;
  display: IScreenRenderer | null;

  /** RGBA frame buffer, with a Uint32 view for fast Gate-Array writes. */
  private readonly _pixels = new Uint8Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  /** Per-frame I/O activity feeding the status-bar LEDs, reset at the start of
   *  each frame. `kbdReads` counts keyboard-matrix scans (the firmware reads the
   *  AY's port A through the PPI ~once per frame); `fdcAccesses` counts FDC
   *  data-port transfers; `tapeReads` counts cassette reads (pulse-load edges or
   *  instant CAS READ traps) so the TAPE LED lights; `ayWrites` counts sound-
   *  register writes to the AY so the AY LED lights. Mirrors the Spectrum's
   *  IOActivity so KEYBOARD/DISK/TAPE/AY light up the same way. */
  readonly activity = { kbdReads: 0, fdcAccesses: 0, mouseReads: 0, tapeReads: 0, ayWrites: 0 };

  /** Screen OCR engine for the TEXT overlay + MCP `ocr` tool. */
  readonly screenText = new CpcScreenText();

  /** T-states in the current CRTC-programmed frame (debugger readout). Falls
   *  back to the nominal frame length before the firmware programs the CRTC. */
  get tStatesPerFrame(): number {
    return this.crtc.linesPerFrame() * this.crtc.charsPerLine() * CPC_T_PER_CHAR;
  }

  /** HSYNCs remaining until the post-VSYNC interrupt re-sync fires (0 = idle). */
  vsyncResyncCountdown = 0;

  // ── Cassette ─────────────────────────────────────────────────────────
  /** Cassette motor state, driven by PPI Port C bit 4. Tracked for the UI only.
   *  NOTE: the 6128 firmware reads tape edges directly and does NOT toggle the
   *  motor relay, so tape advance is gated on read *cadence*, not the motor. */
  tapeMotorOn = false;
  /** T-state of the last cassette (Port B) read, for cadence-based advance. */
  tapeLastAdvanceT = 0;
  /** True while the firmware is actively reading the cassette (detected by a
   *  tight Port-B read cadence). Drives tape advance. */
  tapeLoadingActive = false;
  /** Times the cassette write-data line (PPI Port C bit 5) — what the
   *  firmware's CAS WRITE (or any saver) sends to tape. Read back as a .cdt
   *  by the tape service (see cpc-tape-save.ts). */
  readonly tapeRecorder = new PulseRecorder();
  /** Fast ROM loading: whether the CAS READ instant-load trap is armed (Stage B). */
  tapeFastRom = true;
  /** The firmware's CAS READ routine, located by signature scan of the lower OS
   *  ROM. undefined = not yet scanned, null = not found (instant load disabled,
   *  pulse loading only). Re-scanned when ROMs change. See scanCpcCasRead. */
  private casRead: CpcCasReadRoutine | null | undefined = undefined;
  /** The CAS READ request captured at the routine's entry, consumed when the
   *  firmware reaches the routine's sync/record-read block. */
  private casReadReq: CpcCasReadRequest | null = null;
  /** Auto-accelerate while the cassette is being read (the CPC reads at real
   *  tape speed, so without this a game takes minutes to load). */
  tapeTurbo = true;
  /** Auto-rewind the tape to the start when it runs out (frame probe). */
  tapeAutoRewind = false;

  // The `turbo` flag, the debug surface (breakpoints / watchpoints / onTrap /
  // onStatus / onFrame), and the frame-loop + lifecycle state all live on
  // BaseMachine, shared with the Spectrum.

  constructor(model: CpcModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.config = createCpcConfig(model);
    this.cpu = new Z80();
    this.cpu.onInterrupt = (handler, nmi) => this.noteInterrupt(handler, nmi);
    this.memory = new CpcMemory(this.config);
    this.ay = new AY3891x(CPC_AY_CLOCK, 48000, 'ABC');
    this.fdc = new UPD765A();
    this.hasFdc = this.config.hasFDC;
    // CDT timings are 3.5MHz-referenced; scale them to the CPC's 4MHz Z80.
    this.tape = new TapeDeck(CPC_CPU_CLOCK);
    this.tape.pulseScale = CPC_CPU_CLOCK / TAPE_REF_HZ;
    this.keyboard = new CpcKeyboard();
    this.crtc = new Crtc6845(this.config.crtcType);
    this.gateArray = this.config.isPlus ? new Asic() : new GateArray();
    this.audio = new Audio();
    this.mixer = new AudioMixer(CPC_CPU_CLOCK);
    // The CPC has no beeper; the mixer carries the AY only.
    this.mixer.beeperGain = 0;
    this.mixer.ayGain = 1;
    this.ppi = new Ppi8255(this.ay, this.keyboard, () => this.crtc.vsyncActive,
                           () => { this.activity.kbdReads++; },
                           () => { this.advanceTapeTo(); return this.tape.earBit; },
                           (on) => this.setTapeMotor(on),
                           () => { this.activity.ayWrites++; },
                           (level) => this.tapeRecorder.observe(level, this.cpu.tStates));
    this.display = display ?? null;

    // Gate Array drives ROM enable + RAM banking through the memory.
    this.gateArray.onLowerRom = (on) => this.memory.setLowerRomEnabled(on);
    this.gateArray.onUpperRom = (on) => this.memory.setUpperRomEnabled(on);
    this.gateArray.onRamConfig = (val) => this.memory.setRamConfig(val);

    // Plus ASIC: route register-window paging through to memory. CPU writes
    // that land inside the window go straight to `asic.cpuWrite()` from
    // `cpc-io.ts` (palette/sprite/scroll side-effects fire there). Non-Plus
    // machines skip this entirely (`gateArray` is a plain GateArray).
    if (this.config.isPlus) {
      const asic = this.gateArray as Asic;
      asic.onAsicPage = (visible) =>
        this.memory.setAsicPage(visible ? asic.registerPage : null);
      // RMR2 lower-ROM banking: page a cartridge ROM page into the lower slot.
      asic.onLowerRomBank = (page, slot) => this.memory.setLowerRomBank(page, slot);
      // DMA engine hooks: the channel reads 16-bit little-endian instructions
      // from base 64 KB RAM (using the same video-DMA read path the CRTC uses)
      // and writes PSG registers via the AY.
      asic.readRam16 = (addr) =>
        this.memory.readVideo(addr) | (this.memory.readVideo((addr + 1) & 0xFFFF) << 8);
      asic.writeAy = (reg, val) => this.ay.writeRegister(reg, val);
    }

    // The AMX mouse rides keyboard line 9 (joystick 0).
    this.keyboard.amx = this.amxMouse;

    installCpcMemoryHooks(this);
    wireCpcPortIO(this);

    this.services = createCpcServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  get descriptor(): MachineDescriptor { return cpcDescriptor(this.model); }
  get frameWidth(): number { return CPC_SCREEN_WIDTH; }
  get frameHeight(): number { return CPC_SCREEN_HEIGHT; }
  /** Nominal CPU clock (4 MHz). */
  get cpuClockHz(): number { return this.tape.cpuClock; }

  /** `.scr` export: the 16K RAM quadrant the CRTC displays from (R12:R13 bits
   *  12-13 pick the bank; video DMA only ever reads banks 0-3). This is a raw
   *  screen-RAM dump — it does not carry the ASIC soft-scroll offset or a
   *  split-screen's second base, so it may not match the composited image for
   *  Plus scroll/split effects. Use the PNG screenshot for the exact display. */
  screenExportBytes(): Uint8Array { return this.memory.getRamBank(this.crtc.displayStart >>> 12).slice(); }

  /** RAM export: the full 64K physical RAM image. */
  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ramSnapshot(), filename: 'ram-64k.bin' };
  }

  /**
   * Apply the CPC-specific settings: the Gate Array colour map, master volume,
   * and the tape loader flags (Fast ROM + Turbo while loading; the CPC has no
   * Spectrum-style loader detector, so there is no "Fast edge" setting).
   */
  applySettings(view: SettingsView): void {
    this.gateArray.palette = CPC_PALETTES[view.get('cpc-color-map', 'gate-array') as keyof typeof CPC_PALETTES];
    this.audio.setVolume(view.get('volume', 70) / 100);
    this.tapeFastRom = view.get('tape-instant-rom', true);
    this.tapeTurbo = view.get('tape-turbo-load', true);
    this.tapeAutoRewind = view.get('tape-auto-rewind', false);
    applyAySettings(this.ay, view);
    // Live-disable only: enabling needs a ROM load, which prepare() owns.
    if (!view.get('multiface', false) && this.multiface.enabled) {
      this.multiface.enabled = false;
      this.multiface.pageOut(this.memory);
    }
  }

  /** The Multiface Two ROM load request — shared by build-time prepare() and the
   *  live enable toggle (setCpcMultiface). */
  multifaceAuxRom(awaitLoad: boolean): AuxRomRequest {
    return {
      cacheKey: 'cpc-mf2-rom', source: 'cpc/multiface-2.rom',
      fetchingMsg: 'Fetching Multiface Two ROM…',
      loadedMsg: (n) => `Multiface Two ROM loaded (${n} bytes)`,
      failMsg: 'Failed to load Multiface Two ROM', failId: 'multiface',
      apply: (d) => this.multiface.loadROM(d), awaitLoad,
    };
  }

  /**
   * Fit the Hardware-pane options: the CRTC type and RAM expansion (464/664/
   * 6128 only — the Plus keeps its ASIC CRTC, type 3, and 128K), a DDI-1 on
   * the 464, and the PPI links (every model). Before boot: it rewires the port
   * decode for the disk interface and resizes RAM.
   */
  fit(options: CpcOptions): void {
    this.options = options;
    const classic = cpcTakesClassicOptions(this.model);
    this.crtc.setType(classic ? options.crtcType : this.config.crtcType);
    this.memory.setExpansion(classic ? options.ramExpansionKb : 0);
    this.ppi.setLinks(options.manufacturerCode, options.fiftyHz);
    const hasFdc = this.config.hasFDC || (cpcTakesDdi1(this.model) && options.ddi1);
    if (hasFdc !== this.hasFdc) {
      this.hasFdc = hasFdc;
      wireCpcPortIO(this);
    }
  }

  /** Fit the Hardware-pane options, enable the Multiface Two from settings and
   *  request its ROM (before boot). */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.fit(readCpcOptions(view));
    // uPD765A drive settings (664/6128/DDI-1): write-protect tabs + the
    // drive-B force-ready override. Once per build, like the peripherals.
    if (this.hasFdc) {
      this.fdc.writeProtect[0] = view.get('write-protect-a', false);
      this.fdc.writeProtect[1] = view.get('write-protect-b', false);
      this.fdc.forceReady[1] = view.get('drive-b-force-ready', false);
      // Only the first `driveCount` drives are wired to the controller; a
      // RECALIBRATE/SEEK on an unfitted unit fails and Sense Drive Status
      // reports it not-ready, which is how AMSDOS finds out there is no drive B.
      this.driveCount = resolveDriveCount(view, 'cpc', CPC_MAX_DRIVES);
      for (let u = 0; u < CPC_MAX_DRIVES; u++) this.fdc.connected[u] = u < this.driveCount;
    }
    this.multiface.enabled = view.get('multiface', false);
    return this.multiface.enabled ? [this.multifaceAuxRom(true)] : [];
  }

  /** Upper ROM 7 on a disk-capable CPC — ParaDOS (replacing AMSDOS) when
   *  chosen, or the DDI-1's AMSDOS on a 464 — applied AFTER reset so the
   *  firmware ROM scan initialises it. */
  bootRoms(view: SettingsView): AuxRomRequest[] {
    if (!this.hasFdc) return [];
    if (!view.get('cpc-parados', false)) {
      if (this.config.hasFDC) return [];   // AMSDOS is in the system ROM set
      return [{
        cacheKey: 'cpc-amsdos-rom', source: 'cpc/amsdos.rom',
        fetchingMsg: 'Fetching DDI-1 AMSDOS ROM…',
        loadedMsg: (n) => `DDI-1 AMSDOS ROM loaded (${n} bytes)`,
        failMsg: 'Failed to load the DDI-1 AMSDOS ROM', failId: 'cpc-ddi1',
        apply: (d) => this.memory.setUpperRom(7, d), awaitLoad: true,
      }];
    }
    return [{
      cacheKey: 'cpc-parados-rom', source: 'cpc/parados.rom',
      fetchingMsg: 'Fetching ParaDOS ROM…',
      loadedMsg: (n) => `ParaDOS ROM loaded (${n} bytes)`,
      failMsg: 'Failed to load ParaDOS ROM', failId: 'parados',
      apply: (d) => this.memory.setUpperRom(7, d), awaitLoad: true,
    }];
  }

  // ── Machine: lifecycle ───────────────────────────────────────────────

  loadROM(data: Uint8Array): void {
    // The Plus range boots from a .CPR firmware cartridge (system.cpr — the
    // real v4 OS + BASIC + AMSDOS, with the Burnin' Rubber pack-in on pages
    // 4–7), not the OS+BASIC[+AMSDOS] file split the non-Plus models use. A
    // .CPR arriving here (the Plus models' `romSources`) goes through the
    // cartridge path; anything else is the classic three-ROM image.
    if (isCpr(data)) {
      this.memory.loadCartridge(parseCpr(data));
      this.casRead = undefined;   // force a re-scan against the new lower ROM
      this.setStatus('Cartridge firmware loaded');
      return;
    }
    this.memory.loadROM(data);
    this.casRead = undefined;   // force a re-scan against the new lower ROM
    this.setStatus('ROM loaded');
  }

  /** Insert a parsed DSK image into a drive (uPD765A is shared with the +3). */
  loadDisk(image: DskImage, unit = 0): void {
    this.fdc.insertDisk(image, unit);
  }

  /**
   * Advance the tape, called on every cassette read (PPI Port B). The 6128
   * firmware reads tape edges in a tight timing loop (consecutive reads tens of
   * T-states apart) but never spins the motor relay, while idle VSYNC polls of
   * the same port are thousands of T-states apart. So we gate on read *cadence*:
   * a tight burst means active loading → advance the tape in step; a long gap
   * means idle/done → stop. This is the CPC analogue of the Spectrum's loader
   * detector. Once loading, advance by the full delta so edge timing never lags.
   */
  advanceTapeTo(): void {
    const now = this.cpu.tStates;
    const gap = now - this.tapeLastAdvanceT;
    this.tapeLastAdvanceT = now;
    if (!this.tape.playing) { this.tapeLoadingActive = false; return; }

    if (gap > 0 && gap < TAPE_LOAD_ENTER_GAP) {
      // Tight read cadence — the firmware is reading the cassette. Auto-play
      // (a mounted tape sits paused until the firmware starts pulling on it).
      if (!this.tapeLoadingActive) {
        this.tapeLoadingActive = true;
        if (this.tape.paused) this.tape.paused = false;
      }
    } else if (gap >= TAPE_LOAD_EXIT_GAP) {
      this.tapeLoadingActive = false;
    }
    if (this.tapeLoadingActive && !this.tape.paused && gap > 0) {
      this.tape.advance(gap);
      this.activity.tapeReads++;   // pulse-load edge → TAPE LED
    }
  }

  /** Track the cassette motor state (PPI Port C bit 4) for the UI. It does not
   *  gate playback — see advanceTapeTo for why the 6128 needs cadence gating. */
  setTapeMotor(on: boolean): void {
    this.tapeMotorOn = on;
  }

  /**
   * Seed the Multiface Two I/O shadow from the live chip state, so the freeze
   * cartridge can be enabled mid-session and STOP→Return still restores the
   * running program rather than crashing on a blank shadow. Called when the MF2
   * is toggled on (see CpcMultiface.seedShadow).
   */
  seedMultifaceShadow(): void {
    const p = this.memory.pagingState();
    this.multiface.seedShadow({
      pens: this.gateArray.pens,
      selectedPen: this.gateArray.selectedPenIndex,
      mode: this.gateArray.mode,
      lowerRomEnabled: p.lowerRomEnabled,
      upperRomEnabled: p.upperRomEnabled,
      ramConfig: p.ramConfig,
      ram64kBlock: p.ram64kBlock,
      selectedUpperRom: p.selectedUpperRom,
      crtcRegs: this.crtc.regs,
      crtcSelected: this.crtc.selectedRegister,
      ppiControl: this.ppi.getState().control,
    });
  }

  setBorderSize(mode: BorderMode): void {
    // The Gate Array always renders the full 768×272 buffer (active 640×200
    // centred, CPC_BORDER_LEFT/TOP border on each side). Cropping is purely a
    // display concern: show a centred sub-rect. Normal = whole buffer, Small =
    // half the border, None = just the active area.
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(CPC_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(CPC_BORDER_TOP * (1 - frac));
    if (this.display) {
      this.display.setViewport(
        cropX, cropY,
        CPC_SCREEN_WIDTH - cropX * 2,
        CPC_SCREEN_HEIGHT - cropY * 2,
      );
    }
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.ay.reset();
    this.fdc.reset();
    this.memory.reset();
    this.crtc.reset();
    this.gateArray.reset();
    this.ppi.reset();
    this.tapeRecorder.reset();
    this.multiface.reset();
    this.kempstonMouse.reset();
    this.amxMouse.reset();
    this.keyboard.reset();
    this.audio.reset();
    this.mixer.reset();
    this.tapeMotorOn = false;
    this.tapeLoadingActive = false;
    this.tapeLastAdvanceT = this.cpu.tStates;
    this.resetFrameCount();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  // start / stop / destroy / tick / runUntil and the rAF frame loop live on
  // BaseMachine. The CPC supplies only these hooks; its turbo path uses the
  // base default (a fixed per-rAF budget).

  /** The RGBA frame buffer the rAF driver uploads to the display. */
  protected framePixels(): Uint8Array { return this._pixels; }

  /** Turbo engaged for UI fast-forward, or while a cassette is actively loading. */
  protected inTurbo(): boolean { return this.turbo || (this.tapeTurbo && this.tapeLoadingActive); }

  // ── Beam ───────────────────────────────────────────────────────────────

  /** The next line of the frame in progress to run (it carries over a stop). */
  private fLine = 0;
  /** T-state of that line's HSYNC end, fixed when the line starts (-1 = not
   *  started), and whether its HSYNC work (drawing the line, clocking the Gate
   *  Array) is done: a stop can fall on either side of it. */
  private fHsyncT = -1;
  private fHsyncDone = false;
  /** The frame's geometry and Plus state, taken from the CRTC and ASIC when it
   *  starts, so resuming it after a stop keeps them. */
  private fLines = 312;
  private fLineT = 64 * CPC_T_PER_CHAR;
  private fDisplayTop = 0;
  private fPlusActive = false;

  /** Every frame restarts the CRTC (`crtc.beginFrame`), so frame line 0 is its
   *  row 0, raster 0 — the first display line — and `t` 0 that line's first
   *  character. The geometry is the CRTC's as it stood when the frame began;
   *  between frames it is what the next frame will take. */
  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    const open = this.frameOpen;
    return {
      cyclesPerLine: open ? this.fLineT : this.crtc.charsPerLine() * CPC_T_PER_CHAR,
      linesPerFrame: open ? this.fLines : this.crtc.linesPerFrame(),
      displayStart: 0,
      note: 'line 0 is CRTC row 0 raster 0 (the first display line) and t 0 its first character; '
        + 'line length (R0) and lines (R4/R9/R5) are the CRTC registers as they stood when the frame '
        + 'began, so a mid-frame R4 change (rupture) restarts the CRTC rows without moving the frame; '
        + 'VSYNC begins at row R7 and the Gate Array interrupt counts HSYNC ends; each line is drawn '
        + 'at the end of its HSYNC, so a palette or mode change before then shows on that line',
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return z80ReturnAddress(this.cpu.sp, a => this.memory.readByte(a)); }

  /** Forget a frame a stop left part-way: a loaded snapshot replaces the state
   *  it stopped in, so the next frame starts over at line 0. */
  dropFrameInProgress(): void {
    this.midFrame = false;
    this.fLine = 0;
    this.clearInterrupts();
  }

  /**
   * Execute one frame, rendering scanline by scanline. For each CRTC scanline:
   * run the CPU up to the end of HSYNC, draw the line from the current
   * CRTC/Gate-Array state and clock the Gate Array's HSYNC (raster interrupt
   * counter, mode latch), then run the rest of the line — so mid-frame
   * mode/palette/scroll changes take effect per line.
   */
  protected runFrame(): void {
    const crtc = this.crtc;
    const ga = this.gateArray;
    const skipAudio = this.speedMultiplier !== 1 || (this.tapeTurbo && this.tapeLoadingActive);
    const asic = this.config.isPlus ? (this.gateArray as Asic) : null;

    // Frames run back to back on the 1µs grid: start where the previous frame
    // was scheduled to end (the last instruction's overshoot belongs to this
    // frame), falling back to "now" rounded down to a µs after a reset or a
    // snapshot load moved the clock. A frame a stop left part-way carries on
    // from the line, and the side of its HSYNC, it was in.
    const now = this.cpu.tStates;
    const cycles = crtc.linesPerFrame() * crtc.charsPerLine() * CPC_T_PER_CHAR;
    if (!this.openFrame(cycles, now - (now & 3))) {
      this.activity.kbdReads = 0;
      this.activity.fdcAccesses = 0;
      this.activity.mouseReads = 0;
      this.activity.tapeReads = 0;
      this.activity.ayWrites = 0;

      crtc.beginFrame();
      ga.beginFrame(this._pixels32);

      this.fLines = crtc.linesPerFrame();
      this.fLineT = crtc.charsPerLine() * CPC_T_PER_CHAR;
      // Centre the display vertically by its height, the vertical analogue of
      // the GA's horizontal width-centring: a standard 200-line display lands
      // at CPC_BORDER_TOP (36), while a taller overscan display (more R6 rows)
      // shifts up to stay centred rather than overflowing the bottom edge —
      // e.g. the Crazy Cars II title, whose ground was clipped off the bottom.
      this.fDisplayTop = (CPC_SCREEN_HEIGHT - crtc.displayedLines()) >> 1;
      this.fPlusActive = asic !== null && !asic.locked;
      this.fLine = 0;
      this.fHsyncT = -1;
      this.fHsyncDone = false;

      // VSYNC can begin on the frame's first scanline (R7 = 0).
      if (crtc.vsyncStart) this.vsyncResyncCountdown = 2;
    }
    this.portWatchHit = null;
    this.memWatchHit = null;
    this.lastAudioT = this.cpu.tStates;

    const totalLines = this.fLines;
    const lineT = this.fLineT;
    const displayTop = this.fDisplayTop;
    const plusActive = this.fPlusActive;

    for (; this.fLine < totalLines; this.fLine++) {
      const line = this.fLine;
      const lineStart = this.frameStartT + line * lineT;
      const lineEnd = lineStart + lineT;

      if (!this.fHsyncDone) {
        // The Gate Array counts the falling edge of the CRTC's HSYNC (R2 +
        // width characters into the line), not the end of the scanline.
        if (this.fHsyncT < 0) this.fHsyncT = lineStart + crtc.hsyncEndChar() * CPC_T_PER_CHAR;

        // Run the CPU up to the end of HSYNC.
        if (this.runCpuUntil(this.fHsyncT, plusActive, asic, skipAudio)) break;

        // The display portion of the line (chars 0..R1) precedes HSYNC, so
        // draw it now. On a Plus model the ASIC applies scroll + split-screen
        // to the CRTC line before the GA renders it, and composites sprites
        // on top.
        let lineState = crtc.currentLine();
        // R8 DISPTMG skew 3 holds the display off (types 0/3/4).
        if (crtc.displaySkewOff) lineState.vDisplay = false;
        if (plusActive) {
          lineState = asic!.applyScrollAndSplit(lineState);
        }
        ga.renderScanline(this._pixels32, displayTop + line, lineState,
                          (addr) => this.memory.readVideo(addr));
        if (plusActive) {
          asic!.drawSprites(this._pixels32, displayTop + line);
        }
        // A line with no HSYNC (width 0 on types 0/1, or R2 beyond R0) gives
        // the Gate Array nothing to count: no interrupt line, no mode latch.
        if (crtc.hsyncPresent) {
          ga.onHSync();
          // Plus DMA sound: each HSYNC, every enabled channel runs one
          // instruction (LOAD/PAUSE/REPEAT/LOOP/INT/STOP) — driving the AY for
          // sample playback without burning CPU time on tight timing loops.
          if (plusActive) asic!.dmaCycle();
          // Post-VSYNC interrupt re-sync on the 2nd HSYNC after VSYNC onset
          // (the onset line's own HSYNC is the 1st).
          if (this.vsyncResyncCountdown > 0 && --this.vsyncResyncCountdown === 0) {
            ga.onVSyncResync();
          }
        }
        this.fHsyncDone = true;
      }

      // Run the rest of the scanline, then advance the raster.
      if (this.runCpuUntil(lineEnd, plusActive, asic, skipAudio)) break;
      crtc.advanceLine();
      if (crtc.vsyncStart) this.vsyncResyncCountdown = 2;
      this.fHsyncT = -1;
      this.fHsyncDone = false;
    }

    if (this.fLine < totalLines) {
      // A stop: the frame stays open; the next call carries on in this line.
      this.midFrame = true;
      this.needsDisplay = true;
      return;
    }

    // Safety: once the tape is fully read, drop out of load-turbo even if the
    // program never polls Port B again (the cadence exit relies on such polls).
    if (this.tapeLoadingActive && (this.tape.finished || !this.tape.playing)) {
      this.tapeLoadingActive = false;
    }

    this.needsDisplay = true;
  }

  // ── Raster position (CRTC reads, .SNA v3 counters) ──────────────────────

  /** A frame is part-way through: running, or left open by a debugger stop. */
  get frameInProgress(): boolean { return this.frameOpen; }

  /** The CRTC's horizontal character counter at the CPU's current cycle: the
   *  character of the line in progress, 0 between frames. */
  crtcCharCounter(): number {
    if (!this.frameOpen || this.fLine >= this.fLines) return 0;
    const t = this.cpu.tStates - (this.frameStartT + this.fLine * this.fLineT);
    if (t <= 0) return 0;
    const chars = this.fLineT / CPC_T_PER_CHAR;
    const c = (t / CPC_T_PER_CHAR) | 0;
    return c < chars ? c : chars - 1;
  }

  /** Scanlines per character row within a field, as the CRTC counts them. */
  private crtcRowLines(): number {
    const r9 = this.crtc.regs[R_MAX_RASTER];
    return this.crtc.interlaceVideo ? (r9 >> 1) + 1 : r9 + 1;
  }

  /**
   * Resume the raster where a snapshot left the CRTC: `hcc` characters into
   * raster `ra` of row `vcc` — or, with `vtaDone` >= 0, that many lines into
   * the R5 vertical-total adjust — with `vsyncLeft` VSYNC lines still to run.
   * The frame in progress is rebuilt around that position (the lines above it
   * as if run on the current registers), so the next run carries on from the
   * same raster position and the 52-line interrupt keeps its phase. A position
   * at the very start of a frame simply leaves the next frame to start there.
   */
  resumeRaster(hcc: number, vcc: number, ra: number, vtaDone: number, vsyncLeft: number): void {
    const crtc = this.crtc;
    this.dropFrameInProgress();
    const vtaLeft = vtaDone >= 0 ? Math.max(1, crtc.regs[R_VERT_ADJUST] - vtaDone) : 0;
    crtc.restoreCounters(vcc, ra, vtaLeft, vsyncLeft);
    const rowLines = this.crtcRowLines();
    const line = vtaDone >= 0
      ? (crtc.regs[R_VERT_TOTAL] + 1) * rowLines + vtaDone
      : (vcc & 0x7F) * rowLines + (crtc.interlaceVideo ? (ra & 0x1F) >> 1 : ra & 0x1F);
    const lines = crtc.linesPerFrame();
    const chars = crtc.charsPerLine();
    if ((line === 0 && hcc === 0) || line >= lines || hcc >= chars) return;

    const lineT = chars * CPC_T_PER_CHAR;
    const now = this.cpu.tStates;
    this.frameStartT = now - line * lineT - hcc * CPC_T_PER_CHAR;
    this.frameEndT = this.frameStartT + lines * lineT;
    this.fLines = lines;
    this.fLineT = lineT;
    this.fDisplayTop = (CPC_SCREEN_HEIGHT - crtc.displayedLines()) >> 1;
    this.fPlusActive = this.config.isPlus && !(this.gateArray as Asic).locked;
    this.fLine = line;
    this.fHsyncT = this.frameStartT + line * lineT + crtc.hsyncEndChar() * CPC_T_PER_CHAR;
    // Past this line's HSYNC its drawing and Gate Array clock already happened
    // (the snapshot's Gate Array counters include it).
    this.fHsyncDone = now >= this.fHsyncT;
    this.gateArray.beginFrame(this._pixels32);
    this.midFrame = true;
  }

  /** T-state of the last audio mix step within the current frame. */
  private lastAudioT = 0;

  /**
   * Run the CPU until `until` T-states, servicing the Gate-Array/ASIC
   * interrupt, the CAS READ instant-load trap, and audio mixing. Returns true
   * if a stop (breakpoint, trap, beam target or watchpoint) ended the run.
   */
  private runCpuUntil(until: number, plusActive: boolean, asic: Asic | null, skipAudio: boolean): boolean {
    const ga = this.gateArray;
    while (this.cpu.tStates < until) {
      if (this.checkStops(this.cpu.pc)) return true;

      // CAS READ instant-load. A normal BASIC `RUN"` reaches the firmware's
      // CAS READ routine internally (CAS IN CHAR refilling its 2K buffer), not
      // through the &BCA1 jumpblock, so we trap the ROM routine itself, located
      // by signature scan. The request (A=sync, HL=dest, DE=len) is captured at
      // its entry; the firmware's own setup (sync stash, motor on, PPI) then
      // runs, and at the sync/record-read block the trap delivers the CRC-
      // checked block and resumes at the teardown. On any mismatch it declines
      // and the real routine pulse-loads the block. See cpc-tape-loader.ts.
      if (this.tapeFastRom) {
        if (this.casRead === undefined) this.casRead = scanCpcCasRead(this.memory.getLowerRom());
        const cr = this.casRead;
        if (cr !== null && this.memory.lowerRomAtZero) {
          const pc = this.cpu.pc;
          if (pc === cr.readEntry) {
            this.casReadReq = { dest: this.cpu.hl, len: this.cpu.de, sync: this.cpu.a & 0xFF };
          } else if (pc === cr.common && this.casReadReq !== null) {
            const req = this.casReadReq;
            this.casReadReq = null;
            if (this.cpu.hl === cr.storeByte && this.tape.loaded && this.tape.hasRomBlock()) {
              if (this.tape.paused) { this.tape.paused = false; this.tape.startPlayback(); }
              if (trapCpcCasRead(this, req, cr.tail)) this.activity.tapeReads++;  // instant load → TAPE LED
            }
          }
        }
      }

      // EI suppresses interrupts for one instruction; step() itself resets
      // and re-arms eiDelay per-instruction (see core.ts), so a plain
      // post-step check is enough here.
      this.beforeInsn(this.cpu.pc);
      this.cpu.step();
      const stopped = this.afterInsn();

      if (ga.interruptRequested && this.cpu.iff1 && !this.cpu.eiDelay) {
        // Plus IM 2: the ASIC supplies a vector byte encoding the interrupt
        // source (raster > DMA2 > DMA1 > DMA0). Non-Plus / non-IM-2 paths
        // fall through to the plain INT ack (RST 38h on IM 1). The ack is
        // held by the Gate Array's /WAIT like any bus cycle (IM 1 = 5µs, or
        // 4µs straight after an instruction ending in internal cycles).
        const t = cpcAcknowledgeInterrupt(this.cpu,
          (plusActive && this.cpu.im === 2) ? asic!.consumeInterruptVector() : -1);
        if (t > 0) ga.acknowledgeInterrupt();
      }

      if (!skipAudio) {
        const elapsed = this.cpu.tStates - this.lastAudioT;
        if (elapsed > 0) {
          this.mixer.accumulate(0, elapsed);
          this.mixer.generateSamples(this.audio, this.ay, true);
          this.lastAudioT = this.cpu.tStates;
        }
      }
      // Stop on the instruction that tripped a watchpoint, with the frame
      // open, after the interrupt check so a resume takes a pending one where
      // a run would.
      if (stopped) return true;
    }
    return false;
  }

  // ── Machine: debug helpers ───────────────────────────────────────────

  /** Resolve a Memory-pane ROM region id (declared in the descriptor) to a live
   *  ROM view: the lower (OS) ROM at 0x0000, and the upper BASIC/AMSDOS ROMs
   *  where they overlay at 0xC000. */
  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    if (value === 'cpcRomLower') return { data: this.memory.getLowerRom(), baseAddr: 0x0000 };
    if (value === 'cpcRomBasic') { const d = this.memory.getUpperRom(0); return d ? { data: d, baseAddr: 0xC000 } : null; }
    if (value === 'cpcRomAmsdos') { const d = this.memory.getUpperRom(7); return d ? { data: d, baseAddr: 0xC000 } : null; }
    // Plus models (descriptor.ts) label their ROM slots as cartridge pages: page
    // 0 is the lower/OS ROM, page 1 backs BASIC and page 3 backs AMSDOS at 0xC000.
    if (value === 'cpcCartLower') return { data: this.memory.getLowerRom(), baseAddr: 0x0000 };
    if (value === 'cpcCartBasic') { const d = this.memory.getUpperRom(1); return d ? { data: d, baseAddr: 0xC000 } : null; }
    if (value === 'cpcCartAmsdos') { const d = this.memory.getUpperRom(3); return d ? { data: d, baseAddr: 0xC000 } : null; }
    return null;
  }

  disasmAt(pc: number): DisasmLine {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 8; i++) buf[i] = this.memory.readByte((pc + i) & 0xFFFF);
    return { ...disasmOne(buf, 0), addr: pc };
  }

  /** Execution trace: BaseMachine's startTrace/stopTrace drive it and
   *  beforeInsn/afterInsn feed it (debug/z80/trace.ts). */
  protected override tracer = new Z80Trace(this);

  // ── Screen OCR / TEXT overlay ────────────────────────────────────────

  /** Snapshot the display parameters OCR needs from the current machine state.
   *  R1/R6 are clamped to sane defaults while the firmware is still booting. */
  private ocrInput(): CpcOcrInput {
    const hReg = this.crtc.regs[R_HORIZ_DISPLAYED];
    const rReg = this.crtc.regs[R_VERT_DISPLAYED];
    return {
      readVideo: (addr: number) => this.memory.readVideo(addr),
      mode: this.gateArray.mode,
      dispStart: this.crtc.displayStart,
      hDisplayed: hReg >= 1 && hReg <= 64 ? hReg : 40,
      rows: rReg >= 1 && rReg <= 50 ? rReg : 25,
      font: this.memory.getLowerRom().subarray(CPC_FONT_OFFSET, CPC_FONT_OFFSET + 2048),
    };
  }

  /** Styled OCR (text + coloured HTML + match mask) for the TEXT overlay. */
  ocrScreenStyled(): OcrResult {
    return this.screenText.ocrStyled(this.ocrInput(), this.gateArray.pens, this.gateArray.palette);
  }

  /**
   * Blank the matched character cells in the framebuffer so the crisp overlay
   * glyphs replace the underlying bitmap. `mask` is row-major `cols×rows`. The
   * active area is 640 buffer pixels wide (16 per CRTC char) at CPC_BORDER_LEFT
   * / CPC_BORDER_TOP; each text column is `8 × bytesPerCol` buffer pixels and
   * each character row is 8 buffer rows (vertical is 1:1).
   */
  blankCells(mask: boolean[], cols: number, rows: number, paper?: number[]): void {
    if (cols <= 0 || rows <= 0) return;
    const mode = this.gateArray.mode;
    const cellW = 8 * (mode === 0 ? 4 : mode === 1 ? 2 : 1);
    const cellH = 8;
    const pens = this.gateArray.pens;
    for (let row = 0; row < rows; row++) {
      const y0 = CPC_BORDER_TOP + row * cellH;
      if (y0 + cellH > CPC_SCREEN_HEIGHT) break;
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        if (!mask[idx]) continue;
        const x0 = CPC_BORDER_LEFT + col * cellW;
        if (x0 + cellW > CPC_SCREEN_WIDTH) continue;
        // Fill each cell with its own paper colour (PAPER is rarely pen 0).
        const fill = this.gateArray.palette[pens[(paper ? paper[idx] : 0) & 0x0F] & 0x1F];
        for (let y = 0; y < cellH; y++) {
          const base = (y0 + y) * CPC_SCREEN_WIDTH + x0;
          this._pixels32.fill(fill, base, base + cellW);
        }
      }
    }
  }

  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    // The grid is fixed by screen mode on the CPC, so `mode` is advisory only.
    const input = this.ocrInput();
    return `[${cpcGrid(input.mode)}]\n${this.screenText.ocr(input)}`;
  }
}
