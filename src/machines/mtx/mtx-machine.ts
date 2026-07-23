/**
 * Memotech MTX500/512 motherboard.
 *
 * Reuses the commodity Z80A, TMS9929A, Z80 CTC and SN76489A cores. This first
 * base-machine implementation covers ROM BASIC operation, banked memory,
 * keyboard scanning, VDP video, CTC interrupts, PSG audio and logical `.mtx`
 * cassette loading, the FDX/SDX-compatible floppy expansion, and the optional
 * FDX 80-column display. Printer and DART hardware remain unfitted.
 */

import { Z80 } from '@/cores/z80.ts';
import { Sn76489 } from '@/cores/sn76489.ts';
import { Tms9918a, MSX_PALETTES } from '@/cores/tms9918a.ts';
import { Z80Ctc } from '@/cores/z80-ctc.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import { Tms9918ScreenText } from '@/ocr/tms9918.ts';
import type { OcrGridName } from '@/ocr/ocr.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind,
  MachineTraceMode, SettingsView,
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
  MtxCassette, MTX_FIRST_HEADER_ADDRESS, MTX_FIRST_HEADER_LENGTH,
  MTX_TAPE_FAILURE, MTX_TAPE_RETURN, MTX_TAPE_ROUTINE,
} from './mtx-tape.ts';
import {
  MTX_ACTIVE_LINES, MTX_BORDER_LEFT, MTX_BORDER_TOP, MTX_CPU_CLOCK,
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
  /** Logical `.mtx` stream served through the ROM tape routine. */
  readonly cassette = new MtxCassette();
  readonly activity = { kbdReads: 0, psgWrites: 0, casReads: 0, fdcAccesses: 0 };
  cpmSystemEnabled = false;

  private readonly vdpPixels = new Uint8Array(MTX_SCREEN_WIDTH * MTX_SCREEN_HEIGHT * 4);
  private readonly vdpPixels32 = new Uint32Array(this.vdpPixels.buffer);
  private borderMode: BorderMode = 1;
  private column80Requested = false;
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
    return {
      data: this.memory.ramSnapshot(),
      filename: this.model === 'mtx500' ? 'mtx500-ram-32k.bin' : 'mtx512-ram-64k.bin',
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
    this.column80Requested = view.get('mtx-80-column', false);
    this.setCpmSystemEnabled(view.get('mtx-cpm', false));
  }

  prepare(view: SettingsView): [] {
    this.fdc.writeProtect[0] = view.get('write-protect-a', false);
    this.fdc.writeProtect[1] = view.get('write-protect-b', false);
    this.column80Requested = view.get('mtx-80-column', false);
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
    this.set80ColumnEnabled(enabled || this.column80Requested);
    this.setStatus(`CP/M system ${enabled ? 'enabled' : 'disabled'}`);
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
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  /**
   * Serve one ROM LOAD/VERIFY request from the mounted logical cassette.
   *
   * MEMU's established `.mtx` convention patches the routine at 0AAE with a
   * host trap followed by RET at 0AB0. We leave ROM immutable and intercept the
   * same entry point. SAVE (FD68=0) falls through to the real hardware routine;
   * this fast path only claims LOAD and VERIFY.
   */
  trapCassetteRoutine(): boolean {
    if (
      !this.cassette.loaded ||
      this.memory.ramMode ||
      this.cpu.pc !== MTX_TAPE_ROUTINE ||
      this.memory.readByte(0xFD68) === 0
    ) return false;

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

  protected framePixels(): Uint8Array { return this.pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    this.activity.kbdReads = 0;
    this.activity.psgWrites = 0;
    this.activity.casReads = 0;
    this.activity.fdcAccesses = 0;
    this.vdpPixels32.fill(this.vdp.backdrop());

    const tPerLine = MTX_TSTATES_PER_FRAME / MTX_LINES_PER_FRAME;
    let lineEnd = this.cpu.tStates;
    let lastCtcT = this.cpu.tStates;
    let lastAudioT = this.cpu.tStates;
    let broke = false;

    for (let line = 0; line < MTX_LINES_PER_FRAME; line++) {
      lineEnd += tPerLine;
      while (this.cpu.tStates < lineEnd) {
        if (this.breakpoints.has(this.cpu.pc)) {
          this.breakpointHit = this.cpu.pc;
          broke = true;
          break;
        }
        if (this.onTrap !== null && this.onTrap(this.cpu.pc)) {
          broke = true;
          break;
        }
        if (this.trapCassetteRoutine()) continue;

        const eiBefore = this.cpu.eiDelay;
        this.cpu.step();
        if (eiBefore) this.cpu.eiDelay = false;

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
      }
      if (broke) break;

      if (line < MTX_ACTIVE_LINES) {
        const rowStart = (MTX_BORDER_TOP + line) * MTX_SCREEN_WIDTH + MTX_BORDER_LEFT;
        this.vdp.renderScanline(this.vdpPixels32, rowStart, line);
      } else if (line === MTX_ACTIVE_LINES) {
        // VDP INT is wired to CTC channel 0's trigger, not directly to /INT.
        this.vdp.raiseFrameInterrupt();
        if (this.vdp.interruptPending()) this.ctc.trigger(0);
      }
    }

    if (this.column80.enabled) this.column80.renderFrame();
    this.fdx.tickFrame();
    this.needsDisplay = true;
  }

  startTrace(_mode: MachineTraceMode = 'full'): void {}
  stopTrace(): string { return ''; }
  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    if (this.column80.enabled) return this.column80.text();
    return this.screenText.ocr(this.vdp.vram, this.vdp.regs, this.vdp.mode());
  }
}
