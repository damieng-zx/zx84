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
 * latching, the 52-line flyback interrupt, mode-0/1/2 rendering. Phases 2+ add
 * the unlock sequence, ASIC RAM paging, sprites, scroll, split, raster IRQ and
 * DMA sound as overrides on top.
 *
 * Phase 1: skeleton only — `locked = true` at reset means `super.write()` and
 * `super.onHSync()` carry every behaviour, and a Plus machine boots and runs
 * existing CPC software identically to a non-Plus 6128.
 */

import { GateArray } from '@/machines/cpc/gate-array.ts';

export class Asic extends GateArray {
  /**
   * ASIC lock state. True at reset: every Plus extension is hidden and the
   * chip answers like a discrete 40010 gate array. Toggled by the 16-byte
   * unlock sequence poked through the CRTC register-select port (Phase 2).
   */
  locked = true;

  /**
   * Reset — clears the inherited gate-array state and re-locks the ASIC.
   * Plus extensions (sprites, scroll, palette, DMA, …) will be cleared here
   * as they land in subsequent phases.
   */
  reset(): void {
    super.reset();
    this.locked = true;
  }
}
