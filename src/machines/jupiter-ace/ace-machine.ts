/**
 * JupiterAceMachine — the Jupiter Ace orchestrator.
 *
 * A Z80A at 3.25 MHz, 8KB FORTH ROM, 3KB of RAM (1KB video + 1KB char + 1KB
 * main) and the Ace's own ULA: a 32×24 monochrome text generator with an
 * 8×5 keyboard scan and a cassette port, all on ULA port 0xFE. The ULA pulls
 * /INT low once per frame (50 Hz), serviced in interrupt mode 1 by the ROM.
 *
 * The Ace's only sound hardware is a piezo buzzer: a flip-flop set by any
 * write to the ULA port and cleared by any read, which the FORTH BEEP word
 * (0x0BA0) alternates to make a tone — there is no automatic key click. It
 * is mixed through the shared beeper path. There is no disk, no cartridge
 * and no snapshot format — `disks` and `snapshots` are null.
 */

import { Z80 } from '@/cores/z80.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { LoaderDetector } from '@/media/tape/loader-detector.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  Machine, MachineHost, MachineKind, MachineDescriptor, BorderMode, MachineTraceMode,
  SettingsView, AuxRomRequest,
} from '@/machines/machine.ts';
import { aceDescriptor } from './descriptor.ts';
import { createAceServices, type AceServices } from './services/index.ts';
import type { JupiterAceModel } from './models.ts';
import { AceMemory, type AceRamPackKB } from './ace-memory.ts';
import { AceKeyboard } from './keyboard.ts';
import { AceUla } from './ula.ts';
import { installAceMemoryHooks, wireAcePortIO } from './io.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import {
  ACE_CPU_CLOCK, ACE_T_PER_FRAME, ACE_LINES_PER_FRAME, ACE_ACTIVE_LINES,
  ACE_INT_LENGTH_T, ACE_SCREEN_WIDTH, ACE_SCREEN_HEIGHT,
  ACE_BORDER_LEFT, ACE_BORDER_TOP,
} from './constants.ts';

/** PAL scanlines per field. */
const LINES_PER_FRAME = ACE_LINES_PER_FRAME;
/** Active display lines (24 character rows × 8 scanlines). */
const ACTIVE_LINES = ACE_ACTIVE_LINES;

/** Little-endian RGBA: opaque white paper / opaque black ink. */
const PAPER = 0xffffffff;
const INK = 0xff000000;

/** Settings value ('none' | '16k' | '48k') → pack size. Unknown values fall
 *  back to the default (the 48K pack). */
function parseAceRamPack(value: string): AceRamPackKB {
  if (value === 'none') return 0;
  if (value === '16k') return 16;
  return 48;
}

export class JupiterAceMachine extends BaseMachine implements Machine {
  /** The Ace has no PSG; this dormant AY exists only to satisfy the shared
   *  `audioChip` requirement — it is never wired to anything (see zx8x). */
  protected get audioChip(): AY3891x { return this.ay; }
  readonly kind: MachineKind = 'jupiter-ace';
  readonly model: JupiterAceModel;
  /** Operator's panel (shell / MCP) — null when running headless. */
  host: MachineHost | null = null;
  /** The service surface: the only way shell/UI/MCP reach internals. */
  readonly services: AceServices;

  readonly cpu: Z80;
  readonly memory: AceMemory;
  readonly keyboard: AceKeyboard;
  readonly ula: AceUla;
  /** Pulse-level cassette deck (TAP/TZX/CSW), EAR bit sampled on port 0xFE. */
  readonly tape: TapeDeck;
  readonly loaderDetector = new LoaderDetector();
  /** T-state of the last deck advance, for sub-instruction tape catch-up. */
  tapeLastAdvanceT = 0;
  /** "Turbo while loading" setting — run the real loader code faster. */
  tapeTurboEnabled = true;
  /** Tape-turbo engagement state (see runFrame's tail) — feeds inTurbo(). */
  tapeTurboActive = false;
  private tapeTurboCooldown = 0;
  /** Dormant — the Ace has no PSG (see audioChip). */
  readonly ay: AY3891x;
  readonly mixer: AudioMixer;
  readonly audio: Audio;
  display: IScreenRenderer | null;

  /** Per-frame I/O activity for the status-bar LEDs / tape progress. */
  readonly activity = {
    ulaReads: 0,
    tapePolls: 0,
    earReads: 0,
    beeperToggled: false,
    loaderDetected: false,
  };

  /** RGBA frame buffer + a Uint32 view for fast ULA writes. */
  private readonly _pixels = new Uint8Array(ACE_SCREEN_WIDTH * ACE_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  get tStatesPerFrame(): number { return ACE_T_PER_FRAME; }

  constructor(model: JupiterAceModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.cpu = new Z80();
    this.memory = new AceMemory();
    this.keyboard = new AceKeyboard();
    this.ula = new AceUla(this.keyboard);
    this.tape = new TapeDeck(ACE_CPU_CLOCK);
    // TAP/TZX pulse lengths are 3.5MHz-referenced; scale them to the Ace's
    // 3.25 MHz clock (same treatment as the CPC/Einstein/Lynx/SAM decks).
    this.tape.pulseScale = ACE_CPU_CLOCK / TAPE_REF_HZ;
    this.ay = new AY3891x(ACE_CPU_CLOCK, 48000, 'ABC');
    this.audio = new Audio();
    this.mixer = new AudioMixer(ACE_CPU_CLOCK);
    this.mixer.beeperGain = 1;  // the buzzer is the Ace's only sound
    this.mixer.ayGain = 0;      // no PSG
    this.display = display ?? null;

    installAceMemoryHooks(this);
    wireAcePortIO(this);

    this.tape.onPlayStateChange = () => {
      // Any transport boundary invalidates the detector's run of in-shape
      // reads: without this a stop/start straddles the counters and the next
      // poll continues a run that began before the tape moved.
      this.loaderDetector.onTapePlayStateChange();
      // The port handler clears tapeActive on its next read anyway (it calls
      // advanceTapeTo first), but clear it here too so nothing can sample a
      // stale EAR level between the stop and that read.
      if (!this.tape.playing || this.tape.paused) this.ula.tapeActive = false;
    };

    this.services = createAceServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  get descriptor(): MachineDescriptor { return aceDescriptor(this.model); }
  get frameWidth(): number { return ACE_SCREEN_WIDTH; }
  get frameHeight(): number { return ACE_SCREEN_HEIGHT; }
  /** Nominal CPU clock (3.25 MHz). */
  get cpuClockHz(): number { return this.tape.cpuClock; }

  /** RAM export: video RAM + char RAM + main RAM (the Ace's 3KB of RAM). */
  ramExportBytes(): { data: Uint8Array; filename: string } {
    return { data: this.memory.ramSnapshot(), filename: 'jupiter-ace-ram.bin' };
  }

  applySettings(view: SettingsView): void {
    this.memory.setRamPack(parseAceRamPack(view.get('ace-ram-pack', '48k')));
    this.tapeTurboEnabled = view.get('tape-turbo-load', true);
    this.audio.setVolume(view.get('volume', 70) / 100);
  }

  /**
   * The shell runs prepare() after construction but before the system ROM is
   * installed and reset runs — the RAM pack must be mapped by then, because
   * the FORTH ROM probes the expansion at boot and sets RAMTOP accordingly.
   */
  prepare(view: SettingsView): AuxRomRequest[] {
    this.applySettings(view);
    return [];
  }

  // ── Machine: lifecycle ───────────────────────────────────────────────

  loadROM(data: Uint8Array): void {
    this.memory.loadROM(data);
    this.setStatus('ROM loaded');
  }

  /** The Ace has no disk drive; accept the call so the media layer stays
   *  uniform, but there is nowhere to insert it. */
  loadDisk(_image: unknown, _unit = 0): void {}

  /** Resolve the Memory-pane regions: ROM, video RAM, char RAM, main RAM and
   *  the RAM pack when one is fitted. */
  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    switch (value) {
      case 'rom0': return { data: this.memory.getRom(), baseAddr: 0x0000 };
      case 'vram': return { data: this.memory.getVram(), baseAddr: 0x2400 };
      case 'charram': return { data: this.memory.getCharRam(), baseAddr: 0x2C00 };
      case 'ram': return { data: this.memory.getRamBank(0), baseAddr: 0x3C00 };
      case 'expansion': {
        const pack = this.memory.getRamPack();
        return pack ? { data: pack, baseAddr: 0x4000 } : null;
      }
      default: return null;
    }
  }

  /**
   * Advance the tape to the current cpu.tStates and update the ULA EAR bit.
   * Called from the port-in handler (for sub-instruction accuracy) and from
   * the main loop (to catch up after each instruction).
   */
  advanceTapeTo(): void {
    if (!this.tape.playing || this.tape.paused) {
      this.ula.tapeActive = false;
      return;
    }
    const delta = this.cpu.tStates - this.tapeLastAdvanceT;
    if (delta > 0) {
      this.tape.advance(delta);
      this.tapeLastAdvanceT = this.cpu.tStates;
    }
    this.ula.tapeActive = true;
    this.ula.tapeEarBit = this.tape.earBit;
  }

  setBorderSize(mode: BorderMode): void {
    // The ULA always renders into the full framebuffer with the active area
    // centred; cropping is a pure display concern.
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(ACE_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(ACE_BORDER_TOP * (1 - frac));
    if (this.display) {
      this.display.setViewport(
        cropX, cropY,
        ACE_SCREEN_WIDTH - cropX * 2,
        ACE_SCREEN_HEIGHT - cropY * 2,
      );
    }
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    this.memory.reset();
    this.keyboard.reset();
    this.loaderDetector.reset();
    this.ula.tapeActive = false;
    this.ula.micBit = 0;
    this.ula.buzzerBit = 0;
    this.tapeTurboActive = false;
    this.tapeTurboCooldown = 0;
    this.mixer.prevBeeperBit = 0;
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
    this.setStatus('Reset');
  }

  // start / stop / destroy / tick / runUntil live on BaseMachine.

  protected framePixels(): Uint8Array { return this._pixels; }

  /** Manual turbo, or the automatic tape-loading turbo. */
  protected inTurbo(): boolean { return this.turbo || this.tapeTurboActive; }

  /**
   * Execute one PAL field. Runs the CPU scanline by scanline; renders the 192
   * active lines; the ULA's /INT pulse is asserted at the top of the frame and
   * serviced in interrupt mode 1 (RST 38h).
   */
  protected runFrame(): void {
    // Apply any deferred combo keys (modifier was pressed last frame).
    this.keyboard.processPending();
    // Reset activity counters for this frame.
    this.activity.ulaReads = 0;
    this.activity.tapePolls = 0;
    this.activity.earReads = 0;
    this.activity.beeperToggled = false;
    this.activity.loaderDetected = false;
    this.portWatchHit = null;
    this.memWatchHit = null;
    this.tapeLastAdvanceT = this.cpu.tStates;

    // Paper fills the whole buffer — the Ace border is always paper-white.
    this._pixels32.fill(PAPER);

    // The ULA holds /INT low for ACE_INT_LENGTH_T each frame. If the CPU is
    // masking interrupts (DI), the pulse is lost until the next frame; a retry
    // within the window covers EI's one-instruction delay and HALT wake-up.
    let intPending = this.cpu.interrupt() === 0;
    const intWindowEnd = this.cpu.tStates + ACE_INT_LENGTH_T;

    const skipAudio = this.speedMultiplier !== 1 || this.tapeTurboActive;

    const tPerLine = ACE_T_PER_FRAME / LINES_PER_FRAME;
    let lineEnd = this.cpu.tStates;
    let lastAudioT = this.cpu.tStates;
    let broke = false;

    for (let line = 0; line < LINES_PER_FRAME; line++) {
      lineEnd += tPerLine;

      while (this.cpu.tStates < lineEnd) {
        if (this.breakpoints.size > 0 && this.breakpoints.has(this.cpu.pc)) {
          this.breakpointHit = this.cpu.pc;
          broke = true;
          break;
        }
        if (this.onTrap !== null && this.onTrap(this.cpu.pc)) {
          this.breakpointHit = this.cpu.pc;
          broke = true;
          break;
        }

        // EI suppresses interrupts for one instruction; step() itself resets
        // and re-arms eiDelay per-instruction, so a plain post-step check is
        // enough here.
        this.cpu.step();

        // Pending interrupt: /INT is only held low for the pulse window. If EI
        // re-enables interrupts within it, fire; after the window closes the
        // interrupt is lost until the next frame.
        if (intPending) {
          if (this.cpu.tStates >= intWindowEnd) {
            intPending = false;
          } else if (this.cpu.iff1) {
            if (this.cpu.interrupt() > 0) intPending = false;
          }
        }

        // Advance tape playback and update the ULA EAR bit (catches up any
        // T-states not already advanced by the port-in handler).
        if (this.tape.playing && !this.tape.paused) this.advanceTapeTo();

        // Accumulate buzzer duty and generate audio samples. In turbo the
        // per-instruction mixer work dominates and the sound would be
        // unrecognisable anyway — zero the accumulator so it stays in sync.
        if (!skipAudio) {
          const elapsed = this.cpu.tStates - lastAudioT;
          if (elapsed > 0) {
            this.mixer.accumulate(this.ula.buzzerBit, elapsed);
            this.mixer.generateSamples(this.audio, null, false);
            lastAudioT = this.cpu.tStates;
          }
        }
      }
      if (broke) break;

      // Render active scanlines into the centred active area.
      if (line < ACTIVE_LINES) {
        this.renderScanline(ACE_BORDER_TOP + line, line);
      }
    }

    if (skipAudio) this.mixer.beeperTStatesAccum = 0;

    // Tape turbo: while the tape is genuinely being consumed (the loader is
    // polling the ULA), run the real loading code as fast as the pump allows.
    // Same engagement/cooldown shape as the Spectrum: a 25-frame cooldown
    // rides out inter-block gaps so the acceleration doesn't stutter, and a
    // user stop/pause (userOverride) always wins.
    const tapeLoading = this.tape.loaded && !this.tape.finished
                     && !this.loaderDetector.userOverride
                     && !this.tape.paused
                     && (this.loaderDetector.loaderActive
                         || this.activity.tapePolls > 0
                         || this.activity.loaderDetected);
    if (tapeLoading) {
      if (this.tapeTurboEnabled && !this.tapeTurboActive) this.tapeTurboActive = true;
      this.tapeTurboCooldown = 25;
    } else if (this.tapeTurboCooldown > 0) {
      if (--this.tapeTurboCooldown <= 0) {
        this.tapeTurboActive = false;
        this.mixer.reset();
      }
    } else if (this.tapeTurboActive) {
      // Not loading and the cooldown is spent (tape finished/ejected mid-load).
      this.tapeTurboActive = false;
      this.mixer.reset();
    }

    this.loaderDetector.onFrameEnd(ACE_T_PER_FRAME);
    this.needsDisplay = true;
  }

  /**
   * Render one of the 192 active scanlines. Cell (row, col) of the linear
   * screen file holds the character code; bit 7 inverts the glyph, bits 0-6
   * select one of the 128 char-RAM glyphs (the ROM copies its default set in
   * at boot — chars 0-31 are block graphics, 32-127 ASCII).
   */
  private renderScanline(outY: number, line: number): void {
    const vram = this.memory.getVram();
    const chars = this.memory.getCharRam();
    const row = (line >> 3) * 32;   // char row base in the screen file
    const ra = line & 7;            // scanline within the character cell
    let out = outY * ACE_SCREEN_WIDTH + ACE_BORDER_LEFT;
    for (let col = 0; col < 32; col++) {
      const chr = vram[row + col];
      const gfx = chars[((chr & 0x7F) << 3) | ra] ^ (chr & 0x80 ? 0xFF : 0);
      this._pixels32[out] = (gfx & 0x80) ? INK : PAPER;
      this._pixels32[out + 1] = (gfx & 0x40) ? INK : PAPER;
      this._pixels32[out + 2] = (gfx & 0x20) ? INK : PAPER;
      this._pixels32[out + 3] = (gfx & 0x10) ? INK : PAPER;
      this._pixels32[out + 4] = (gfx & 0x08) ? INK : PAPER;
      this._pixels32[out + 5] = (gfx & 0x04) ? INK : PAPER;
      this._pixels32[out + 6] = (gfx & 0x02) ? INK : PAPER;
      this._pixels32[out + 7] = (gfx & 0x01) ? INK : PAPER;
      out += 8;
    }
  }

  // ── Machine: debug helpers ───────────────────────────────────────────

  startTrace(_mode: MachineTraceMode = 'full'): void {
    // Execution tracing is a later addition; no-op so the MCP tool degrades.
  }

  stopTrace(): string { return ''; }

  /** MCP `ocr` tool: the 32×24 screen file read as text (printable ASCII
   *  only — the block-graphics codes render as spaces). */
  ocrScreenForMcp(): string {
    const vram = this.memory.getVram();
    let out = '';
    for (let row = 0; row < 24; row++) {
      for (let col = 0; col < 32; col++) {
        const chr = vram[row * 32 + col] & 0x7F;
        out += chr >= 0x20 && chr < 0x7F ? String.fromCharCode(chr) : ' ';
      }
      out = out.replace(/\s+$/, '') + '\n';
    }
    return out;
  }
}
