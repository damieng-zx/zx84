import { Z80 } from '@/cores/z80.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, MachineTraceMode, SettingsView,
} from '@/machines/machine.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type { OcrGridName, OcrResult } from '@/ocr/ocr.ts';
import type { Zx8xModel } from './models.ts';
import { Zx8xMemory } from './memory.ts';
import { Zx8xKeyboard } from './keyboard.ts';
import { zx8xDescriptor } from './descriptor.ts';
import { Zx8xScreenText } from './screen-text.ts';
import { createZx8xServices, type Zx8xServices } from './services/index.ts';
import {
  ZX8X_ACTIVE_HEIGHT, ZX8X_ACTIVE_WIDTH, ZX8X_BORDER_LEFT, ZX8X_BORDER_TOP,
  ZX8X_CPU_CLOCK, ZX8X_LINES_PER_FRAME, ZX8X_SCREEN_HEIGHT, ZX8X_SCREEN_WIDTH, ZX8X_T_PER_FRAME,
} from './constants.ts';

const WHITE = 0xffffffff;
const BLACK = 0xff000000;

export class Zx8xMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'zx8x';
  readonly model: Zx8xModel;
  readonly cpu = new Z80();
  readonly memory: Zx8xMemory;
  readonly keyboard = new Zx8xKeyboard();
  readonly screenText = new Zx8xScreenText();
  readonly ay = new AY3891x(ZX8X_CPU_CLOCK, 48000, 'ABC');
  readonly audio = new Audio();
  readonly mixer = new AudioMixer(ZX8X_CPU_CLOCK);
  readonly services: Zx8xServices;
  readonly activity = { kbdReads: 0 };
  host: MachineHost | null = null;
  display: IScreenRenderer | null;

  private readonly frame = new Uint8Array(ZX8X_SCREEN_WIDTH * ZX8X_SCREEN_HEIGHT * 4);
  private readonly frame32 = new Uint32Array(this.frame.buffer);
  private nmiEnabled = false;

  constructor(model: Zx8xModel, display: IScreenRenderer | null = null) {
    super();
    this.model = model;
    this.display = display;
    this.memory = new Zx8xMemory(model);
    this.mixer.beeperGain = 0;
    this.mixer.ayGain = 0;
    this.installCpuBus();
    this.services = createZx8xServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }
  get descriptor(): MachineDescriptor { return zx8xDescriptor(this.model); }
  get pixels(): Uint8Array { return this.frame; }
  get frameWidth(): number { return ZX8X_SCREEN_WIDTH; }
  get frameHeight(): number { return ZX8X_SCREEN_HEIGHT; }
  get tStatesPerFrame(): number { return ZX8X_T_PER_FRAME; }
  get cpuClockHz(): number { return ZX8X_CPU_CLOCK; }

  private installCpuBus(): void {
    this.cpu.read8 = (addr: number): number => {
      addr &= 0xffff;
      let value = this.memory.readByte(addr);
      // During an opcode fetch from the echoed display file the ULA presents a
      // NOP for a character byte; a 0x76 line terminator remains HALT.
      if (addr >= 0xc000 && addr <= 0xffff && (value & 0x40) === 0) value = 0x00;
      if (this.memWatchpoints.length && this.memWatchHit === null) {
        for (const wp of this.memWatchpoints) if ((wp.mode === 'read' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          this.memWatchHit = { addr, value, dir: 'read' }; break;
        }
      }
      return value;
    };
    this.cpu.write8 = (addr: number, value: number): void => {
      addr &= 0xffff;
      this.memory.writeByte(addr, value);
      if (this.memWatchpoints.length && this.memWatchHit === null) {
        for (const wp of this.memWatchpoints) if ((wp.mode === 'write' || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
          this.memWatchHit = { addr, value: value & 0xff, dir: 'write' }; break;
        }
      }
    };
    this.cpu._contendAccurate = () => {};
    this.cpu.contend = () => {};
    this.cpu.portInHandler = (port: number): number => {
      this.activity.kbdReads++;
      const value = 0x60 | this.keyboard.read((port >> 8) & 0xff);
      if (this.portWatchpoints.has(port & 0xffff) && this.portWatchHit === null) this.portWatchHit = { port: port & 0xffff, value, dir: 'in' };
      return value;
    };
    this.cpu.portOutHandler = (port: number, value: number): void => {
      const low = port & 0xff;
      if (this.model === 'zx81') {
        if (low === 0xfe) this.nmiEnabled = true;
        else if (low === 0xfd) this.nmiEnabled = false;
      }
      if (this.portWatchpoints.has(port & 0xffff) && this.portWatchHit === null) this.portWatchHit = { port: port & 0xffff, value: value & 0xff, dir: 'out' };
    };
  }

  loadROM(data: Uint8Array): void { this.memory.loadROM(data); }

  applySettings(view: SettingsView): void {
    this.memory.set16kExpansion(view.get('zx8x-16k-ram', false));
    this.audio.setVolume(view.get('volume', 70) / 100);
  }

  loadProgram(data: Uint8Array, address: number): void {
    this.stop();
    this.reset();
    this.memory.loadRamImage(data, address);
    this.cpu.iy = 0x4000;
    this.cpu.i = this.model === 'zx80' ? 0x0e : 0x1e;
    if (this.model === 'zx81') {
      this.prepareZx81LoadedProgram();
    } else {
      this.cpu.sp = this.memory.has16kExpansion ? 0x7ffc : 0x43fc;
      this.cpu.pc = 0x0283;
    }
    this.renderDisplayFile();
    this.needsDisplay = true;
    // Browser loads resume the live frame loop; the headless MCP deliberately
    // advances with tick()/runUntil() and has no requestAnimationFrame.
    if (this.display) void this.start();
  }

  /** Restore the CPU and the nine RAM bytes omitted from a ZX81 .p image.
   *
   * A real LOAD resumes at SLOW/FAST ($0207) after LOAD/SAVE has discarded its
   * own return address. The remaining stack returns through $0676 into the
   * BASIC next-line path. These values are the stable post-LOAD state recorded
   * by sz81; without them the first RET lands at $0000 and RAM-CHECK erases the
   * program a few frames later. */
  private prepareZx81LoadedProgram(): void {
    const expanded = this.memory.has16kExpansion;
    const ramTop = expanded ? 0x8000 : 0x4400;
    const sp = ramTop - 4;

    this.cpu.a = 0x0b; this.cpu.f = 0x00;
    this.cpu.b = 0x00; this.cpu.c = 0x02;
    this.cpu.d = expanded ? 0x43 : 0x40; this.cpu.e = 0x9b;
    this.cpu.h = expanded ? 0x43 : 0x40; this.cpu.l = 0x99;
    this.cpu.a_ = expanded ? 0xec : 0xf8; this.cpu.f_ = 0xa9;
    this.cpu.b_ = expanded ? 0x81 : 0x00; this.cpu.c_ = expanded ? 0x02 : 0x00;
    this.cpu.d_ = 0x00; this.cpu.e_ = 0x2b;
    this.cpu.h_ = 0x00; this.cpu.l_ = 0x00;
    this.cpu.ix = 0x0281;
    this.cpu.iy = 0x4000;
    this.cpu.i = 0x1e;
    this.cpu.r = 0xdd;
    this.cpu.sp = sp;
    this.cpu.pc = 0x0207;
    this.cpu.iff1 = false;
    this.cpu.iff2 = false;
    // sz81's internal value 2 denotes Z80 interrupt mode 1. Our Z80 core
    // uses the conventional 0/1/2 values, so translate it rather than
    // copying the emulator-internal representation literally.
    this.cpu.im = 1;

    // ERR_NR, FLAGS, ERR_SP, RAMTOP, MODE, PPC — not present in .p files,
    // whose first byte maps to VERSN at $4009.
    const prefix = [0xff, 0x80, sp & 0xff, sp >> 8, ramTop & 0xff, ramTop >> 8, 0x00, 0xfe, 0xff];
    for (let i = 0; i < prefix.length; i++) this.memory.writeByte(0x4000 + i, prefix[i]);

    // Return to the ROM's post-command next-line path, followed by its normal
    // stack sentinel. Little-endian words: $0676, $3E00.
    this.memory.writeByte(sp + 0, 0x76);
    this.memory.writeByte(sp + 1, 0x06);
    this.memory.writeByte(sp + 2, 0x00);
    this.memory.writeByte(sp + 3, 0x3e);
    this.nmiEnabled = false;
  }

  private read16(addr: number): number {
    return this.memory.readByte(addr) | (this.memory.readByte(addr + 1) << 8);
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.memory.reset();
    this.keyboard.reset();
    this.nmiEnabled = false;
    this.audio.reset();
    this.mixer.reset();
    this.frame32.fill(WHITE);
    this.needsDisplay = true;
  }

  setBorderSize(mode: BorderMode): void {
    const fraction = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(ZX8X_BORDER_LEFT * (1 - fraction));
    const cropY = Math.round(ZX8X_BORDER_TOP * (1 - fraction));
    this.display?.setViewport(cropX, cropY, ZX8X_SCREEN_WIDTH - cropX * 2, ZX8X_SCREEN_HEIGHT - cropY * 2);
  }

  protected framePixels(): Uint8Array { return this.frame; }
  protected inTurbo(): boolean { return this.turbo; }

  protected runFrame(): void {
    this.activity.kbdReads = 0;
    const lineT = ZX8X_T_PER_FRAME / ZX8X_LINES_PER_FRAME;
    let lineEnd = this.cpu.tStates;
    let lastAudio = this.cpu.tStates;
    let broke = false;
    for (let line = 0; line < ZX8X_LINES_PER_FRAME; line++) {
      lineEnd += lineT;
      if (this.model === 'zx81' && this.nmiEnabled) this.cpu.nmi();
      while (this.cpu.tStates < lineEnd) {
        if (this.breakpoints.has(this.cpu.pc)) { this.breakpointHit = this.cpu.pc; broke = true; break; }
        if (this.onTrap?.(this.cpu.pc)) { broke = true; break; }
        const beforeEi = this.cpu.eiDelay;
        this.cpu.step();
        if (beforeEi) this.cpu.eiDelay = false;
        if (this.cpu.halted && this.cpu.pc >= 0xc000 && this.cpu.iff1 && !this.cpu.eiDelay) this.cpu.interrupt();
        const elapsed = this.cpu.tStates - lastAudio;
        if (!this.turbo && elapsed > 0) {
          this.mixer.accumulate(0, elapsed);
          this.mixer.generateSamples(this.audio, null, false);
          lastAudio = this.cpu.tStates;
        }
      }
      if (broke) break;
    }
    this.renderDisplayFile();
    this.needsDisplay = true;
  }

  /** Render the current 32x24 display file with the character page selected by I. */
  private renderDisplayFile(): void {
    this.frame32.fill(WHITE);
    let ptr = this.read16(0x400c);
    if (ptr < 0x4000 || ptr > 0x7fff) return;
    if (this.memory.readByte(ptr) === 0x76) ptr++;
    const fontPage = this.cpu.i || (this.model === 'zx80' ? 0x0e : 0x1e);
    for (let row = 0; row < 24; row++) {
      let col = 0;
      while (col < 32) {
        const code = this.memory.readByte(ptr++);
        if (code === 0x76) break;
        const inverse = (code & 0x80) !== 0;
        const glyph = (fontPage << 8) + ((code & 0x3f) << 3);
        for (let gy = 0; gy < 8; gy++) {
          const bits = this.memory.readByte(glyph + gy);
          const base = (ZX8X_BORDER_TOP + row * 8 + gy) * ZX8X_SCREEN_WIDTH + ZX8X_BORDER_LEFT + col * 8;
          for (let gx = 0; gx < 8; gx++) {
            const ink = ((bits >> (7 - gx)) & 1) !== 0;
            this.frame32[base + gx] = ink !== inverse ? BLACK : WHITE;
          }
        }
        col++;
      }
      // A collapsed display file uses an immediate newline for blank rows.
      if (col === 32 && this.memory.readByte(ptr) === 0x76) ptr++;
    }
  }

  screenExportBytes(): Uint8Array {
    const out = new Uint8Array((ZX8X_ACTIVE_WIDTH * ZX8X_ACTIVE_HEIGHT) >> 3);
    for (let y = 0; y < ZX8X_ACTIVE_HEIGHT; y++) {
      for (let xByte = 0; xByte < ZX8X_ACTIVE_WIDTH >> 3; xByte++) {
        let value = 0;
        const base = (ZX8X_BORDER_TOP + y) * ZX8X_SCREEN_WIDTH + ZX8X_BORDER_LEFT + xByte * 8;
        for (let bit = 0; bit < 8; bit++) if (this.frame32[base + bit] === BLACK) value |= 0x80 >> bit;
        out[y * 32 + xByte] = value;
      }
    }
    return out;
  }
  ocrScreenStyled(): OcrResult {
    return this.screenText.ocrStyled(this.memory.snapshot(), this.model);
  }
  blankTextCells(mask: readonly boolean[]): void {
    for (let row = 0; row < 24; row++) for (let col = 0; col < 32; col++) {
      if (!mask[row * 32 + col]) continue;
      for (let y = 0; y < 8; y++) {
        const start = (ZX8X_BORDER_TOP + row * 8 + y) * ZX8X_SCREEN_WIDTH + ZX8X_BORDER_LEFT + col * 8;
        this.frame32.fill(WHITE, start, start + 8);
      }
    }
    this.display?.updateTexture(this.frame);
  }
  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ramSnapshot(), filename: `ram-${this.memory.ramSize / 1024}k.bin` };
  }
  startTrace(_mode: MachineTraceMode = 'full'): void {}
  stopTrace(): string { return ''; }
  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    return `[32x24]\n${this.screenText.ocr(this.memory.snapshot(), this.model)}`;
  }
  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    return value === 'rom0' ? { data: this.memory.getRom(), baseAddr: 0 } : null;
  }
}
