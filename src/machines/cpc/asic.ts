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

import { GateArray, FN_RMR } from '@/machines/cpc/gate-array.ts';

/**
 * The 16-byte sequence poked through the CRTC register-select port (&BC00)
 * that toggles the ASIC lock. Real hardware matches it byte-for-byte against
 * an internal state machine; a single mismatch resets the matcher. Source:
 * Grimware CPC Plus ASIC documentation / Caprice32 asic.cpp.
 */
const LOCK_SEQUENCE: readonly number[] = [
  0x00, 0x00, 0xFF, 0x77, 0xB3, 0x51, 0xA8, 0xD4,
  0x62, 0x39, 0x9C, 0x46, 0x2B, 0x15, 0x8A, 0xCD,
];

/** Mask selecting the top three bits — %101xxxxx = RMR2 escape in the GA
 *  command byte (FN_RMR = %100xxxxx with bit 5 set). */
const RMR2_MASK = 0xE0;
/** The %101 prefix that distinguishes RMR2 from a plain FN_RMR byte. */
const RMR2_PREFIX = 0xA0;
/** Bit 4 of RMR2: pages the ASIC register window into &4000–&7FFF. */
const RMR2_ASIC_PAGE = 0x10;

/** ASIC RAM regions within the 16 KB register window (CPU addresses
 *  &4000–&7FFF while paged). */
const ASIC_PALETTE_OFFSET = 0x2400;   // &6400 − &4000 = 0x2400
const ASIC_PALETTE_BYTES = 32 * 2;    // 32 pens × 2 bytes (R+B, G)

/**
 * Expand a 4-bit channel value (0–15) to 8 bits by scaling ×17, matching the
 * ASIC's analogue output stage: 0→0, 1→17, …, 15→255. (Nibble replication.)
 */
function nibbleToByte(n: number): number {
  return n | (n << 4);
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

  /** Wired by the machine: swap slot 1's read/write source between RAM and the
   *  ASIC register page. */
  onAsicPage: (visible: boolean) => void = () => {};

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
   * Decode an RMR2 byte. Phase 2 handles only bit 4 (ASIC register window
   * paging); Phase 4 will add bits 3 (lower-ROM relocation) and 2:0
   * (cartridge ROM page select).
   *
   * RMR2 layout (Grimware):
   *   %101  asic_page  lower_rom_loc  cartridge_rom_page[2:0]
   *   bit 4 = 1 → page ASIC register window into &4000–&7FFF
   *   bit 3 = lower-ROM mapping area selector (Phase 4)
   *   bits 2:0 = cartridge ROM page 0–7 for the lower-ROM slot (Phase 4)
   */
  private writeRmr2(val: number): void {
    const wantPage = (val & RMR2_ASIC_PAGE) !== 0;
    if (wantPage !== this.asicPageVisible) {
      this.asicPageVisible = wantPage;
      this.onAsicPage(wantPage);
    }
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
   * side-effects. Phase 2 owns the palette; Phase 3 adds sprite/scroll/split/
   * DMA side-effects.
   */
  cpuWrite(offset: number, val: number): void {
    this.registerPage[offset] = val & 0xFF;
    if (offset >= ASIC_PALETTE_OFFSET &&
        offset < ASIC_PALETTE_OFFSET + ASIC_PALETTE_BYTES) {
      this.writePaletteReg(offset - ASIC_PALETTE_OFFSET, val);
    }
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
    if (isGreenByte) {
      const g = nibbleToByte(val & 0x0F);
      this.asicPalette[pen] = (current & 0xFF00FFFF) | (g << 16);
    } else {
      const r = nibbleToByte((val >>> 4) & 0x0F);
      const b = nibbleToByte(val & 0x0F);
      this.asicPalette[pen] = (current & 0xFF00FF00) | (b << 8) | r;
    }
  }

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
  }

  reset(): void {
    super.reset();
    this.locked = true;
    this.lockSeqPos = 0;
    this.asicPageVisible = false;
    this.registerPage.fill(0);
    this.asicPalette.fill(0);
  }
}

/** Re-export so callers don't need to know the FN_RMR bit pattern. */
export { FN_RMR };
