/**
 * EnterpriseMachine — the Enterprise 64/128 motherboard.
 *
 * A Z80A at 4MHz, Nick drawing the picture from video RAM, and Dave paging
 * memory, making sound and raising interrupts. The machine owns the bus
 * timing between them: memory outside video RAM costs Dave's wait states
 * (port 0xBF), and any CPU access to video RAM or Nick's ports waits for
 * Nick's next free slot in its 16-clock cycle.
 *
 * Software loads two ways: EXDOS disks through the optional disk card, or
 * bare EXOS files (.com/.bas) through the emulator's FILE: device, which the
 * machine installs as an extension ROM when a file is mounted and serves by
 * trapping the device's entry points (see hostfs.ts).
 */

import { Z80 } from '@/cores/z80.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { resolveDriveCount } from '@/machines/shared/drive-count.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind, MachineTraceMode,
  SettingsView, AuxRomRequest,
} from '@/machines/machine.ts';
import {
  CARTRIDGE_MAX_SIZE, EP_CPU_CLOCK, EP_MAX_DRIVES, EP_FRAME_HEIGHT, EP_FRAME_WIDTH, EP_LINES_PER_FRAME,
  EP_SEGMENT_SIZE, EP_T_PER_FRAME, EP_T_PER_LINE, EP_VSYNC_TO_FIRST_LINE, EXDOS_MAX_SIZE,
  EXOS_MAX_SIZE, EXTENSION_MAX_SIZE, EXTENSION_SOCKETS, NICK_CLOCKS_PER_T, SEG_CARTRIDGE,
  SEG_EXDOS, SEG_EXOS, SEG_EXTENSION, SEG_HOSTFS,
} from './constants.ts';
import type { EnterpriseModel } from './models.ts';
import { EnterpriseMemory } from './memory.ts';
import { Nick, nickScreenText } from './nick.ts';
import { Dave } from './dave.ts';
import { EnterpriseKeyboard } from './keyboard.ts';
import { ExdosCard } from './exdos.ts';
import {
  buildHostFsRom, HostFileBundle, HostFsHandler, type HostFsRegs,
} from './hostfs.ts';
import { wireEnterprisePortIO } from './io.ts';
import { enterpriseDescriptor } from './descriptor.ts';
import { createEnterpriseServices, type EnterpriseServices } from './services/index.ts';

const HOSTFS_ROM = buildHostFsRom();

/** One step of a typed boot sequence: a character to type, or a pause
 *  measured in keyboard scans. */
type TypeStep = { ch: string } | { wait: number };

/** Keyboard scans a typed key is held for, and released for afterwards. */
const TYPE_HOLD_SCANS = 3;
const TYPE_GAP_SCANS = 3;
/** A minute of emulated time: a typer still waiting then never will be. */
const TYPE_GIVE_UP_FRAMES = 50 * 60;

export class EnterpriseMachine extends BaseMachine implements Machine {
  readonly kind: MachineKind = 'enterprise';
  readonly model: EnterpriseModel;
  readonly services: EnterpriseServices;

  readonly cpu = new Z80();
  readonly memory: EnterpriseMemory;
  readonly nick: Nick;
  readonly dave = new Dave();
  readonly keyboard = new EnterpriseKeyboard();
  /** The EXDOS card, when fitted. */
  exdos: ExdosCard | null = null;
  /** Whether the Hardware pane wants the disk card. */
  exdosWanted = true;
  /** How many of the EXDOS card's four drives are fitted (Drives pane choice). */
  driveCount = EP_MAX_DRIVES;
  private exdosRom: Uint8Array | null = null;

  /** FILE: device state; the ROM is only fitted while a bundle is mounted. */
  readonly hostFs = new HostFsHandler();
  private hostFsRegs: HostFsRegs = { a: 0, b: 0, c: 0, d: 0, e: 0 };

  readonly mixer = new AudioMixer(EP_CPU_CLOCK);
  readonly audio = new Audio();
  display: IScreenRenderer | null;

  readonly activity = { kbdReads: 0, fdcAccesses: 0, fileAccesses: 0 };

  private host: MachineHost | null = null;
  private readonly _pixels32 = new Uint32Array(EP_FRAME_WIDTH * EP_FRAME_HEIGHT);
  private readonly _pixels = new Uint8Array(this._pixels32.buffer);

  /** Frame-buffer row of the next Nick line; negative above the picture. */
  private frameRow = 0;
  private prevLineVsync = false;
  /** CPU time the current Nick line began. */
  private lineStartT = 0;
  /** CPU time the audio was last brought up to. */
  private audioT = 0;
  private skipAudio = false;

  /** Non-video memory wait per access (Dave, port 0xBF): 1 in "all", only on
   *  M1 in "M1" mode, none otherwise. */
  private waitAll = 1;
  private waitM1 = 0;

  /** The typer: keys queued for the ROM's keyboard scan. */
  private typeQueue: TypeStep[] = [];
  private typeHold = 0;
  private lastRow = 0;
  /** Frames the typer has left before it gives up on a ROM that never
   *  scans the keyboard. */
  private typeFramesLeft = 0;

  /**
   * Run flat out while the typer is starting a program (the "turbo while
   * loading" setting). Booting is slow on this machine: EXOS tests its RAM,
   * and with the EXDOS card fitted and drive A: empty, EXDOS waits out its
   * read timeout several times over — a WD1770 with no disk never sees an
   * index pulse — some sixteen seconds before BASIC.
   */
  bootTurbo = true;

  constructor(model: EnterpriseModel, display: IScreenRenderer | null = null) {
    super();
    this.model = model;
    this.display = display;
    this.memory = new EnterpriseMemory(model);
    this.nick = new Nick(this.memory.videoRam);
    this.nick.onInterrupt = (active) => this.dave.setInt1(active);
    this.dave.onWaitModeChange = (mode) => this.setWaitMode(mode);

    const mem = this.memory;
    this.cpu.read8 = (addr: number): number => {
      const page = (addr >> 14) & 3;
      if (mem.videoPageMask & (1 << page)) this.videoWait();
      else if (this.waitAll || (this.waitM1 && addr === this.cpu.pc)) this.cpu.tStates++;
      const value = mem.readByte(addr);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.checkMemWatch(addr & 0xFFFF, value, 'read');
      return value;
    };
    this.cpu.write8 = (addr: number, v: number): void => {
      const page = (addr >> 14) & 3;
      if (mem.videoPageMask & (1 << page)) this.videoWait();
      else if (this.waitAll) this.cpu.tStates++;
      mem.writeByte(addr, v);
      if (this.memWatchpoints.length > 0 && this.memWatchHit === null) this.checkMemWatch(addr & 0xFFFF, v & 0xFF, 'write');
    };
    wireEnterprisePortIO(this);

    this.services = createEnterpriseServices(this, () => this.host);
  }

  private checkMemWatch(addr: number, value: number, dir: 'read' | 'write'): void {
    for (const wp of this.memWatchpoints) {
      if ((wp.mode === dir || wp.mode === 'rw') && addr >= wp.start && addr <= wp.end) {
        this.memWatchHit = { addr, value, dir };
        return;
      }
    }
  }

  // ── Bus timing ─────────────────────────────────────────────────────────

  private setWaitMode(mode: number): void {
    this.waitAll = mode === 0 ? 1 : 0;
    this.waitM1 = mode === 1 ? 1 : 0;
  }

  /**
   * Hold the CPU until Nick's next Z80 slot. Nick spends ten of every sixteen
   * of its clocks fetching for the display and gives the CPU the rest; an
   * access arriving outside that window waits for the next one.
   */
  private videoWait(): void {
    const nickPos = ((this.cpu.tStates - this.lineStartT) * NICK_CLOCKS_PER_T) & 15;
    if (nickPos >= 3) this.cpu.tStates += Math.ceil((16 - nickPos) / NICK_CLOCKS_PER_T);
  }

  /** Nick's ports are on its bus too, and wait for the same slot. */
  nickPortWait(): void { this.videoWait(); }

  // ── Machine SPI ────────────────────────────────────────────────────────

  get descriptor(): MachineDescriptor { return enterpriseDescriptor(this.model); }
  get pixels(): Uint8Array { return this._pixels; }
  get frameWidth(): number { return EP_FRAME_WIDTH; }
  get frameHeight(): number { return EP_FRAME_HEIGHT; }
  get tStatesPerFrame(): number { return EP_T_PER_FRAME; }
  get cpuClockHz(): number { return EP_CPU_CLOCK; }

  attachHost(host: MachineHost): void { this.host = host; }

  applySettings(view: SettingsView): void {
    this.bootTurbo = view.get('tape-turbo-load', true);
  }

  setBorderSize(_mode: BorderMode): void { /* fixed geometry */ }

  /** Fit or remove the EXDOS card, and ask for its ROM. */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.exdosWanted = view.get('enterprise-exdos', true);
    this.driveCount = resolveDriveCount(view, 'enterprise', EP_MAX_DRIVES);
    this.setExdosFitted(this.exdosWanted);
    if (!this.exdosWanted) return [];
    return [{
      cacheKey: 'enterprise-exdos-13',
      source: 'enterprise/exdos13.rom',
      fetchingMsg: 'Fetching EXDOS ROM…',
      loadedMsg: (bytes) => `EXDOS ROM loaded (${bytes} bytes)`,
      failMsg: 'Failed to load the EXDOS ROM',
      failId: 'enterprise-exdos',
      apply: (data) => this.installExdosRom(data),
      awaitLoad: true,
    }];
  }

  setExdosFitted(on: boolean): void {
    if (on && !this.exdos) this.exdos = new ExdosCard();
    if (!on) this.exdos = null;
    if (this.exdos) {
      const connected = this.exdos.fdc.connected;
      for (let u = 0; u < connected.length; u++) connected[u] = u < this.driveCount;
    }
    this.pageExdosRom();
  }

  installExdosRom(data: Uint8Array): void {
    this.exdosRom = data.slice(0, EXDOS_MAX_SIZE);
    this.pageExdosRom();
  }

  /** The EXDOS ROM is in the segment space while the card is fitted. */
  private pageExdosRom(): void {
    this.memory.loadRom(SEG_EXDOS, this.exdos ? this.exdosRom : null, EXDOS_MAX_SIZE / EP_SEGMENT_SIZE);
  }

  /**
   * The system ROM set, as romSources concatenates it: EXOS first, then the
   * BASIC cartridge (16K). EXOS is 32K for 2.0/2.1 or 64K for 2.3; a set with
   * no cartridge is EXOS alone.
   */
  loadROM(data: Uint8Array): void {
    let exosLen = data.length;
    if (data.length === 0xC000 || data.length === 0x14000) exosLen = data.length - 0x4000;
    exosLen = Math.min(exosLen, EXOS_MAX_SIZE);
    this.memory.loadRom(SEG_EXOS, data.subarray(0, exosLen), EXOS_MAX_SIZE / EP_SEGMENT_SIZE);
    const cart = data.length > exosLen ? data.subarray(exosLen, exosLen + CARTRIDGE_MAX_SIZE) : null;
    this.memory.loadRom(SEG_CARTRIDGE, cart, CARTRIDGE_MAX_SIZE / EP_SEGMENT_SIZE);
  }

  reset(): void {
    this.cpu.reset();
    this.memory.reset();
    this.nick.reset();
    this.dave.reset();
    this.keyboard.reset();
    this.exdos?.reset();
    this.hostFs.reset();
    this.setWaitMode(0);
    this.frameRow = 0;
    this.prevLineVsync = false;
    this.lineStartT = this.cpu.tStates;
    this.audioT = this.cpu.tStates;
    this.typeHold = 0;
    this.mixer.reset();
  }

  // ── Extension ROM sockets ──────────────────────────────────────────────

  /** What each extension socket holds (null when empty). */
  readonly extensionRoms: (Uint8Array | null)[] = new Array(EXTENSION_SOCKETS).fill(null);

  /** Fit (or with null, empty) extension socket `index`. EXOS finds the ROM
   *  at its next reset. */
  loadExtensionRom(index: number, data: Uint8Array | null): void {
    if (index < 0 || index >= EXTENSION_SOCKETS) return;
    const rom = data ? data.slice(0, EXTENSION_MAX_SIZE) : null;
    this.extensionRoms[index] = rom;
    this.memory.loadRom(SEG_EXTENSION + index * 2, rom, EXTENSION_MAX_SIZE / EP_SEGMENT_SIZE);
  }

  // ── FILE: device ───────────────────────────────────────────────────────

  /** Mount files for the FILE: device (fitting its ROM), or with null take
   *  it away. The caller resets the machine so EXOS finds the device. */
  setFileBundle(bundle: HostFileBundle | null): void {
    this.hostFs.bundle = bundle;
    this.memory.loadRom(SEG_HOSTFS, bundle ? HOSTFS_ROM.image : null, 1);
  }

  get fileBundle(): HostFileBundle | null { return this.hostFs.bundle; }

  /** Serve a FILE: entry point the CPU has reached. */
  private serviceHostFs(fn: number): void {
    const cpu = this.cpu;
    const r = this.hostFsRegs;
    r.a = cpu.a; r.b = cpu.b; r.c = cpu.c; r.d = cpu.d; r.e = cpu.e;
    const mem = this.memory;
    // EXOS keeps the caller's four page segments at 0xBFFC-0xBFFF of its
    // system segment (paged at 0x8000 during a device call).
    const userSeg = (addr: number): Uint8Array | null => mem.segment(mem.readByte(0xBFFC + ((addr >> 14) & 3)));
    this.hostFs.perform(fn, r, {
      read: (addr) => mem.readByte(addr),
      userRead: (addr) => userSeg(addr)?.[addr & 0x3FFF] ?? 0xFF,
      userWrite: (addr, value) => {
        const seg = mem.readByte(0xBFFC + ((addr >> 14) & 3));
        if (mem.isRomSegment(seg)) return;
        const s = mem.segment(seg);
        if (s) s[addr & 0x3FFF] = value;
      },
    });
    cpu.a = r.a; cpu.b = r.b; cpu.c = r.c; cpu.d = r.d; cpu.e = r.e;
    this.activity.fileAccesses++;
  }

  // ── The typer ──────────────────────────────────────────────────────────

  /**
   * Type `text` once the ROM is scanning the keyboard, after first pressing
   * a key to leave the start-up screen (`skipSplash`). `\n` is ENTER.
   */
  typeText(text: string, opts: { skipSplash?: boolean; delayScans?: number } = {}): void {
    const steps: TypeStep[] = [];
    if (opts.delayScans) steps.push({ wait: opts.delayScans });
    if (opts.skipSplash) steps.push({ ch: ' ' }, { wait: 150 });
    for (const ch of text) if (EnterpriseKeyboard.canType(ch)) steps.push({ ch });
    this.typeQueue = steps;
    this.typeHold = 0;
    this.typeFramesLeft = TYPE_GIVE_UP_FRAMES;
  }

  get typing(): boolean { return this.typeQueue.length > 0 || this.typeHold !== 0; }

  /** Port 0xB5 row select. EXOS scans rows 0 to 9 in order, so the step back
   *  to row 0 marks a completed scan — the typer's clock. */
  keyboardRowSelected(row: number): void {
    if (row === 0 && this.lastRow === 9) this.onKeyboardScan();
    this.lastRow = row;
  }

  private onKeyboardScan(): void {
    if (this.typeHold > 0) {
      if (--this.typeHold === 0) {
        this.keyboard.setTypedChar(null);
        this.typeHold = -TYPE_GAP_SCANS;
      }
      return;
    }
    if (this.typeHold < 0) { this.typeHold++; return; }
    const step = this.typeQueue[0];
    if (!step) return;
    if ('wait' in step) {
      if (--step.wait <= 0) this.typeQueue.shift();
      return;
    }
    this.typeQueue.shift();
    this.keyboard.setTypedChar(step.ch);
    this.typeHold = TYPE_HOLD_SCANS;
  }

  // ── Port 0xB6 ──────────────────────────────────────────────────────────

  /** Port 0xB6: b0-b2 external joystick/control inputs for the selected row
   *  (none fitted), b3 printer ready (not), b4-b5 serial, b6-b7 tape input. */
  readControlPort(): number { return 0xFF; }

  /** Bring Dave's audio up to the current CPU time before a register write
   *  changes what it is playing. */
  syncAudio(): void {
    const now = this.cpu.tStates;
    const dt = now - this.audioT;
    if (dt <= 0) return;
    this.audioT = now;
    this.dave.advance(dt, !this.skipAudio);
    if (!this.skipAudio) {
      this.mixer.accumulate(0, dt);
      this.mixer.generateSamples(this.audio, this.dave, true);
    }
  }

  // ── Debug SPI ──────────────────────────────────────────────────────────

  startTrace(_mode: MachineTraceMode = 'full'): void { /* not yet */ }
  stopTrace(): string { return ''; }

  /** The character-mode text on screen, read from Nick's line parameter
   *  table rather than recognised from pixels. */
  ocrScreenForMcp(): string {
    const rows = nickScreenText(this.memory.videoRam, this.nick.lptBase);
    if (rows.length === 0) return '[enterprise] no character-mode text on screen';
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ram.slice(), filename: `ram-${this.model}.bin` };
  }

  // ── Frame ──────────────────────────────────────────────────────────────

  protected get audioChip() { return this.dave; }
  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo || this.bootTurboActive; }

  /** Turbo for the boot the typer is driving. */
  get bootTurboActive(): boolean { return this.bootTurbo && this.typing; }

  protected runFrame(): void {
    this.skipAudio = this.speedMultiplier !== 1 || this.bootTurboActive;
    if (this.typing && --this.typeFramesLeft <= 0) {
      this.typeQueue = [];
      this.typeHold = 0;
      this.keyboard.setTypedChar(null);
    }
    this.activity.kbdReads = 0;
    this.activity.fdcAccesses = 0;
    this.activity.fileAccesses = 0;

    const cpu = this.cpu;
    const dave = this.dave;
    const watchActive = this.portWatchpoints.size > 0 || this.memWatchpoints.length > 0;
    const hostFsFitted = this.hostFs.bundle !== null;
    const traps = HOSTFS_ROM.traps;
    let broke = false;

    for (let line = 0; line < EP_LINES_PER_FRAME && !broke; line++) {
      this.lineStartT = cpu.tStates;
      this.nick.beginLine();
      const lineEnd = this.lineStartT + EP_T_PER_LINE;

      while (cpu.tStates < lineEnd) {
        const pc = cpu.pc;
        if (this.breakpoints.has(pc)) { this.breakpointHit = pc; broke = true; break; }
        if (this.onTrap !== null && this.onTrap(pc)) { broke = true; break; }
        // A FILE: entry point: serve it, then run the entry's NOP straight
        // away so an interrupt taken here cannot make it serve twice.
        let trapped = false;
        if (hostFsFitted && pc >= 0xC000 && this.memory.pages[3] === SEG_HOSTFS) {
          const fn = traps.get(pc);
          if (fn !== undefined) { this.serviceHostFs(fn); trapped = true; }
        }
        // Dave holds /INT low while any latch is set; the Z80 samples it
        // between instructions.
        if (!trapped && dave.irq && cpu.iff1 && !cpu.eiDelay) cpu.interrupt();
        else cpu.step();
        this.syncAudio();
        if (watchActive && (this.portWatchHit !== null || this.memWatchHit !== null)) { broke = true; break; }
      }

      // Frame-buffer row: lines count from the end of the VSYNC block.
      const vsync = this.nick.inVsync;
      if (this.prevLineVsync && !vsync) this.frameRow = -EP_VSYNC_TO_FIRST_LINE;
      this.prevLineVsync = vsync;
      const row = this.frameRow >= 0 && this.frameRow < EP_FRAME_HEIGHT ? this._pixels32 : null;
      this.nick.endLine(row, row ? this.frameRow * EP_FRAME_WIDTH : 0);
      // With no VSYNC in the table (a game mid-setup) keep drawing somewhere.
      if (++this.frameRow > EP_LINES_PER_FRAME * 2) this.frameRow = 0;
    }

    this.exdos?.fdc.tickFrame();
    if (this.display) this.display.updateTexture(this._pixels);
  }
}
