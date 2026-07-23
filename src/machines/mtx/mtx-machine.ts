/**
 * Memotech MTX500/512 motherboard.
 *
 * Reuses the commodity Z80A, TMS9929A, Z80 CTC and SN76489A cores. This first
 * base-machine implementation covers ROM BASIC operation, banked memory,
 * keyboard scanning, VDP video, CTC interrupts and PSG audio. Cassette,
 * printer, DART and disk expansions remain unfitted.
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
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind,
  MachineTraceMode, SettingsView,
} from '@/machines/machine.ts';
import type { MtxModel } from './models.ts';
import { MtxMemory } from './mtx-memory.ts';
import { MtxKeyboard } from './mtx-keyboard.ts';
import { installMtxMemoryHooks, wireMtxPortIO } from './mtx-io.ts';
import { mtxDescriptor } from './descriptor.ts';
import { createMtxServices, type MtxServices } from './services/index.ts';
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
  readonly psg = new Sn76489(MTX_CPU_CLOCK, 48_000, 'mtx');
  readonly screenText = new Tms9918ScreenText();
  readonly mixer = new AudioMixer(MTX_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  /** Last byte written to the cassette output port (transport is a follow-up). */
  tapeOutput = 0;
  readonly activity = { kbdReads: 0, psgWrites: 0 };

  private readonly _pixels = new Uint8Array(MTX_SCREEN_WIDTH * MTX_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  protected get audioChip(): Sn76489 { return this.psg; }
  get descriptor(): MachineDescriptor { return mtxDescriptor(this.model); }
  get frameWidth(): number { return MTX_SCREEN_WIDTH; }
  get frameHeight(): number { return MTX_SCREEN_HEIGHT; }
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
    this.setStatus(`MTX firmware loaded (${Math.min(data.length, 0x6000)} bytes)`);
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
    return null;
  }

  applySettings(view: SettingsView): void {
    this.vdp.palette =
      MSX_PALETTES[view.get('msx-color-map', 'pal') as keyof typeof MSX_PALETTES];
    this.audio.setVolume(view.get('volume', 70) / 100);
  }

  setBorderSize(mode: BorderMode): void {
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

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.memory.reset();
    this.vdp.reset();
    this.ctc.reset();
    this.keyboard.reset();
    this.psg.reset();
    this.audio.reset();
    this.mixer.reset();
    this.tapeOutput = 0;
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    this.activity.kbdReads = 0;
    this.activity.psgWrites = 0;
    this._pixels32.fill(this.vdp.backdrop());

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
        this.vdp.renderScanline(this._pixels32, rowStart, line);
      } else if (line === MTX_ACTIVE_LINES) {
        // VDP INT is wired to CTC channel 0's trigger, not directly to /INT.
        this.vdp.raiseFrameInterrupt();
        if (this.vdp.interruptPending()) this.ctc.trigger(0);
      }
    }

    this.needsDisplay = true;
  }

  startTrace(_mode: MachineTraceMode = 'full'): void {}
  stopTrace(): string { return ''; }
  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    return this.screenText.ocr(this.vdp.vram, this.vdp.regs, this.vdp.mode());
  }
}
