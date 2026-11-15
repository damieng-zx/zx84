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
import { crc32, type StateReader, type StateWriter } from '@/machines/shared/state-io.ts';
import { withStopsDisarmed } from '@/machines/shared/native-state.ts';
import { m6502ReturnAddress, type BeamInfo, type BeamPos } from '@/debug/beam-log.ts';
import { accessTime, isReadModifyWrite } from '@/debug/m6502/bus-cycles.ts';
import { M6502Trace } from '@/debug/m6502/trace.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { PulseRecorder } from '@/media/tape/pulse-recorder.ts';
import type { C64Program } from '@/media/tape/t64.ts';
import type { ChipSection } from '@/debug/chip-state.ts';
import { VIC_PALETTE } from '@/machines/shared/cbm/vic-ii-board.ts';
import { CbmSerialBus, IEC_ATN, IEC_CLK, IEC_DATA } from '@/machines/shared/cbm/serial-bus.ts';
import {
  normalizeDriveModels, type CbmDriveModel, type CbmDriveUnit,
} from '@/machines/shared/cbm/drive/drive-unit.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  AuxRomRequest, BorderMode, Machine, MachineDescriptor, MachineHost, SettingsView,
} from '@/machines/machine.ts';
import type { C128Model } from './models.ts';
import { C128Memory } from './memory.ts';
import { C128Keyboard } from './keyboard.ts';
import { Vdc, VDC_RAM_16K, VDC_RAM_64K } from './vdc.ts';
import { c128ScreenText, vdcScreenText } from './screen-text.ts';
import {
  renderVdc, vdcGeometry, VDC_FRAME_HEIGHT, VDC_FRAME_WIDTH, VDC_PIXEL_ASPECT_X, VDC_PALETTE,
} from './vdc-display.ts';
import { vdcOcrGrid } from './vdc-ocr.ts';
import { c64OcrGrid, type C64OcrResult } from '@/ocr/c64.ts';
import {
  C128_ACTIVE_HEIGHT, C128_ACTIVE_WIDTH, C128_BORDER_LEFT, C128_CHARGEN_128_OFFSET,
  C128_SCREEN_WIDTH, c128Timing, type C128Timing,
} from './constants.ts';
import { C128_ROM_CHIP_SIZES } from './models.ts';
import { c128Descriptor } from './descriptor.ts';
import { c128Chips } from './chip-dump.ts';
import { createC128Services, type C128Services } from './services/index.ts';

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

/** Joystick directions as CIA port bits (active low on the port). */
const JOY_BITS: Readonly<Record<string, number>> = {
  up: 0x01, down: 0x02, left: 0x04, right: 0x08, fire: 0x10,
};

/** Frames after a reset by which BASIC is ready, in either mode. */
const BOOT_FRAMES = 260;
/** Frames the C= key is held for a start in C64 mode (the BIOS reads it at once). */
const C64_KEY_HOLD_FRAMES = 30;
/** Serial bus writes in a frame that mean a file is moving (a byte is dozens). */
const IEC_BUSY_WRITES = 8;
/** Frames of quiet before tape turbo lets go. */
const TAPE_TURBO_COOLDOWN = 25;
/** Reads of the 8502 port in a frame that mean a program is polling the
 *  cassette sense line (the KERNAL's IRQ reads it about once a frame). */
const AUTO_PLAY_POLLS = 100;
/** Reads of CIA 1's interrupt flags in a frame that mean the tape is being
 *  read: every pulse is an interrupt (or a poll), where the KERNAL's jiffy
 *  IRQ alone reads it about once a frame. */
const TURBO_ICR_READS = 10;

/** Where BASIC keeps its pointers and its keyboard queue, and where a program
 *  starts, in C128 mode (BASIC 7.0, program text at $1C01 in RAM block 0) and
 *  in C64 mode (BASIC V2 at $0801). */
interface BasicLayout {
  readonly txttab: number;
  readonly vartab: number;
  readonly arytab: number;
  readonly strend: number;
  readonly keyBuf: number;
  readonly keyCount: number;
  readonly start: number;
}
const BASIC7: BasicLayout = {
  txttab: 0x2D, vartab: 0x2F, arytab: 0x31, strend: 0x33, keyBuf: 0x034A, keyCount: 0xD0, start: 0x1C01,
};
const BASIC2: BasicLayout = {
  txttab: 0x2B, vartab: 0x2D, arytab: 0x2F, strend: 0x31, keyBuf: 0x0277, keyCount: 0xC6, start: 0x0801,
};

export class C128Machine extends BaseMachine implements Machine {
  readonly kind = 'c128' as const;
  readonly model: C128Model = 'c128';
  host: MachineHost | null = null;
  readonly services: C128Services;

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
  /** The Datasette's tape, played through the shared pulse deck. */
  readonly tape: TapeDeck;
  /** Edges of the cassette write line since the last reset (what SAVE wrote). */
  readonly tapeRecorder = new PulseRecorder();
  /** The serial bus and the disk drives on it. CIA 2 port A drives the bus as
   *  on the 64 (ATN, CLK and DATA out on bits 3-5), and CIA 1's shift register
   *  is the fast serial port, which the MMU's mode register bit 3 points out
   *  or in. The 128's own drive is a 1571. */
  readonly iec = new CbmSerialBus(() => {
    const driven = this.cia2.drivenA;
    return ((driven & 0x08) ? IEC_ATN : 0) | ((driven & 0x10) ? IEC_CLK : 0) | ((driven & 0x20) ? IEC_DATA : 0);
  });
  /** The disk drives on the serial bus, device 8 first; none while unplugged. */
  get drives(): readonly CbmDriveUnit[] { return this.iec.drives; }
  /** The first drive (device 8), or null when none is fitted. */
  get drive(): CbmDriveUnit | null { return this.iec.drive; }
  /** The drives set up, one model each: what the next build fits. */
  get driveModels(): readonly CbmDriveModel[] { return this.iec.driveModels; }
  /** The model of the first drive in that setup. */
  get driveModel(): CbmDriveModel { return this.iec.driveModel; }

  readonly mixer: AudioMixer;
  readonly audio = new Audio();
  display: IScreenRenderer | null;
  private readonly _pixels: Uint8Array;
  private readonly vdcPixels32 = new Uint32Array(VDC_FRAME_WIDTH * VDC_FRAME_HEIGHT);
  private readonly vdcPixels = new Uint8Array(this.vdcPixels32.buffer);
  private displayMode: C128DisplayMode = 'auto';
  /** Which chip's frame the canvas was last told about. */
  private announced80 = false;
  private borderMode: BorderMode = 2;

  readonly activity = { kbdReads: 0, sidWrites: 0, tapeEdges: 0, joyReads: 0 };

  /** Joystick bits held (active high here), port 1 and port 2. */
  private joy1 = 0;
  private joy2 = 0;

  /** The 1351 mouse: the control port it is plugged into (0 = none), its two
   *  6-bit position counters (what the SID's POT lines read) and its buttons
   *  (bit 0 left, bit 1 right). */
  private mousePort: 0 | 1 | 2 = 0;
  private mouseX = 0;
  private mouseY = 0;
  private mouseButtons = 0;

  // Tape transport.
  tapeTurbo = true;
  private _tapeTurboActive = false;
  private tapeTurboCooldown = 0;
  private tapeLastT = 0;
  private prevEar = 0;
  private motorWasOn = false;
  private autoPlayArmed = false;
  /** CIA 1 interrupt-flag reads this frame, and the recorder's length at
   *  the last frame's end (for the turbo). */
  private icrReads = 0;
  /** Writes to the serial bus this frame: a drive sending or taking a file. */
  private iecWrites = 0;
  private recordedAtFrame = 0;

  /** A program waiting for BASIC to be ready before it is put in memory. */
  private pendingProgram: { prog: C64Program; run: boolean } | null = null;
  private framesSinceReset = 0;
  /** Frames left of C= held for a start in C64 mode. */
  private c64KeyFrames = 0;

  /** A state without its disks (the browser-refresh copy) was restored: the
   *  shell then puts the persisted disk back, which must not look like a disk
   *  change to the drive. Cleared by any reset. */
  refreshResumed = false;

  get tapeTurboActive(): boolean { return this._tapeTurboActive; }

  /** VIC-IIe registers $D02F (the keyboard lines it selects, bits 0-2) and
   *  $D030 (bit 0 is the 2 MHz mode, which is not modelled yet). */
  private kbdLines = 0x07;
  private vicClockReg = 0;
  get keyboardLinesSelected(): number { return this.kbdLines; }
  get vicClockRegister(): number { return this.vicClockReg; }

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
    this.tape = new TapeDeck(this.timing.clockHz);
    this.tape.pulseScale = this.timing.clockHz / TAPE_REF_HZ;
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
    this.iec.driveModels = ['1571'];
    this.iec.attachFastSerial(this.cia1, this.timing.clockHz);
    this.memory.mmu.onFastSerialDir = (out) => { this.iec.fastHostTransmits = out; };
    // CAPS LOCK and the 40/80 key latch: a host key or the on-screen keyboard flips them.
    this.keyboard.onLatchChange = () => {
      this.setCapsLock(this.keyboard.capsLock);
      this.setDisplay80(this.keyboard.display80);
    };
    this.services = createC128Services(this);
  }

  // ── Disk drives ──────────────────────────────────────────────────────────

  /** Fit these drives, device 8 first (see `CbmSerialBus.fitDrives`). */
  fitDrives(models: readonly CbmDriveModel[]): void { this.iec.fitDrives(models); }

  /** Put the DOS ROM in every drive of that model. */
  installDriveRom(model: CbmDriveModel, rom: Uint8Array): void { this.iec.installDriveRom(model, rom); }

  /** Fit a drive running the DOS in `rom`, or take every drive off the bus
   *  (null); see `CbmSerialBus.installDrive`. The default is a 1571. */
  installDrive(rom: Uint8Array | null, model: CbmDriveModel = '1571'): void {
    this.iec.installDrive(rom, model);
  }

  /** Bring the drives up to the machine's cycle `t`. */
  private syncDrive(t: number): void { this.iec.syncTo(t, this.timing.clockHz); }

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
    cia1.portAIn = (driven) => {
      const joy = this.joyBits(2);
      if (joy !== 0) this.activity.joyReads++;
      return driven & ~joy & keyboard.columnsFor(cia1.drivenB & ~this.joyBits(1));
    };
    cia1.portBIn = (driven) => {
      this.activity.kbdReads++;
      return driven & ~this.joyBits(1)
        & keyboard.rowsForLines(cia1.drivenA & ~this.joyBits(2), mmu.c64Mode ? 0x07 : this.kbdLines);
    };
    // The paddle lines of the control port CIA 1 port A bits 6-7 select
    // (bit 6 port 1, bit 7 port 2) go to the SID; a 1351 answers on its own.
    sid.potRead = (axis) => {
      const sel = cia1.drivenA & 0xC0;
      const selected = sel === 0x40 ? 1 : sel === 0x80 ? 2 : 0;
      if (this.mousePort === 0 || selected !== this.mousePort) return 0xFF;
      return ((axis === 0 ? this.mouseX : this.mouseY) & 0x3F) << 1;
    };
    // CIA 2 port A: VIC bank (bits 0-1), the serial bus outputs through
    // inverters (ATN 3, CLK 4, DATA 5) and inputs (CLK 6, DATA 7). A line is
    // low while the machine or any drive pulls it.
    cia2.portAIn = (driven) => {
      const clkLow = (driven & 0x10) !== 0 || this.iec.clkLow;
      const dataLow = (driven & 0x20) !== 0 || this.iec.dataLow;
      return (driven & 0x3F) | (clkLow ? 0 : 0x40) | (dataLow ? 0 : 0x80);
    };
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
        case 0xC: {
          const t = this.accessT(addr, false);
          cia1.advanceTo(t);
          if ((addr & 0x0F) === 0x0D) this.icrReads++;
          // The fast serial port's bits arrive from the drive as it runs.
          if (this.iec.fitted && ((addr & 0x0F) === 0x0C || (addr & 0x0F) === 0x0D)) this.syncDrive(t);
          return cia1.read(addr);
        }
        case 0xD: {
          const t = this.accessT(addr, false);
          cia2.advanceTo(t);
          if (this.iec.fitted && (addr & 0x0F) === 0) this.syncDrive(t);
          return cia2.read(addr);
        }
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
          this.activity.sidWrites++;
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
        case 0xC: {
          cia1.advanceTo(t);
          // The shift register and its control: the drive's end must be as
          // far on as ours when a byte is sent or the direction changes.
          const fast = this.iec.fitted && ((addr & 0x0F) === 0x0C || (addr & 0x0F) === 0x0E);
          if (fast) this.syncDrive(t);
          cia1.write(addr, value);
          break;
        }
        case 0xD: {
          cia2.advanceTo(t);
          const bus = this.iec.fitted && ((addr & 0x0F) === 0 || (addr & 0x0F) === 2);
          if (bus) { this.syncDrive(t); this.iecWrites++; }
          cia2.write(addr, value);
          if (bus) this.iec.update();
          break;
        }
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
    memory.onPortChange = () => this.portChanged();
  }

  /** The 8502 port changed: follow the motor and the write line. */
  private portChanged(): void {
    const motor = this.memory.motorOn;
    if (motor !== this.motorWasOn) {
      this.motorWasOn = motor;
      if (this.tape.loaded && this.tape.playing) {
        if (motor) this.tapeLastT = this.cpu.tStates;
        this.tape.paused = !motor;
      }
    }
    if (motor) this.tapeRecorder.observe(this.memory.cassetteWrite ? 1 : 0, this.cpu.tStates);
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  reset(): void {
    this.stop();
    this.resetHardware();
    this.resetFrameCount();
    this.setStatus('Reset');
  }

  /**
   * Install the system ROM as the ROM host serves it: the six images end to
   * end (BASIC low, BASIC high, the system ROM, the character ROM, 64 BASIC,
   * 64 KERNAL; see `C128_ROM_CHIP_SIZES`). A shorter image fills the sockets it
   * reaches and leaves the others as they are.
   */
  loadROM(data: Uint8Array): void {
    let at = 0;
    const chips = C128_ROM_CHIP_SIZES.map((size): Uint8Array | null => {
      const chip = at + size <= data.length ? data.subarray(at, at + size) : null;
      at += size;
      return chip;
    });
    this.loadRoms(chips[0], chips[1], chips[2], chips[3], chips[4], chips[5]);
    this.setStatus(`C128 ROMs loaded (${data.length} bytes)`);
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
    this.joy1 = this.joy2 = 0;
    this.memory.capsLockDown = this.keyboard.capsLock;
    this.memory.cassetteSense = this.tapeSense;
    this.memory.pinsChanged();
    this.memory.mmu.displayKeyUp = !this.keyboard.display80;
    this.cpu.reset();
    this.z80.reset();
    this.iec.reset();
    this.tapeRecorder.reset();
    this.recordedAtFrame = 0;
    this.motorWasOn = false;
    if (this.tape.loaded) this.tape.paused = true;
    this._tapeTurboActive = false;
    this.tapeTurboCooldown = 0;
    this.framesSinceReset = 0;
    this.pendingProgram = null;
    this.c64KeyFrames = 0;
    this.refreshResumed = false;
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
    this.tapeLastT = t;
    this.audioLastT = t;
  }

  // ── Datasette ────────────────────────────────────────────────────────────

  /** A button is down on the deck. A mounted tape has PLAY down until the
   *  user stops it; an empty deck stands for a blank cassette with RECORD and
   *  PLAY down, so SAVE goes straight to the recorder (and LOAD searches, as
   *  it would on a blank tape). */
  private get tapeSense(): boolean { return !this.tape.loaded || this.tape.playing; }

  /** The tape was mounted, ejected, played or stopped: PLAY follows it, and
   *  the deck runs only while the motor is on. */
  tapeTransportChanged(): void {
    this.memory.cassetteSense = this.tapeSense;
    this.memory.pinsChanged();
    this.motorWasOn = this.memory.motorOn;
    this.tapeLastT = this.cpu.tStates;
    this.prevEar = this.tape.earBit;
    if (this.tape.loaded && this.tape.playing) this.tape.paused = !this.motorWasOn;
  }

  /** Mounting a tape leaves PLAY up (with it down the KERNAL would run the
   *  motor at the READY prompt and wind the tape on); PLAY goes down by
   *  itself the first time software sits waiting for it. */
  armAutoPlay(): void { this.autoPlayArmed = true; }

  /** PLAY, pressed for a program polling the sense line (the KERNAL's PRESS
   *  PLAY ON TAPE loop, or a loader's own). */
  private checkAutoPlay(): void {
    const polls = this.memory.portReads;
    this.memory.portReads = 0;
    if (!this.autoPlayArmed || !this.tape.loaded || this.tape.playing) return;
    if (polls < AUTO_PLAY_POLLS) return;
    this.autoPlayArmed = false;
    this.tape.startPlayback();
    this.tapeTransportChanged();
    this.setStatus('PLAY pressed on the Datasette');
  }

  /** Turbo while the KERNAL (or a loader) is reading the tape — the motor
   *  is on and the deck is moving — or saving to the empty deck, or a disk is
   *  busy. */
  private updateTapeTurbo(): void {
    const reading = this.tape.playing && !this.tape.paused && this.icrReads >= TURBO_ICR_READS;
    const writing = this.tapeRecorder.count !== this.recordedAtFrame;
    this.icrReads = 0;
    this.recordedAtFrame = this.tapeRecorder.count;
    // A disk is busy while a motor runs and either the controller moves bytes
    // or the serial bus is carrying them (a 1581 reads a sector in a blink and
    // then spends the best part of a second sending it).
    let diskBusy = false;
    const busy = this.iecWrites >= IEC_BUSY_WRITES;
    this.iecWrites = 0;
    for (const d of this.drives) if ((d.takeActivity() > 0 || busy) && d.motorOn) diskBusy = true;
    const loading = (this.memory.motorOn && (reading || writing)) || diskBusy;
    if (loading) {
      this._tapeTurboActive = this.tapeTurbo;
      this.tapeTurboCooldown = TAPE_TURBO_COOLDOWN;
    } else if (this.tapeTurboCooldown > 0) {
      if (--this.tapeTurboCooldown === 0) this.releaseTapeTurbo();
    } else if (this._tapeTurboActive) {
      this.releaseTapeTurbo();
    }
  }

  private releaseTapeTurbo(): void {
    if (!this._tapeTurboActive) return;
    this._tapeTurboActive = false;
    this.sid.flush();
    this.mixer.reset();
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
  protected inTurbo(): boolean { return this.turbo || this._tapeTurboActive; }
  protected override interruptEntryPending(): boolean { return this.running8502 && this.cpu.interruptPending(); }
  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.running8502 ? this.cpu.sp : this.z80.sp; }
  protected override cpuPc(): number { return this.running8502 ? this.cpu.pc : this.z80.pc; }

  /** Which CPU is running: the 8502 once the BIOS has handed over. */
  get cpuIs8502(): boolean { return this.running8502; }

  protected runFrame(): void {
    const skipAudio = this.speedMultiplier !== 1 || this._tapeTurboActive;
    this.sid.audible = !skipAudio;
    if (!this.openFrame(this.timing.cyclesPerFrame)) {
      this.activity.kbdReads = 0;
      this.activity.sidWrites = 0;
      this.activity.tapeEdges = 0;
      this.activity.joyReads = 0;
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
    this.framesSinceReset++;
    if (this.c64KeyFrames > 0 && --this.c64KeyFrames === 0) this.keyboard.setKey('cbm', false);
    if (this.pendingProgram && this.basicReady()) this.applyPendingProgram();
    if (skipAudio) { this.audioLastT = this.cpu.tStates; this.sid.advanceTo(this.cpu.tStates); }
    this.syncDrive(this.cpu.tStates);
    this.vdc.tickFrame();
    this.drawVdc();
    this.checkAutoPlay();
    this.updateTapeTurbo();
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
    this.applyViewport();
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

  /** After each instruction: the tape, the CIAs and the interrupt lines. */
  private afterStep(): void {
    const now = this.cpu.tStates;
    const tape = this.tape;
    if (tape.playing && !tape.paused) {
      const gap = now - this.tapeLastT;
      this.tapeLastT = now;
      if (gap > 0) tape.advance(gap);
      const ear = tape.earBit;
      if (ear !== this.prevEar) {
        this.prevEar = ear;
        if (ear === 0) { this.cia1.flag(); this.activity.tapeEdges++; }
      }
    }
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

  /** A joystick direction or fire on control port 1 or 2. */
  joystickPress(dir: string, pressed: boolean, port: 1 | 2): void {
    const bit = JOY_BITS[dir];
    if (!bit) return;
    if (port === 1) this.joy1 = pressed ? this.joy1 | bit : this.joy1 & ~bit;
    else this.joy2 = pressed ? this.joy2 | bit : this.joy2 & ~bit;
  }

  releaseJoysticks(): void { this.joy1 = this.joy2 = 0; }

  /** The bits a port reads as held: its joystick, and a mouse's buttons (the
   *  left is the fire button, the right reads as up). */
  private joyBits(port: 1 | 2): number {
    const joy = port === 1 ? this.joy1 : this.joy2;
    if (this.mousePort !== port || this.mouseButtons === 0) return joy;
    return joy | ((this.mouseButtons & 1) !== 0 ? 0x10 : 0) | ((this.mouseButtons & 2) !== 0 ? 0x01 : 0);
  }

  // ── 1351 mouse ───────────────────────────────────────────────────────────

  /** Plug the mouse into a control port, or take it out (0). */
  setMousePort(port: 0 | 1 | 2): void {
    this.mousePort = port;
    if (port === 0) this.mouseButtons = 0;
  }

  /** Move the mouse: the counters the POT lines read count the motion, 6 bits
   *  wrapping, and the driver works out the difference between two reads.
   *  `dy` is screen-down, as the host reports it; the 1351 counts up. */
  moveMouse(dx: number, dy: number): void {
    // A driver reads about once a frame and cannot tell more than half a turn
    // of the counter from a move the other way: a flick is cut to that.
    const cut = (v: number) => Math.max(-31, Math.min(31, Math.round(v)));
    this.mouseX = (this.mouseX + cut(dx)) & 0x3F;
    this.mouseY = (this.mouseY - cut(dy)) & 0x3F;
  }

  setMouseButton(index: number, pressed: boolean): void {
    const bit = index === 0 ? 1 : index === 2 ? 2 : 0;
    if (bit === 0) return;
    this.mouseButtons = pressed ? this.mouseButtons | bit : this.mouseButtons & ~bit;
  }

  // ── Programs (.prg / .t64) ───────────────────────────────────────────────

  /**
   * Start a program the way LOAD and RUN would on a freshly switched-on 128:
   * the machine is reset (so whatever was running cannot be overwritten
   * under it) and the program goes into memory once BASIC is at READY. A
   * program at the start of BASIC gets BASIC's pointers set and, with `run`,
   * RUN typed for it. A BASIC program says which machine it is for by where it
   * starts: $1C01 is BASIC 7.0's (C128 mode), $0801 the 64's, for which the
   * machine starts in C64 mode, as it does with C= held. Machine code stays in
   * the mode the machine is in. Safe while running: it only touches the
   * hardware between frames.
   */
  injectProgram(prog: C64Program, run: boolean): void {
    const want64 = prog.start === BASIC2.start ? true : prog.start === BASIC7.start ? false : this.c64Mode;
    this.resetHardware();
    if (want64) {
      this.keyboard.setKey('cbm', true);
      this.c64KeyFrames = C64_KEY_HOLD_FRAMES;
    }
    this.pendingProgram = { prog, run };
  }

  /** BASIC is ready once the 8502 has had the time to finish starting. */
  private basicReady(): boolean {
    return this.running8502 && this.framesSinceReset >= BOOT_FRAMES;
  }

  private applyPendingProgram(): void {
    const pending = this.pendingProgram;
    if (!pending) return;
    this.pendingProgram = null;
    const { prog, run } = pending;
    const layout = this.c64Mode ? BASIC2 : BASIC7;
    const mode = this.c64Mode ? 'C64 mode' : 'C128 mode';
    const ram = this.memory.ram;
    const end = Math.min(0x10000, prog.start + prog.data.length);
    ram.set(prog.data.subarray(0, end - prog.start), prog.start);
    const isBasic = prog.start === (ram[layout.txttab] | (ram[layout.txttab + 1] << 8)) || prog.start === layout.start;
    if (isBasic) {
      for (const ptr of [layout.vartab, layout.arytab, layout.strend]) {
        ram[ptr] = end & 0xFF;
        ram[ptr + 1] = end >> 8;
      }
      if (run) {
        const keys = [0x52, 0x55, 0x4E, 0x0D];   // R U N <return>
        ram.set(keys, layout.keyBuf);
        ram[layout.keyCount] = keys.length;
      }
      this.setStatus(`Loaded "${prog.name}" (${mode})${run ? ' — RUN' : ''}`);
    } else {
      this.setStatus(`Loaded "${prog.name}" at $${prog.start.toString(16).toUpperCase()} (${mode}) — start it with SYS`);
    }
  }

  // ── Settings and options ─────────────────────────────────────────────────

  get descriptor(): MachineDescriptor {
    return c128Descriptor(this.model, this.timing.ntsc ? 'us' : 'uk', this.showing80);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  applySettings(view: SettingsView): void {
    this.audio.setVolume(view.get('volume', 70) / 100);
    this.tapeTurbo = view.get('tape-turbo-load', true);
    this.sid.setModel(view.get<string>('c64-sid', '6581') === '8580' ? '8580' : '6581');
    this.drives.forEach((d, i) => { d.writeProtected = view.get('write-protect-' + 'abcd'[i], false); });
    const mode = view.get<string>('c128-display', 'auto');
    this.setDisplayMode(mode === '40' || mode === '80' ? mode : 'auto');
  }

  /** The VDC's RAM and the drives are fitted with the power off: size the one
   *  and fit the others, and list the DOS ROMs they need (fetched before the
   *  machine starts). */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.vdc.setRamBytes(view.get<string>('c128-vdc-ram', '16k') === '64k' ? VDC_RAM_64K : VDC_RAM_16K);
    const models = normalizeDriveModels(view.get<unknown>('drive-models:c128', null) ?? ['1571']);
    this.iec.driveModels = models;
    if (!view.get('c128-drive', true)) {
      this.iec.unplug();
      return [];
    }
    this.iec.fitDrives(models);
    return this.iec.romRequests('c64-dos');
  }

  /** The border is fully rendered; the setting crops it: Normal shows it
   *  all, Small half, None just the display window. Both frames are cropped
   *  to the borders their descriptor reports, which is what the TEXT overlay
   *  measures from, so the overlay stays on the characters whatever the setting. */
  setBorderSize(mode: BorderMode): void {
    this.borderMode = mode;
    this.applyViewport();
  }

  private applyViewport(): void {
    if (!this.display) return;
    const frac = this.borderMode === 2 ? 1 : this.borderMode === 1 ? 0.5 : 0;
    const { width, height, borderLeft, borderTop } = this.descriptor.screen;
    const cropX = Math.round(borderLeft * (1 - frac));
    const cropY = Math.round(borderTop * (1 - frac));
    this.display.setViewport(cropX, cropY, width - cropX * 2, height - cropY * 2);
  }

  // ── Beam / debug ─────────────────────────────────────────────────────────

  beam(): BeamPos { return this.gridBeam(); }
  beamInfo(): BeamInfo {
    return {
      cyclesPerLine: this.timing.cyclesPerLine,
      linesPerFrame: this.timing.linesPerFrame,
      displayStart: 0,
      note: `line 0 is raster line 0 and cycle 0 of a line is the ${this.timing.ntsc ? '8564' : '8566'}'s cycle 1, where the raster counter moves on and the raster interrupt is raised; bad lines hold the CPU from cycle 11 to 54 and sprite DMA from cycle 54 on. The display window is lines 51-250. The picture is drawn as the beam goes, caught up before every VIC-IIe and CIA 2 write. The 8502 runs at 1 MHz (2 MHz is not modelled) and the Z80 is stepped at two T-states to a cycle`,
    };
  }
  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }
  protected override interruptedPc(): number { return m6502ReturnAddress(this.cpu.sp, a => this.memory.peekByte(a)); }
  /** No opcode is fetched from I/O, where a read has side effects. */
  protected override peekOpcode(addr: number): number {
    return (addr >> 12) === 0xD && this.memory.ioIn ? -1 : this.memory.peekByte(addr);
  }

  protected override tracer = new M6502Trace(this, { io: [[0xD000, 0xDFFF]], ioLabel: c128IoLabel });

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: `${this.model}-ram-128k.bin` };
  }

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    switch (value) {
      case 'rom-basic-lo': return { data: this.memory.basicLo, baseAddr: 0x4000 };
      case 'rom-basic-hi': return { data: this.memory.basicHi, baseAddr: 0x8000 };
      case 'rom-system': return { data: this.memory.kernal, baseAddr: 0xC000 };
      case 'rom-chargen': return { data: this.memory.chargen, baseAddr: 0xD000 };
      case 'rom-basic64': return { data: this.memory.basic64, baseAddr: 0xA000 };
      case 'rom-kernal64': return { data: this.memory.kernal64, baseAddr: 0xE000 };
      case 'color-ram': return { data: this.memory.colorBanks[0], baseAddr: 0xD800 };
      case 'vdc-ram': return { data: this.vdc.ram, baseAddr: 0 };
      default: return null;
    }
  }

  /** The custom chips (and the drives), for the debugger's `chip_state`. */
  chips(): readonly ChipSection[] { return c128Chips(this); }

  /** The text screen the canvas shows, as text: 80 columns from the VDC's
   *  RAM, or 40 from the VIC-IIe's matrix. */
  ocrScreenForMcp(_mode?: string): string {
    return this.showing80 ? vdcScreenText(this.vdc) : c128ScreenText(this.memory, this.vic.regs);
  }

  // ── TEXT overlay ─────────────────────────────────────────────────────────

  /** Styled OCR (text, coloured HTML, match mask) for the chip on screen. */
  ocrScreenStyled(): C64OcrResult {
    return this.showing80 ? vdcOcrGrid(this.vdc) : this.vicOcrGrid();
  }

  /** The VIC-IIe's 40×25 grid, read the way the 64's is. `c64OcrGrid` takes
   *  the character ROM as the *reference* to match the glyphs the chip fetches,
   *  so it gets the 4K set the VIC-IIe is copying from: the 128's own (the
   *  second half of the character ROM) in C128 mode, the 64's in 64 mode. */
  private vicOcrGrid(): C64OcrResult {
    const mem = this.memory;
    const from = this.c64Mode ? 0x0000 : C128_CHARGEN_128_OFFSET;
    return c64OcrGrid({
      regs: this.vic.regs,
      chargen: mem.chargen.subarray(from, from + 0x1000),
      palette: VIC_PALETTE,
      vicRead: a => mem.vicRead(a),
      colour: i => mem.colorRam[i],
    });
  }

  /**
   * Where the text sits in the frame buffer, in buffer pixels. The 40-column
   * screen is the 320×200 window moved by the scroll registers, as on the 64;
   * the 80-column one is the VDC's own grid, which the register-derived
   * geometry places and sizes.
   */
  get textField(): { x: number; y: number; width: number; height: number } {
    if (this.showing80) {
      const g = vdcGeometry(this.vdc);
      // The smooth scrolls move the picture up and left, so the grid sits that
      // much nearer the frame's top-left corner.
      return {
        x: g.x0 - g.shiftLeft, y: g.y0 - g.vScroll,
        width: g.cols * g.cellTotalW, height: g.rows * g.rowTotal,
      };
    }
    const regs = this.vic.regs;
    return {
      x: C128_BORDER_LEFT + (regs[0x16] & 7),
      y: this.timing.borderTop - 3 + (regs[0x11] & 7),
      width: C128_ACTIVE_WIDTH,
      height: C128_ACTIVE_HEIGHT,
    };
  }

  /** Paint the overlay's matched cells out of the frame, each in its `paper`. */
  blankCells(mask: readonly boolean[], paper: readonly number[]): void {
    const field = this.textField;
    if (this.showing80) this.blankVdcCells(mask, paper, field);
    else this.blankVicCells(mask, paper, field);
    this.needsDisplay = true;
  }

  private blankVdcCells(
    mask: readonly boolean[], paper: readonly number[],
    field: { x: number; y: number; width: number; height: number },
  ): void {
    const g = vdcGeometry(this.vdc);
    if (!g.ok) return;
    const px = this.vdcPixels32;
    for (let row = 0; row < g.rows; row++) {
      const top = field.y + row * g.rowTotal;
      if (top < 0 || top >= VDC_FRAME_HEIGHT) continue;
      for (let col = 0; col < g.cols; col++) {
        const i = row * g.cols + col;
        if (!mask[i]) continue;
        const left = field.x + col * g.cellTotalW;
        const colour = VDC_PALETTE[paper[i] & 0x0F];
        for (let y = 0; y < g.rowShown; y++) {
          const line = top + y;
          if (line < 0 || line >= VDC_FRAME_HEIGHT) continue;
          const base = line * VDC_FRAME_WIDTH;
          for (let x = 0; x < g.cellW; x++) {
            const at = left + x;
            if (at >= 0 && at < VDC_FRAME_WIDTH) px[base + at] = colour;
          }
        }
      }
    }
  }

  private blankVicCells(
    mask: readonly boolean[], paper: readonly number[],
    field: { x: number; y: number; width: number; height: number },
  ): void {
    const px = this.vic.pixels;
    const w = C128_SCREEN_WIDTH;
    for (let row = 0; row < 25; row++) {
      const top = field.y + row * 8;
      if (top + 8 > this.timing.screenHeight) break;
      for (let col = 0; col < 40; col++) {
        if (!mask[row * 40 + col]) continue;
        const left = field.x + col * 8;
        if (left + 8 > w) continue;
        const colour = VIC_PALETTE[paper[row * 40 + col] & 0x0F];
        for (let y = 0; y < 8; y++) {
          const base = (top + y) * w + left;
          px.fill(colour, base, base + 8);
        }
      }
    }
  }

  // ── Snapshots (.c128state) ───────────────────────────────────────────────

  /** CRC-32s of the six ROMs: BASIC low and high, the system ROM, the character
   *  ROM, 64 BASIC and 64 KERNAL. */
  stateRomCrcs(): number[] {
    const m = this.memory;
    return [m.basicLo, m.basicHi, m.kernal, m.chargen, m.basic64, m.kernal64].map(rom => crc32(rom));
  }

  private completeFrame(): void {
    if (this.midFrame) withStopsDisarmed(this, () => this.stepFrame());
  }

  /** The machine between frames. The tape is not part of it. */
  saveState(w: StateWriter, withMedia: boolean): void {
    this.completeFrame();
    w.section('CPU ', () => this.cpu.saveState(w));
    w.section('Z80 ', () => this.z80.saveState(w));
    w.section('MACH', () => {
      w.f64(this.frameStartT); w.f64(this.frameEndT); w.f64(this.frameNumber);
      w.bool(this.nmiLevel); w.bool(this.running8502);
      w.u8(this.kbdLines); w.u8(this.vicClockReg);
      w.bool(this.keyboard.capsLock); w.bool(this.keyboard.display80);
    });
    w.section('TV  ', () => w.bool(this.timing.ntsc));
    w.section('MEM ', () => this.memory.saveState(w));
    w.section('VDC ', () => this.vdc.saveState(w));
    w.section('VIC ', () => this.vic.saveState(w));
    w.section('SID ', () => this.sid.saveState(w));
    w.section('CIA1', () => this.cia1.saveState(w));
    w.section('CIA2', () => this.cia2.saveState(w));
    w.section('SERI', () => {
      this.cia1.saveSerial(w);
      for (const d of this.drives.filter(x => x.hasRom)) {
        const cia = d.fastCia;
        w.bool(cia !== undefined);
        if (cia) cia.saveSerial(w);
      }
    });
    this.iec.saveState(w, withMedia);
  }

  loadState(r: StateReader): void {
    this.cpu.loadState(r.section('CPU '));
    this.z80.loadState(r.section('Z80 '));
    {
      const s = r.section('MACH');
      this.frameStartT = s.f64(); this.frameEndT = s.f64(); this.frameNumber = s.f64();
      this.nmiLevel = s.bool(); this.running8502 = s.bool();
      this.kbdLines = s.u8(); this.vicClockReg = s.u8();
      this.keyboard.capsLock = s.bool(); this.keyboard.display80 = s.bool();
    }
    const ntsc = r.section('TV  ').bool();
    if (ntsc !== this.timing.ntsc) {
      throw new Error(`This is a ${ntsc ? 'NTSC' : 'PAL'} snapshot: choose the ${ntsc ? 'NTSC' : 'PAL'} Commodore 128 first`);
    }
    this.memory.loadState(r.section('MEM '));
    this.vdc.loadState(r.section('VDC '));
    this.vic.loadState(r.section('VIC '));
    this.sid.loadState(r.section('SID '));
    this.cia1.loadState(r.section('CIA1'));
    this.cia2.loadState(r.section('CIA2'));
    const serial = r.section('SERI');
    this.cia1.loadSerial(serial);
    const withMedia = this.iec.loadState(r);
    for (const d of this.drives.filter(x => x.hasRom)) {
      if (serial.bool()) {
        const cia = d.fastCia;
        if (cia) cia.loadSerial(serial);
      }
    }
    this.iec.fastHostTransmits = this.memory.mmu.fastSerialOut;
    this.memory.capsLockDown = this.keyboard.capsLock;
    this.memory.mmu.displayKeyUp = !this.keyboard.display80;
    this.memory.cassetteSense = this.tapeSense;
    this.memory.pinsChanged();
    this.motorWasOn = this.memory.motorOn;
    this.memory.setVicBank((~this.cia2.drivenA) & 3);
    this.midFrame = false;
    this.fLine = 0;
    this.fEvent = 0;
    this.lineLive = false;
    this.irqLine = false;
    this.clearInterrupts();
    this.keyboard.reset();
    this.keyboard.capsLock = this.memory.capsLockDown;
    this.joy1 = this.joy2 = 0;
    this._tapeTurboActive = false;
    this.tapeTurboCooldown = 0;
    this.framesSinceReset = BOOT_FRAMES;
    this.pendingProgram = null;
    this.c64KeyFrames = 0;
    this.tapeLastT = this.cpu.tStates;
    this.audioLastT = this.cpu.tStates;
    this.audio.reset();
    this.mixer.reset();
    this.refreshResumed = !withMedia;
    this.drawVdc();
    this.needsDisplay = true;
  }
}

/** Trace labels for the I/O page. */
function c128IoLabel(addr: number): string {
  switch ((addr >> 8) & 0x0F) {
    case 0x0: case 0x1: case 0x2: case 0x3: return 'VIC';
    case 0x4: return 'SID';
    case 0x5: return 'MMU';
    case 0x6: return 'VDC';
    case 0x8: case 0x9: case 0xA: case 0xB: return 'COLOR';
    case 0xC: return 'CIA1';
    case 0xD: return 'CIA2';
    default: return 'IO';
  }
}
