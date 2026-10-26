/**
 * Currah µSpeech — a speech synthesiser for the Spectrum's edge connector: a
 * General Instrument SP0256-AL2 allophone chip behind a 2 KB ROM that adds a
 * speech vocabulary to BASIC (`LET s$=…` is spoken from the interrupt routine).
 *
 * The unit is memory-mapped and has no I/O ports. While its ROM is switched in it
 * takes over the whole of 0x0000-0x3FFF:
 *
 *   0x0000-0x07FF  µSpeech ROM            (mirrored at 0x0800-0x0FFF)
 *   0x1000-0x1FFF  SP0256 interface       read: bit 0 = busy (LRQ deasserted)
 *                                         write: bits 0-5 = allophone number
 *   0x3000 / 0x3001  write: pitch select, low / high (bit 6 of the allophone,
 *                                         which the ROM routes to the address that
 *                                         raises the SP0256 clock a few percent)
 *
 * Paging is a toggle on the Z80's own interrupt routine. Any access to address
 * 0x0038 flips a latch: the first RST 38 / IM 1 interrupt maps the ROM in, and the
 * ROM's last act is to JP 0x0038 again, which flips it back out. The flip lands
 * AFTER the access that caused it — the opcode at 0x0038 is fetched from whichever
 * ROM is current (it is PUSH AF in both, which is how the ROM begins by undoing it
 * with POP AF). Only opcode fetches at 0x0038 are modelled; the real address
 * decode also reacts to data reads, writes and port cycles, which no software uses.
 *
 * Slot 0 is overlaid with `setSlot0`, like the other shadow-ROM interfaces. The
 * interface register at 0x1000 is memory-mapped but the CPU's read path is a bare
 * array lookup, so the busy bit is kept in the overlay: `sync` refreshes that page
 * whenever the chip's LRQ changes.
 *
 * Both ROMs (the µSpeech's 2 KB and the SP0256-AL2's 2 KB) are external images.
 */

import { Sp0256, SP0256_CLOCKS_PER_SAMPLE, SP0256_NOMINAL_CLOCK } from '@/cores/sp0256.ts';
import type { SpectrumMemory } from '@/machines/spectrum/memory.ts';

/** The address whose opcode fetch toggles the unit. */
export const USPEECH_TOGGLE_ADDR = 0x0038;

/** SP0256 clock with the pitch register set high, relative to low. */
const HIGH_PITCH_RATIO = 1.07;
/** The SP0256's output filter: it rolls off above the 5 kHz Nyquist of a 10 kHz stream. */
const OUTPUT_CUTOFF_HZ = 3800;
/** The chip's output is quiet next to the beeper; bring it to a comparable level. */
const OUTPUT_GAIN = 2.6;

export class CurrahUSpeech {
  enabled = false;
  /** The µSpeech ROM is currently switched in over 0x0000-0x3FFF. */
  pagedIn = false;
  /** The µSpeech ROM image is present. */
  romLoaded = false;

  /** The 2 KB µSpeech ROM. */
  readonly rom = new Uint8Array(2048);
  readonly chip = new Sp0256();

  /** Bumped on every allophone accepted — drives the activity LED / MCP status. */
  accepted = 0;
  /** Last command written to the chip (for status). */
  lastCommand = -1;
  /** The pitch latch selects the raised SP0256 clock. */
  highPitch = false;

  private readonly overlay = new Uint8Array(16384);

  // Resampling: the chip streams at clock/312, the speaker at the audio rate.
  private cpuClock = 3_500_000;
  private audioRate = 44100;
  private tStatesPerChipSample = 0;
  private phase = 0;
  private prev = 0;
  private cur = 0;
  private lp = 0;
  private lpAlpha = 0;
  /** LRQ as last reflected in the overlay's interface page. */
  private shownBusy = false;

  constructor() { this.configure(this.cpuClock, this.audioRate); }

  /** Set the CPU clock and the audio sample rate the output is resampled to. */
  configure(cpuClock: number, audioRate: number): void {
    this.cpuClock = cpuClock;
    this.audioRate = audioRate;
    this.lpAlpha = 1 - Math.exp(-2 * Math.PI * OUTPUT_CUTOFF_HZ / audioRate);
    this.updateChipTiming();
  }

  /** Re-derive the resampling constants if the CPU clock or audio rate changed
   *  (the audio context only reports its real rate once it has started). */
  ensureRates(cpuClock: number, audioRate: number): void {
    if (cpuClock !== this.cpuClock || audioRate !== this.audioRate) this.configure(cpuClock, audioRate);
  }

  private updateChipTiming(): void {
    const clock = SP0256_NOMINAL_CLOCK * (this.highPitch ? HIGH_PITCH_RATIO : 1);
    this.tStatesPerChipSample = this.cpuClock * SP0256_CLOCKS_PER_SAMPLE / clock;
  }

  loadROM(data: Uint8Array): void {
    this.rom.fill(0);
    this.rom.set(data.subarray(0, 2048));
    this.romLoaded = true;
  }

  loadSpeechROM(data: Uint8Array): void { this.chip.loadRom(data); }

  get speechRomLoaded(): boolean { return this.chip.romLoaded; }

  /** Hardware reset: the unit drops out and the speech chip restarts. */
  reset(memory?: SpectrumMemory): void {
    if (this.pagedIn && memory) this.pageOut(memory);
    this.pagedIn = false;
    this.chip.reset();
    this.highPitch = false;
    this.updateChipTiming();
    this.phase = 0;
    this.prev = this.cur = this.lp = 0;
    this.shownBusy = false;
    this.accepted = 0;
    this.lastCommand = -1;
  }

  // ── Paging ──────────────────────────────────────────────────────────────

  /** True if the instruction about to run toggles the unit (opcode fetch at 0x0038). */
  togglesAt(pc: number): boolean { return this.enabled && this.romLoaded && pc === USPEECH_TOGGLE_ADDR; }

  /** Flip the paging latch; `otherOverlay` is true when another interface owns slot 0. */
  toggle(memory: SpectrumMemory, otherOverlay: boolean): void {
    if (this.pagedIn) this.pageOut(memory);
    else if (!otherOverlay) this.pageIn(memory);
  }

  private pageIn(memory: SpectrumMemory): void {
    const o = this.overlay;
    o.set(this.rom, 0);
    o.set(this.rom, 0x0800);
    this.shownBusy = !this.chip.ready;
    o.fill(this.statusByte(), 0x1000, 0x2000);
    o.fill(0xFF, 0x2000, 0x4000);
    memory.setSlot0(o);
    this.pagedIn = true;
  }

  pageOut(memory: SpectrumMemory): void {
    if (!this.pagedIn) return;
    memory.restoreSlot0();
    this.pagedIn = false;
  }

  /** What a read of the interface page returns: bit 0 set while LRQ is deasserted. */
  private statusByte(): number { return this.shownBusy ? 0xFF : 0xFE; }

  // ── CPU access (only while paged in) ────────────────────────────────────

  /** A write to 0x0000-0x3FFF with the unit paged in; everything but the two
   *  registers is ROM or unmapped and ignores it. */
  write(addr: number, val: number, memory: SpectrumMemory): void {
    if ((addr & 0xF000) === 0x1000) {
      if (this.chip.writeAld(val & 0x3F)) {
        this.accepted++;
        this.lastCommand = val & 0x3F;
      }
      this.sync(memory);
    } else if ((addr & 0xFFFE) === 0x3000) {
      const high = (addr & 1) !== 0;
      if (high !== this.highPitch) {
        this.highPitch = high;
        this.updateChipTiming();
      }
    }
  }

  /** Reflect the chip's LRQ in the interface page if it changed. */
  sync(memory: SpectrumMemory): void {
    if (!this.pagedIn) return;
    const busy = !this.chip.ready;
    if (busy === this.shownBusy) return;
    this.shownBusy = busy;
    memory.flat.fill(this.statusByte(), 0x1000, 0x2000);
  }

  // ── Speech output ───────────────────────────────────────────────────────

  /** Advance the chip by `tStates` of CPU time. */
  advance(tStates: number, memory: SpectrumMemory): void {
    this.phase += tStates;
    if (this.phase < this.tStatesPerChipSample) return;
    do {
      this.phase -= this.tStatesPerChipSample;
      this.prev = this.cur;
      this.cur = this.chip.nextSample();
    } while (this.phase >= this.tStatesPerChipSample);
    this.sync(memory);
  }

  /** Next output sample at the audio rate: interpolated, then low-passed. */
  generateSampleMono(): number {
    const frac = this.phase / this.tStatesPerChipSample;
    const v = this.prev + (this.cur - this.prev) * frac;
    this.lp += this.lpAlpha * (v - this.lp);
    return this.lp * OUTPUT_GAIN;
  }
}
