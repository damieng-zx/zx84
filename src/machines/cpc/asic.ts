/**
 * Amstrad ASIC (40489) — the Plus range's gate-array successor.
 *
 * Used by:
 *   - CPC 6128Plus (6128+): replaces the 40010 gate array, the 6128 PAL, the
 *     CRTC 6845, the 8255 PPI, and the uPD765A in a single chip.
 *   - GX4000: the console variant — same ASIC, no disk, no tape.
 *
 * The ASIC is a strict superset of the gate array: it adds a 12-bit palette
 * (4096 colours), 16 hardware sprites, hardware H/V soft scroll + horizontal
 * split screen, a programmable raster interrupt, 3-channel DMA sound feeding
 * the AY-3-8912, an RMR2 banking surface, and a cartridge ROM port. All of
 * these extra features live behind an "ASIC lock": until software writes the
 * 16-byte unlock sequence to the CRTC register-select port, the ASIC behaves
 * bit-for-bit like the discrete gate array, so unmodified CPC software runs
 * unchanged.
 *
 * `Asic` extends `GateArray` and inherits the locked-mode behaviour — pen/mode
 * latching, the 52-line flyback interrupt, mode-0/1/2 rendering. Phase 2 adds
 * the unlock sequence, ASIC RAM paging, the extended 12-bit palette, and the
 * RMR2 banking surface. Phase 3+ adds sprites, scroll, split, raster IRQ and
 * DMA sound as overrides on top.
 *
 * Hot-path note: ASIC-paged writes go through `cpuWrite()` once per CPU store
 * (tier 3), not per-T-state (tier 1/2). The `locked` short-circuit keeps the
 * non-Plus cost to zero.
 */

import { CPC_SCREEN_WIDTH, CPC_BORDER_LEFT, CPC_BORDER_TOP } from '@/machines/cpc/constants.ts';
import { GateArray, FN_RMR } from '@/machines/cpc/gate-array.ts';
import type { CrtcLine } from '@/cores/crtc-6845.ts';

/**
 * The 16-byte key poked through the CRTC register-select port (&BC00) that
 * arms the ASIC lock toggle; the 17th byte then flips the lock (unlock/lock).
 * Real hardware matches it byte-for-byte against an internal state machine; a
 * single mismatch resets the matcher (the leading 0xFF re-syncs it). Source:
 * Grimware CPC Plus ASIC documentation / Caprice32 `asic_locked_seq`.
 *
 * The first byte is 0xFF, NOT 0x00 — a 0x00 here never matches the sequence
 * real Plus software sends (e.g. Batman The Movie's loader writes
 * FF 00 FF 77 … CD EE), so the ASIC would never unlock and every ASIC game
 * hangs waiting for it.
 */
const LOCK_SEQUENCE: readonly number[] = [
  0xFF, 0x00, 0xFF, 0x77, 0xB3, 0x51, 0xA8, 0xD4,
  0x62, 0x39, 0x9C, 0x46, 0x2B, 0x15, 0x8A, 0xCD,
];

/** Mask selecting the top three bits — %101xxxxx = RMR2 escape in the GA
 *  command byte (FN_RMR = %100xxxxx with bit 5 set). */
const RMR2_MASK = 0xE0;
/** The %101 prefix that distinguishes RMR2 from a plain FN_RMR byte. */
const RMR2_PREFIX = 0xA0;

/** ASIC RAM regions within the 16 KB register window (CPU addresses
 *  &4000–&7FFF while paged). Offsets are within `registerPage`. */
const ASIC_SPRITE_PIXELS_OFFSET = 0x0000;   // &4000 — 16 sprites × 256 bytes (4 KB)
const ASIC_SPRITE_ATTRS_OFFSET = 0x2000;    // &6000 — 16 sprites × 8 bytes (128 B)
const ASIC_PALETTE_OFFSET = 0x2400;         // &6400 — 32 pens × 2 bytes (64 B)
const ASIC_PALETTE_BYTES = 32 * 2;
const ASIC_RASTER_IRQ_OFFSET = 0x2800;      // &6800 — raster interrupt scanline
const ASIC_SPLIT_SCANLINE_OFFSET = 0x2801;  // &6801 — split scanline
const ASIC_SPLIT_ADDR_HI_OFFSET = 0x2802;   // &6802 — split address high
const ASIC_SPLIT_ADDR_LO_OFFSET = 0x2803;   // &6803 — split address low
const ASIC_SCROLL_OFFSET = 0x2804;          // &6804 — scroll / extend border
const ASIC_VECTOR_OFFSET = 0x2805;          // &6805 — interrupt vector
const ASIC_DMA_CHAN_OFFSET = 0x2C00;        // &6C00 — 3 channels × 4 bytes
const ASIC_DMA_DCSR_OFFSET = 0x2C0F;        // &6C0F — DMA control/status

/** Number of hardware sprites the ASIC renders (fixed in hardware). */
const SPRITE_COUNT = 16;
/** Native sprite dimensions in pixels (each axis independently magnified). */
const SPRITE_NATIVE = 16;

/**
 * Expand a 4-bit channel value (0–15) to 8 bits by scaling ×17, matching the
 * ASIC's analogue output stage: 0→0, 1→17, …, 15→255. (Nibble replication.)
 */
function nibbleToByte(n: number): number {
  return n | (n << 4);
}

/**
 * Decode a 2-bit magnification field into a pixel multiplier per the Arnold V
 * spec: %00 = not displayed (0×), %01 = 1×, %10 = 2×, %11 = 4×. A 0 on either
 * axis hides the sprite.
 */
function magToMultiplier(mag: number): number {
  return mag === 0 ? 0 : mag === 1 ? 1 : mag === 2 ? 2 : 4;
}

export class Asic extends GateArray {
  /**
   * ASIC lock state. True at reset: every Plus extension is hidden and the
   * chip answers like a discrete 40010 gate array. Toggled by the 16-byte
   * unlock sequence poked through the CRTC register-select port.
   */
  locked = true;

  /** Current position in the unlock-sequence matcher (0..16). 16 means the
   *  full sequence has been seen and the next poke toggles lock state. */
  private lockSeqPos = 0;

  /**
   * The 16 KB ASIC register window that software sees at CPU &4000–&7FFF when
   * the RMR2 bit-4 pages it in. Stores every write so reads mirror back. Phase
   * 3 will keep sprite/attribute data here too; Phase 2 only consumes the
   * palette range at offset 0x2400.
   */
  readonly registerPage = new Uint8Array(0x4000);

  /**
   * The 12-bit decoded palette: 32 ABGR entries. Pens 0–15 are background
   * (shared with the inherited GA pens), pen 16 is the border, pens 17–31 are
   * sprite colours (Phase 3 consumes those). Until software writes the ASIC
   * palette explicitly, this defaults to the measured ASIC levels converted
   * from the GA's 5-bit colour codes.
   */
  readonly asicPalette = new Uint32Array(32);

  /** True when the ASIC register window is currently mapped at CPU &4000. */
  asicPageVisible = false;

  // ── Phase 3: sprites, scroll, split, raster IRQ ────────────────────────

  /** Programmable raster interrupt scanline (0 = legacy 52-line flyback). */
  interruptSl = 0;
  /** Scanline (from frame start) at which the CRTC's MA is force-loaded from
   *  `splitAddr`. 0 disables the split. */
  splitSl = 0;
  /** Forced memory address for split-screen rendering. */
  splitAddr = 0;
  /** Sub-character horizontal scroll, in mode-2 pixels (0–15). */
  hscroll = 0;
  /** Sub-row vertical scroll, in scanlines (0–7). */
  vscroll = 0;
  /** When set, the border is widened by 16 px (and hstart bumps by 1). */
  extendBorder = false;
  /** Top 5 bits of the IM 2 interrupt vector. Phase 5 (DMA) consumes this. */
  interruptVector = 0xF8;

  /** Scanline counter from frame start, used by the raster IRQ + split. Reset
   *  in `beginFrame`. Separate from the inherited `rasterCount` (which wraps
   *  at 52 for the legacy flyback). */
  private frameLine = 0;

  /** The CRTC's natural `maRow` captured at the split line, so the split region
   *  can track the CRTC's address progression as an offset from `splitAddr`. */
  private splitBaseMa = 0;

  // ── Phase 5: DMA sound (3 channels feeding the AY-3-8912) ─────────────
  /** Per-channel DMA state. Each channel executes one instruction per HSYNC
   *  while enabled and not paused. Source addresses target base 64 KB RAM. */
  private readonly dma = [
    { source: 0, prescaler: 0, pauseTicks: 0, loops: 0, loopAddr: 0, enabled: false, intPending: false },
    { source: 0, prescaler: 0, pauseTicks: 0, loops: 0, loopAddr: 0, enabled: false, intPending: false },
    { source: 0, prescaler: 0, pauseTicks: 0, loops: 0, loopAddr: 0, enabled: false, intPending: false },
  ];
  /** Raster-interrupt pending bit, mirrored into DCSR bit 7 for the CPU. */
  private rasterIntPending = false;
  /** Wired by the machine: read a 16-bit little-endian word from base 64 KB
   *  RAM (used by the DMA engine to fetch instructions). */
  readRam16: (addr: number) => number = () => 0;
  /** Wired by the machine: write an AY-3-8912 register (LOAD instruction). */
  writeAy: (reg: number, val: number) => void = () => {};

  /** Wired by the machine: swap slot 1's read/write source between RAM and the
   *  ASIC register page. */
  onAsicPage: (visible: boolean) => void = () => {};

  /** Wired by the machine: bank a cartridge ROM page into the lower-ROM slot
   *  (RMR2 D2–D0 page, D4–D3 overlay position). */
  onLowerRomBank: (page: number, slot: number) => void = () => {};

  /** Override of the GA command-byte decoder: in unlocked state, the %101
   *  prefix selects RMR2 (the Plus banking surface) instead of plain RMR. */
  write(val: number): void {
    if (!this.locked && (val & RMR2_MASK) === RMR2_PREFIX) {
      this.writeRmr2(val);
      return;
    }
    super.write(val);
  }

  /**
   * Decode an RMR2 byte (unlocked-only secondary ROM mapping register).
   *
   * RMR2 layout (Arnold V / Grimware):
   *   %101  D4 D3  D2 D1 D0
   *   D4–D3 = lower-ROM overlay position AND ASIC register-page enable:
   *     00 → lower ROM at &0000, register page off
   *     01 → lower ROM at &4000, register page off
   *     10 → lower ROM at &8000, register page off
   *     11 → lower ROM at &0000, register page ON at &4000–&7FFF
   *   D2–D0 = which of the low 8 cartridge ROM pages backs the lower ROM.
   *
   * The register page is enabled ONLY when D4=D3=1 — a bit-4-only test wrongly
   * pages it in for the &8000 lower-ROM position (D4=1,D3=0), which real Plus
   * software uses for banking.
   */
  private writeRmr2(val: number): void {
    const d4d3 = (val >>> 3) & 0x03;
    const page = val & 0x07;
    const wantPage = d4d3 === 0x03;
    if (wantPage !== this.asicPageVisible) {
      this.asicPageVisible = wantPage;
      this.onAsicPage(wantPage);
    }
    // Lower-ROM overlay slot: 01 → &4000 (slot 1), 10 → &8000 (slot 2),
    // 00/11 → &0000 (slot 0).
    const slot = d4d3 === 0x01 ? 1 : d4d3 === 0x02 ? 2 : 0;
    this.onLowerRomBank(page, slot);
  }

  /**
   * Snoop a write to the CRTC register-select port (&BC00). The CRTC ignores
   * out-of-range register selects; the ASIC matches the byte against the
   * unlock sequence and toggles `locked` once the full sequence plus a final
   * byte arrive. Called from `cpc-io.ts` BEFORE the regular CRTC select so
   * both chips always see the byte.
   *
   * State machine:
   *   - state 0..15: expect LOCK_SEQUENCE[state]. Match → advance. Mismatch
   *     restarts, but if the byte itself matches SEQ[0] it counts as the new
   *     start of the sequence (otherwise a real byte 0 in the middle would
   *     force two writes to recover).
   *   - state 16: the full sequence has been seen; this byte toggles lock.
   */
  pokeLockSequence(val: number): void {
    if (this.lockSeqPos >= LOCK_SEQUENCE.length) {
      // 16 bytes already matched — toggle and reset, regardless of `val`.
      this.setLocked(!this.locked);
      this.lockSeqPos = 0;
      return;
    }
    if (val === LOCK_SEQUENCE[this.lockSeqPos]) {
      this.lockSeqPos++;
      return;
    }
    // Mismatch: restart, but credit this byte if it itself matches SEQ[0].
    this.lockSeqPos = (val === LOCK_SEQUENCE[0]) ? 1 : 0;
  }

  /** Centralised lock-state mutator — leaves room for side-effects (clearing
   *  Plus register state on a re-lock) as later phases land. */
  private setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    if (locked && this.asicPageVisible) {
      // Re-locking hides the ASIC window immediately.
      this.asicPageVisible = false;
      this.onAsicPage(false);
    }
  }

  /**
   * Route a CPU write that landed inside the ASIC register window. Stores the
   * byte (so a follow-up read mirrors it back) and applies register-specific
   * side-effects. Phase 2 owns the palette; Phase 3 adds scroll/split/raster
   * IRQ; Phase 5 will add DMA.
   */
  cpuWrite(offset: number, val: number): void {
    this.registerPage[offset] = val & 0xFF;
    if (offset >= ASIC_PALETTE_OFFSET &&
        offset < ASIC_PALETTE_OFFSET + ASIC_PALETTE_BYTES) {
      this.writePaletteReg(offset - ASIC_PALETTE_OFFSET, val);
      return;
    }
    // Phase 3 control registers — each is a single byte with side-effects.
    switch (offset) {
      case ASIC_RASTER_IRQ_OFFSET:
        this.interruptSl = val & 0xFF;
        return;
      case ASIC_SPLIT_SCANLINE_OFFSET:
        this.splitSl = val & 0xFF;
        // Writing the split-scanline register also resets the split counter,
        // matching real hardware (the CRTC's sl_count resets on write).
        this.frameLine = 0;
        return;
      case ASIC_SPLIT_ADDR_HI_OFFSET:
        this.splitAddr = (this.splitAddr & 0x00FF) | ((val & 0x3F) << 8);
        return;
      case ASIC_SPLIT_ADDR_LO_OFFSET:
        this.splitAddr = (this.splitAddr & 0xFF00) | (val & 0xFF);
        return;
      case ASIC_SCROLL_OFFSET:
        this.extendBorder = (val & 0x80) !== 0;
        this.vscroll = (val >>> 4) & 0x07;
        this.hscroll = val & 0x0F;
        return;
      case ASIC_VECTOR_OFFSET:
        this.interruptVector = val & 0xF8;
        return;
    }

    // DMA channel registers: 3 channels × 4 bytes at offset 0x2C00.
    // Per channel: +0 src LSB, +1 src MSB, +2 prescaler, +3 unused.
    if (offset >= ASIC_DMA_CHAN_OFFSET && offset < ASIC_DMA_CHAN_OFFSET + 12) {
      const chan = (offset - ASIC_DMA_CHAN_OFFSET) >> 2;
      const field = (offset - ASIC_DMA_CHAN_OFFSET) & 3;
      const ch = this.dma[chan];
      if (field === 0) ch.source = (ch.source & 0xFF00) | (val & 0xFF);
      else if (field === 1) ch.source = (ch.source & 0x00FF) | ((val & 0xFF) << 8);
      else if (field === 2) ch.prescaler = val & 0xFF;
      return;
    }

    // DCSR (DMA Control/Status Register): writes set channel enables (bits
    // 0-2) and clear interrupt-pending bits (bits 3-5 = ch2/1/0).
    if (offset === ASIC_DMA_DCSR_OFFSET) {
      for (let c = 0; c < 3; c++) {
        this.dma[c].enabled = (val & (1 << c)) !== 0;
      }
      for (let c = 0; c < 3; c++) {
        if (val & (1 << (3 + (2 - c)))) this.dma[c].intPending = false;
      }
      this.writeDcsr();
      return;
    }
  }

  /** Recompute the DCSR byte (enables + int-pending bits) and write it back
   *  into the register page so a CPU read sees the live state. */
  private writeDcsr(): void {
    let v = 0;
    for (let c = 0; c < 3; c++) {
      if (this.dma[c].enabled) v |= 1 << c;
      if (this.dma[c].intPending) v |= 1 << (3 + (2 - c));
    }
    if (this.rasterIntPending) v |= 0x80;
    this.registerPage[ASIC_DMA_DCSR_OFFSET] = v;
  }

  /**
   * Advance one DMA tick — called once per HSYNC after the GA's own per-line
   * work. Each enabled, non-paused channel fetches one 16-bit instruction
   * from base 64 KB RAM at its source address and executes it. The top 3
   * bits encode the opcode:
   *
   *   %000 (0x0000) — LOAD R,DD: write DD to PSG register R (R in bits 11:8).
   *   %011 (0x1800) — PAUSE N: pause for N ticks (N in bits 11:0).
   *   %010 (0x1000) — REPEAT N: set loop counter to N, loop body starts at
   *                    the next instruction.
   *   %100 (0x2000) — STOP group, sub-selected by low bits: bit 0 = LOOP,
   *                    bit 4 = INT, bit 5 = STOP.
   *
   * Source: CPCWiki DMA sound + Caprice32 asic_step_dma. The prescaler would
   * divide the tick rate further on real hardware; Phase 5 leaves it unused
   * (treat each tick as one HSYNC).
   */
  dmaCycle(): void {
    if (this.locked) return;
    for (const ch of this.dma) {
      if (!ch.enabled) continue;
      if (ch.pauseTicks > 0) { ch.pauseTicks--; continue; }
      const instr = this.readRam16(ch.source & 0xFFFF);
      ch.source = (ch.source + 2) & 0xFFFF;
      // Mirror the advanced source back into the register page so software
      // reading &6C00/&6C01 after a DMA tick sees the live position.
      const chanIdx = this.dma.indexOf(ch);
      if (chanIdx >= 0) {
        const base = ASIC_DMA_CHAN_OFFSET + (chanIdx << 2);
        this.registerPage[base] = ch.source & 0xFF;
        this.registerPage[base + 1] = (ch.source >>> 8) & 0xFF;
      }
      this.executeDma(ch, instr);
    }
  }

  /** Decode and execute one DMA instruction. */
  private executeDma(ch: { source: number; pauseTicks: number; loops: number; loopAddr: number; enabled: boolean; intPending: boolean; }, instr: number): void {
    switch ((instr >>> 13) & 0x07) {
      case 0x00:
        // LOAD — write data byte to a PSG register.
        this.writeAy((instr >>> 8) & 0x0F, instr & 0xFF);
        return;
      case 0x02:
        // REPEAT — remember the next instruction as the loop body and set
        // the loop counter.
        ch.loops = instr & 0x07FF;
        ch.loopAddr = ch.source;
        return;
      case 0x03:
        // PAUSE — stall the channel for N ticks.
        ch.pauseTicks = instr & 0x07FF;
        return;
      case 0x04:
        // NOP / LOOP / INT / STOP group.
        if (instr & 0x01) {
          if (ch.loops > 0) { ch.loops--; ch.source = ch.loopAddr; }
        }
        if (instr & 0x10) {
          if (!ch.intPending) {
            ch.intPending = true;
            this.interruptRequested = true;
            this.writeDcsr();
          }
        }
        if (instr & 0x20) {
          ch.enabled = false;
          this.writeDcsr();
        }
        return;
    }
  }

  /**
   * Compute the IM 2 vector byte for the highest-priority pending interrupt
   * source. Priority order: raster (6) > DMA2 (4) > DMA1 (2) > DMA0 (0). The
   * raster source is implicit (any time the raster IRQ fires). DMA sources
   * are gated by their channel's intPending bit.
   *
   * Called by the machine when it services a Plus interrupt in IM 2. Clears
   * the raster pending bit (the CPU's ack is implicit); DMA pending bits
   * clear only on a write to DCSR.
   */
  consumeInterruptVector(): number {
    const base = this.interruptVector;
    if (this.rasterIntPending) {
      this.rasterIntPending = false;
      this.writeDcsr();
      return base | 0x06;
    }
    for (let c = 2; c >= 0; c--) {
      if (this.dma[c].intPending) {
        // DMA sources stay pending until DCSR clears them — multiple
        // services in a row return the same vector. Real hardware behaves
        // identically (the bit clears on a DCSR write, not on ack).
        return base | (c << 1);
      }
    }
    return base;   // no DMA source — fall back to base (e.g. legacy flyback)
  }

  /**
   * Decode one byte of the 2-byte ASIC palette entry. Each pen occupies two
   * bytes in ASIC RAM at offset `pen * 2`:
   *   byte 0 (even): R in high nibble, B in low nibble
   *   byte 1 (odd) : G in low nibble (high nibble unused)
   * Each channel 0–15 is scaled to 0–255 by nibble replication (×17), matching
   * the ASIC's analogue DAC. The result is packed ABGR for the renderer.
   */
  private writePaletteReg(idx: number, val: number): void {
    const pen = idx >>> 1;
    if (pen >= 32) return;
    const isGreenByte = (idx & 1) === 1;
    const current = this.asicPalette[pen];
    // Pack to the renderer's little-endian RGBA word: A<<24 | B<<16 | G<<8 | R
    // (matching constants.ts packRgb). Alpha is forced opaque — a palette entry
    // with alpha 0 renders transparent/black, which is why unlocked Plus screens
    // came out blank.
    if (isGreenByte) {
      const g = nibbleToByte(val & 0x0F);
      this.asicPalette[pen] = (0xFF000000 | (current & 0x00FF00FF) | (g << 8)) >>> 0;
    } else {
      const r = nibbleToByte((val >>> 4) & 0x0F);
      const b = nibbleToByte(val & 0x0F);
      this.asicPalette[pen] = (0xFF000000 | (current & 0x0000FF00) | (b << 16) | r) >>> 0;
    }
  }

  // ── Rendering: 12-bit palette when unlocked ───────────────────────────

  /** Border colour: the ASIC's pen 16 (12-bit) once unlocked, else the classic
   *  Gate-Array border. */
  protected borderColor(): number {
    return this.locked ? super.borderColor() : this.asicPalette[16];
  }

  /** Drawing pens: the ASIC's 12-bit pens 0–15 once unlocked, else the classic
   *  Gate-Array pens. A Plus game programs colour through the ASIC palette RAM
   *  (&6400), so a locked-mode pens[] lookup would render the wrong colours (in
   *  practice a near-uniform screen). */
  protected refreshPenLut(): void {
    if (this.locked) { super.refreshPenLut(); return; }
    for (let p = 0; p < 16; p++) this.penLut[p] = this.asicPalette[p];
  }

  // ── Phase 3: per-frame hooks ──────────────────────────────────────────

  /**
   * Per-frame setup. Calls the GA's framebuffer-clear (which fills the buffer
   * with the border colour) and resets the Plus per-frame counters so the
   * raster IRQ and split-scanline logic start at frame-line 0.
   */
  beginFrame(px: Uint32Array): void {
    super.beginFrame(px);
    this.frameLine = 0;
  }

  /**
   * Per-HSYNC hook. Applies the screen-mode latch, advances the GA's legacy
   * 52-line flyback counter (kept for VSYNC-resync compatibility), and either
   * fires the legacy flyback OR the Plus raster IRQ — never both in the same
   * frame. The Plus raster IRQ is suppressed while locked or when
   * `interruptSl === 0` (the documented compatibility behaviour).
   */
  onHSync(): void {
    this.mode = this.pendingMode;
    this.rasterCount++;
    // NB: `frameLine` is incremented at the END of this method (matching MAME's
    // `vpos++` after the PRI comparison). Incrementing it up-front fired the PRI
    // one scanline early — before the coincident 52-wrap had reset rasterCount —
    // so the PRI's bit-5 clear (below) hit rasterCount=51 instead of 0 and
    // subtracted 32, shifting the counter and making the game miss VSYNC every
    // other frame (the Burnin' Rubber logo-band palette flicker).
    // The gate-array 52-HSync interrupt counter runs and wraps at 52 ALWAYS —
    // even while a Plus raster interrupt (PRI) is armed. Only the RAISING of the
    // INT line is suppressed while PRI is active; the counter keeps ticking so
    // that when PRI is later disabled the standard interrupt still lands at the
    // right scanline. (Our previous code took an either/or branch and never
    // reset rasterCount while PRI was armed, so a stale count fired a spurious
    // mid-screen interrupt the moment PRI went back to 0 — desyncing games that
    // toggle PRI every frame, which flickered every other frame.)
    // Source: MAME amstrad_plus_hsync_changed / Arnold ASIC_HSync.
    if (this.rasterCount >= 52) {
      this.rasterCount = 0;
      if (this.locked || this.interruptSl === 0) this.interruptRequested = true;
    }
    // Plus programmable raster interrupt: fires when the ASIC frame line reaches
    // interruptSl. On match the ASIC clears bit 5 (0x20) of the HSync counter,
    // which re-syncs the standard interrupt to the frame top once PRI is off.
    if (!this.locked && this.interruptSl !== 0 && this.frameLine === this.interruptSl) {
      this.interruptRequested = true;
      this.rasterCount &= ~0x20;
      if (!this.rasterIntPending) {
        this.rasterIntPending = true;
        this.writeDcsr();
      }
    }
    this.frameLine++;
  }

  /**
   * VSYNC re-sync of the HSync interrupt counter. The counter always resets to
   * 0 a couple of lines after VSYNC (keeping interrupts phase-locked to the
   * display), but the interrupt it would raise is suppressed while a Plus
   * raster interrupt is armed — matching the 52-line path above. Source: MAME
   * (`hsync_after_vsync_counter`, gated by `pri == 0 || !enabled`).
   */
  onVSyncResync(): void {
    const wouldInterrupt = this.rasterCount >= 32;
    this.rasterCount = 0;
    if (wouldInterrupt && (this.locked || this.interruptSl === 0)) {
      this.interruptRequested = true;
    }
  }

  /**
   * Adjust a CRTC scanline's display address for the Plus soft-scroll + split
   * screen. Returns the (possibly modified) line for the GA renderer to use.
   * No-op when locked or when neither feature is active.
   *
   * Soft scroll: each scanline's video address is offset by `vscroll` char
   * rows (× 0x0800 bytes) plus a coarse `hscroll` byte backstep. Phase 3
   * implements address-level scroll (vertical fine + horizontal coarse);
   * pixel-precise horizontal scroll (sub-character) is a later refinement.
   *
   * Split screen: from `splitSl` onward the display base becomes `splitAddr`,
   * after which the address follows the CRTC's own progression. We reproduce
   * that by offsetting `splitAddr` by the CRTC's natural `maRow` delta since
   * the split line — so the address advances one char-row per (R9+1) scanlines
   * exactly as the CRTC does, with no assumption about the row height.
   */
  applyScrollAndSplit(line: CrtcLine): CrtcLine {
    if (this.locked) return line;
    let maRow = line.maRow;
    if (this.splitSl > 0 && this.frameLine > this.splitSl) {
      // Capture the CRTC's address at the split line, then track its delta so
      // the split region follows the same per-character-row advancement.
      if (this.frameLine === this.splitSl + 1) this.splitBaseMa = line.maRow;
      maRow = (this.splitAddr + line.maRow - this.splitBaseMa) & 0x3FFF;
    } else if (this.vscroll !== 0) {
      // Vertical soft scroll: shift the video address by vscroll char rows.
      // Each char row is 0x0800 bytes (half of one RAM bank); clamped to the
      // 14-bit CRTC address space.
      maRow = (maRow + this.vscroll * 0x0800) & 0x3FFF;
    }
    if (maRow === line.maRow) return line;
    return { ...line, maRow };
  }

  /**
   * Composite the 16 hardware sprites onto the framebuffer for one scanline.
   * Sprites are drawn lowest-priority-first so sprite 0 wins on top. A sprite
   * pixel of 0 is transparent and does not overwrite. Sprite colours come
   * from `asicPalette[17..31]` (pen value 1–15 maps to index 16 + value).
   *
   * Coordinate convention (Arnold V): sprite (X, Y) is in mode-2 pixels with
   * the origin at the top-left of the *active* display area, so it maps to the
   * framebuffer at (CPC_BORDER_LEFT + X, CPC_BORDER_TOP + Y). X is a signed
   * 16-bit value, Y likewise.
   *
   * No-op when locked.
   */
  drawSprites(px: Uint32Array, bufferY: number): void {
    if (this.locked) return;
    const page = this.registerPage;
    const pal = this.asicPalette;
    for (let id = SPRITE_COUNT - 1; id >= 0; id--) {
      const attrBase = ASIC_SPRITE_ATTRS_OFFSET + (id << 3);
      const xLo = page[attrBase];
      const xHi = page[attrBase + 1];
      const yLo = page[attrBase + 2];
      const yHi = page[attrBase + 3];
      const mag = page[attrBase + 4];

      const xMult = magToMultiplier((mag >>> 2) & 0x03);
      const yMult = magToMultiplier(mag & 0x03);
      if (xMult === 0 || yMult === 0) continue;      // %00 on either axis = hidden

      // Sign-extend the 16-bit X/Y coordinates, then place relative to the
      // active area's top-left corner.
      const x = CPC_BORDER_LEFT + (((xHi << 8) | xLo) << 16 >> 16);
      const y = CPC_BORDER_TOP + (((yHi << 8) | yLo) << 16 >> 16);

      const spriteW = SPRITE_NATIVE * xMult;
      const spriteH = SPRITE_NATIVE * yMult;

      // Cull sprites that don't touch this scanline.
      if (bufferY < y || bufferY >= y + spriteH) continue;
      const srcRow = ((bufferY - y) / yMult) | 0;
      if (srcRow < 0 || srcRow >= SPRITE_NATIVE) continue;

      const rowBase = ASIC_SPRITE_PIXELS_OFFSET + (id << 8) + (srcRow << 4);
      const rowEnd = px.length - CPC_SCREEN_WIDTH;   // safety for buffer overruns
      for (let dx = 0; dx < spriteW; dx++) {
        const srcX = (dx / xMult) | 0;
        const pen = page[rowBase + srcX] & 0x0F;
        if (pen === 0) continue;                     // transparent — keep underlying pixel
        const bufferX = x + dx;
        if (bufferX < 0 || bufferX >= CPC_SCREEN_WIDTH) continue;
        const idx = bufferY * CPC_SCREEN_WIDTH + bufferX;
        if (idx < 0 || idx > rowEnd) continue;
        px[idx] = pal[16 + pen];
      }
    }
  }

  // ── Snapshot restore ──────────────────────────────────────────────────

  /** Restore ASIC state from a snapshot — extends the GA's restoreState. */
  restoreCoreState(locked: boolean, registerPage: ArrayLike<number>,
                   asicPalette: ArrayLike<number>): void {
    this.locked = locked;
    this.lockSeqPos = 0;
    this.asicPageVisible = false;
    for (let i = 0; i < this.registerPage.length; i++) {
      this.registerPage[i] = registerPage[i] & 0xFF;
    }
    for (let i = 0; i < this.asicPalette.length; i++) {
      this.asicPalette[i] = asicPalette[i] >>> 0;
    }
    // Re-derive scroll/split/raster state from the restored register page.
    this.interruptSl = this.registerPage[ASIC_RASTER_IRQ_OFFSET] & 0xFF;
    this.splitSl = this.registerPage[ASIC_SPLIT_SCANLINE_OFFSET] & 0xFF;
    this.splitAddr =
      ((this.registerPage[ASIC_SPLIT_ADDR_HI_OFFSET] & 0x3F) << 8) |
      this.registerPage[ASIC_SPLIT_ADDR_LO_OFFSET];
    const sc = this.registerPage[ASIC_SCROLL_OFFSET];
    this.extendBorder = (sc & 0x80) !== 0;
    this.vscroll = (sc >>> 4) & 0x07;
    this.hscroll = sc & 0x0F;
    this.interruptVector = this.registerPage[ASIC_VECTOR_OFFSET] & 0xF8;
    this.frameLine = 0;
    // Restore DMA channel state from the register page.
    for (let c = 0; c < 3; c++) {
      const base = ASIC_DMA_CHAN_OFFSET + (c << 2);
      const src = this.registerPage[base] | (this.registerPage[base + 1] << 8);
      this.dma[c].source = src;
      this.dma[c].prescaler = this.registerPage[base + 2];
    }
    this.rasterIntPending = false;
    this.writeDcsr();
  }

  /**
   * Snapshot helper: capture the dynamic DMA channel state that isn't stored
   * in `registerPage` (pauseTicks, loops, loopAddr, enabled, intPending).
   * Returns 15 bytes (3 channels × 5 fields, each one byte except loopAddr
   * which is two). The register-page bytes carry everything else.
   */
  captureDmaState(): Uint8Array {
    const out = new Uint8Array(3 * 6);
    for (let c = 0; c < 3; c++) {
      const ch = this.dma[c];
      const base = c * 6;
      out[base] = ch.pauseTicks & 0xFF;
      out[base + 1] = ch.loops & 0xFF;
      out[base + 2] = ch.loopAddr & 0xFF;
      out[base + 3] = (ch.loopAddr >>> 8) & 0xFF;
      out[base + 4] = ch.enabled ? 1 : 0;
      out[base + 5] = ch.intPending ? 1 : 0;
    }
    return out;
  }

  /** Snapshot helper: restore the dynamic DMA state from a `captureDmaState`
   *  byte array. Complements `restoreCoreState` — call after it. */
  restoreDmaState(state: ArrayLike<number>): void {
    for (let c = 0; c < 3; c++) {
      const base = c * 6;
      const ch = this.dma[c];
      ch.pauseTicks = state[base] & 0xFF;
      ch.loops = state[base + 1] & 0xFF;
      ch.loopAddr = state[base + 2] | (state[base + 3] << 8);
      ch.enabled = state[base + 4] !== 0;
      ch.intPending = state[base + 5] !== 0;
    }
    this.writeDcsr();
  }

  reset(): void {
    super.reset();
    this.locked = true;
    this.lockSeqPos = 0;
    this.asicPageVisible = false;
    this.registerPage.fill(0);
    this.asicPalette.fill(0);
    this.interruptSl = 0;
    this.splitSl = 0;
    this.splitAddr = 0;
    this.hscroll = 0;
    this.vscroll = 0;
    this.extendBorder = false;
    this.interruptVector = 0xF8;
    this.frameLine = 0;
    for (const ch of this.dma) {
      ch.source = 0;
      ch.prescaler = 0;
      ch.pauseTicks = 0;
      ch.loops = 0;
      ch.loopAddr = 0;
      ch.enabled = false;
      ch.intPending = false;
    }
    this.rasterIntPending = false;
  }
}

/** Re-export so callers don't need to know the FN_RMR bit pattern. */
export { FN_RMR };
