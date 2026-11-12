/**
 * Commodore 128 motherboard, C128 mode (PAL or NTSC).
 *
 * Two CPUs share the bus and only one runs at a time: the Z80 starts the
 * machine and runs the BIOS in the system ROM, which sets up the MMU and hands
 * over to the 8502 (an 8502 at 1 MHz here: a 6502 with the same on-chip port
 * as the 6510) by setting the MMU mode register's bit 0; the 8502 then starts
 * as if it had been reset. The rest is the 64's board with a bigger memory
 * map: a VIC-IIe (the 64's VIC-II with two extra registers), the SID, two 6526
 * CIAs (CIA 1 scans the keyboard, with three more lines than the 64's), and
 * the VDC (the 80-column chip, drawn by `vdc-display.ts`). The one canvas shows
 * either video chip: see `showing80`. See `memory.ts` for the map and `mmu.ts`
 * for the registers that move it.
 *
 * The frame loop is the 64's: it runs line by line, stopping at the cycles
 * where the VIC-II does its per-line work, with the CPU held off the bus for
 * the cycles the VIC-II takes. The 8502's cycle counter is the master clock;
 * while the Z80 runs, its T-states (two to a phi2 cycle) advance it.
 */

import { M6502 } from '@/cores/m6502.ts';
import { Z80 } from '@/cores/z80.ts';
import { Mos6526 } from '@/cores/mos6526.ts';
import { Mos6581 } from '@/cores/mos6581.ts';
import {
  EV_SPRITE_DMA, EV_SPRITE_MCB, EV_VC, VicII,
} from '@/cores/vic-ii.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { accessTime, isReadModifyWrite } from '@/debug/m6502/bus-cycles.ts';
import { VIC_PALETTE } from '@/machines/shared/cbm/vic-ii-board.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import { C128Memory } from './memory.ts';
import { C128Keyboard } from './keyboard.ts';
import { Vdc } from './vdc.ts';
import { c128ScreenText, vdcScreenText } from './screen-text.ts';
import { renderVdc, VDC_FRAME_HEIGHT, VDC_FRAME_WIDTH, VDC_PIXEL_ASPECT_X } from './vdc-display.ts';
import { C128_SCREEN_WIDTH, c128Timing, type C128Timing } from './constants.ts';

/** Indices into the line's events (see `lineEvents`), in the order they fall. */
const EVT_VC = 0;
const EVT_SPRITE_MCB = 1;
const EVT_SPRITE_DMA = 2;
const EVT_LINE_END = 3;

/** The Z80 runs at two T-states to the 8502's phi2 cycle. */
const Z80_TSTATES_PER_CYCLE = 2;
/** What the 8502's reset sequence costs once it has been handed the bus. */
const CPU_RESET_CYCLES = 7;

/** Which of the two video chips the one canvas shows: the 40/80 DISPLAY key's
 *  choice (`auto`), or one of them whatever the key says. */
export type C128DisplayMode = 'auto' | '40' | '80';

export class C128Machine extends BaseMachine {
  readonly kind = 'c128' as const;

  readonly cpu = new M6502();
  readonly z80 = new Z80();
  readonly memory = new C128Memory();
  readonly vic: VicII;
  /** PAL or NTSC: the clock, the line and frame, the visible lines. */
  readonly timing: C128Timing;
  readonly sid: Mos6581;
  readonly cia1 = new Mos6526();
  readonly cia2 = new Mos6526();
  readonly vdc = new Vdc();
  readonly keyboard = new C128Keyboard();

  readonly mixer: AudioMixer;
  readonly audio = new Audio();
  display: IScreenRenderer | null;
  private readonly _pixels: Uint8Array;
  private readonly vdcPixels32 = new Uint32Array(VDC_FRAME_WIDTH * VDC_FRAME_HEIGHT);
  private readonly vdcPixels = new Uint8Array(this.vdcPixels32.buffer);
  private displayMode: C128DisplayMode = 'auto';
  /** Which chip's frame the canvas was last told about. */
  private announced80 = false;

  /** VIC-IIe registers $D02F (the keyboard lines it selects, bits 0-2) and
   *  $D030 (bit 0 is the 2 MHz mode, which is not modelled yet). */
  private kbdLines = 0x07;
  private vicClockReg = 0;

  /** Which CPU is running now; the MMU's mode register says which should be. */
  private running8502 = false;
  private irqLine = false;
  // NMI is edge-triggered from the wired-OR of CIA 2 and RESTORE.
  private nmiLevel = false;

  // Frame-in-progress state (carried over a stop).
  private fLine = 0;
  private fEvent = 0;
  private lineLive = false;
  private lastInsnStart = 0;
  private insnStart = 0;
  private insnOp = -1;
  private insnRmw = false;
  private rmwAddr = -1;
  private rmwValue = 0;
  private audioLastT = 0;

  /** The line cycles at which the frame loop hands over to the VIC-II, in order. */
  private readonly lineEvents: readonly number[];

  constructor(display: IScreenRenderer | null = null, ntsc = false) {
    super();
    this.display = display;
    this.timing = c128Timing(ntsc);
    this.sid = new Mos6581(this.timing.clockHz);
    this.mixer = new AudioMixer(this.timing.clockHz);
    this.lineEvents = [EV_VC, EV_SPRITE_MCB, EV_SPRITE_DMA, this.timing.lineEndCycle, this.timing.cyclesPerLine];
    this.vic = new VicII(this.memory, this.timing, VIC_PALETTE);
    this._pixels = new Uint8Array(this.vic.pixels.buffer);
    this.mixer.beeperGain = 0;
    this.mixer.psgGain = 1;
    this.deferAccessStamps = true;

    this.cpu.onInterrupt = (vector) => this.noteInterrupt(this.cpu.pc, vector === 0xFFFA);
    this.cpu.read = (addr) => {
      const value = this.memory.readByte(addr);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, value, 'read');
      return value;
    };
    this.cpu.write = (addr, val) => {
      this.memory.writeByte(addr, val);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.recordMemWatch(addr & 0xFFFF, val & 0xFF, 'write');
    };
    this.z80.read8 = (addr) => this.memory.z80Read(addr);
    this.z80.write8 = (addr, val) => this.memory.z80Write(addr, val);
    this.z80.portInHandler = (port) => this.memory.z80In(port);
    this.z80.portOutHandler = (port, val) => this.memory.z80Out(port, val);
    this.wireIo();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  /** The cycle a register access of the instruction in progress lands on. */
  private accessT(addr: number, write: boolean): number {
    if (!this.running8502) return this.cpu.tStates;
    return accessTime(this.insnStart, this.insnOp, this.insnPc, addr, write, false);
  }

  private wireIo(): void {
    const { memory, vic, sid, cia1, cia2, keyboard, vdc } = this;
    const mmu = memory.mmu;

    // CIA 1: port A drives the keyboard columns, port B reads the rows (and
    // the extra lines $D02F selects are part of the columns).
    cia1.portAIn = (driven) => driven & keyboard.columnsFor(cia1.drivenB);
    cia1.portBIn = (driven) => driven & keyboard.rowsForLines(cia1.drivenA, mmu.c64Mode ? 0x07 : this.kbdLines);
    // CIA 2 port A: VIC bank (bits 0-1); the serial bus lines (bits 6-7) read
    // high with nothing on the bus.
    cia2.portAIn = (driven) => (driven & 0x3F) | 0xC0;
    cia2.onPortWrite = (port) => {
      if (port !== 0) return;
      const bank = (~cia2.drivenA) & 3;
      if ((bank << 14) !== memory.vicBase) {
        vic.drawTo(this.cpu.tStates);
        memory.setVicBank(bank);
      }
    };
    memory.setVicBank((~cia2.drivenA) & 3);

    // The 40/80 key is read through the MMU's mode register.
    mmu.displayKeyUp = !keyboard.display80;

    const ioRead = (addr: number): number => {
      switch ((addr >> 8) & 0x0F) {
        case 0x0: case 0x1: case 0x2: case 0x3: {
          const r = addr & 0x3F;
          if (r === 0x2F && !mmu.c64Mode) return 0xF8 | this.kbdLines;
          if (r === 0x30 && !mmu.c64Mode) return 0xFC | this.vicClockReg;
          if (r === 0x1E || r === 0x1F) vic.drawTo(this.accessT(addr, false));
          return vic.read(addr);
        }
        case 0x4:
          sid.advanceTo(this.accessT(addr, false));
          return sid.read(addr);
        case 0x5:
          mmu.displayKeyUp = !keyboard.display80;
          return mmu.read(addr & 0xFF);
        case 0x6:
          return vdc.read(addr & 1);
        case 0x8: case 0x9: case 0xA: case 0xB:
          return (memory.colorRead(addr) & 0x0F) | (vic.read(0x12) & 0xF0);
        case 0xC:
          cia1.advanceTo(this.accessT(addr, false));
          return cia1.read(addr);
        case 0xD:
          cia2.advanceTo(this.accessT(addr, false));
          return cia2.read(addr);
        default: return 0xFF;
      }
    };
    memory.ioRead = (addr) => {
      const value = ioRead(addr);
      if (this.insnRmw) { this.rmwAddr = addr; this.rmwValue = value; }
      return value;
    };
    memory.ioPeek = (addr) => {
      switch ((addr >> 8) & 0x0F) {
        case 0x0: case 0x1: case 0x2: case 0x3: {
          const r = addr & 0x3F;
          if (r === 0x2F && !mmu.c64Mode) return 0xF8 | this.kbdLines;
          if (r === 0x30 && !mmu.c64Mode) return 0xFC | this.vicClockReg;
          return vic.peek(addr);
        }
        case 0x4: return sid.peek(addr);
        case 0x5: return mmu.read(addr & 0xFF);
        case 0x6: return vdc.peek(addr & 1);
        case 0x8: case 0x9: case 0xA: case 0xB: return memory.colorRead(addr) & 0x0F;
        case 0xC: return cia1.peek(addr);
        case 0xD: return cia2.peek(addr);
        default: return 0xFF;
      }
    };
    const ioWrite = (addr: number, value: number, t: number): void => {
      switch ((addr >> 8) & 0x0F) {
        case 0x0: case 0x1: case 0x2: case 0x3: {
          const r = addr & 0x3F;
          if (r === 0x2F && !mmu.c64Mode) { this.kbdLines = value & 0x07; break; }
          if (r === 0x30 && !mmu.c64Mode) { this.vicClockReg = value & 0x03; break; }
          vic.write(addr, value, t);
          break;
        }
        case 0x4:
          sid.advanceTo(t);
          sid.write(addr, value);
          break;
        case 0x5:
          mmu.write(addr & 0xFF, value);
          break;
        case 0x6:
          vdc.write(addr & 1, value);
          break;
        case 0x8: case 0x9: case 0xA: case 0xB:
          memory.colorWrite(addr, value);
          break;
        case 0xC:
          cia1.advanceTo(t);
          cia1.write(addr, value);
          break;
        case 0xD:
          cia2.advanceTo(t);
          cia2.write(addr, value);
          break;
        default: break;
      }
    };
    memory.ioWrite = (addr, value) => {
      const t = this.accessT(addr, true);
      // An NMOS read-modify-write writes the byte it read straight back, a
      // cycle before the new one (INC $D019 acknowledges the VIC-II with the
      // first write).
      if (this.running8502 && this.insnRmw && addr === this.rmwAddr) ioWrite(addr, this.rmwValue, t - 1);
      ioWrite(addr, value, t);
    };
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  reset(): void {
    this.stop();
    this.resetHardware();
    this.resetFrameCount();
    this.setStatus('Reset');
  }

  /**
   * Install the system ROMs, one image per socket (a null keeps what is
   * there): BASIC 7.0 low and high, the system ROM and the character ROM, and
   * for C64 mode the 64's BASIC and KERNAL.
   */
  loadRoms(
    basicLo: Uint8Array | null, basicHi: Uint8Array | null,
    kernal: Uint8Array | null, chargen: Uint8Array | null,
    basic64: Uint8Array | null = null, kernal64: Uint8Array | null = null,
  ): void {
    this.memory.loadRoms(basicLo, basicHi, kernal, chargen, basic64, kernal64);
  }

  /** The machine is in C64 mode (the MMU's mode register bit 6). */
  get c64Mode(): boolean { return this.memory.mmu.c64Mode; }

  /** Power on: the Z80 is the CPU, with the MMU cleared, and starts at $0000. */
  private resetHardware(): void {
    this.memory.reset();
    this.vdc.reset();
    this.vic.reset();
    this.sid.reset();
    this.cia1.reset();
    this.cia2.reset();
    this.memory.setVicBank((~this.cia2.drivenA) & 3);
    this.keyboard.reset();
    this.kbdLines = 0x07;
    this.vicClockReg = 0;
    this.memory.capsLockDown = this.keyboard.capsLock;
    this.memory.pinsChanged();
    this.memory.mmu.displayKeyUp = !this.keyboard.display80;
    this.cpu.reset();
    this.z80.reset();
    this.running8502 = false;
    this.irqLine = false;
    this.nmiLevel = false;
    this.midFrame = false;
    this.fLine = 0;
    this.fEvent = 0;
    this.lineLive = false;
    this.clearInterrupts();
    this.syncChipClocks();
    this.mixer.reset();
    this.audio.reset();
    this.needsDisplay = true;
  }

  /** The chips' own clocks follow the CPU's (it restarts at 0 on reset). */
  private syncChipClocks(): void {
    const t = this.cpu.tStates;
    this.cia1.now = t;
    this.cia2.now = t;
    this.sid.now = t;
    this.sid.flush();
    this.audioLastT = t;
  }

  /** The MMU's mode register handed the bus to the other CPU. The Z80 carries
   *  on where it stopped; the 8502 starts as if it had been reset, reading its
   *  vector from whatever the map shows at the top of memory. */
  private switchCpu(): void {
    const to8502 = this.memory.mmu.cpu8502;
    this.running8502 = to8502;
    if (!to8502) return;
    const t = this.cpu.tStates;
    this.cpu.reset();
    this.cpu.tStates = t + CPU_RESET_CYCLES;
    this.cpu.setIRQ(this.irqLine);
  }

  // ── Frame ────────────────────────────────────────────────────────────────

  /** Whether the canvas is showing the VDC (80 columns) rather than the VIC-IIe.
   *  In C64 mode Auto shows the VIC-II: the 64's software never uses the VDC. */
  get showing80(): boolean {
    return this.displayMode === 'auto' ? this.keyboard.display80 && !this.c64Mode : this.displayMode === '80';
  }

  get pixels(): Uint8Array { return this.showing80 ? this.vdcPixels : this._pixels; }
  get frameWidth(): number { return this.showing80 ? VDC_FRAME_WIDTH : C128_SCREEN_WIDTH; }
  get frameHeight(): number { return this.showing80 ? VDC_FRAME_HEIGHT : this.timing.screenHeight; }
  get tStatesPerFrame(): number { return this.timing.cyclesPerFrame; }
  get cpuClockHz(): number { return this.timing.clockHz; }
  protected override get frameHz(): number { return this.timing.clockHz / this.timing.cyclesPerFrame; }

  protected get audioChip(): Mos6581 { return this.sid; }
  protected framePixels(): Uint8Array { return this.pixels; }
  protected inTurbo(): boolean { return this.turbo; }
  protected override interruptEntryPending(): boolean { return this.running8502 && this.cpu.interruptPending(); }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.running8502 ? this.cpu.sp : this.z80.sp; }
  protected override cpuPc(): number { return this.running8502 ? this.cpu.pc : this.z80.pc; }

  /** Which CPU is running: the 8502 once the BIOS has handed over. */
  get cpuIs8502(): boolean { return this.running8502; }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1;
    this.sid.audible = !skipAudio;
    if (!this.openFrame(this.timing.cyclesPerFrame)) {
      this.fLine = 0;
      this.fEvent = 0;
      this.lineLive = false;
    }
    this.memWatchHit = null;
    const vic = this.vic;

    const events = this.lineEvents;
    for (; this.fLine < this.timing.linesPerFrame; this.fLine++) {
      const lineStart = this.frameStartT + this.fLine * this.timing.cyclesPerLine;
      if (!this.lineLive) {
        this.lineLive = true;
        this.fEvent = 0;
        vic.startLine(this.fLine, lineStart);
        this.vdc.setBeam(this.fLine / this.timing.linesPerFrame);
        this.updateInterrupts();
      }
      for (; this.fEvent < events.length; this.fEvent++) {
        const at = events[this.fEvent];
        if (!this.runCpuTo(lineStart + at)) {
          this.midFrame = true;
          this.needsDisplay = true;
          return;
        }
        switch (this.fEvent) {
          case EVT_VC: vic.loadCounters(); break;
          case EVT_SPRITE_MCB: vic.spriteRowAdvance(); break;
          case EVT_SPRITE_DMA:
            vic.spriteDmaCheck();
            this.cpu.tStates += vic.stretch(this.lastInsnStart, this.cpu.tStates, false);
            break;
          case EVT_LINE_END: vic.endOfLineFetches(); break;
          default: vic.endLine(); break;
        }
        this.updateInterrupts();
      }
      this.lineLive = false;
      if (!skipAudio) this.pumpAudio();
    }

    this.cia1.todTick();
    this.cia2.todTick();
    if (skipAudio) { this.audioLastT = this.cpu.tStates; this.sid.advanceTo(this.cpu.tStates); }
    this.vdc.tickFrame();
    this.drawVdc();
    this.needsDisplay = true;
  }

  /** Draw the VDC's frame when the canvas shows it, and tell the canvas when
   *  the chip it shows (so its size and the shape of a pixel) has changed. */
  private drawVdc(): void {
    const is80 = this.showing80;
    if (is80) renderVdc(this.vdc, this.vdcPixels32);
    if (is80 === this.announced80) return;
    this.announced80 = is80;
    this.display?.resize(this.frameWidth, this.frameHeight);
    this.display?.setPixelAspectX(is80 ? VDC_PIXEL_ASPECT_X : 1);
    this.onScreenChange?.();
  }

  /** Feed the SID's samples to the mixer up to now. */
  private pumpAudio(): void {
    const now = this.cpu.tStates;
    this.sid.advanceTo(now);
    const elapsed = now - this.audioLastT;
    this.audioLastT = now;
    if (elapsed <= 0) return;
    this.mixer.accumulate(0, elapsed);
    this.mixer.generateSamples(this.audio, this.sid, true);
  }

  /** Run the CPU in charge to cycle `target`. False when a stop left it part-way. */
  private runCpuTo(target: number): boolean {
    const cpu = this.cpu;
    const vic = this.vic;
    while (cpu.tStates < target) {
      // Wait out a hold the VIC-II has on the bus.
      const free = vic.stealEnd(cpu.tStates);
      if (free !== cpu.tStates) { cpu.tStates = free; continue; }
      if (this.running8502 !== this.memory.mmu.cpu8502) this.switchCpu();
      if (!this.running8502) { this.stepZ80(); continue; }
      if (this.checkStops(cpu.pc)) return false;
      const start = cpu.tStates;
      const pc = cpu.pc;
      this.beforeInsn(pc);
      this.insnStart = start;
      this.insnOp = cpu.interruptPending() ? -1 : this.memory.peekByte(pc);
      this.insnRmw = this.insnOp >= 0 && isReadModifyWrite(this.insnOp);
      this.rmwAddr = -1;
      cpu.step();
      cpu.tStates += vic.stretch(start, cpu.tStates);
      this.lastInsnStart = start;
      const stopped = this.afterInsn();
      this.afterStep();
      if (stopped) return false;
    }
    return true;
  }

  /** One Z80 instruction (or interrupt), its T-states charged to the master clock. */
  private stepZ80(): void {
    const z80 = this.z80;
    const before = z80.tStates;
    if (this.irqLine && z80.iff1 && !z80.eiDelay) z80.interrupt();
    else z80.step();
    this.cpu.tStates += Math.max(1, Math.ceil((z80.tStates - before) / Z80_TSTATES_PER_CYCLE));
    this.afterStep();
  }

  /** After each instruction: the CIAs and the interrupt lines. */
  private afterStep(): void {
    const now = this.cpu.tStates;
    this.cia1.advanceTo(now);
    this.cia2.advanceTo(now);
    this.updateInterrupts();
  }

  private updateInterrupts(): void {
    this.irqLine = this.cia1.irq || this.vic.irq;
    const nmi = this.cia2.irq || this.keyboard.restore;
    if (this.running8502) {
      this.cpu.setIRQ(this.irqLine);
      if (nmi && !this.nmiLevel) this.cpu.nmi();
    } else if (nmi && !this.nmiLevel) {
      this.z80.nmi();
    }
    this.nmiLevel = nmi;
  }

  // ── Input ────────────────────────────────────────────────────────────────

  /** CAPS LOCK went down or up: its port bit follows. */
  setCapsLock(down: boolean): void {
    this.keyboard.capsLock = down;
    this.memory.capsLockDown = down;
    this.memory.pinsChanged();
  }

  /** The 40/80 DISPLAY key went down (80 columns) or up (40). */
  setDisplay80(down: boolean): void {
    this.keyboard.display80 = down;
    this.memory.mmu.displayKeyUp = !down;
    this.drawVdc();
    this.needsDisplay = true;
  }

  /** Show the 40-column chip, the 80-column chip, or whichever the 40/80 key
   *  says (the Display menu). */
  setDisplayMode(mode: C128DisplayMode): void {
    this.displayMode = mode;
    this.drawVdc();
    this.needsDisplay = true;
  }

  // ── Debug ────────────────────────────────────────────────────────────────

  /** The text screen the canvas shows, as text: 80 columns from the VDC's
   *  RAM, or 40 from the VIC-IIe's matrix. */
  ocrScreenForMcp(_mode?: string): string {
    return this.showing80 ? vdcScreenText(this.vdc) : c128ScreenText(this.memory, this.vic.regs);
  }
}
