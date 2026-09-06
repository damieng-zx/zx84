/**
 * SamMachine — MGT SAM Coupé orchestrator.
 *
 * The SAM's counterpart to `Spectrum` / `CpcMachine` / `MsxMachine`: it owns the
 * Z80B, the paged memory and the MGT ASIC, and drives its own PAL field loop.
 * Implements the shared `Machine` SPI so the shell, UI and MCP server treat it
 * like any other machine.
 *
 * The CPU, memory paging, all four screen modes and both interrupt sources are
 * live, as are the keyboard, the Kempston port, the SAA1099 and the two WD1772
 * drives and the cassette deck. Still to come: snapshots.
 */

import { Z80 } from '@/cores/z80.ts';
import { SAA1099 } from '@/cores/saa1099.ts';
import { TapeDeck, TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { Audio } from '@/audio.ts';
import { AudioMixer } from '@/machines/shared/audio-mixer.ts';
import { disasmOne, type DisasmLine } from '@/debug/z80/disasm.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type {
  BorderMode, Machine, MachineDescriptor, MachineHost, MachineKind,
  MachineTraceMode, SettingsView,
} from '@/machines/machine.ts';
import type { OcrGridName, SamOcrGrid } from '@/ocr/ocr.ts';
import {
  samScreenCells, samScreenText, SAM_FONT_OFFSET, SAM_TEXT_ROWS,
  type SamOcrCells,
} from '@/ocr/sam.ts';
import { BaseMachine } from '@/machines/base-machine.ts';
import { SamMemory } from './sam-memory.ts';
import { SamAsic } from './asic.ts';
import { SamKeyboard } from './sam-keyboard.ts';
import { SamJoystick } from './sam-joystick.ts';
import { SamMouse } from './sam-mouse.ts';
import { SamContention } from './contention.ts';
import { SamDiskInterface } from './peripherals/sam-disk.ts';
import { createSamConfig, samRamLabel, type SamConfig } from './config.ts';
import { samExternalPages, type SamModel } from './models.ts';
import { samDescriptor } from './descriptor.ts';
import { createSamServices, type SamServices } from './services/index.ts';
import { installSamMemoryHooks, wireSamPortIO } from './sam-io.ts';
import {
  SAM_BOOT_KEY_FRAMES,
  SAM_BORDER_LEFT, SAM_BORDER_TOP, SAM_CPU_CLOCK, SAM_DISPLAY_WIDTH,
  SAM_LINES_PER_FRAME, SAM_PAGE_SIZE, SAM_SAA_CLOCK,
  SAM_PALETTES, SAM_SCREEN_HEIGHT, SAM_SCREEN_WIDTH,
  SAM_T_PER_FRAME, SAM_T_PER_LINE,
  type SamColorMap,
} from './constants.ts';
import { SAM_CHARS_ADDR, SAM_SYSVAR_PAGE, SAM_SYSVAR_WINDOW } from './sysvars.ts';

export class SamMachine extends BaseMachine implements Machine {
  protected get audioChip(): SAA1099 { return this.psg; }

  readonly kind: MachineKind = 'sam';
  readonly model: SamModel;
  readonly config: SamConfig;
  /** Operator's panel (shell / MCP) — null when running headless. */
  host: MachineHost | null = null;
  readonly services: SamServices;

  readonly cpu: Z80;
  readonly memory: SamMemory;
  /** The custom silicon: video, palette, border and the interrupt sources. */
  readonly asic: SamAsic;
  readonly keyboard = new SamKeyboard();
  readonly joystick = new SamJoystick();
  /** MGT mouse on the 8-pin DIN port, read through `IN A,(&FFFE)`. */
  readonly mouse = new SamMouse();
  /** The ASIC's RAM slot quantiser (see contention.ts). */
  readonly contention = new SamContention();
  readonly psg: SAA1099;
  /** The two internal 3.5" drives on their WD1772 controllers. */
  readonly disk = new SamDiskInterface();
  /** Cassette deck. Pulse lengths in tape images are referenced to 3.5 MHz,
   *  so the deck scales them to the SAM's 6 MHz clock. */
  readonly tape: TapeDeck;
  readonly mixer: AudioMixer;
  readonly audio: Audio;
  display: IScreenRenderer | null;

  // ── Latches read back through port 0xFE ───────────────────────────────────
  /** Beeper output (port 0xFE bit 4). */
  beeperBit = 0;
  /** Cassette MIC output (port 0xFE bit 3). */
  micBit = 0;
  /** Cassette EAR input level. */
  earBit = 0;

  /** Per-frame I/O activity, mapped onto the status-bar LEDs by the probe. */
  readonly activity = {
    kbdReads: 0, joystickReads: 0, beeperToggles: 0, psgWrites: 0,
    fdcAccesses: 0, tapeReads: 0, mouseReads: 0,
  };

  /** RGBA frame buffer plus a Uint32 view for fast ASIC writes. */
  private readonly _pixels = new Uint8Array(SAM_SCREEN_WIDTH * SAM_SCREEN_HEIGHT * 4);
  private readonly _pixels32 = new Uint32Array(this._pixels.buffer);
  get pixels(): Uint8Array { return this._pixels; }

  get tStatesPerFrame(): number { return SAM_T_PER_FRAME; }
  get cpuClockHz(): number { return SAM_CPU_CLOCK; }
  get frameWidth(): number { return SAM_SCREEN_WIDTH; }
  get frameHeight(): number { return SAM_SCREEN_HEIGHT; }

  constructor(model: SamModel, display?: IScreenRenderer | null) {
    super();
    this.model = model;
    this.config = createSamConfig(model);
    this.cpu = new Z80();
    this.memory = new SamMemory(this.config);
    this.asic = new SamAsic(this.memory);
    this.psg = new SAA1099(SAM_SAA_CLOCK, 44100);
    this.tape = new TapeDeck(SAM_CPU_CLOCK);
    this.tape.pulseScale = SAM_CPU_CLOCK / TAPE_REF_HZ;
    this.audio = new Audio();
    this.mixer = new AudioMixer(SAM_CPU_CLOCK);
    this.mixer.beeperGain = 1;
    this.mixer.psgGain = 1;
    this.display = display ?? null;

    installSamMemoryHooks(this);
    wireSamPortIO(this);

    this.services = createSamServices(this);
  }

  attachHost(host: MachineHost): void { this.host = host; }

  get descriptor(): MachineDescriptor { return samDescriptor(this.model); }

  /** BaseMachine notifies `onStatus`; the SAM also forwards to the attached
   *  host so the shell's status line reflects ROM/reset events. */
  protected override setStatus(msg: string): void {
    super.setStatus(msg);
    this.host?.setStatus(msg);
  }

  // ── Seams used by sam-io.ts ───────────────────────────────────────────────

  /** Port 0xFE keyboard bits for the rows the port's high byte selects. */
  readKeyboardLow(rowSelect: number): number { return this.keyboard.readLow(rowSelect); }
  /** Port 0xF9's top three bits — the SAM's extra keys. */
  readKeyboardHigh(rowSelect: number): number { return this.keyboard.readHigh(rowSelect); }
  /** Kempston joystick on port 0x1F. */
  readKempston(): number { return this.joystick.read(); }

  /** MGT mouse, ANDed into the keyboard bits of `IN A,(&FFFE)` (RDMSEL). */
  readMouse(tStates: number): number {
    const value = this.mouse.read(tStates);
    // Activity means a driver reading a report that actually carries
    // something. The ROM polls this port every frame whether or not anyone is
    // touching the mouse, so both halves are needed to keep the indicator from
    // sticking on — see `SamMouse.sequential` and `SamMouse.reporting`.
    if (this.mouse.sequential && this.mouse.reporting) this.activity.mouseReads++;
    return value;
  }

  /** T-state the deck was last advanced to. */
  private tapeLastAdvanceT = 0;

  /**
   * Catch the cassette up to the current T-state and latch its EAR level.
   *
   * Called from the port 0xFE read handler so each poll of the tape bit sees an
   * up-to-date edge, exactly as the Spectrum does. The SAM has no motor relay
   * to gate on, so playback runs whenever the deck is playing and unpaused.
   */
  advanceTapeTo(): void {
    const now = this.cpu.tStates;
    if (this.tape.playing && !this.tape.paused) {
      const delta = now - this.tapeLastAdvanceT;
      if (delta > 0) this.tape.advance(delta);
      this.earBit = this.tape.earBit;
      // Counted only while the deck is actually running. Port 0xFE is the
      // keyboard as well as the EAR line, and the ROM scans the matrix every
      // frame — counting every read left the EAR LED (and the TEXT LED, which
      // shares its latch) lit from boot to power-off.
      this.activity.tapeReads++;
    }
    // The baseline moves on even while stopped or paused. Leaving it stale
    // would hand the deck the whole paused interval as a single delta on
    // resume, skipping the tape forward by however long the user waited.
    this.tapeLastAdvanceT = now;
  }

  /** Ask for the frame buffer to be re-uploaded on the next display tick.
   *  Services use this after mutating machine state out-of-band. */
  requestRedraw(): void { this.needsDisplay = true; }

  /** Memory fitted, as the Hardware pane shows it ("512K + 2MB external"). */
  get ramLabel(): string {
    return samRamLabel(this.config.internalPages, this.memory.externalPageCount);
  }

  /** Screen-off latch, read back through port 0xFE. */
  get screenOff(): boolean { return this.asic.screenOff; }
  /** Active-low interrupt status, read through port 0xF9. */
  get status(): number { return this.asic.status; }

  // ── Machine: settings, ROM, regions ───────────────────────────────────────

  applySettings(view: SettingsView): void {
    const map = view.get('sam-color-map', 'linear') as SamColorMap;
    this.asic.palette = SAM_PALETTES[map] ?? SAM_PALETTES.linear;
    // Accuracy is the Display pane's shared drop-down: on the SAM its only
    // meaningful step is whether the ASIC's memory slots are charged at all,
    // so "Low" runs uncontended and everything above it contends.
    const accuracy = view.get('scanline-accuracy', 'high') as 'high' | 'mid' | 'low';
    this.contention.enabled = accuracy !== 'low';
    this.memory.setExternalPages(
      samExternalPages(view.get('sam-external-ram', 0)),
    );
    // The Drive pane's per-drive write-protect, shared with every other
    // machine that has built-in floppies.
    this.disk.setWriteProtect(0, view.get('write-protect-a', false));
    this.disk.setWriteProtect(1, view.get('write-protect-b', false));
    this.audio.setVolume(view.get('volume', 70) / 100);
    // Beeper/PSG balance: the SAM is one of the few machines with both, so the
    // Sound pane's Mixer slider has something to weigh.
    const mix = view.get('ay-mix', 50) / 100;
    this.mixer.beeperGain = Math.min(1, 2 * (1 - mix));
    this.mixer.psgGain = Math.min(1, 2 * mix);
    this.needsDisplay = true;
  }

  loadROM(data: Uint8Array): void {
    this.memory.loadRom(data);
    this.setStatus('ROM loaded');
  }

  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null {
    if (value === 'sam-rom0') return { data: this.memory.getRom(0), baseAddr: 0x0000 };
    if (value === 'sam-rom1') return { data: this.memory.getRom(1), baseAddr: 0xC000 };
    return null;
  }

  /** `.scr` export: the 24K display page pair the ASIC is currently fetching. */
  screenExportBytes(): Uint8Array {
    const base = this.memory.videoBasePage;
    const out = new Uint8Array(0x8000);
    out.set(this.memory.videoPage(base), 0);
    out.set(this.memory.videoPage(base + 1), 0x4000);
    return out;
  }

  ramExportBytes(): { data: Uint8Array; filename: string } {
    return {
      data: this.memory.allRam(),
      filename: `ram-${this.config.internalPages * 16}k.bin`,
    };
  }

  // ── Machine: lifecycle ────────────────────────────────────────────────────

  setBorderSize(mode: BorderMode): void {
    // The ASIC always renders the full field; the border size is a pure crop.
    const frac = mode === 2 ? 1 : mode === 1 ? 0.5 : 0;
    const cropX = Math.round(SAM_BORDER_LEFT * (1 - frac));
    const cropY = Math.round(SAM_BORDER_TOP * (1 - frac));
    this.display?.setViewport(
      cropX, cropY,
      SAM_SCREEN_WIDTH - cropX * 2,
      SAM_SCREEN_HEIGHT - cropY * 2,
    );
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
    // The SAM's ROM runs in interrupt mode 1 (RST 38h). Z80.reset() already
    // defaults im = 1, so nothing to force here.
    this.memory.reset();
    this.asic.reset();
    this.keyboard.reset();
    this.joystick.reset();
    this.mouse.reset();
    this.psg.reset();
    this.disk.reset();
    this.tape.stopPlayback();
    this.tapeLastAdvanceT = 0;
    this.beeperBit = 0;
    this.micBit = 0;
    this.audio.reset();
    this.mixer.reset();
    this.needsDisplay = true;
    // `keyboard.reset()` above has already dropped any held boot key.
    this.bootKeyFrames = 0;
    this.setStatus('Reset');
  }

  /**
   * Frames of F9 left to hold for the library's one-click boot, or 0.
   *
   * The SAM has no key-wait loop to trap the way the Spectrum's menu does: it
   * runs a five-second RAM test after reset and scans the keyboard from its
   * frame interrupt throughout. So the boot key is simply held down until the
   * ROM acts on it, which it announces by touching the floppy controller.
   * The ceiling is a safety net for a drive with nothing bootable in it.
   */
  private bootKeyFrames = 0;

  /** F9 on the SAM's keypad: row 2, bit 7 — the key that boots drive 1. */
  private static readonly BOOT_KEY: readonly [number, number] = [2, 7];

  /** Hold the boot key from the next frame on. The shell resets the machine
   *  first, so this is armed against a cold start. */
  armBootTrap(_kind: 'menu' | 'rom48k' | 'disk'): void {
    this.bootKeyFrames = SAM_BOOT_KEY_FRAMES;
    this.keyboard.setKey(SamMachine.BOOT_KEY[0], SamMachine.BOOT_KEY[1], true);
  }

  /** Let the boot key go, once. Safe to call when nothing is armed. */
  private releaseBootKey(): void {
    if (this.bootKeyFrames === 0) return;
    this.bootKeyFrames = 0;
    this.keyboard.setKey(SamMachine.BOOT_KEY[0], SamMachine.BOOT_KEY[1], false);
  }

  protected framePixels(): Uint8Array { return this._pixels; }
  protected inTurbo(): boolean { return this.turbo; }

  /**
   * Execute one PAL field: 312 scanlines of 384 T-states each.
   *
   * Per scanline: latch the ASIC's state, run the CPU to the end of the line
   * (journalling any mid-line palette/border writes), draw the line, then
   * advance the interrupt state machine at the boundary.
   */
  protected runFrame(): void {
    const cpu = this.cpu;
    const asic = this.asic;
    const memory = this.memory;
    const contention = this.contention;
    const skipAudio = this.speedMultiplier !== 1;
    const a = this.activity;
    a.kbdReads = 0; a.joystickReads = 0; a.beeperToggles = 0;
    a.psgWrites = 0; a.fdcAccesses = 0; a.tapeReads = 0; a.mouseReads = 0;

    asic.beginFrame();
    this.tapeLastAdvanceT = cpu.tStates;

    let lineEnd = cpu.tStates;
    let lastAudioT = cpu.tStates;
    let broke = false;

    for (let line = 0; line < SAM_LINES_PER_FRAME; line++) {
      lineEnd += SAM_T_PER_LINE;
      asic.beginLine(line, cpu.tStates);
      contention.beginLine(line, cpu.tStates, memory.videoMode, asic.screenOff);

      while (cpu.tStates < lineEnd) {
        if (this.breakpoints.has(cpu.pc)) { this.breakpointHit = cpu.pc; broke = true; break; }
        if (this.onTrap !== null && this.onTrap(cpu.pc)) { broke = true; break; }

        // Sample where this instruction is fetched from BEFORE stepping: after
        // the step `pc` is the *next* instruction's address, which may well sit
        // in a different section.
        const stepStart = cpu.tStates;
        const contended = contention.enabled && memory.sectionContended[cpu.pc >>> 14] !== 0;
        cpu.step();
        // The ASIC owns most of the memory bus, so an instruction's duration
        // rounds up to the slot width where the raster currently is.
        if (contended) {
          cpu.tStates += contention.instructionDelay(stepStart, cpu.tStates - stepStart);
        }

        // The ASIC drops /INT once its hold time expires, whether or not the
        // CPU ever noticed — an interrupt missed behind a DI is missed for good.
        asic.releaseExpired(cpu.tStates);

        // /INT is level-sensitive and un-acknowledged, so take it as soon as
        // the CPU allows while it is still asserted.
        if (asic.intPending && cpu.iff1 && !cpu.eiDelay) {
          cpu.interrupt();
        }

        if (!skipAudio) {
          const elapsed = cpu.tStates - lastAudioT;
          if (elapsed > 0) {
            this.mixer.accumulate(this.beeperBit, elapsed);
            this.mixer.generateSamples(this.audio, this.psg, true);
            lastAudioT = cpu.tStates;
          }
        }
      }

      // Draw the line even when execution broke inside it, so a breakpoint
      // leaves a coherent partial frame on screen rather than a torn one.
      asic.renderScanline(this._pixels32, line);
      if (broke) break;

      asic.endLine(line, cpu.tStates);
    }

    // The disk answering means the ROM has taken the boot key; anything longer
    // means there was nothing to boot. Either way, stop holding it — a game
    // that reads F9 for itself must not find it stuck down.
    if (this.bootKeyFrames > 0 && (a.fdcAccesses > 0 || --this.bootKeyFrames === 0)) {
      this.releaseBootKey();
    }

    this.needsDisplay = true;
  }

  /** True while any interrupt source is asserted (status bits are active low). */
  get intPending(): boolean { return this.asic.intPending; }

  // ── Machine: debug helpers ────────────────────────────────────────────────

  disasmAt(pc: number): DisasmLine {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 8; i++) buf[i] = this.memory.readByte((pc + i) & 0xFFFF);
    return { ...disasmOne(buf, 0), addr: pc };
  }

  startTrace(_mode: MachineTraceMode = 'full'): void {
    // Execution tracing arrives with the ASIC; no-op so the MCP tool degrades.
  }

  stopTrace(): string { return ''; }

  /**
   * Screen OCR.
   *
   * There is no character grid in memory — the SAM's screen is a bitmap — so
   * this matches 8x8 cells against SAM BASIC's font, which lives in RAM rather
   * than ROM and so follows a program that redefines characters. See
   * `src/ocr/sam.ts` for the layout details, all measured rather than assumed.
   */
  ocrScreenForMcp(_mode: OcrGridName | 'auto' = 'auto'): string {
    const result = samScreenText(this.ocrVram(), this.memory.videoMode, this.ocrFont());
    if (!result) return SAM_OCR_UNAVAILABLE;
    return `[${samGrid(this.memory.videoMode)}]\n${result.text}`;
  }

  /** Reader over the 24K display window the ASIC is currently fetching. */
  private ocrVram(): (off: number) => number {
    const base = this.memory.videoBasePage;
    const pageA = this.memory.videoPage(base);
    const pageB = this.memory.videoPage(base + 1);
    return (off: number) => (off < 0x4000 ? pageA[off] : pageB[off - 0x4000]);
  }

  /**
   * SAM BASIC's live character set.
   *
   * Taken from CHARS (SVAR &36, at 0x5C36 in the system page) rather than the
   * fixed 0x5090 so a program that repoints the character set is still
   * transcribed. CHARS points 256 bytes below CHR$ 0's definition, exactly as
   * the Spectrum's does, and the pointer is a plain 16-bit address in the
   * system page's own window at 0x4000.
   */
  private ocrFont(): Uint8Array {
    const page = this.memory.getRamBank(SAM_SYSVAR_PAGE);
    const lo = page[SAM_CHARS_ADDR - SAM_SYSVAR_WINDOW];
    const hi = page[SAM_CHARS_ADDR - SAM_SYSVAR_WINDOW + 1];
    const chars = (hi << 8) | lo;
    // Fall back to the power-on address when CHARS points outside this page —
    // a screen font living elsewhere is not something we can follow.
    const offset = chars >= SAM_SYSVAR_WINDOW && chars < SAM_SYSVAR_WINDOW + SAM_PAGE_SIZE - 0x400
      ? chars - SAM_SYSVAR_WINDOW
      : SAM_FONT_OFFSET;
    return page.subarray(offset, offset + 128 * 8);
  }

  /**
   * Screen OCR for the TEXT overlay: the same transcription, plus the colours
   * and cell rectangles the overlay needs.
   *
   * Colour is sampled from the RENDERED frame buffer rather than derived from
   * the CLUT. Modes 1 and 2 keep their colours in an attribute area the OCR
   * reader never touches, and in every mode the ROM's wallpaper rewrites a
   * palette entry mid-scanline — so the only answer that matches what the user
   * is looking at is the pixel that is already on screen.
   */
  ocrScreenStyled(): SamStyledOcr {
    const mode = this.memory.videoMode;
    const cells = samScreenCells(this.ocrVram(), mode, this.ocrFont());
    if (!cells) {
      return { text: '', html: '', grid: samGrid(mode), cells: null };
    }

    // Slot each detected row into the overlay's fixed 9-pixel grid so a blank
    // band on screen stays a blank line in the overlay, instead of every line
    // below it sliding up.
    const rowOf = new Array<number>(cells.rows);
    const taken = new Set<number>();
    for (let r = 0; r < cells.rows; r++) {
      let slot = Math.min(SAM_TEXT_ROWS - 1, Math.round(cells.rowTops[r] / 9));
      while (slot < SAM_TEXT_ROWS - 1 && taken.has(slot)) slot++;
      taken.add(slot);
      rowOf[r] = slot;
    }

    const lines: string[] = new Array(SAM_TEXT_ROWS).fill('');
    const htmlRows: string[] = new Array(SAM_TEXT_ROWS).fill('');
    for (let r = 0; r < cells.rows; r++) {
      let text = '';
      let html = '';
      let openHex = '';
      for (let col = 0; col < cells.cols; col++) {
        const idx = r * cells.cols + col;
        const ch = cells.chars[idx];
        text += ch;
        if (ch === ' ') {
          if (openHex) { html += '</span>'; openHex = ''; }
          html += ' ';
          continue;
        }
        const hex = this.pixelHex(cells.width, cells.inkX[idx], cells.inkY[idx]);
        if (hex !== openHex) {
          if (openHex) html += '</span>';
          html += `<span style="color:${hex}">`;
          openHex = hex;
        }
        html += ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
      }
      if (openHex) html += '</span>';
      lines[rowOf[r]] = text.replace(/\s+$/, '');
      htmlRows[rowOf[r]] = html;
    }

    return {
      text: lines.join('\n').replace(/\n+$/, ''),
      html: htmlRows.join('\n'),
      grid: samGrid(mode),
      cells,
    };
  }

  /** CSS colour of the frame-buffer pixel under a display-space coordinate. */
  private pixelHex(displayWidth: number, x: number, y: number): string {
    if (x < 0 || y < 0) return '#ffffff';
    const abgr = this._pixels32[this.bufferIndex(displayWidth, x, y)];
    const r = abgr & 0xFF, g = (abgr >>> 8) & 0xFF, b = (abgr >>> 16) & 0xFF;
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  /** Display-space (x,y) → index into the full-border frame buffer. */
  private bufferIndex(displayWidth: number, x: number, y: number): number {
    const scale = SAM_DISPLAY_WIDTH / displayWidth;
    const bx = SAM_BORDER_LEFT + Math.round(x * scale);
    const by = SAM_BORDER_TOP + y;
    return by * SAM_SCREEN_WIDTH + bx;
  }

  /**
   * Clear every transcribed cell to its own paper colour, so the overlay's
   * text sits on a clean background instead of over the pixels it duplicates.
   * Unmatched cells are left alone — those are graphics the overlay is not
   * replacing.
   */
  blankCells(cells: SamOcrCells): void {
    const scale = SAM_DISPLAY_WIDTH / cells.width;
    const cellW = Math.round(8 * scale);
    for (let r = 0; r < cells.rows; r++) {
      const top = SAM_BORDER_TOP + cells.rowTops[r];
      for (let col = 0; col < cells.cols; col++) {
        const idx = r * cells.cols + col;
        if (!cells.mask[idx]) continue;
        const px = cells.paperX[idx];
        const fill = px < 0
          ? 0xFF000000
          : this._pixels32[this.bufferIndex(cells.width, px, cells.paperY[idx])];
        const x0 = SAM_BORDER_LEFT + Math.round(col * 8 * scale);
        for (let y = 0; y < 8; y++) {
          const base = (top + y) * SAM_SCREEN_WIDTH + x0;
          this._pixels32.fill(fill, base, base + cellW);
        }
      }
    }
  }
}

/** Text grid label for a screen mode — mode 3 is 512 pixels across. */
function samGrid(mode: 1 | 2 | 3 | 4): SamOcrGrid {
  return mode === 3 ? '64x21' : '32x21';
}

/** Why OCR could not run. Shared by the MCP tool and the TEXT overlay. */
export const SAM_OCR_UNAVAILABLE =
  '[sam] OCR unavailable: no usable font table at the expected address, '
  + 'so the screen cannot be transcribed.';

/** Styled transcription: overlay text/HTML plus the cells to blank under it. */
export interface SamStyledOcr {
  readonly text: string;
  readonly html: string;
  readonly grid: SamOcrGrid;
  /** null when no font was found and nothing was transcribed. */
  readonly cells: SamOcrCells | null;
}
