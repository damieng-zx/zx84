/**
 * Memotech MTX500/512 and RS128 motherboard.
 *
 * Reuses the commodity Z80A, TMS9929A, Z80 CTC and SN76489A cores. This first
 * base-machine implementation covers ROM BASIC operation, banked memory,
 * keyboard scanning, VDP video, CTC interrupts, PSG audio and logical `.mtx`
 * cassette loading, the FDX/SDX-compatible floppy expansion, and the optional
 * FDX 80-column display. Printer and DART/RS-232 behavior is not emulated;
 * the DART was optional on the MTX models and standard on the RS128.
 * Snapshots are zx84's own `.mtxstate` (snapshots/mtx-state.ts).
 */

import { Z80 } from '@/cores/z80.ts';
import { Sn76489, type Sn76489AntialiasMode, type Sn76489StereoMode } from '@/cores/sn76489.ts';
import { Tms9918a, MSX_PALETTES } from '@/cores/tms9918a.ts';
import { Z80Ctc } from '@/cores/z80-ctc.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { resolveDriveCount } from '@/machines/shared/drive-count.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { crc32, type StateReader, type StateWriter } from '@/machines/shared/state-io.ts';
import { withStopsDisarmed } from '@/machines/shared/native-state.ts';
import { readDskImage, writeDskImage } from '@/media/floppy/disk-state.ts';
import { z80ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { Z80Trace } from '@/debug/z80/trace.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import { Tms9918ScreenText, tms9918TextGrid } from '@/ocr/tms9918.ts';
import type { OcrGridName, OcrResult } from '@/ocr/ocr.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind,
  SettingsView,
} from '@/machines/machine.ts';
import type { MtxModel } from './models.ts';
import { MtxMemory } from './mtx-memory.ts';
import { MtxKeyboard } from './mtx-keyboard.ts';
import { MtxFdx } from './peripherals/fdx.ts';
import {
  Mtx80ColumnCard, MTX_80_COLUMN_HEIGHT, MTX_80_COLUMN_WIDTH,
} from './peripherals/fdx-80-column.ts';
import { installMtxMemoryHooks, wireMtxPortIO } from './mtx-io.ts';
import { mtxDescriptor } from './descriptor.ts';
import { createMtxServices, type MtxServices } from './services/index.ts';
import {
  MtxCassette, MtxTapeRecorder, MTX_FIRST_HEADER_ADDRESS, MTX_FIRST_HEADER_LENGTH,
  MTX_TAPE_EPILOGUE, MTX_TAPE_FAILURE, MTX_TAPE_RETURN, MTX_TAPE_ROUTINE,
} from './mtx-tape.ts';
import {
  MTX_ACTIVE_LINES, MTX_BORDER_LEFT, MTX_BORDER_TOP, MTX_CPU_CLOCK, MTX_MAX_DRIVES,
  MTX_LINES_PER_FRAME, MTX_SCREEN_HEIGHT, MTX_SCREEN_WIDTH,
  MTX_TSTATES_PER_FRAME,
} from './constants.ts';

export class MtxMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'mtx';
  readonly model: MtxModel;
  host: MachineHost | null = null;
  readonly services: MtxServices;

  readonly cpu = new Z80();
  readonly memory: MtxMemory;
  readonly vdp = new Tms9918a();
  readonly ctc = new Z80Ctc();
  readonly keyboard = new MtxKeyboard();
  readonly fdx = new MtxFdx();
  readonly fdc = this.fdx.fdc;
  readonly column80 = new Mtx80ColumnCard();
  readonly psg = new Sn76489(MTX_CPU_CLOCK, 48_000, 'mtx');
  readonly screenText = new Tms9918ScreenText();
  readonly mixer = new AudioMixer(MTX_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  /** Last byte written to the physical cassette output port. */
  tapeOutput = 0;
  /** Port 6's sound latch: OUT (6) only fills it; a read of port 3 strobes
   *  it into the SN76489 (the SN76489 is not on the data bus, so the board latches the byte first). */
  soundLatch = 0;
  /** The VDP /INT line as last sampled (true = asserted). CTC channel 0
   *  counts its falling edges, not frames. */
  private vdpIntAsserted = false;
  /** Logical `.mtx` stream served through the ROM tape routine. */
  readonly cassette = new MtxCassette();
  /** What the ROM tape routine was asked to SAVE since the last reset. */
  readonly tapeRecorder = new MtxTapeRecorder();
  readonly activity = { kbdReads: 0, psgWrites: 0, casReads: 0, fdcAccesses: 0 };
  cpmSystemEnabled = false;
  /** FDX floppy subsystem fitted (drives B:/C: + FDX Disk BASIC ROM). */
  floppyEnabled = true;
  /** How many of the FDX's two drives are fitted (Drives pane choice). */
  driveCount = MTX_MAX_DRIVES;

  private readonly vdpPixels = new Uint8Array(MTX_SCREEN_WIDTH * MTX_SCREEN_HEIGHT * 4);
  private readonly vdpPixels32 = new Uint32Array(this.vdpPixels.buffer);
  private borderMode: BorderMode = 1;
  private column80Requested = false;
  private floppyRequested = true;
  get pixels(): Uint8Array {
    return this.column80.enabled ? this.column80.pixels : this.vdpPixels;
  }

  protected get audioChip(): Sn76489 { return this.psg; }
  get descriptor(): MachineDescriptor { return mtxDescriptor(this.model); }
  get frameWidth(): number {
    return this.column80.enabled ? MTX_80_COLUMN_WIDTH : MTX_SCREEN_WIDTH;
  }
  get frameHeight(): number {
    return this.column80.enabled ? MTX_80_COLUMN_HEIGHT : MTX_SCREEN_HEIGHT;
  }
  get tStatesPerFrame(): number { return MTX_TSTATES_PER_FRAME; }
  get cpuClockHz(): number { return MTX_CPU_CLOCK; }

  constructor(model: MtxModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.memory = new MtxMemory(model);
    this.display = display ?? null;
    // The CTC is the only daisy-chain device: RETI clears its IUS latch.
    this.cpu.onReti = () => this.ctc.reti();
    this.cpu.onInterrupt = (handler, nmi) => this.noteInterrupt(handler, nmi);

    this.mixer.beeperGain = 0;
    this.mixer.psgGain = 1;
    installMtxMemoryHooks(this);
    wireMtxPortIO(this);
    this.services = createMtxServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  loadROM(data: Uint8Array): void {
    this.memory.loadRom(data);
    this.setStatus(`MTX firmware loaded (${Math.min(data.length, 0xA000)} bytes)`);
  }

  loadDisk(image: DskImage, unit = 0): void {
    this.fdc.insertDisk(image, unit);
  }

  screenExportBytes(): Uint8Array { return this.vdp.vram.slice(); }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    const ramKib = this.memory.ramSizeBytes / 1024;
    return {
      data: this.memory.ramSnapshot(),
      filename: `${this.model}-ram-${ramKib}k.bin`,
    };
  }

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    if (value === 'rom-os') return { data: this.memory.osRom, baseAddr: 0x0000 };
    if (value === 'rom-basic') return { data: this.memory.romPages[0], baseAddr: 0x2000 };
    if (value === 'rom-assem') return { data: this.memory.romPages[1], baseAddr: 0x2000 };
    if (value === 'rom-cpm') return { data: this.memory.romPages[4], baseAddr: 0x2000 };
    if (value === 'rom-fdx') return { data: this.memory.romPages[5], baseAddr: 0x2000 };
    return null;
  }

  applySettings(view: SettingsView): void {
    this.vdp.palette =
      MSX_PALETTES[view.get('msx-color-map', 'pal') as keyof typeof MSX_PALETTES];
    this.audio.setVolume(view.get('volume', 70) / 100);
    // Reuses the Sound panel's shared Filter dropdown — the MTX carries an
    // SN76489 instead of the AY-family PSG the setting is named after, but
    // the anti-alias strategies (see Sn76489AntialiasMode) are equivalent.
    this.psg.antialias = view.get<Sn76489AntialiasMode>('ay-antialias', 'mute');
    this.psg.setStereoMode(view.get<Sn76489StereoMode>('sn-stereo', 'MONO'));
    this.column80Requested = view.get('mtx-80-column', false);
    this.floppyRequested = view.get('mtx-floppy', true);
    this.set512kRamEnabled(view.get('mtx-512k-ram', false));
    this.setCpmSystemEnabled(view.get('mtx-cpm', false));
  }

  prepare(view: SettingsView): [] {
    this.fdc.writeProtect[0] = view.get('write-protect-a', false);
    this.fdc.writeProtect[1] = view.get('write-protect-b', false);
    this.driveCount = resolveDriveCount(view, 'mtx', MTX_MAX_DRIVES);
    for (let u = 0; u < this.fdc.connected.length; u++) this.fdc.connected[u] = u < this.driveCount;
    this.column80Requested = view.get('mtx-80-column', false);
    this.floppyRequested = view.get('mtx-floppy', true);
    this.set512kRamEnabled(view.get('mtx-512k-ram', false));
    this.setCpmSystemEnabled(view.get('mtx-cpm', false));
    return [];
  }

  setBorderSize(mode: BorderMode): void {
    this.borderMode = mode;
    if (this.column80.enabled) {
      this.display?.setViewport(0, 0, MTX_80_COLUMN_WIDTH, MTX_80_COLUMN_HEIGHT);
      return;
    }
    const fraction = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(MTX_BORDER_LEFT * (1 - fraction));
    const cropY = Math.round(MTX_BORDER_TOP * (1 - fraction));
    this.display?.setViewport(
      cropX,
      cropY,
      MTX_SCREEN_WIDTH - cropX * 2,
      MTX_SCREEN_HEIGHT - cropY * 2,
    );
  }

  set80ColumnEnabled(enabled: boolean): void {
    if (this.column80.enabled === enabled) return;
    this.column80.enabled = enabled;
    this.display?.resize(this.frameWidth, this.frameHeight);
    this.setBorderSize(this.borderMode);
    if (enabled) this.column80.renderFrame();
    this.needsDisplay = true;
    this.setStatus(`80-column display ${enabled ? 'enabled' : 'disabled'}`);
  }

  setCpmSystemEnabled(enabled: boolean): void {
    this.cpmSystemEnabled = enabled;
    this.memory.setCpmBootstrapEnabled(enabled);
    this.set80ColumnEnabled(enabled || this.column80Requested);
    // CP/M boots from a floppy, so it force-fits the FDX subsystem.
    this.setFloppyEnabled(enabled || this.floppyRequested);
    this.setStatus(`CP/M system ${enabled ? 'enabled' : 'disabled'}`);
  }

  /** Fit or remove the FDX floppy subsystem — drives B:/C: and the FDX Disk
   *  BASIC ROM. CP/M force-fits it (see setCpmSystemEnabled). */
  setFloppyEnabled(enabled: boolean): void {
    if (!enabled && this.floppyEnabled) {
      this.fdc.ejectDisk(0);
      this.fdc.ejectDisk(1);
    }
    this.floppyEnabled = enabled;
    this.memory.setFdxRomEnabled(enabled);
  }

  set512kRamEnabled(enabled: boolean): void {
    this.memory.set512kRamExpansionEnabled(enabled);
    this.services.disks.configureCpmRamDiskStartup(enabled);
    const ramKib = this.memory.ramSizeBytes / 1024;
    this.setStatus(`512 KiB RAM expansion ${enabled ? 'enabled' : 'disabled'} (${ramKib} KiB total)`);
  }

  /**
   * Re-sample the VDP's /INT output, a level (F AND IE) wired to CTC channel
   * 0's CLK/TRG: only its assertion is an edge. Called wherever F or IE can
   * change — the frame flag, a status read (clears F), a control write (IE).
   * While F stays set because nobody read the status, later frames make no
   * new edge; setting IE with F already pending makes one.
   */
  sampleVdpInt(): void {
    const asserted = this.vdp.interruptPending();
    if (asserted && !this.vdpIntAsserted) this.ctc.trigger(0);
    this.vdpIntAsserted = asserted;
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.memory.reset();
    this.vdp.reset();
    this.ctc.reset();
    this.keyboard.reset();
    this.fdx.reset();
    this.column80.reset();
    this.psg.reset();
    this.audio.reset();
    this.mixer.reset();
    this.tapeOutput = 0;
    this.tapeRecorder.reset();
    this.soundLatch = 0;
    this.vdpIntAsserted = false;
    this.resetFrameCount();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  /**
   * Serve one ROM tape request from the logical cassette.
   *
   * MEMU's established `.mtx` convention patches the routine at 0AAE with a
   * host trap followed by RET at 0AB0. We leave ROM immutable and intercept the
   * same entry point. LOAD and VERIFY (FD68 != 0) are served from the mounted
   * image. SAVE (FD68 = 0) is completed instantly into `tapeRecorder` (the Save
   * menu's .mtx): the real routine times its bits with CTC channel 1 counting
   * an external clock, which is not modelled, so left to itself it would wait
   * forever for the first bit-cell interrupt.
   */
  trapCassetteRoutine(): boolean {
    if (this.cpu.pc !== MTX_TAPE_ROUTINE || this.memory.ramMode) return false;
    if (this.memory.readByte(0xFD68) === 0) return this.trapCassetteSave();
    if (!this.cassette.loaded) return false;

    const base = this.cpu.hl;
    const length = this.cpu.de;
    if (base === MTX_FIRST_HEADER_ADDRESS && length === MTX_FIRST_HEADER_LENGTH) {
      this.cassette.rewind();
    }

    let ok = true;
    if (this.memory.readByte(0xFD67) !== 0) {
      ok = this.cassette.verifyChunk(this.memory.readBlock(base, length)) === true;
    } else {
      const chunk = this.cassette.readChunk(length);
      if (!chunk) {
        ok = false;
      } else {
        for (let i = 0; i < chunk.length; i++) {
          this.memory.writeByte((base + i) & 0xFFFF, chunk[i]);
        }
      }
    }

    this.activity.casReads++;
    if (ok) {
      // Leave the registers as the real routine's last `DEC DE / LD A,D /
      // OR E` does: HL past the block, DE zero, Z set. 0AB0 is `RET Z` in the
      // unpatched ROM, so without Z the CPU falls into the hardware routine
      // and waits forever for a tape edge.
      this.cpu.hl = (base + length) & 0xFFFF;
      this.cpu.de = 0;
      this.cpu.a = 0;
      this.cpu.f = 0x44;
    }
    this.cpu.pc = ok ? MTX_TAPE_RETURN : MTX_TAPE_FAILURE;
    // Account for the two-byte host-trap opcode used by the reference patch.
    this.cpu.tStates += 8;

    // The bypassed ROM routine stops all CTC channels, acknowledges the VDP
    // interrupt, then restores channel 0 as the frame-interrupt counter.
    this.ctc.write(0, 0xF0);
    this.ctc.write(0, 0x03);
    this.ctc.write(1, 0x03);
    this.ctc.write(2, 0x03);
    this.ctc.write(3, 0x03);
    this.vdp.readStatus();
    this.ctc.write(0, 0xA5);
    this.ctc.write(0, 0x7D);
    return true;
  }

  /**
   * Complete one SAVE request: copy the HL/DE block into the recorder, then
   * leave the routine the way it leaves after its last byte — HL past the
   * block, DE zero, Z set by its final `LD A,D / OR E` — through its own
   * epilogue at 0B06, which resets the CTC, restores the frame interrupt and
   * returns to the caller. A zero-length request is the routine's own early
   * RET, so it is left to the ROM.
   */
  private trapCassetteSave(): boolean {
    const base = this.cpu.hl;
    const length = this.cpu.de;
    if (length === 0) return false;
    const sp = this.cpu.sp;
    const caller = this.memory.readByte(sp) | (this.memory.readByte((sp + 1) & 0xFFFF) << 8);
    this.tapeRecorder.record(caller, this.memory.readBlock(base, length));
    this.activity.casReads++;
    this.cpu.hl = (base + length) & 0xFFFF;
    this.cpu.de = 0;
    this.cpu.a = 0;
    this.cpu.f = 0x44;              // Z and P/V, as OR E leaves them with A = 0
    this.cpu.pc = MTX_TAPE_EPILOGUE;
    return true;
  }

  protected framePixels(): Uint8Array { return this.pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  // ── Beam ───────────────────────────────────────────────────────────────

  /** The next line of the frame in progress to run (it carries over a stop). */
  private fLine = 0;

  /** Frame line 0 is the VDP's first active line; its frame flag (to CTC
   *  channel 0) comes at the end of line 192. Each line is drawn when the CPU
   *  reaches its end. */
  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: MTX_TSTATES_PER_FRAME / MTX_LINES_PER_FRAME,
      linesPerFrame: MTX_LINES_PER_FRAME,
      displayStart: 0,
      note: 'line 0 is the first active line of the VDP; the 4MHz PAL field is split evenly over 313 lines, so a line is a fractional ~255.6 cycles; each line is drawn whole when the CPU reaches its end, so a VDP write shows from the line it is made in; the frame flag rises at the end of line 192 and reaches /INT through CTC channel 0; the 80-column card\'s picture is drawn once at the end of the frame',
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  protected override interruptedPc(): number { return z80ReturnAddress(this.cpu.sp, a => this.memory.readByte(a)); }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    // A frame a stop left part-way carries on from the line it was in.
    if (!this.openFrame(MTX_TSTATES_PER_FRAME)) {
      this.activity.kbdReads = 0;
      this.activity.psgWrites = 0;
      this.activity.casReads = 0;
      this.activity.fdcAccesses = 0;
      this.vdpPixels32.fill(this.vdp.backdrop());
      this.fLine = 0;
    }
    this.portWatchHit = null;
    this.memWatchHit = null;

    const tPerLine = MTX_TSTATES_PER_FRAME / MTX_LINES_PER_FRAME;
    let lastCtcT = this.cpu.tStates;
    let lastAudioT = this.cpu.tStates;

    for (; this.fLine < MTX_LINES_PER_FRAME; this.fLine++) {
      const line = this.fLine;
      const lineEnd = this.frameStartT + (line + 1) * tPerLine;
      while (this.cpu.tStates < lineEnd) {
        if (this.checkStops(this.cpu.pc)) {
          // The frame stays open; the next call carries on in this line.
          this.midFrame = true;
          this.needsDisplay = true;
          return;
        }
        if (this.trapCassetteRoutine()) continue;

        // EI suppresses interrupts for one instruction; step() itself resets
        // and re-arms eiDelay per-instruction (see core.ts), so a plain
        // post-step check is enough here.
        this.beforeInsn(this.cpu.pc);
        this.cpu.step();
        const stopped = this.afterInsn();

        const elapsed = this.cpu.tStates - lastCtcT;
        if (elapsed > 0) {
          this.ctc.addCycles(elapsed);
          lastCtcT = this.cpu.tStates;
        }

        if (this.ctc.interruptPending && this.cpu.iff1 && !this.cpu.eiDelay) {
          const vector = this.ctc.pendingVector();
          if (vector >= 0 && this.cpu.interruptWithVector(vector) > 0) this.ctc.acknowledge();
        }

        if (!skipAudio) {
          const audioElapsed = this.cpu.tStates - lastAudioT;
          if (audioElapsed > 0) {
            this.mixer.accumulate(0, audioElapsed);
            this.mixer.generateSamples(this.audio, this.psg, true);
            lastAudioT = this.cpu.tStates;
          }
        }

        // Stop on the instruction that tripped a watchpoint, once its cycles
        // have reached the CTC, with the frame open.
        if (stopped) {
          this.midFrame = true;
          this.needsDisplay = true;
          return;
        }
      }

      if (line < MTX_ACTIVE_LINES) {
        const rowStart = (MTX_BORDER_TOP + line) * MTX_SCREEN_WIDTH + MTX_BORDER_LEFT;
        this.vdp.renderScanline(this.vdpPixels32, rowStart, line);
      } else if (line === MTX_ACTIVE_LINES) {
        // VDP INT is wired to CTC channel 0's trigger, not directly to /INT.
        this.vdp.raiseFrameInterrupt();
        this.sampleVdpInt();
      }
    }

    if (this.column80.enabled) this.column80.renderFrame();
    this.fdx.tickFrame();
    this.needsDisplay = true;
  }

  /** Execution trace: BaseMachine's startTrace/stopTrace drive it and
   *  beforeInsn/afterInsn feed it (debug/z80/trace.ts). */
  protected override tracer = new Z80Trace(this);

  // ── Snapshot state (.mtxstate) ─────────────────────────────────────────

  /** CRC-32s of the five firmware ROMs (OS, BASIC, ASSEM, CP/M, FDX). */
  stateRomCrcs(): number[] {
    const mem = this.memory;
    return [mem.osRom, mem.romPages[0], mem.romPages[1], mem.romPages[4], mem.romPages[5]].map(crc32);
  }

  /** Run the rest of a frame a stop left open, so the machine is between
   *  frames (where a snapshot is taken). */
  private completeFrame(): void {
    if (this.midFrame) withStopsDisarmed(this, () => this.stepFrame());
  }

  /** The fitted hardware a state depends on, in CONF order. */
  private stateConfig(): number[] {
    return [
      this.memory.ramExpansion512kEnabled ? 1 : 0,
      this.cpmSystemEnabled ? 1 : 0,
      this.floppyEnabled ? 1 : 0,
      this.column80.enabled ? 1 : 0,
      this.driveCount,
    ];
  }

  /**
   * Write the machine's sections of a `.mtxstate` (see snapshots/mtx-state.ts).
   * The disks always travel with the state, even the refresh copy: the shell
   * does not persist MTX disks across a reload, and a CP/M session without
   * its disk cannot carry on.
   */
  saveState(w: StateWriter, _withMedia: boolean): void {
    this.completeFrame();
    w.section('CONF', () => { for (const v of this.stateConfig()) w.u8(v); });
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameStartT); w.f64(this.frameEndT); w.f64(this.frameNumber);
      w.u8(this.tapeOutput); w.u8(this.soundLatch); w.bool(this.vdpIntAsserted);
      w.u8(this.keyboard.driveLatch);
    });
    w.section('MEM ', () => {
      this.memory.saveState(w);
      w.str(this.services.roms.cartridge.name);
    });
    w.section('VDP ', () => this.vdp.saveState(w));
    w.section('PSG ', () => this.psg.saveState(w));
    w.section('CTC ', () => this.ctc.saveState(w));
    w.section('80CO', () => this.column80.saveState(w));
    w.section('MEDA', () => {
      for (const id of ['a', 'b']) {
        const image = this.fdc.getDiskImage(id === 'b' ? 1 : 0);
        w.bool(image !== null);
        if (!image) continue;
        writeDskImage(w, image);
        const name = this.services.disks.nameOf(id);
        w.bool(name !== undefined);
        if (name !== undefined) w.str(name);
      }
    });
    w.section('FDX ', () => this.fdx.saveState(w));
  }

  /** Restore a state written by {@link saveState}. The frame loop must be
   *  stopped. Throws before changing anything if the fitted hardware differs. */
  loadState(r: StateReader): void {
    const conf = r.section('CONF');
    const saved = this.stateConfig().map(() => conf.u8());
    const live = this.stateConfig();
    const names = ['the 512 KiB RAM expansion', 'the CP/M system', 'the FDX floppy subsystem', 'the 80-column card'];
    for (let i = 0; i < names.length; i++) {
      if (saved[i] !== live[i]) {
        throw new Error(`This snapshot was saved ${saved[i] ? 'with' : 'without'} ${names[i]}; ${saved[i] ? 'fit' : 'remove'} it in the Hardware pane and load it again`);
      }
    }
    if (saved[4] !== live[4]) {
      throw new Error(`This snapshot was saved with ${saved[4]} drive${saved[4] === 1 ? '' : 's'} fitted and this MTX has ${live[4]}; change it in the Drives pane and load it again`);
    }

    this.cpu.loadState(r.section('CPU '));
    {
      const s = r.section('MACH');
      this.frameStartT = s.f64(); this.frameEndT = s.f64(); this.frameNumber = s.f64();
      this.tapeOutput = s.u8(); this.soundLatch = s.u8(); this.vdpIntAsserted = s.bool();
      this.keyboard.reset();
      this.keyboard.selectDrive(s.u8());
    }
    {
      const s = r.section('MEM ');
      this.memory.loadState(s);
      this.services.roms.restoreRomPackName(s.str());
    }
    this.vdp.loadState(r.section('VDP '));
    this.psg.loadState(r.section('PSG '));
    this.ctc.loadState(r.section('CTC '));
    this.column80.loadState(r.section('80CO'));
    {
      const s = r.section('MEDA');
      for (const id of ['a', 'b']) {
        if (!s.bool()) { this.services.disks.restore(id, null, undefined); continue; }
        const image = readDskImage(s);
        const name = s.bool() ? s.str() : undefined;
        this.services.disks.restore(id, image, name);
      }
    }
    this.fdx.loadState(r.section('FDX '));

    // What the state does not hold: the host's keys are whatever they are
    // now, and nothing is part-way through a frame.
    this.midFrame = false;
    this.clearInterrupts();
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
  }

  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    if (this.column80.enabled) return this.column80.text();
    return this.screenText.ocr(this.vdp.vram, this.vdp.regs, this.vdp.mode());
  }

  /** Styled OCR (text + coloured HTML + match mask) for the TEXT overlay. */
  ocrScreenStyled(): OcrResult {
    return this.screenText.ocrStyled(this.vdp.vram, this.vdp.regs, this.vdp.mode(), this.vdp.palette);
  }

  /**
   * Blank the matched VDP character cells to their paper colour so the crisp
   * overlay glyphs replace the underlying bitmap. `mask` is row-major
   * `cols×rows`; cell width/x-origin follow the current VDP mode (same TMS9918
   * geometry as the MSX).
   */
  blankCells(mask: boolean[], cols: number, rows: number, paper?: number[]): void {
    const g = tms9918TextGrid(this.vdp.mode());
    if (!g) return;
    const cellW = g.cellWidth, cellH = 8;
    const pal = this.vdp.palette;
    for (let row = 0; row < rows; row++) {
      const y0 = MTX_BORDER_TOP + row * cellH;
      if (y0 + cellH > MTX_SCREEN_HEIGHT) break;
      for (let col = 0; col < cols; col++) {
        if (!mask[row * cols + col]) continue;
        const x0 = MTX_BORDER_LEFT + (g.xOffset ?? 0) + col * cellW;
        if (x0 + cellW > MTX_SCREEN_WIDTH) continue;
        const fill = pal[(paper ? paper[row * cols + col] : 0) & 0x0F];
        for (let y = 0; y < cellH; y++) {
          const b = (y0 + y) * MTX_SCREEN_WIDTH + x0;
          this.vdpPixels32.fill(fill, b, b + cellW);
        }
      }
    }
  }
}
